use std::process::Command;

use anyhow::Context;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterFrame {
    pub captured_at: String,
    pub interface_id: String,
    pub levels: Vec<AudioLevel>,
    pub node_id: String,
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
    pub crest_factor_db: f32,
    pub hum_score: f32,
    pub noise_score: f32,
    pub speech_like: bool,
    pub speech_score: f32,
    pub static_score: f32,
    pub zero_crossing_rate: f32,
}

pub struct MeterCaptureConfig<'a> {
    pub channel_count: u16,
    pub clip_dbfs: f32,
    pub command: &'a str,
    pub device: &'a str,
    pub format: &'a str,
    pub sample_rate: u32,
    pub sample_seconds: u64,
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
    if !config.format.eq_ignore_ascii_case("S16_LE") {
        anyhow::bail!(
            "meter sampling currently supports S16_LE PCM, not {}",
            config.format
        );
    }

    let output = Command::new(config.command)
        .arg("-D")
        .arg(config.device)
        .arg("-f")
        .arg(config.format)
        .arg("-r")
        .arg(config.sample_rate.to_string())
        .arg("-c")
        .arg(config.channel_count.to_string())
        .arg("-d")
        .arg(config.sample_seconds.max(1).to_string())
        .arg("-t")
        .arg("raw")
        .arg("-q")
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

    pcm_s16le_meter_frame(
        node_id,
        interface_id,
        &output.stdout,
        config.channel_count,
        config.clip_dbfs,
    )
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

    let mut stats = (0..channel_count)
        .map(|_| ChannelStats::default())
        .collect::<Vec<_>>();

    for (sample_index, sample) in pcm.chunks_exact(2).enumerate() {
        let channel_index = sample_index % usize::from(channel_count);
        let sample = i16::from_le_bytes([sample[0], sample[1]]);
        stats[channel_index].observe(sample);
    }

    let levels = stats
        .iter()
        .enumerate()
        .map(|(index, stats)| {
            let rms_dbfs = amplitude_to_dbfs(stats.rms());
            let peak_dbfs = amplitude_to_dbfs(stats.peak);
            let quality = stats.audio_quality(rms_dbfs, peak_dbfs);

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

#[derive(Default)]
struct ChannelStats {
    peak: f64,
    previous_nonzero_sign: Option<i8>,
    sample_count: u64,
    sum_squares: f64,
    zero_crossings: u64,
}

impl ChannelStats {
    fn observe(&mut self, sample: i16) {
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

        AudioQuality {
            crest_factor_db: round_2(crest_factor_db.min(80.0)),
            hum_score: round_2(hum_score),
            noise_score: round_2(noise_score),
            speech_like: speech_score >= 0.55,
            speech_score: round_2(speech_score),
            static_score: round_2(static_score),
            zero_crossing_rate: round_2(zero_crossing_rate),
        }
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

    AudioQuality {
        crest_factor_db: round_2((peak_dbfs - rms_dbfs).max(0.0)),
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
}
