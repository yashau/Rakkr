use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;

use crate::capture::{CaptureChannelMap, CaptureChannelMapEntry, CapturePlan, local_capture_path};
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

    CapturePlan {
        channel_map,
        channels,
        command: config.capture_command.clone(),
        device: job.command.capture_device.clone(),
        format: job.command.capture_format.clone(),
        output_path: local_capture_path(&job.command.output_file_name),
        render_command: config.channel_render_command.clone(),
        sample_rate: job.command.capture_sample_rate,
        seconds: job.command.duration_seconds,
    }
}

pub fn render_capture_output(plan: &CapturePlan, captured_path: &Path) -> anyhow::Result<PathBuf> {
    let Some(channel_map) = &plan.channel_map else {
        return Ok(captured_path.to_path_buf());
    };
    let Some(render_plan) = channel_render_plan(channel_map) else {
        return Ok(captured_path.to_path_buf());
    };
    let rendered_path = rendered_capture_path(captured_path);
    let output = Command::new(&plan.render_command)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(captured_path)
        .arg("-filter_complex")
        .arg(&render_plan.filter)
        .arg("-ac")
        .arg(render_plan.output_channels.to_string())
        .arg(&rendered_path)
        .output()
        .with_context(|| format!("run channel render command {}", plan.render_command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);

        anyhow::bail!(
            "channel render command {} failed with status {}: {}",
            plan.render_command,
            output.status,
            stderr.trim()
        );
    }

    let metadata = fs::metadata(&rendered_path).with_context(|| {
        format!(
            "inspect rendered channel output {}",
            rendered_path.display()
        )
    })?;

    if metadata.len() == 0 {
        anyhow::bail!(
            "rendered channel output is empty: {}",
            rendered_path.display()
        );
    }

    Ok(rendered_path)
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

fn rendered_capture_path(captured_path: &Path) -> PathBuf {
    let extension = captured_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("wav");

    captured_path.with_extension(format!("mapped.{extension}"))
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

#[cfg(test)]
mod tests {
    use super::*;
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
            output_file_name: "rec.wav".to_string(),
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
        assert_eq!(
            rendered_capture_path(Path::new("data/raw.wav")),
            PathBuf::from("data/raw.mapped.wav")
        );
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
}
