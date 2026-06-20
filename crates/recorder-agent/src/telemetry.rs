use std::process::Command;

use anyhow::Context;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::meter_command::{MeterCaptureConfig, meter_command_args};

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
    pub crest_factor_db: f32,
    pub estimated_snr_db: f32,
    pub hum_score: f32,
    pub noise_score: f32,
    pub speech_like: bool,
    pub speech_score: f32,
    pub static_score: f32,
    pub zero_crossing_rate: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCorrelation {
    pub peer_channel_index: u16,
    pub phase: &'static str,
    pub score: f32,
}

const MONITOR_CHUNK_SAMPLE_RATE: u32 = 16_000;

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
    Ok(alsa_meter_sample(node_id, interface_id, config)?.frame)
}

pub fn alsa_meter_sample(
    node_id: &str,
    interface_id: &str,
    config: &MeterCaptureConfig<'_>,
) -> anyhow::Result<MeterSample> {
    if !config.format.eq_ignore_ascii_case("S16_LE") {
        anyhow::bail!(
            "meter sampling currently supports S16_LE PCM, not {}",
            config.format
        );
    }

    let args = meter_command_args(config)?;
    let output = Command::new(config.command)
        .args(&args)
        .output()
        .with_context(|| format!("run {} for ALSA meter sampling", config.command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "ALSA meter command exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }

    meter_sample_from_pcm(node_id, interface_id, &output.stdout, config)
}

pub fn pcm_s16le_meter_frame(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    channel_count: u16,
    clip_dbfs: f32,
) -> anyhow::Result<MeterFrame> {
    let captured_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("format captured timestamp")?;

    pcm_s16le_meter_frame_at(
        node_id,
        interface_id,
        pcm,
        channel_count,
        clip_dbfs,
        &captured_at,
    )
}

fn meter_sample_from_pcm(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    config: &MeterCaptureConfig<'_>,
) -> anyhow::Result<MeterSample> {
    let frame = pcm_s16le_meter_frame(
        node_id,
        interface_id,
        pcm,
        config.channel_count,
        config.clip_dbfs,
    )?;
    let monitor_duration_ms = pcm_duration_ms(pcm, config.sample_rate, config.channel_count)
        .unwrap_or_else(|| config.sample_seconds.max(1).saturating_mul(1000));
    let monitor_wav = pcm_s16le_monitor_wav(
        pcm,
        config.sample_rate,
        config.channel_count,
        MONITOR_CHUNK_SAMPLE_RATE,
    )?;

    Ok(MeterSample {
        frame,
        monitor_duration_ms,
        monitor_wav,
    })
}

fn pcm_s16le_meter_frame_at(
    node_id: &str,
    interface_id: &str,
    pcm: &[u8],
    channel_count: u16,
    clip_dbfs: f32,
    captured_at: &str,
) -> anyhow::Result<MeterFrame> {
    if channel_count == 0 {
        anyhow::bail!("meter frame requires at least one channel");
    }

    if pcm.len() < usize::from(channel_count) * 2 {
        anyhow::bail!("meter PCM payload does not contain a complete frame");
    }

    if !pcm.len().is_multiple_of(2) {
        anyhow::bail!("meter PCM payload has an incomplete sample");
    }

    let channel_count = usize::from(channel_count);
    let frame_bytes = channel_count * 2;

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
            let offset = channel_index * 2;
            let sample = i16::from_le_bytes([frame[offset], frame[offset + 1]]);
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
    })
}

fn pcm_s16le_monitor_wav(
    pcm: &[u8],
    source_sample_rate: u32,
    channel_count: u16,
    target_sample_rate: u32,
) -> anyhow::Result<Vec<u8>> {
    if source_sample_rate == 0 || target_sample_rate == 0 || channel_count == 0 {
        anyhow::bail!("monitor WAV requires non-zero sample rates and channels");
    }

    let channel_count = usize::from(channel_count);
    let frame_bytes = channel_count * 2;

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
                let offset = channel * 2;
                i32::from(i16::from_le_bytes([frame[offset], frame[offset + 1]]))
            })
            .sum::<i32>()
            / i32::try_from(channel_count).unwrap_or(1);

        samples.push(mixed.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16);
    }

    Ok(wav_mono_s16le(&samples, target_sample_rate))
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

fn pcm_duration_ms(pcm: &[u8], sample_rate: u32, channel_count: u16) -> Option<u64> {
    if sample_rate == 0 || channel_count == 0 {
        return None;
    }

    let frame_bytes = usize::from(channel_count) * 2;
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
    fn observe(&mut self, sample: i16) -> f64 {
        let signed = f64::from(sample) / 32768.0;
        let normalized = signed.abs();

        self.peak = self.peak.max(normalized);
        self.sample_count += 1;
        self.sum_squares += normalized * normalized;

        let sign = if sample > 0 {
            1
        } else if sample < 0 {
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
        let noise_score =
            clamp_01(audible_score * (1.0 - speech_score).max(hum_score * 0.85).max(static_score));
        let estimated_snr_db = estimated_snr_db(
            audible_score,
            [speech_score, noise_score, hum_score, static_score],
            crest_factor_db,
        );

        AudioQuality {
            channel_correlation: None,
            crest_factor_db: round_2(crest_factor_db.min(80.0)),
            estimated_snr_db: round_1(estimated_snr_db),
            hum_score: round_2(hum_score),
            noise_score: round_2(noise_score),
            speech_like: speech_score >= 0.55,
            speech_score: round_2(speech_score),
            static_score: round_2(static_score),
            zero_crossing_rate: round_2(zero_crossing_rate),
        }
    }
}

#[derive(Default)]
struct ChannelPairStats {
    left: usize,
    right: usize,
    sample_count: u64,
    sum_left: f64,
    sum_right: f64,
    sum_left_squares: f64,
    sum_right_squares: f64,
    sum_products: f64,
}

impl ChannelPairStats {
    fn observe(&mut self, left: f64, right: f64) {
        self.sample_count += 1;
        self.sum_left += left;
        self.sum_right += right;
        self.sum_left_squares += left * left;
        self.sum_right_squares += right * right;
        self.sum_products += left * right;
    }

    fn correlation(&self) -> Option<f32> {
        if self.sample_count < 8 {
            return None;
        }

        let sample_count = self.sample_count as f64;
        let covariance = sample_count * self.sum_products - self.sum_left * self.sum_right;
        let left_variance = sample_count * self.sum_left_squares - self.sum_left * self.sum_left;
        let right_variance =
            sample_count * self.sum_right_squares - self.sum_right * self.sum_right;

        if left_variance <= f64::EPSILON || right_variance <= f64::EPSILON {
            return None;
        }

        Some((covariance / (left_variance.sqrt() * right_variance.sqrt())).clamp(-1.0, 1.0) as f32)
    }
}

fn channel_pairs(channel_count: usize) -> Vec<ChannelPairStats> {
    let mut pairs = Vec::new();

    for left in 0..channel_count {
        for right in (left + 1)..channel_count {
            pairs.push(ChannelPairStats {
                left,
                right,
                ..ChannelPairStats::default()
            });
        }
    }

    pairs
}

fn strongest_channel_correlations(
    pairs: &[ChannelPairStats],
    rms_dbfs: &[f32],
) -> Vec<Option<ChannelCorrelation>> {
    const AUDIBLE_DBFS: f32 = -65.0;
    const DISPLAY_MIN_ABS_SCORE: f32 = 0.80;

    let mut strongest = vec![None; rms_dbfs.len()];

    for pair in pairs {
        if rms_dbfs[pair.left] <= AUDIBLE_DBFS || rms_dbfs[pair.right] <= AUDIBLE_DBFS {
            continue;
        }

        let Some(score) = pair.correlation() else {
            continue;
        };

        if score.abs() < DISPLAY_MIN_ABS_SCORE {
            continue;
        }

        remember_correlation(&mut strongest, pair.left, pair.right, score);
        remember_correlation(&mut strongest, pair.right, pair.left, score);
    }

    strongest
}

fn remember_correlation(
    strongest: &mut [Option<ChannelCorrelation>],
    channel_index: usize,
    peer_index: usize,
    score: f32,
) {
    let should_replace = strongest[channel_index]
        .as_ref()
        .is_none_or(|current| score.abs() > current.score.abs());

    if should_replace {
        strongest[channel_index] = Some(ChannelCorrelation {
            peer_channel_index: u16::try_from(peer_index + 1).unwrap_or(u16::MAX),
            phase: if score < 0.0 { "inverted" } else { "same" },
            score: round_2(score),
        });
    }
}

fn amplitude_to_dbfs(value: f64) -> f32 {
    if value <= 0.0 {
        return -160.0;
    }

    (20.0 * value.log10()).max(-160.0) as f32
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

    AudioQuality {
        channel_correlation: None,
        crest_factor_db: round_2(crest_factor_db),
        estimated_snr_db: round_1(estimated_snr_db(
            audible_score,
            [speech_score, noise_score, 0.0, 0.0],
            crest_factor_db,
        )),
        hum_score: round_2(clamp_01(audible_score * phase.cos().abs() * 0.12)),
        noise_score: round_2(noise_score),
        speech_like: speech_score >= 0.55,
        speech_score: round_2(speech_score),
        static_score: round_2(clamp_01(audible_score * phase.sin().abs() * 0.08)),
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
mod tests {
    use super::*;

    #[test]
    fn computes_s16le_meter_levels_per_channel() {
        let pcm = [0_i16, i16::MAX, 16384_i16, -16384_i16, -32768_i16, 0_i16]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();

        let frame =
            pcm_s16le_meter_frame_at("node_1", "iface_1", &pcm, 2, -1.0, "2026-06-18T00:00:00Z")
                .expect("meter frame");

        assert_eq!(frame.levels.len(), 2);
        assert_eq!(frame.levels[0].channel_index, 1);
        assert!(frame.levels[0].clipping);
        assert!(frame.levels[0].peak_dbfs >= -0.1);
        assert!(frame.levels[1].rms_dbfs < frame.levels[1].peak_dbfs);
    }

    #[test]
    fn builds_mono_monitor_wav_from_interleaved_pcm() {
        let pcm = [1000_i16, -1000_i16, 3000_i16, -3000_i16]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();
        let wav = pcm_s16le_monitor_wav(&pcm, 2, 2, 2).expect("monitor wav");

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 2);
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 4);
    }

    #[test]
    fn rejects_empty_channel_count() {
        let error = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &[0, 0],
            0,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect_err("channel count should fail");

        assert!(error.to_string().contains("at least one channel"));
    }

    #[test]
    fn computes_silence_as_floor_dbfs() {
        let frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &[0, 0, 0, 0],
            2,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("silence");

        assert_eq!(frame.levels[0].rms_dbfs, -160.0);
        assert_eq!(frame.levels[1].peak_dbfs, -160.0);
        assert_eq!(frame.levels[0].quality.speech_score, 0.0);
        assert_eq!(frame.levels[0].quality.noise_score, 0.0);
        assert_eq!(frame.levels[0].quality.hum_score, 0.0);
        assert_eq!(frame.levels[0].quality.static_score, 0.0);
        assert_eq!(frame.levels[0].quality.estimated_snr_db, 0.0);
        assert!(!frame.levels[0].clipping);
    }

    #[test]
    fn estimates_speech_like_quality_from_pcm_shape() {
        let pcm = (0..480)
            .map(|index| {
                let envelope = if index % 29 < 14 { 0.9 } else { 0.35 };
                let sign = if index % 17 < 8 { 1.0 } else { -1.0 };
                (sign * envelope * 10_000.0) as i16
            })
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();

        let frame =
            pcm_s16le_meter_frame_at("node_1", "iface_1", &pcm, 1, -1.0, "2026-06-18T00:00:00Z")
                .expect("speech-like frame");

        assert!(frame.levels[0].quality.speech_score > frame.levels[0].quality.noise_score);
        assert!(frame.levels[0].quality.speech_like);
    }

    #[test]
    fn estimates_hum_and_static_likelihood_from_pcm_shape() {
        let hum_pcm = (0..960)
            .map(|index| {
                let phase = index as f32 / 80.0 * std::f32::consts::TAU;

                (phase.sin() * 12_000.0) as i16
            })
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();
        let static_pcm = (0..960)
            .map(|index| {
                if index % 2 == 0 {
                    10_000_i16
                } else {
                    -10_000_i16
                }
            })
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();
        let hum_frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &hum_pcm,
            1,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("hum-like frame");
        let static_frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &static_pcm,
            1,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("static-like frame");

        assert!(hum_frame.levels[0].quality.hum_score > 0.4);
        assert!(hum_frame.levels[0].quality.hum_score > hum_frame.levels[0].quality.static_score);
        assert!(static_frame.levels[0].quality.static_score > 0.8);
        assert!(
            static_frame.levels[0].quality.static_score > static_frame.levels[0].quality.hum_score
        );
    }

    #[test]
    fn calibrates_voice_hum_static_and_silence_fixtures() {
        let voice_frame = fixture_frame(&voice_like_pcm(4_800), 1);
        let hum_frame = fixture_frame(&hum_pcm(4_800), 1);
        let static_frame = fixture_frame(&static_pcm(4_800), 1);
        let silence_frame = fixture_frame(&silence_pcm(4_800), 1);
        let voice = &voice_frame.levels[0].quality;
        let hum = &hum_frame.levels[0].quality;
        let static_noise = &static_frame.levels[0].quality;
        let silence = &silence_frame.levels[0].quality;

        assert!(voice.speech_like);
        assert!(voice.speech_score >= 0.65);
        assert!(voice.speech_score > voice.noise_score);
        assert!(voice.hum_score < 0.35);
        assert!(voice.static_score < 0.35);
        assert!(voice.estimated_snr_db >= 12.0);
        assert!(!hum.speech_like);
        assert!(hum.hum_score >= 0.65);
        assert!(hum.hum_score > hum.speech_score);
        assert!(hum.hum_score > hum.static_score);
        assert!(voice.estimated_snr_db > hum.estimated_snr_db);
        assert!(!static_noise.speech_like);
        assert!(static_noise.static_score >= 0.85);
        assert!(static_noise.static_score > static_noise.speech_score);
        assert_eq!(silence.speech_score, 0.0);
    }

    #[test]
    fn calibration_fixtures_keep_independent_channels_uncorrelated() {
        let frame = fixture_frame(&independent_stereo_pcm(4_800), 2);

        assert!(frame.levels[0].quality.channel_correlation.is_none());
        assert!(frame.levels[1].quality.channel_correlation.is_none());
    }

    #[test]
    fn estimates_same_phase_and_inverted_channel_correlation() {
        let same_phase_pcm = correlated_pcm(false);
        let inverted_phase_pcm = correlated_pcm(true);
        let same_phase_frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &same_phase_pcm,
            2,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("same-phase frame");
        let inverted_phase_frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &inverted_phase_pcm,
            2,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("inverted-phase frame");
        let same_phase = same_phase_frame.levels[0]
            .quality
            .channel_correlation
            .as_ref()
            .expect("same phase correlation");
        let inverted_phase = inverted_phase_frame.levels[0]
            .quality
            .channel_correlation
            .as_ref()
            .expect("inverted phase correlation");

        assert_eq!(same_phase.peer_channel_index, 2);
        assert_eq!(same_phase.phase, "same");
        assert!(same_phase.score > 0.98);
        assert_eq!(inverted_phase.peer_channel_index, 2);
        assert_eq!(inverted_phase.phase, "inverted");
        assert!(inverted_phase.score < -0.98);
    }

    #[test]
    fn ignores_silent_channel_correlation() {
        let frame = pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            2,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("silent frame");

        assert!(frame.levels[0].quality.channel_correlation.is_none());
        assert!(frame.levels[1].quality.channel_correlation.is_none());
    }

    fn correlated_pcm(inverted: bool) -> Vec<u8> {
        (0..128)
            .flat_map(|index| {
                let sample =
                    (((index as f32 / 11.0).sin() * 16_000.0) as i16).clamp(-16_000, 16_000);
                let peer = if inverted { -sample } else { sample };

                [sample, peer].into_iter().flat_map(i16::to_le_bytes)
            })
            .collect()
    }

    fn fixture_frame(pcm: &[u8], channel_count: u16) -> MeterFrame {
        pcm_s16le_meter_frame_at(
            "node_1",
            "iface_1",
            pcm,
            channel_count,
            -1.0,
            "2026-06-18T00:00:00Z",
        )
        .expect("fixture frame")
    }

    fn voice_like_pcm(samples: usize) -> Vec<u8> {
        mono_pcm(samples, |index| {
            let time = index as f32 / 48_000.0;
            let phrase_envelope = if index % 43 < 25 { 0.95 } else { 0.28 };
            let syllable_envelope = 0.55 + 0.45 * (time * 5.0 * std::f32::consts::TAU).sin().abs();
            let voiced_sign = if index % 10 < 5 { 1.0 } else { -1.0 };
            let formant_motion = 0.72
                + (time * 730.0 * std::f32::consts::TAU).sin() * 0.18
                + (time * 1_800.0 * std::f32::consts::TAU).sin() * 0.1;

            voiced_sign * formant_motion * phrase_envelope * syllable_envelope * 11_000.0
        })
    }

    fn hum_pcm(samples: usize) -> Vec<u8> {
        mono_pcm(samples, |index| {
            let time = index as f32 / 48_000.0;

            (time * 60.0 * std::f32::consts::TAU).sin() * 12_000.0
        })
    }

    fn static_pcm(samples: usize) -> Vec<u8> {
        mono_pcm(
            samples,
            |index| {
                if index % 2 == 0 { 10_000.0 } else { -10_000.0 }
            },
        )
    }

    fn silence_pcm(samples: usize) -> Vec<u8> {
        mono_pcm(samples, |_| 0.0)
    }

    fn independent_stereo_pcm(samples: usize) -> Vec<u8> {
        (0..samples)
            .flat_map(|index| {
                let time = index as f32 / 48_000.0;
                let left = (time * 230.0 * std::f32::consts::TAU).sin() * 11_000.0;
                let right = (time * 1_370.0 * std::f32::consts::TAU + 0.7).sin() * 9_000.0;

                [to_i16(left), to_i16(right)]
                    .into_iter()
                    .flat_map(i16::to_le_bytes)
            })
            .collect()
    }

    fn mono_pcm(samples: usize, sample: impl Fn(usize) -> f32) -> Vec<u8> {
        (0..samples)
            .map(|index| to_i16(sample(index)))
            .flat_map(i16::to_le_bytes)
            .collect()
    }

    fn to_i16(sample: f32) -> i16 {
        sample.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
    }
}
