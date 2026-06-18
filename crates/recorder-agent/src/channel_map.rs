use serde_json::json;

use crate::capture::{CaptureChannelMap, CapturePlan, local_capture_path};
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
        sample_rate: job.command.capture_sample_rate,
        seconds: job.command.duration_seconds,
    }
}

pub fn channel_map_details(channel_map: &CaptureChannelMap) -> serde_json::Value {
    json!({
        "assignmentId": channel_map.assignment_id.as_str(),
        "captureChannels": channel_map.source_channels,
        "channelMode": channel_map.channel_mode.as_str(),
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
        source_channels,
        target_id: bundle.assignment.target_id.clone(),
        target_type: bundle.assignment.target_type.clone(),
        template_id: bundle.template.id.clone(),
        template_name: bundle.template.name.clone(),
    })
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
}
