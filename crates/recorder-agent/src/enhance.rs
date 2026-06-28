//! In-process voice enhancement (noise suppression) for the recorder agent.
//!
//! Two engines run fully in-process with embedded models, so no extra packages
//! are deployed to recorder nodes:
//! - `Deepfilternet3` via the `deep_filter` crate (pure-Rust `tract` inference;
//!   the DeepFilterNet3 model is embedded through its `default-model` feature).
//! - `Rnnoise` via the `nnnoiseless` crate.
//!
//! Both engines operate on 48 kHz mono audio. The recording render path enhances
//! a channel-mapped mono intermediate (see `channel_map.rs`); the live monitor
//! enhances the captured PCM before it is downsampled to the 16 kHz monitor chunk
//! (see `telemetry.rs`). The raw audio is always preserved separately; enhancement
//! is an additional, switchable rendition.

// Transitional: the WAV file helpers are consumed by the recording render
// integration in the next commit; the engine core is already exercised by tests.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result, bail};

/// Sample rate required by both denoise engines.
pub const ENHANCE_SAMPLE_RATE: u32 = 48_000;

/// Noise-suppression engine selected by a recording profile or monitor config.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnhancementEngine {
    Rnnoise,
    Deepfilternet3,
}

impl EnhancementEngine {
    /// Parse the wire value used by shared contracts; returns `None` for unknown
    /// values and for the disabled sentinel `"off"`.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "rnnoise" => Some(Self::Rnnoise),
            "deepfilternet3" | "deepfilternet" | "dfn" => Some(Self::Deepfilternet3),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rnnoise => "rnnoise",
            Self::Deepfilternet3 => "deepfilternet3",
        }
    }
}

/// A loaded denoiser. Construct once and reuse across buffers; loading the
/// DeepFilterNet model is comparatively expensive.
pub struct Enhancer {
    backend: Backend,
}

enum Backend {
    Rnnoise,
    Dfn(Box<df::tract::DfTract>),
}

impl Enhancer {
    pub fn new(engine: EnhancementEngine) -> Result<Self> {
        let backend = match engine {
            EnhancementEngine::Rnnoise => Backend::Rnnoise,
            EnhancementEngine::Deepfilternet3 => {
                use df::tract::{DfParams, DfTract, RuntimeParams};

                let model = DfTract::new(DfParams::default(), &RuntimeParams::default_with_ch(1))
                    .context("initialize DeepFilterNet model")?;
                Backend::Dfn(Box::new(model))
            }
        };

        Ok(Self { backend })
    }

    /// Denoise a 48 kHz mono buffer, returning a buffer of the same length.
    pub fn process_mono(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        match &mut self.backend {
            Backend::Rnnoise => Ok(rnnoise_process(samples)),
            Backend::Dfn(model) => dfn_process(model, samples),
        }
    }
}

fn rnnoise_process(samples: &[f32]) -> Vec<f32> {
    // nnnoiseless processes fixed frames and expects samples in i16 scale stored
    // as f32, so scale the normalized [-1, 1] buffer in and back out.
    let mut state = nnnoiseless::DenoiseState::new();
    let frame = nnnoiseless::DenoiseState::FRAME_SIZE;
    let mut input = vec![0f32; frame];
    let mut output = vec![0f32; frame];
    let mut out = Vec::with_capacity(samples.len());

    for chunk in samples.chunks(frame) {
        for (slot, value) in input
            .iter_mut()
            .zip(chunk.iter().copied().chain(std::iter::repeat(0.0)))
        {
            *slot = value * 32768.0;
        }
        state.process_frame(&mut output, &input);
        out.extend(output.iter().map(|sample| sample / 32768.0));
    }

    out.truncate(samples.len());
    out
}

fn dfn_process(model: &mut df::tract::DfTract, samples: &[f32]) -> Result<Vec<f32>> {
    use ndarray::Array2;

    let hop = model.hop_size;
    let mut frame = vec![0f32; hop];
    let mut out = Vec::with_capacity(samples.len());

    for chunk in samples.chunks(hop) {
        frame[..chunk.len()].copy_from_slice(chunk);
        for slot in frame.iter_mut().skip(chunk.len()) {
            *slot = 0.0;
        }
        let noisy = Array2::from_shape_vec((1, hop), frame.clone())
            .context("shape DeepFilterNet input frame")?;
        let mut enhanced = Array2::<f32>::zeros((1, hop));
        model
            .process(noisy.view(), enhanced.view_mut())
            .context("DeepFilterNet process frame")?;
        out.extend_from_slice(
            enhanced
                .as_slice()
                .context("DeepFilterNet output not contiguous")?,
        );
    }

    out.truncate(samples.len());
    Ok(out)
}

/// Read a 48 kHz mono WAV, denoise it, and write a 48 kHz mono 16-bit WAV. Used by
/// the recording render path against the channel-mapped intermediate.
pub fn enhance_wav_file(input: &Path, output: &Path, engine: EnhancementEngine) -> Result<()> {
    let (samples, sample_rate) = read_mono_wav(input)?;
    if sample_rate != ENHANCE_SAMPLE_RATE {
        bail!(
            "enhancement requires {ENHANCE_SAMPLE_RATE} Hz mono input, got {sample_rate} Hz: {}",
            input.display()
        );
    }

    let mut enhancer = Enhancer::new(engine)?;
    let processed = enhancer.process_mono(&samples)?;
    write_mono_wav(output, &processed)
}

fn read_mono_wav(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("open WAV {}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;

    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<_, _>>()
                .context("read integer WAV samples")?
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .context("read float WAV samples")?,
    };

    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();

    Ok((mono, spec.sample_rate))
}

fn write_mono_wav(path: &Path, samples: &[f32]) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: ENHANCE_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .with_context(|| format!("create WAV {}", path.display()))?;
    for &sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        writer.write_sample(value).context("write WAV sample")?;
    }
    writer.finalize().context("finalize WAV")?;
    Ok(())
}

#[cfg(all(test, not(miri)))]
mod tests {
    use super::*;

    // A 48 kHz mono tone plus broadband noise; denoisers should lower the energy
    // of the noise-dominated tail without zeroing the whole signal.
    fn noisy_signal() -> Vec<f32> {
        let mut samples = Vec::with_capacity(ENHANCE_SAMPLE_RATE as usize);
        let mut seed: u32 = 0x1234_5678;
        for n in 0..ENHANCE_SAMPLE_RATE as usize {
            let t = n as f32 / ENHANCE_SAMPLE_RATE as f32;
            let tone = (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 0.2;
            // cheap xorshift noise
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let noise = (seed as f32 / u32::MAX as f32 - 0.5) * 0.2;
            samples.push(tone + noise);
        }
        samples
    }

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn engine_parse_round_trips() {
        assert_eq!(
            EnhancementEngine::parse("rnnoise"),
            Some(EnhancementEngine::Rnnoise)
        );
        assert_eq!(
            EnhancementEngine::parse("DeepFilterNet3"),
            Some(EnhancementEngine::Deepfilternet3)
        );
        assert_eq!(EnhancementEngine::parse("off"), None);
        assert_eq!(EnhancementEngine::parse("bogus"), None);
    }

    #[test]
    fn rnnoise_preserves_length_and_reduces_energy() {
        let input = noisy_signal();
        let mut enhancer = Enhancer::new(EnhancementEngine::Rnnoise).expect("rnnoise");
        let output = enhancer.process_mono(&input).expect("process");
        assert_eq!(output.len(), input.len());
        assert!(
            rms(&output) < rms(&input),
            "expected denoise to reduce energy"
        );
    }

    #[test]
    fn deepfilternet_preserves_length_and_reduces_energy() {
        let input = noisy_signal();
        let mut enhancer = Enhancer::new(EnhancementEngine::Deepfilternet3).expect("dfn");
        let output = enhancer.process_mono(&input).expect("process");
        assert_eq!(output.len(), input.len());
        assert!(
            rms(&output) < rms(&input),
            "expected denoise to reduce energy"
        );
    }
}
