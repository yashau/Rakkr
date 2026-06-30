use anyhow::Context;
use tracing::warn;

use super::{
    AGENT_ID_HEADER, ControllerCaptureCommand, ControllerRecordingJob, DataEnvelope,
    RenditionUploadInputs, capture_plan_for_job, content_type_for_codec, controller_http_client,
    mark_recording_job_failed, render_capture_output, upload_recording_renditions, write_job_state,
};
use crate::config::AgentConfig;

/// Claim the next queued job plus every queued sibling sharing its capture group
/// so the agent can capture the shared device once and split it per job.
pub(super) async fn claim_next_recording_group(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<Vec<ControllerRecordingJob>> {
    let url = format!(
        "{}/api/v1/nodes/{}/recording-jobs/claim-next-group",
        config.controller_url.trim_end_matches('/'),
        config.node_id
    );
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .header(AGENT_ID_HEADER, config.node_id.as_str())
        .send()
        .await
        .context("claim next recording job group")?;
    let status = response.status();

    if status.as_u16() == 204 {
        return Ok(Vec::new());
    }

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected next job group claim with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<Vec<ControllerRecordingJob>>>()
        .await
        .context("decode claimed recording job group")?;

    Ok(envelope.data)
}

/// The number of source channels a shared capture must record so every group
/// member can render its subset: the widest channel span across the primary and
/// all secondaries.
pub(super) fn session_capture_channels(
    primary_channels: u16,
    secondaries: &[ControllerRecordingJob],
) -> u16 {
    secondaries.iter().fold(primary_channels, |widest, member| {
        widest.max(member_channel_span(&member.command))
    })
}

/// The highest 1-based source channel a job reads: from its channel map, else
/// its explicit selection, else its raw channel count.
fn member_channel_span(command: &ControllerCaptureCommand) -> u16 {
    if let Some(map) = command.channel_map.as_ref() {
        return map.source_channels;
    }

    command
        .capture_channel_selection
        .as_ref()
        .and_then(|selection| selection.iter().copied().max())
        .unwrap_or(command.capture_channels)
}

/// Render, enhance, and upload each shared-capture member from the single raw
/// the primary captured. Each member finalizes independently; a failure on one
/// member is recorded against that member and does not abort the others.
pub(super) async fn finalize_secondary_members(
    config: &AgentConfig,
    token: &str,
    secondaries: &[ControllerRecordingJob],
    session_raw_path: &std::path::Path,
) {
    for member in secondaries {
        if let Err(error) = finalize_secondary_member(config, token, member, session_raw_path).await
        {
            let reason = error.to_string();

            warn!(
                error = %reason,
                job_id = %member.id,
                recording_id = %member.recording_id,
                "failed to finalize shared-capture member"
            );
            let _ = mark_recording_job_failed(config, token, &member.id, &reason).await;
            let _ = write_job_state(config, member, "failed", None, Some(&reason));
        }
    }
}

async fn finalize_secondary_member(
    config: &AgentConfig,
    token: &str,
    member: &ControllerRecordingJob,
    session_raw_path: &std::path::Path,
) -> anyhow::Result<()> {
    let plan = capture_plan_for_job(config, member, &[]);
    let output_path = render_capture_output(&plan, session_raw_path)?;
    let content_type = content_type_for_codec(member.command.output_codec.as_deref(), &output_path);
    let file_name = member.command.output_file_name.clone();

    write_job_state(config, member, "running", Some(&output_path), None)?;
    upload_recording_renditions(RenditionUploadInputs {
        capture_plan: &plan,
        config,
        content_type,
        duration_seconds: member.command.duration_seconds,
        file_name: &file_name,
        job: member,
        output_path: &output_path,
        raw_output_path: session_raw_path,
        token,
    })
    .await?;
    write_job_state(config, member, "completed", Some(&output_path), None)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::ControllerRecordingJobChannelMap;

    fn capture_command(
        channel_map_source: Option<u16>,
        selection: Option<Vec<u16>>,
        capture_channels: u16,
    ) -> ControllerCaptureCommand {
        ControllerCaptureCommand {
            capture_backend: None,
            capture_channels,
            capture_channel_selection: selection,
            capture_device: "hw:0".to_string(),
            capture_format: "S16_LE".to_string(),
            capture_group_id: Some("cap_session".to_string()),
            capture_interface_id: Some("iface".to_string()),
            capture_sample_rate: 48_000,
            channel_map: channel_map_source.map(|source_channels| {
                ControllerRecordingJobChannelMap {
                    assignment_id: "assignment".to_string(),
                    channel_mode: "stereo".to_string(),
                    entries: Vec::new(),
                    source_channels,
                    target_id: "iface".to_string(),
                    target_type: "interface".to_string(),
                    template_id: "template".to_string(),
                    template_name: "Template".to_string(),
                }
            }),
            duration_seconds: 60,
            enhancement: None,
            output_bitrate_kbps: None,
            output_codec: Some("wav".to_string()),
            output_file_name: "rec.wav".to_string(),
            output_vbr: None,
            recorder_cache_retention: None,
            track_group_id: None,
            track_index: None,
            track_total: None,
        }
    }

    fn group_member(command: ControllerCaptureCommand, id: &str) -> ControllerRecordingJob {
        ControllerRecordingJob {
            command,
            failure_reason: None,
            id: id.to_string(),
            node_id: "node_1".to_string(),
            recording_id: format!("rec_{id}"),
            status: "running".to_string(),
        }
    }

    #[test]
    fn member_channel_span_prefers_map_then_selection_then_count() {
        assert_eq!(member_channel_span(&capture_command(Some(32), None, 2)), 32);
        assert_eq!(
            member_channel_span(&capture_command(None, Some(vec![5, 6]), 2)),
            6
        );
        assert_eq!(member_channel_span(&capture_command(None, None, 8)), 8);
    }

    #[test]
    fn session_capture_channels_uses_widest_member_span() {
        let secondaries = vec![
            group_member(capture_command(Some(4), None, 2), "b"),
            group_member(capture_command(Some(32), None, 2), "c"),
        ];

        // Primary owns ch1-2 but ch31-32 are claimed by a sibling, so the shared
        // capture must record all 32 channels.
        assert_eq!(session_capture_channels(2, &secondaries), 32);
        // A lone job (no siblings) keeps its own channel span.
        assert_eq!(session_capture_channels(2, &[]), 2);
    }
}
