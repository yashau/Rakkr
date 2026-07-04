use std::process::Command;

use anyhow::Context;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::enhance::Enhancer;
use crate::meter_command::{MeterCaptureConfig, meter_command_args};

mod correlation;

use self::correlation::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterFrame {
    pub captured_at: String,
    pub interface_id: String,
    pub levels: Vec<AudioLevel>,
    pub node_id: String,
}

pub struct MeterSample {
    pub frame: MeterFrame,
    pub monitor_duration_ms: u64,
    pub monitor_wav: Vec<u8>,
    // Denoised 16 kHz mono chunk, produced on demand when a listener wants enhanced
    // monitor audio. None otherwise.
    pub enhanced_monitor_wav: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    pub channel_index: u16,
    pub clipping: bool,
    pub label: String,
    pub peak_dbfs: f32,
    pub quality: AudioQuality,
    pub rms_dbfs: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioQuality {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_correlation: Option<ChannelCorrelation>,
    pub broadband_noise_score: f32,
    pub crest_factor_db: f32,
    pub estimated_snr_db: f32,
    pub hum_score: f32,
    pub intelligibility_score: f32,
    pub noise_score: f32,
    pub speech_like: bool,
    pub speech_score: f32,
    pub static_score: f32,
    pub zero_crossing_rate: f32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterQualityEvidence {
    pub max_broadband_noise_score: Option<f32>,
    pub max_hum_score: Option<f32>,
    pub max_noise_score: Option<f32>,
    pub max_speech_score: Option<f32>,
    pub max_static_score: Option<f32>,
    pub min_estimated_snr_db: Option<f32>,
    pub min_intelligibility_score: Option<f32>,
}

#[derive(Clone, Copy)]
pub enum MeterFaultKind {
    ChannelCorrelation(f32),
    Clipping(f32),
    Flatline(f32),
    LowSignal(f32),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCorrelation {
    pub peer_channel_index: u16,
    pub phase: &'static str,
    pub score: f32,
}

const MONITOR_CHUNK_SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Copy)]
enum PcmSampleFormat {
    S16Le,
    S32Le,
}

impl PcmSampleFormat {
    fn parse(format: &str) -> anyhow::Result<Self> {
        match format.to_ascii_uppercase().as_str() {
            "S16_LE" => Ok(Self::S16Le),
            "S32_LE" => Ok(Self::S32Le),
            _ => anyhow::bail!(
                "meter sampling currently supports S16_LE and S32_LE PCM, not {}",
                format
            ),
        }
    }

    fn bytes_per_sample(self) -> usize {
        match self {
            Self::S16Le => 2,
            Self::S32Le => 4,
        }
    }

    fn normalized_sample(self, sample: &[u8]) -> f64 {
        match self {
            Self::S16Le => f64::from(i16::from_le_bytes([sample[0], sample[1]])) / 32768.0,
            Self::S32Le => {
                f64::from(i32::from_le_bytes([
                    sample[0], sample[1], sample[2], sample[3],
                ])) / 2_147_483_648.0
            }
        }
    }
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn alsa_meter_frame(
    node_id: &str,
    interface_id: &str,
    config: &MeterCaptureConfig<'_>,
) -> anyhow::Result<MeterFrame> {
    Ok(alsa_meter_sample(node_id, interface_id, config, None)?.frame)
}

pub fn alsa_meter_sample(
    node_id: &str,
    interface_id: &str,
    config: &MeterCaptureConfig<'_>,
    enhancer: Option<&mut Enhancer>,
) -> anyhow::Result<MeterSample> {
    let sample_format = PcmSampleFormat::parse(config.format)?;

    let args = meter_command_args(config)?;
    let output = Command::new(config.command)
        .args(&args)
        .output()
        .with_context(|| format!("run {} for meter sampling", config.command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "meter command exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }

    meter_sample_from_pcm(
        node_id,
        interface_id,
        &output.stdout,
        config,
        sample_format,
        enhancer,
    )
}

fn meter_sample_from_pcm(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    config: &MeterCaptureConfig<'_>,
    sample_format: PcmSampleFormat,
    enhancer: Option<&mut Enhancer>,
) -> anyhow::Result<MeterSample> {
    let captured_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("format captured timestamp")?;
    let frame = pcm_meter_frame_at(
        node_id,
        interface_id,
        pcm,
        config.channel_count,
        config.clip_dbfs,
        &captured_at,
        sample_format,
    )?;
    let monitor_duration_ms =
        pcm_duration_ms(pcm, config.sample_rate, config.channel_count, sample_format)
            .unwrap_or_else(|| config.sample_seconds.max(1).saturating_mul(1000));
    let monitor_wav = pcm_monitor_wav(
        pcm,
        config.sample_rate,
        config.channel_count,
        MONITOR_CHUNK_SAMPLE_RATE,
        sample_format,
    )?;

    // On-demand enhanced chunk: denoise must run at 48 kHz, so only when the
    // capture rate matches. Best-effort; a failure just omits the enhanced chunk.
    let enhanced_monitor_wav = match enhancer {
        Some(enhancer) if config.sample_rate == crate::enhance::ENHANCE_SAMPLE_RATE => {
            enhanced_monitor_wav(pcm, config.channel_count, sample_format, enhancer).ok()
        }
        _ => None,
    };

    Ok(MeterSample {
        frame,
        monitor_duration_ms,
        monitor_wav,
        enhanced_monitor_wav,
    })
}

#[cfg(test)]
fn pcm_s16le_meter_frame_at(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    channel_count: u16,
    clip_dbfs: f32,
    captured_at: &str,
) -> anyhow::Result<MeterFrame> {
    pcm_meter_frame_at(
        node_id,
        interface_id,
        pcm,
        channel_count,
        clip_dbfs,
        captured_at,
        PcmSampleFormat::S16Le,
    )
}

fn pcm_meter_frame_at(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    channel_count: u16,
    clip_dbfs: f32,
    captured_at: &str,
    sample_format: PcmSampleFormat,
) -> anyhow::Result<MeterFrame> {
    if channel_count == 0 {
        anyhow::bail!("meter frame requires at least one channel");
    }

    let sample_bytes = sample_format.bytes_per_sample();

    if pcm.len() < usize::from(channel_count) * sample_bytes {
        anyhow::bail!("meter PCM payload does not contain a complete frame");
    }

    if !pcm.len().is_multiple_of(sample_bytes) {
        anyhow::bail!("meter PCM payload has an incomplete sample");
    }

    let channel_count = usize::from(channel_count);
    let frame_bytes = channel_count * sample_bytes;

    if !pcm.len().is_multiple_of(frame_bytes) {
        anyhow::bail!("meter PCM payload has an incomplete interleaved frame");
    }

    let mut stats = (0..channel_count)
        .map(|_| ChannelStats::default())
        .collect::<Vec<_>>();
    let mut pair_stats = channel_pairs(channel_count);

    for frame in pcm.chunks_exact(frame_bytes) {
        let mut samples = Vec::with_capacity(channel_count);

        for (channel_index, channel_stats) in stats.iter_mut().enumerate() {
            let offset = channel_index * sample_bytes;
            let sample = sample_format.normalized_sample(&frame[offset..offset + sample_bytes]);
            let signed = channel_stats.observe(sample);

            samples.push(signed);
        }

        for pair in &mut pair_stats {
            pair.observe(samples[pair.left], samples[pair.right]);
        }
    }

    let rms_dbfs = stats
        .iter()
        .map(|stats| amplitude_to_dbfs(stats.rms()))
        .collect::<Vec<_>>();
    let peak_dbfs = stats
        .iter()
        .map(|stats| amplitude_to_dbfs(stats.peak))
        .collect::<Vec<_>>();
    let correlations = strongest_channel_correlations(&pair_stats, &rms_dbfs);
    let levels = stats
        .iter()
        .enumerate()
        .map(|(index, stats)| {
            let rms_dbfs = rms_dbfs[index];
            let peak_dbfs = peak_dbfs[index];
            let mut quality = stats.audio_quality(rms_dbfs, peak_dbfs);

            quality.channel_correlation = correlations[index].clone();

            AudioLevel {
                channel_index: u16::try_from(index + 1).unwrap_or(u16::MAX),
                clipping: peak_dbfs >= clip_dbfs,
                label: format!("Input {}", index + 1),
                peak_dbfs: round_1(peak_dbfs),
                quality,
                rms_dbfs: round_1(rms_dbfs),
            }
        })
        .collect::<Vec<_>>();

    Ok(MeterFrame {
        captured_at: captured_at.to_string(),
        interface_id: interface_id.to_string(),
        levels,
        node_id: node_id.to_string(),
    })
}

pub fn synthetic_meter_frame(
    node_id: &str,
    interface_id: &str,
    channel_count: u16,
    tick: u64,
) -> anyhow::Result<MeterFrame> {
    let levels = (1..=channel_count)
        .map(|channel_index| {
            let phase = tick as f32 / 3.0 + channel_index as f32 * 0.72;
            let rms_dbfs = (-42.0 + phase.sin() * 12.0).max(-72.0);
            let peak_dbfs = (rms_dbfs + 14.0 + phase.cos().abs() * 4.0).min(-3.0);

            AudioLevel {
                channel_index,
                clipping: peak_dbfs > -1.0,
                label: format!("Input {channel_index}"),
                peak_dbfs: round_1(peak_dbfs),
                quality: synthetic_quality(rms_dbfs, peak_dbfs, phase),
                rms_dbfs: round_1(rms_dbfs),
            }
        })
        .collect::<Vec<_>>();

    if levels.is_empty() {
        anyhow::bail!("meter frame requires at least one channel");
    }

    Ok(MeterFrame {
        captured_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .context("format captured timestamp")?,
        interface_id: interface_id.to_string(),
        levels,
        node_id: node_id.to_string(),
    })
}

pub fn synthetic_meter_sample(
    node_id: &str,
    interface_id: &str,
    channel_count: u16,
    tick: u64,
) -> anyhow::Result<MeterSample> {
    let frame = synthetic_meter_frame(node_id, interface_id, channel_count, tick)?;
    let monitor_duration_ms = 1000;
    let monitor_wav = meter_frame_monitor_wav(&frame, monitor_duration_ms);

    Ok(MeterSample {
        frame,
        monitor_duration_ms,
        monitor_wav,
        enhanced_monitor_wav: None,
    })
}

pub fn meter_quality_evidence(frame: &MeterFrame) -> MeterQualityEvidence {
    MeterQualityEvidence {
        max_broadband_noise_score: max_quality_by(frame, |quality| quality.broadband_noise_score),
        max_hum_score: max_quality_by(frame, |quality| quality.hum_score),
        max_noise_score: max_quality_by(frame, |quality| quality.noise_score),
        max_speech_score: max_quality_by(frame, |quality| quality.speech_score),
        max_static_score: max_quality_by(frame, |quality| quality.static_score),
        min_estimated_snr_db: min_quality_by(frame, |quality| quality.estimated_snr_db),
        min_intelligibility_score: min_quality_by(frame, |quality| quality.intelligibility_score),
    }
}

pub fn meter_max_rms_dbfs(frame: &MeterFrame) -> Option<f32> {
    frame
        .levels
        .iter()
        .map(|level| level.rms_dbfs)
        .max_by(f32::total_cmp)
}

pub fn meter_fault_score(frame: &MeterFrame, fault: MeterFaultKind) -> Option<f32> {
    if frame.levels.is_empty() {
        return None;
    }

    Some(round_2(match fault {
        MeterFaultKind::ChannelCorrelation(min_abs_score) => channel_correlation_fault_score(
            frame
                .levels
                .iter()
                .filter_map(|level| level.quality.channel_correlation.as_ref())
                .map(|correlation| correlation.score.abs())
                .max_by(f32::total_cmp)
                .unwrap_or(0.0),
            min_abs_score,
        ),
        MeterFaultKind::Clipping(clip_dbfs) => rising_score(max_peak_dbfs(frame), clip_dbfs, 0.0),
        MeterFaultKind::Flatline(flatline_dbfs) => falling_score(
            meter_max_rms_dbfs(frame).unwrap_or(-160.0),
            flatline_dbfs - 40.0,
            flatline_dbfs,
        ),
        MeterFaultKind::LowSignal(low_signal_dbfs) => falling_score(
            meter_max_rms_dbfs(frame).unwrap_or(-160.0),
            low_signal_dbfs - 30.0,
            low_signal_dbfs,
        ),
    }))
}

fn max_quality_by(frame: &MeterFrame, value: impl Fn(&AudioQuality) -> f32) -> Option<f32> {
    frame
        .levels
        .iter()
        .map(|level| value(&level.quality))
        .max_by(f32::total_cmp)
}

fn min_quality_by(frame: &MeterFrame, value: impl Fn(&AudioQuality) -> f32) -> Option<f32> {
    frame
        .levels
        .iter()
        .map(|level| value(&level.quality))
        .min_by(f32::total_cmp)
}

fn max_peak_dbfs(frame: &MeterFrame) -> f32 {
    frame
        .levels
        .iter()
        .map(|level| level.peak_dbfs)
        .max_by(f32::total_cmp)
        .unwrap_or(-160.0)
}

fn channel_correlation_fault_score(max_abs_score: f32, min_abs_score: f32) -> f32 {
    if max_abs_score < min_abs_score {
        return 0.0;
    }

    clamp_01((max_abs_score - min_abs_score) / (1.0 - min_abs_score).max(0.01))
}

#[cfg(test)]
fn pcm_s16le_monitor_wav(
    pcm: &[u8],
    source_sample_rate: u32,
    channel_count: u16,
    target_sample_rate: u32,
) -> anyhow::Result<Vec<u8>> {
    pcm_monitor_wav(
        pcm,
        source_sample_rate,
        channel_count,
        target_sample_rate,
        PcmSampleFormat::S16Le,
    )
}

fn pcm_monitor_wav(
    pcm: &[u8],
    source_sample_rate: u32,
    channel_count: u16,
    target_sample_rate: u32,
    sample_format: PcmSampleFormat,
) -> anyhow::Result<Vec<u8>> {
    if source_sample_rate == 0 || target_sample_rate == 0 || channel_count == 0 {
        anyhow::bail!("monitor WAV requires non-zero sample rates and channels");
    }

    let channel_count = usize::from(channel_count);
    let sample_bytes = sample_format.bytes_per_sample();
    let frame_bytes = channel_count * sample_bytes;

    if pcm.len() < frame_bytes || !pcm.len().is_multiple_of(frame_bytes) {
        anyhow::bail!("monitor PCM payload has incomplete interleaved frames");
    }

    let source_frames = pcm.len() / frame_bytes;
    let target_samples = ((source_frames as f64 / f64::from(source_sample_rate))
        * f64::from(target_sample_rate))
    .round()
    .max(1.0) as usize;
    let mut samples = Vec::with_capacity(target_samples);

    for index in 0..target_samples {
        let source_index = ((index as f64 * f64::from(source_sample_rate))
            / f64::from(target_sample_rate))
        .floor()
        .min((source_frames - 1) as f64) as usize;
        let frame = &pcm[source_index * frame_bytes..(source_index + 1) * frame_bytes];
        let mixed = (0..channel_count)
            .map(|channel| {
                let offset = channel * sample_bytes;
                sample_format.normalized_sample(&frame[offset..offset + sample_bytes])
            })
            .sum::<f64>()
            / channel_count as f64;

        samples.push(
            (mixed * f64::from(i16::MAX)).clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16,
        );
    }

    Ok(wav_mono_s16le(&samples, target_sample_rate))
}

// Denoise the captured 48 kHz PCM (mixed to mono) in-process, then downsample to
// the 16 kHz monitor chunk. Caller guarantees the source rate is 48 kHz.
fn enhanced_monitor_wav(
    pcm: &[u8],
    channel_count: u16,
    sample_format: PcmSampleFormat,
    enhancer: &mut Enhancer,
) -> anyhow::Result<Vec<u8>> {
    let channels = usize::from(channel_count);
    let sample_bytes = sample_format.bytes_per_sample();
    let frame_bytes = channels * sample_bytes;

    if frame_bytes == 0 || pcm.len() < frame_bytes || !pcm.len().is_multiple_of(frame_bytes) {
        anyhow::bail!("monitor PCM payload has incomplete interleaved frames");
    }

    let source_frames = pcm.len() / frame_bytes;
    let mut mono = Vec::with_capacity(source_frames);
    for index in 0..source_frames {
        let frame = &pcm[index * frame_bytes..(index + 1) * frame_bytes];
        let mixed = (0..channels)
            .map(|channel| {
                let offset = channel * sample_bytes;
                sample_format.normalized_sample(&frame[offset..offset + sample_bytes])
            })
            .sum::<f64>()
            / channels as f64;
        mono.push(mixed as f32);
    }

    let denoised = enhancer.process_mono(&mono)?;
    let source_rate = f64::from(crate::enhance::ENHANCE_SAMPLE_RATE);
    let target_rate = f64::from(MONITOR_CHUNK_SAMPLE_RATE);
    let target_samples = ((denoised.len() as f64 / source_rate) * target_rate)
        .round()
        .max(1.0) as usize;
    let mut samples = Vec::with_capacity(target_samples);

    for index in 0..target_samples {
        let source_index = ((index as f64 * source_rate) / target_rate)
            .floor()
            .min((denoised.len().max(1) - 1) as f64) as usize;
        let value = f64::from(denoised[source_index]) * f64::from(i16::MAX);
        samples.push(value.clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16);
    }

    Ok(wav_mono_s16le(&samples, MONITOR_CHUNK_SAMPLE_RATE))
}

fn meter_frame_monitor_wav(frame: &MeterFrame, duration_ms: u64) -> Vec<u8> {
    let sample_count = ((u64::from(MONITOR_CHUNK_SAMPLE_RATE) * duration_ms) / 1000).max(1);
    let peak_dbfs = frame
        .levels
        .iter()
        .map(|level| level.peak_dbfs)
        .fold(-90.0_f32, f32::max);
    let amplitude = (10.0_f32.powf(peak_dbfs / 20.0)).clamp(0.02, 0.25);
    let samples = (0..sample_count)
        .map(|index| {
            let phase = (2.0 * std::f32::consts::PI * 440.0 * index as f32)
                / MONITOR_CHUNK_SAMPLE_RATE as f32;

            (phase.sin() * amplitude * f32::from(i16::MAX)).round() as i16
        })
        .collect::<Vec<_>>();

    wav_mono_s16le(&samples, MONITOR_CHUNK_SAMPLE_RATE)
}

fn wav_mono_s16le(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_bytes = samples.len().saturating_mul(2);
    let mut bytes = vec![0_u8; 44 + data_bytes];

    bytes[0..4].copy_from_slice(b"RIFF");
    bytes[4..8].copy_from_slice(&(36_u32 + data_bytes as u32).to_le_bytes());
    bytes[8..12].copy_from_slice(b"WAVE");
    bytes[12..16].copy_from_slice(b"fmt ");
    bytes[16..20].copy_from_slice(&16_u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&1_u16.to_le_bytes());
    bytes[22..24].copy_from_slice(&1_u16.to_le_bytes());
    bytes[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    bytes[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes[32..34].copy_from_slice(&2_u16.to_le_bytes());
    bytes[34..36].copy_from_slice(&16_u16.to_le_bytes());
    bytes[36..40].copy_from_slice(b"data");
    bytes[40..44].copy_from_slice(&(data_bytes as u32).to_le_bytes());

    for (index, sample) in samples.iter().enumerate() {
        let offset = 44 + index * 2;

        bytes[offset..offset + 2].copy_from_slice(&sample.to_le_bytes());
    }

    bytes
}

fn pcm_duration_ms(
    pcm: &[u8],
    sample_rate: u32,
    channel_count: u16,
    sample_format: PcmSampleFormat,
) -> Option<u64> {
    if sample_rate == 0 || channel_count == 0 {
        return None;
    }

    let frame_bytes = usize::from(channel_count) * sample_format.bytes_per_sample();
    let frames = pcm.len() / frame_bytes;

    Some(
        ((frames as f64 / f64::from(sample_rate)) * 1000.0)
            .round()
            .max(1.0) as u64,
    )
}

#[derive(Default)]
struct ChannelStats {
    peak: f64,
    previous_nonzero_sign: Option<i8>,
    sample_count: u64,
    sum_squares: f64,
    zero_crossings: u64,
}

impl ChannelStats {
    fn observe(&mut self, sample: f64) -> f64 {
        let signed = sample.clamp(-1.0, 1.0);
        let normalized = signed.abs();

        self.peak = self.peak.max(normalized);
        self.sample_count += 1;
        self.sum_squares += normalized * normalized;

        let sign = if signed > 0.0 {
            1
        } else if signed < 0.0 {
            -1
        } else {
            0
        };

        if sign != 0 {
            if self
                .previous_nonzero_sign
                .is_some_and(|previous| previous != sign)
            {
                self.zero_crossings += 1;
            }

            self.previous_nonzero_sign = Some(sign);
        }

        signed
    }

    fn rms(&self) -> f64 {
        if self.sample_count == 0 {
            return 0.0;
        }

        (self.sum_squares / self.sample_count as f64).sqrt()
    }

    fn zero_crossing_rate(&self) -> f32 {
        if self.sample_count < 2 {
            return 0.0;
        }

        (self.zero_crossings as f32 / (self.sample_count - 1) as f32).min(1.0)
    }

    fn audio_quality(&self, rms_dbfs: f32, peak_dbfs: f32) -> AudioQuality {
        let crest_factor_db = (peak_dbfs - rms_dbfs).max(0.0);
        let zero_crossing_rate = self.zero_crossing_rate();
        let audible_score = rising_score(rms_dbfs, -65.0, -35.0);
        let zcr_score = band_score(zero_crossing_rate, 0.015, 0.22);
        let crest_score = band_score(crest_factor_db, 4.0, 22.0);
        let speech_score = clamp_01(audible_score * (0.2 + zcr_score * 0.45 + crest_score * 0.35));
        let hum_score = hum_likelihood(audible_score, zero_crossing_rate, crest_factor_db);
        let static_score = static_likelihood(audible_score, zero_crossing_rate, crest_factor_db);
        let broadband_noise_score = broadband_noise_likelihood(
            audible_score,
            speech_score,
            zero_crossing_rate,
            crest_factor_db,
        );
        let noise_score =
            clamp_01(audible_score * (1.0 - speech_score).max(hum_score * 0.85).max(static_score));
        let estimated_snr_db = estimated_snr_db(
            audible_score,
            [speech_score, noise_score, hum_score, static_score],
            crest_factor_db,
        );
        let intelligibility_score = intelligibility_score(
            audible_score,
            [speech_score, noise_score, hum_score, static_score],
            estimated_snr_db,
            crest_factor_db,
        );

        AudioQuality {
            channel_correlation: None,
            broadband_noise_score: round_2(broadband_noise_score),
            crest_factor_db: round_2(crest_factor_db.min(80.0)),
            estimated_snr_db: round_1(estimated_snr_db),
            hum_score: round_2(hum_score),
            intelligibility_score: round_2(intelligibility_score),
            noise_score: round_2(noise_score),
            speech_like: speech_score >= 0.55,
            speech_score: round_2(speech_score),
            static_score: round_2(static_score),
            zero_crossing_rate: round_2(zero_crossing_rate),
        }
    }
}

fn round_1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

fn round_2(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

fn synthetic_quality(rms_dbfs: f32, peak_dbfs: f32, phase: f32) -> AudioQuality {
    let audible_score = rising_score(rms_dbfs, -65.0, -35.0);
    let speech_score = clamp_01(audible_score * (0.62 + phase.sin() * 0.18));
    let noise_score = clamp_01(audible_score * (1.0 - speech_score));
    let crest_factor_db = (peak_dbfs - rms_dbfs).max(0.0);
    let hum_score = clamp_01(audible_score * phase.cos().abs() * 0.12);
    let static_score = clamp_01(audible_score * phase.sin().abs() * 0.08);
    let broadband_noise_score = clamp_01(noise_score * 0.7);
    let estimated_snr_db = estimated_snr_db(
        audible_score,
        [speech_score, noise_score, hum_score, static_score],
        crest_factor_db,
    );

    AudioQuality {
        channel_correlation: None,
        broadband_noise_score: round_2(broadband_noise_score),
        crest_factor_db: round_2(crest_factor_db),
        estimated_snr_db: round_1(estimated_snr_db),
        hum_score: round_2(hum_score),
        intelligibility_score: round_2(intelligibility_score(
            audible_score,
            [speech_score, noise_score, hum_score, static_score],
            estimated_snr_db,
            crest_factor_db,
        )),
        noise_score: round_2(noise_score),
        speech_like: speech_score >= 0.55,
        speech_score: round_2(speech_score),
        static_score: round_2(static_score),
        zero_crossing_rate: round_2(0.08 + phase.cos().abs() * 0.08),
    }
}

fn hum_likelihood(audible_score: f32, zero_crossing_rate: f32, crest_factor_db: f32) -> f32 {
    let low_zcr_score = falling_score(zero_crossing_rate, 0.02, 0.08);
    let steady_tone_score = falling_score(crest_factor_db, 8.0, 18.0);

    clamp_01(audible_score * low_zcr_score * steady_tone_score)
}

fn static_likelihood(audible_score: f32, zero_crossing_rate: f32, crest_factor_db: f32) -> f32 {
    let high_zcr_score = rising_score(zero_crossing_rate, 0.35, 0.7);
    let flat_noise_score = falling_score(crest_factor_db, 10.0, 24.0);

    clamp_01(audible_score * high_zcr_score * flat_noise_score)
}

fn broadband_noise_likelihood(
    audible_score: f32,
    speech_score: f32,
    zero_crossing_rate: f32,
    crest_factor_db: f32,
) -> f32 {
    let broadband_zcr_score = band_score(zero_crossing_rate, 0.18, 0.55);
    let steady_noise_score = falling_score(crest_factor_db, 8.0, 24.0);
    let speech_penalty = falling_score(speech_score, 0.55, 0.9);

    clamp_01(audible_score * broadband_zcr_score * steady_noise_score * speech_penalty)
}

fn estimated_snr_db(audible_score: f32, scores: [f32; 4], crest_factor_db: f32) -> f32 {
    if audible_score <= 0.0 {
        return 0.0;
    }

    let [speech_score, noise_score, hum_score, static_score] = scores;
    let interference_score = noise_score.max(hum_score).max(static_score);
    let speech_margin = (speech_score - interference_score).max(0.0);
    let transient_bonus = rising_score(crest_factor_db, 6.0, 24.0) * 6.0;

    (audible_score * (speech_margin * 30.0 + transient_bonus)).clamp(0.0, 80.0)
}

fn intelligibility_score(
    audible_score: f32,
    scores: [f32; 4],
    estimated_snr_db: f32,
    crest_factor_db: f32,
) -> f32 {
    let [speech_score, noise_score, hum_score, static_score] = scores;
    let interference_score = noise_score.max(hum_score).max(static_score);
    let snr_score = rising_score(estimated_snr_db, 6.0, 24.0);
    let clarity_score = rising_score(crest_factor_db, 6.0, 18.0);

    clamp_01(
        audible_score
            * speech_score
            * (0.5 + snr_score * 0.35 + clarity_score * 0.15)
            * (1.0 - interference_score * 0.55),
    )
}

fn rising_score(value: f32, floor: f32, ceiling: f32) -> f32 {
    clamp_01((value - floor) / (ceiling - floor))
}

fn band_score(value: f32, low: f32, high: f32) -> f32 {
    if value < low {
        return clamp_01(value / low);
    }

    if value > high {
        return clamp_01(1.0 - (value - high) / high);
    }

    1.0
}

fn falling_score(value: f32, floor: f32, ceiling: f32) -> f32 {
    clamp_01(1.0 - ((value - floor) / (ceiling - floor)))
}

fn clamp_01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests;
