//! Enhanced recording rendition production.
//!
//! Pipeline: channel-map + downmix to 48 kHz mono (ffmpeg) -> in-process denoise
//! (`enhance`) -> voice-chain filters + encode (ffmpeg). Kept separate from
//! `channel_map` to keep both files within the LOC budget.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;

use crate::capture::CapturePlan;
use crate::channel_map::{channel_render_plan, output_codec_args};
use crate::controller::ControllerRecordingEnhancement;
use crate::enhance;

/// Produce the enhanced rendition next to the raw capture, or `None` when the
/// profile enables no enhancement stage. Best-effort: the caller falls back to
/// raw-only if this errors.
pub fn render_enhanced_output(
    plan: &CapturePlan,
    captured_path: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    let Some(enhancement) = plan.enhancement.as_ref() else {
        return Ok(None);
    };

    let chain = enhanced_filter_chain(enhancement);
    if !enhancement.denoise.enabled && chain.is_none() {
        return Ok(None);
    }

    let render_plan = plan.channel_map.as_ref().and_then(channel_render_plan);
    let stem = plan
        .final_output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");
    let dir = plan
        .final_output_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mono_path = dir.join(format!("{stem}.enh-mono.wav"));
    let denoised_path = dir.join(format!("{stem}.enh-denoised.wav"));
    let enhanced_path = dir.join(format!("{stem}.enhanced.{}", plan.output_codec));

    // Sweep the mono/denoised intermediates on every exit path. Previously a
    // failed denoise or Pass B returned via `?` and left them on disk; on a
    // long chunked recording with a persistent enhancement failure that leaks
    // two WAVs per chunk while the job still reports success.
    let _intermediates = IntermediateCleanup {
        paths: vec![mono_path.clone(), denoised_path.clone()],
    };

    // Pass A: apply the channel map, then downmix to 48 kHz mono PCM.
    let mut args_a: Vec<OsString> = vec![
        OsString::from("-y"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        captured_path.as_os_str().to_os_string(),
    ];
    if let Some(render_plan) = render_plan.as_ref() {
        args_a.push(OsString::from("-filter_complex"));
        args_a.push(OsString::from(&render_plan.filter));
    }
    args_a.extend([
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(enhance::ENHANCE_SAMPLE_RATE.to_string()),
        OsString::from("-c:a"),
        OsString::from("pcm_s16le"),
        mono_path.as_os_str().to_os_string(),
    ]);
    run_render_command(&plan.render_command, &args_a)?;

    // In-process denoise (or pass the mono intermediate straight through).
    let denoise_input = if enhancement.denoise.enabled {
        let engine = enhance::EnhancementEngine::parse(&enhancement.denoise.engine)
            .unwrap_or(enhance::EnhancementEngine::Deepfilternet3);
        enhance::enhance_wav_file(&mono_path, &denoised_path, engine)?;
        denoised_path.clone()
    } else {
        mono_path.clone()
    };

    // Pass B: voice-chain filters and encode to the output codec/channel layout.
    let output_channels = render_plan
        .as_ref()
        .map_or(1, |render_plan| render_plan.output_channels);
    let mut args_b: Vec<OsString> = vec![
        OsString::from("-y"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        denoise_input.as_os_str().to_os_string(),
    ];
    if let Some(chain) = chain.as_ref() {
        args_b.push(OsString::from("-af"));
        args_b.push(OsString::from(chain));
    }
    args_b.push(OsString::from("-ac"));
    args_b.push(OsString::from(output_channels.to_string()));
    args_b.extend(output_codec_args(plan));
    args_b.push(enhanced_path.as_os_str().to_os_string());
    run_render_command(&plan.render_command, &args_b)?;

    Ok(Some(enhanced_path))
}

// RAII sweep of the enhanced-render intermediates so a failed pass cannot leak
// them; runs on success and on any `?` early return.
struct IntermediateCleanup {
    paths: Vec<PathBuf>,
}

impl Drop for IntermediateCleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn run_render_command(command: &str, args: &[OsString]) -> anyhow::Result<()> {
    let output = Command::new(command)
        .args(args)
        .output()
        .with_context(|| format!("run enhancement render command {command}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "enhancement render command {command} failed with status {}: {}",
            output.status,
            stderr.trim()
        );
    }

    Ok(())
}

/// Build the post-denoise ffmpeg `-af` chain from the enabled stages (denoise runs
/// in-process and is not part of this string).
fn enhanced_filter_chain(enhancement: &ControllerRecordingEnhancement) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if enhancement.highpass.enabled {
        parts.push(format!("highpass=f={}", enhancement.highpass.hz));
    }
    if enhancement.lowpass.enabled {
        parts.push(format!("lowpass=f={}", enhancement.lowpass.hz));
    }
    if enhancement.deesser.enabled {
        parts.push(format!("deesser=i={:.2}", enhancement.deesser.intensity));
    }
    if enhancement.compressor.enabled {
        parts.push("acompressor=threshold=-18dB:ratio=3:attack=20:release=250".to_string());
    }
    if enhancement.loudnorm.enabled {
        parts.push(format!(
            "loudnorm=I={}:TP={}:LRA={}",
            enhancement.loudnorm.target_i, enhancement.loudnorm.true_peak, enhancement.loudnorm.lra
        ));
    }
    if enhancement.gate.enabled {
        let linear = 10f32.powf(enhancement.gate.threshold_db / 20.0);
        parts.push(format!("agate=threshold={linear:.5}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg_attr(miri, ignore)] // touches the real filesystem
    fn intermediate_cleanup_removes_files_on_drop() {
        let dir = std::env::temp_dir().join(format!("rakkr-enh-cleanup-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mono = dir.join("clip.enh-mono.wav");
        let denoised = dir.join("clip.enh-denoised.wav");
        fs::write(&mono, b"pcm").unwrap();
        fs::write(&denoised, b"pcm").unwrap();

        {
            let _cleanup = IntermediateCleanup {
                paths: vec![mono.clone(), denoised.clone()],
            };
            // Scope end drops the guard even on an error path — the render
            // intermediates must be swept regardless of pass success.
        }

        assert!(!mono.exists(), "mono intermediate must be removed on drop");
        assert!(
            !denoised.exists(),
            "denoised intermediate must be removed on drop"
        );

        let _ = fs::remove_dir(&dir);
    }
}
