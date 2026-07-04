use serde_json::json;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;

use crate::capture::{CaptureChannelMap, CaptureChannelMapEntry, CapturePlan, local_capture_path};
use crate::capture_naming::safe_file_name;
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
        enhancement: job.command.enhancement.clone(),
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
pub(crate) struct ChannelRenderPlan {
    pub(crate) filter: String,
    pub(crate) output_channels: u16,
}

pub(crate) fn channel_render_plan(channel_map: &CaptureChannelMap) -> Option<ChannelRenderPlan> {
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

pub(crate) fn output_codec_args(plan: &CapturePlan) -> Vec<OsString> {
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
#[path = "channel_map/tests.rs"]
mod tests;
