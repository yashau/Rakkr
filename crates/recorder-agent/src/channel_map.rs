use serde_json::json;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;

use crate::capture::{
    CaptureChannelMap, CaptureChannelMapEntry, CapturePlan, local_capture_path, safe_file_name,
};
use crate::config::AgentConfig;
use crate::controller::{
    ControllerCaptureCommand, ControllerChannelMapBundle, ControllerRecordingJob,
    ControllerRecordingJobChannelMap,
};

pub fn capture_plan_for_job(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    channel_maps: &[ControllerChannelMapBundle],
) -> CapturePlan {
    let channel_map = capture_channel_map_for_job(&config.node_id, &job.command, channel_maps);
    let channels = channel_map
        .as_ref()
        .map_or(job.command.capture_channels, |map| map.source_channels);
    let output_codec = output_codec(&job.command);
    let backend = job
        .command
        .capture_backend
        .unwrap_or(config.capture_backend);
    let final_output_path = local_capture_path(&job.command.output_file_name);
    let output_path = if output_codec == "wav" && channel_map.is_none() {
        final_output_path.clone()
    } else {
        local_capture_path(&raw_capture_file_name(&job.command.output_file_name))
    };

    CapturePlan {
        args_template: config.capture_args_template.clone(),
        backend,
        channel_map,
        channels,
        command: config.effective_capture_command(backend).to_string(),
        device: job.command.capture_device.clone(),
        final_output_path,
        format: job.command.capture_format.clone(),
        growth_grace_seconds: config.capture_growth_grace_seconds,
        min_output_bytes: config.capture_min_output_bytes,
        output_bitrate_kbps: job.command.output_bitrate_kbps,
        output_codec,
        output_path,
        output_vbr: job.command.output_vbr.unwrap_or(false),
        render_command: config.channel_render_command.clone(),
        sample_rate: job.command.capture_sample_rate,
        seconds: job.command.duration_seconds,
        stalled_seconds: config.capture_stalled_seconds,
    }
}

pub fn render_capture_output(plan: &CapturePlan, captured_path: &Path) -> anyhow::Result<PathBuf> {
    let render_plan = plan.channel_map.as_ref().and_then(channel_render_plan);

    if render_plan.is_none()
        && plan.output_codec == "wav"
        && captured_path == plan.final_output_path
    {
        return Ok(captured_path.to_path_buf());
    };

    let output = Command::new(&plan.render_command)
        .args(render_command_args(
            plan,
            captured_path,
            render_plan.as_ref(),
        ))
        .output()
        .with_context(|| format!("run recording render command {}", plan.render_command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);

        anyhow::bail!(
            "recording render command {} failed with status {}: {}",
            plan.render_command,
            output.status,
            stderr.trim()
        );
    }

    let metadata = fs::metadata(&plan.final_output_path).with_context(|| {
        format!(
            "inspect rendered recording output {}",
            plan.final_output_path.display()
        )
    })?;

    if metadata.len() == 0 {
        anyhow::bail!(
            "rendered recording output is empty: {}",
            plan.final_output_path.display()
        );
    }

    Ok(plan.final_output_path.clone())
}

pub fn channel_map_details(channel_map: &CaptureChannelMap) -> serde_json::Value {
    json!({
        "assignmentId": channel_map.assignment_id.as_str(),
        "captureChannels": channel_map.source_channels,
        "channelMode": channel_map.channel_mode.as_str(),
        "entryCount": channel_map.entries.len(),
        "targetId": channel_map.target_id.as_str(),
        "targetType": channel_map.target_type.as_str(),
        "templateId": channel_map.template_id.as_str(),
        "templateName": channel_map.template_name.as_str(),
    })
}

fn capture_channel_map_for_job(
    node_id: &str,
    command: &ControllerCaptureCommand,
    channel_maps: &[ControllerChannelMapBundle],
) -> Option<CaptureChannelMap> {
    command
        .channel_map
        .as_ref()
        .map(pinned_channel_map)
        .or_else(|| {
            select_capture_channel_map(
                node_id,
                command.capture_interface_id.as_deref(),
                &command.capture_device,
                channel_maps,
            )
        })
}

fn pinned_channel_map(channel_map: &ControllerRecordingJobChannelMap) -> CaptureChannelMap {
    CaptureChannelMap {
        assignment_id: channel_map.assignment_id.clone(),
        channel_mode: channel_map.channel_mode.clone(),
        entries: channel_map.entries.iter().map(controller_entry).collect(),
        source_channels: channel_map.source_channels,
        target_id: channel_map.target_id.clone(),
        target_type: channel_map.target_type.clone(),
        template_id: channel_map.template_id.clone(),
        template_name: channel_map.template_name.clone(),
    }
}

fn select_capture_channel_map(
    node_id: &str,
    capture_interface_id: Option<&str>,
    capture_device: &str,
    channel_maps: &[ControllerChannelMapBundle],
) -> Option<CaptureChannelMap> {
    channel_maps
        .iter()
        .find_map(|bundle| {
            if bundle.assignment.target_type == "interface"
                && (Some(bundle.assignment.target_id.as_str()) == capture_interface_id
                    || bundle.assignment.target_id == capture_device)
            {
                capture_channel_map_from_bundle(bundle)
            } else {
                None
            }
        })
        .or_else(|| {
            channel_maps.iter().find_map(|bundle| {
                if bundle.assignment.target_type == "node" && bundle.assignment.target_id == node_id
                {
                    capture_channel_map_from_bundle(bundle)
                } else {
                    None
                }
            })
        })
}

fn capture_channel_map_from_bundle(
    bundle: &ControllerChannelMapBundle,
) -> Option<CaptureChannelMap> {
    let source_channels = bundle
        .template
        .entries
        .iter()
        .filter(|entry| entry.included)
        .map(|entry| entry.source_channel_index)
        .max()?;

    Some(CaptureChannelMap {
        assignment_id: bundle.assignment.id.clone(),
        channel_mode: bundle.template.channel_mode.clone(),
        entries: bundle
            .template
            .entries
            .iter()
            .map(controller_entry)
            .collect(),
        source_channels,
        target_id: bundle.assignment.target_id.clone(),
        target_type: bundle.assignment.target_type.clone(),
        template_id: bundle.template.id.clone(),
        template_name: bundle.template.name.clone(),
    })
}

#[derive(Debug, Eq, PartialEq)]
struct ChannelRenderPlan {
    filter: String,
    output_channels: u16,
}

fn channel_render_plan(channel_map: &CaptureChannelMap) -> Option<ChannelRenderPlan> {
    let entries = included_entries(channel_map);

    if entries.is_empty() {
        return None;
    }

    match channel_map.channel_mode.as_str() {
        "mono" => Some(ChannelRenderPlan {
            filter: format!("pan=mono|c0={}", mix_expression(&entries)),
            output_channels: 1,
        }),
        "stereo" => stereo_render_plan(&entries),
        "mono_to_stereo_mix" => {
            let mix = mix_expression(&entries);

            Some(ChannelRenderPlan {
                filter: format!("pan=stereo|c0={mix}|c1={mix}"),
                output_channels: 2,
            })
        }
        "multichannel" => multichannel_render_plan(&entries),
        _ => multichannel_render_plan(&entries),
    }
}

fn stereo_render_plan(entries: &[&CaptureChannelMapEntry]) -> Option<ChannelRenderPlan> {
    let left = entry_for_output(entries, 1)?;
    let right = entry_for_output(entries, 2).unwrap_or(left);

    Some(ChannelRenderPlan {
        filter: format!(
            "pan=stereo|c0={}|c1={}",
            source_channel(left),
            source_channel(right)
        ),
        output_channels: 2,
    })
}

fn multichannel_render_plan(entries: &[&CaptureChannelMapEntry]) -> Option<ChannelRenderPlan> {
    let output_channels = entries
        .iter()
        .filter_map(|entry| entry.output_channel_index)
        .max()
        .unwrap_or(entries.len() as u16);

    if output_channels == 0 {
        return None;
    }

    let mut assignments = Vec::new();

    for output_channel in 1..=output_channels {
        let Some(entry) = entry_for_output(entries, output_channel) else {
            continue;
        };

        assignments.push(format!("c{}={}", output_channel - 1, source_channel(entry)));
    }

    if assignments.is_empty() {
        return None;
    }

    Some(ChannelRenderPlan {
        filter: format!("pan={}c|{}", output_channels, assignments.join("|")),
        output_channels,
    })
}

fn entry_for_output<'a>(
    entries: &'a [&'a CaptureChannelMapEntry],
    output_channel: u16,
) -> Option<&'a CaptureChannelMapEntry> {
    entries
        .iter()
        .copied()
        .find(|entry| entry.output_channel_index == Some(output_channel))
        .or_else(|| entries.get((output_channel - 1) as usize).copied())
}

fn included_entries(channel_map: &CaptureChannelMap) -> Vec<&CaptureChannelMapEntry> {
    let mut entries = channel_map
        .entries
        .iter()
        .filter(|entry| entry.included)
        .collect::<Vec<_>>();

    entries.sort_by_key(|entry| {
        entry
            .output_channel_index
            .unwrap_or(entry.source_channel_index)
    });
    entries
}

fn mix_expression(entries: &[&CaptureChannelMapEntry]) -> String {
    if entries.len() == 1 {
        return source_channel(entries[0]);
    }

    let gain = 1.0 / entries.len() as f32;

    entries
        .iter()
        .map(|entry| format!("{gain:.6}*{}", source_channel(entry)))
        .collect::<Vec<_>>()
        .join("+")
}

fn source_channel(entry: &CaptureChannelMapEntry) -> String {
    format!("c{}", entry.source_channel_index.saturating_sub(1))
}

fn controller_entry(
    entry: &crate::controller::ControllerChannelMapEntry,
) -> CaptureChannelMapEntry {
    CaptureChannelMapEntry {
        included: entry.included,
        label: entry.label.clone(),
        output_channel_index: entry.output_channel_index,
        source_channel_index: entry.source_channel_index,
    }
}

fn output_codec(command: &ControllerCaptureCommand) -> String {
    command
        .output_codec
        .as_deref()
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "flac" | "mp3" | "wav"))
        .or_else(|| {
            Path::new(&command.output_file_name)
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
        })
        .filter(|value| matches!(value.as_str(), "flac" | "mp3" | "wav"))
        .unwrap_or_else(|| "wav".to_string())
}

fn raw_capture_file_name(output_file_name: &str) -> String {
    let safe_name = safe_file_name(output_file_name);
    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");

    format!("{stem}.raw.wav")
}

fn render_command_args(
    plan: &CapturePlan,
    captured_path: &Path,
    render_plan: Option<&ChannelRenderPlan>,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-y"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        captured_path.as_os_str().to_os_string(),
    ];

    if let Some(render_plan) = render_plan {
        args.push(OsString::from("-filter_complex"));
        args.push(OsString::from(&render_plan.filter));
        args.push(OsString::from("-ac"));
        args.push(OsString::from(render_plan.output_channels.to_string()));
    }

    args.extend(output_codec_args(plan));
    args.push(plan.final_output_path.as_os_str().to_os_string());
    args
}

fn output_codec_args(plan: &CapturePlan) -> Vec<OsString> {
    match plan.output_codec.as_str() {
        "flac" => os_args(["-codec:a", "flac"]),
        "mp3" if plan.output_vbr => {
            let quality = mp3_vbr_quality(plan.output_bitrate_kbps.unwrap_or(128));

            vec![
                OsString::from("-codec:a"),
                OsString::from("libmp3lame"),
                OsString::from("-q:a"),
                OsString::from(quality.to_string()),
            ]
        }
        "mp3" => vec![
            OsString::from("-codec:a"),
            OsString::from("libmp3lame"),
            OsString::from("-b:a"),
            OsString::from(format!("{}k", plan.output_bitrate_kbps.unwrap_or(128))),
        ],
        _ => os_args(["-codec:a", "pcm_s16le"]),
    }
}

fn os_args<const N: usize>(values: [&str; N]) -> Vec<OsString> {
    values.into_iter().map(OsString::from).collect()
}

fn mp3_vbr_quality(bitrate_kbps: u32) -> u8 {
    match bitrate_kbps {
        245.. => 0,
        225..=244 => 1,
        190..=224 => 2,
        175..=189 => 3,
        165..=174 => 4,
        128..=164 => 5,
        112..=127 => 6,
        96..=111 => 7,
        80..=95 => 8,
        _ => 9,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CaptureBackend;
    use crate::controller::{
        ControllerChannelMapAssignment, ControllerChannelMapEntry, ControllerChannelMapTemplate,
    };

    #[test]
    fn pinned_job_channel_map_wins_over_live_assignments() {
        let selected = capture_channel_map_for_job(
            "node_1",
            &command_with_pinned_channel_map(),
            &[channel_map_bundle(
                "live_assignment",
                "node",
                "node_1",
                "live_template",
                &[8],
            )],
        )
        .expect("selected channel map");

        assert_eq!(selected.assignment_id, "pinned_assignment");
        assert_eq!(selected.source_channels, 3);
        assert_eq!(selected.template_id, "pinned_template");
    }

    #[test]
    fn selects_interface_channel_map_before_node_channel_map() {
        let selected = select_capture_channel_map(
            "node_1",
            Some("interface_1"),
            "hw:1,0",
            &[
                channel_map_bundle("node_assignment", "node", "node_1", "node_template", &[4]),
                channel_map_bundle(
                    "interface_assignment",
                    "interface",
                    "interface_1",
                    "interface_template",
                    &[2],
                ),
            ],
        )
        .expect("selected channel map");

        assert_eq!(selected.assignment_id, "interface_assignment");
        assert_eq!(selected.source_channels, 2);
    }

    #[test]
    fn node_channel_map_uses_highest_included_source_channel() {
        let selected = select_capture_channel_map(
            "node_1",
            None,
            "default",
            &[channel_map_bundle(
                "node_assignment",
                "node",
                "node_1",
                "node_template",
                &[1, 8],
            )],
        )
        .expect("selected channel map");

        assert_eq!(selected.source_channels, 8);
        assert_eq!(selected.template_id, "node_template");
    }

    #[test]
    fn ignores_channel_map_without_included_entries() {
        assert!(
            select_capture_channel_map(
                "node_1",
                None,
                "default",
                &[channel_map_bundle(
                    "node_assignment",
                    "node",
                    "node_1",
                    "node_template",
                    &[],
                )],
            )
            .is_none()
        );
    }

    fn command_with_pinned_channel_map() -> ControllerCaptureCommand {
        ControllerCaptureCommand {
            capture_backend: None,
            capture_channels: 2,
            capture_device: "default".to_string(),
            capture_format: "S16_LE".to_string(),
            capture_interface_id: Some("interface_1".to_string()),
            capture_sample_rate: 48_000,
            channel_map: Some(ControllerRecordingJobChannelMap {
                assignment_id: "pinned_assignment".to_string(),
                channel_mode: "mono_to_stereo_mix".to_string(),
                entries: channel_map_entries(&[3]),
                source_channels: 3,
                target_id: "interface_1".to_string(),
                target_type: "interface".to_string(),
                template_id: "pinned_template".to_string(),
                template_name: "Pinned Template".to_string(),
            }),
            duration_seconds: 60,
            output_bitrate_kbps: Some(128),
            output_codec: Some("mp3".to_string()),
            output_file_name: "rec.wav".to_string(),
            output_vbr: Some(true),
            recorder_cache_retention: None,
            track_group_id: None,
            track_index: None,
            track_total: None,
        }
    }

    #[test]
    fn builds_mono_to_stereo_mix_pan_filter() {
        let channel_map = capture_channel_map("mono_to_stereo_mix", &[1, 3]);
        let plan = channel_render_plan(&channel_map).expect("render plan");

        assert_eq!(
            plan.filter,
            "pan=stereo|c0=0.500000*c0+0.500000*c2|c1=0.500000*c0+0.500000*c2"
        );
        assert_eq!(plan.output_channels, 2);
    }

    #[test]
    fn builds_stereo_pan_filter_from_output_indexes() {
        let mut channel_map = capture_channel_map("stereo", &[5, 2]);

        channel_map.entries[1].output_channel_index = Some(2);
        channel_map.entries[2].output_channel_index = Some(1);
        let plan = channel_render_plan(&channel_map).expect("render plan");

        assert_eq!(plan.filter, "pan=stereo|c0=c1|c1=c4");
    }

    #[test]
    fn rendered_capture_path_preserves_original_extension() {
        assert_eq!(raw_capture_file_name("rec.mp3"), "rec.raw.wav");
    }

    #[test]
    fn mp3_vbr_render_args_use_profile_bitrate_quality() {
        let plan = render_test_plan("mp3", Some(128), true, "rec.mp3");
        let args = render_command_args(&plan, Path::new("rec.raw.wav"), None);
        let text_args = string_args(args);

        assert!(
            text_args
                .windows(2)
                .any(|args| args[0] == "-codec:a" && args[1] == "libmp3lame")
        );
        assert!(
            text_args
                .windows(2)
                .any(|args| args[0] == "-q:a" && args[1] == "5")
        );
        assert_eq!(text_args.last().map(String::as_str), Some("rec.mp3"));
    }

    #[test]
    fn flac_render_args_use_flac_encoder() {
        let plan = render_test_plan("flac", None, false, "rec.flac");
        let args = string_args(render_command_args(&plan, Path::new("rec.raw.wav"), None));

        assert!(
            args.windows(2)
                .any(|args| args[0] == "-codec:a" && args[1] == "flac")
        );
    }

    #[test]
    fn wav_without_channel_map_uses_direct_capture_output() {
        let mut command = command_with_pinned_channel_map();

        command.channel_map = None;
        command.output_codec = Some("wav".to_string());
        command.output_file_name = "rec_123.wav".to_string();
        command.output_vbr = Some(false);
        let job = ControllerRecordingJob {
            command,
            failure_reason: None,
            id: "job_1".to_string(),
            node_id: "node_1".to_string(),
            recording_id: "rec_123".to_string(),
            status: "running".to_string(),
        };
        let plan = capture_plan_for_job(&test_config(), &job, &[]);

        assert!(plan.output_path.ends_with("rec_123.wav"));
        assert_eq!(plan.output_path, plan.final_output_path);
    }

    #[test]
    fn mp3_job_captures_raw_wav_and_finishes_as_profile_output() {
        let config = AgentConfig {
            capture_backend: CaptureBackend::Alsa,
            capture_command: "arecord".to_string(),
            channel_render_command: "ffmpeg".to_string(),
            capture_growth_grace_seconds: 10,
            capture_min_output_bytes: 128,
            capture_stalled_seconds: 30,
            node_id: "node_1".to_string(),
            ..test_config()
        };
        let job = ControllerRecordingJob {
            command: ControllerCaptureCommand {
                output_file_name: "rec_123.mp3".to_string(),
                ..command_with_pinned_channel_map()
            },
            failure_reason: None,
            id: "job_1".to_string(),
            node_id: "node_1".to_string(),
            recording_id: "rec_123".to_string(),
            status: "running".to_string(),
        };
        let plan = capture_plan_for_job(&config, &job, &[]);

        assert!(plan.output_path.ends_with("rec_123.raw.wav"));
        assert!(plan.final_output_path.ends_with("rec_123.mp3"));
        assert_eq!(plan.output_codec, "mp3");
    }

    #[test]
    fn pipewire_job_uses_pipewire_capture_backend_and_default_command() {
        let job = ControllerRecordingJob {
            command: ControllerCaptureCommand {
                capture_backend: Some(CaptureBackend::Pipewire),
                capture_device: "alsa_input.usb-recorder".to_string(),
                output_file_name: "rec_123.wav".to_string(),
                output_codec: Some("wav".to_string()),
                output_vbr: Some(false),
                ..command_with_pinned_channel_map()
            },
            failure_reason: None,
            id: "job_1".to_string(),
            node_id: "node_1".to_string(),
            recording_id: "rec_123".to_string(),
            status: "running".to_string(),
        };
        let plan = capture_plan_for_job(&test_config(), &job, &[]);

        assert_eq!(plan.backend, CaptureBackend::Pipewire);
        assert_eq!(plan.command, "pw-record");
        assert_eq!(
            crate::capture::capture_command_args(&plan, "/tmp/rec.wav").unwrap(),
            vec![
                "--record",
                "--target",
                "alsa_input.usb-recorder",
                "--rate",
                "48000",
                "--channels",
                "3",
                "--format",
                "s16",
                "--sample-count",
                "2880000",
                "--container",
                "wav",
                "/tmp/rec.wav",
            ]
        );
    }

    fn render_test_plan(
        output_codec: &str,
        output_bitrate_kbps: Option<u32>,
        output_vbr: bool,
        final_output_path: &str,
    ) -> CapturePlan {
        CapturePlan {
            args_template: None,
            backend: CaptureBackend::Alsa,
            channel_map: None,
            channels: 2,
            command: "arecord".to_string(),
            device: "default".to_string(),
            final_output_path: PathBuf::from(final_output_path),
            format: "S16_LE".to_string(),
            growth_grace_seconds: 10,
            min_output_bytes: 128,
            output_bitrate_kbps,
            output_codec: output_codec.to_string(),
            output_path: PathBuf::from("rec.raw.wav"),
            output_vbr,
            render_command: "ffmpeg".to_string(),
            sample_rate: 48_000,
            seconds: 60,
            stalled_seconds: 30,
        }
    }

    fn string_args(args: Vec<std::ffi::OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    fn channel_map_bundle(
        assignment_id: &str,
        target_type: &str,
        target_id: &str,
        template_id: &str,
        included_sources: &[u16],
    ) -> ControllerChannelMapBundle {
        ControllerChannelMapBundle {
            assignment: ControllerChannelMapAssignment {
                assigned_at: "2026-06-18T00:00:00Z".to_string(),
                id: assignment_id.to_string(),
                target_id: target_id.to_string(),
                target_type: target_type.to_string(),
                template_id: template_id.to_string(),
            },
            template: ControllerChannelMapTemplate {
                channel_mode: "mono_to_stereo_mix".to_string(),
                entries: channel_map_entries(included_sources),
                id: template_id.to_string(),
                name: format!("Template {template_id}"),
                tags: vec![],
            },
        }
    }

    fn channel_map_entries(included_sources: &[u16]) -> Vec<ControllerChannelMapEntry> {
        let mut entries = vec![ControllerChannelMapEntry {
            included: false,
            label: "Muted".to_string(),
            output_channel_index: None,
            source_channel_index: 16,
        }];

        entries.extend(
            included_sources
                .iter()
                .copied()
                .map(|source_channel_index| ControllerChannelMapEntry {
                    included: true,
                    label: format!("Channel {source_channel_index}"),
                    output_channel_index: Some(source_channel_index),
                    source_channel_index,
                }),
        );

        entries
    }

    fn capture_channel_map(channel_mode: &str, included_sources: &[u16]) -> CaptureChannelMap {
        CaptureChannelMap {
            assignment_id: "assignment".to_string(),
            channel_mode: channel_mode.to_string(),
            entries: channel_map_entries(included_sources)
                .iter()
                .map(controller_entry)
                .collect(),
            source_channels: included_sources.iter().copied().max().unwrap_or(1),
            target_id: "node_1".to_string(),
            target_type: "node".to_string(),
            template_id: "template".to_string(),
            template_name: "Template".to_string(),
        }
    }

    fn test_config() -> AgentConfig {
        AgentConfig {
            agent_health_log_file: PathBuf::from("health-events.jsonl"),
            agent_health_log_max_bytes: 1_048_576,
            agent_health_log_retained_files: 3,
            agent_state_file: PathBuf::from("state.json"),
            allow_insecure_controller: false,
            alias: "Node".to_string(),
            attach_cache_content_type: "audio/mpeg".to_string(),
            attach_cache_duration_seconds: None,
            attach_cache_file: None,
            attach_cache_file_name: None,
            attach_cache_recording_id: None,
            capture_args_template: None,
            capture_backend: CaptureBackend::Alsa,
            capture_channels: 2,
            capture_command: "arecord".to_string(),
            capture_device: "default".to_string(),
            capture_format: "S16_LE".to_string(),
            capture_growth_grace_seconds: 10,
            capture_min_output_bytes: 128,
            capture_output: None,
            capture_recording_id: None,
            capture_sample_rate: 48_000,
            capture_seconds: 60,
            capture_stalled_seconds: 30,
            channel_render_command: "ffmpeg".to_string(),
            controller_ca_cert_path: None,
            controller_token: None,
            controller_url: "http://localhost:8787".to_string(),
            heartbeat_seconds: 5,
            job_poll_seconds: 2,
            meter_backend: crate::config::MeterBackend::Synthetic,
            meter_args_template: None,
            meter_clip_dbfs: -1.0,
            meter_flatline_dbfs: -120.0,
            meter_sample_seconds: 1,
            monitor_chunk_sync_enabled: true,
            max_concurrent_recordings: 1,
            node_id: "node_1".to_string(),
            print_channel_map_assignments: false,
            print_inventory: false,
            print_meter_frame: false,
            recorder_cache_manifest_file: PathBuf::from("recorder-cache-manifest.json"),
            room: "Room".to_string(),
            run_next_job: false,
            site: "Site".to_string(),
            system_health_disk_critical_percent: 95.0,
            system_health_df_command: "df".to_string(),
            system_health_disk_path: PathBuf::from("."),
            system_health_disk_warning_percent: 85.0,
            system_health_enabled: true,
            system_health_load_critical_per_core: 4.0,
            system_health_load_warning_per_core: 2.0,
        }
    }
}
