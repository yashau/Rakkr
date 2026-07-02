mod cache_upload;
mod capture_group;
mod types;
use crate::cache_content_type::content_type_for_codec;
use crate::capture::CaptureChild;
use crate::channel_map::{capture_plan_for_job, channel_map_details, render_capture_output};
use crate::chunked_capture;
use crate::config::AgentConfig;
use crate::controller_http::controller_http_client;
use crate::health_log::{self, AgentHealthEvent};
use crate::inventory::NodeInventory;
use crate::recording_job_chunked;
use crate::recording_job_disk::{
    RuntimeCaptureDiskRecoveryEvidence, capture_disk_space_shortfall, ensure_capture_disk_space,
    recover_runtime_capture_disk_space, report_capture_disk_space_shortfall,
};
use crate::recording_job_recovery::{
    apply_recorder_cache_retention, recover_runtime_capture_device_loss,
    refresh_capture_device_from_inventory, report_capture_command_failure,
    report_control_plane_sync_failure, spawn_capture_plan_with_recovery,
    write_recoverable_job_state,
};
use crate::recording_job_segments::{
    STITCH_FAILED_REASON, StitchContext, StitchOutcome, report_unrecoverable_capture_segments,
    stitch_recovered_capture_segments,
};
use crate::recording_job_upload::{
    RenditionUploadInputs, UploadCheckpoint, append_job_health_event, upload_recording_renditions,
    write_upload_checkpoint_state,
};
use crate::state::write_job_state;
use crate::telemetry::MeterFrame;
use anyhow::Context;
pub use cache_upload::upload_cache_file;
use capture_group::{
    claim_next_recording_group, finalize_secondary_members, session_capture_channels,
};
use reqwest::header::DATE;
use serde_json::json;
use std::fs;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc2822};
use tracing::{info, warn};
use types::DataEnvelope;
pub use types::{
    CacheFileUpload, ControllerCaptureCommand, ControllerChannelMapBundle,
    ControllerChannelMapEntry, ControllerRecordingEnhancement, ControllerRecordingJob,
    ControllerRecordingJobChannelMap,
};
#[cfg(test)]
pub use types::{ControllerChannelMapAssignment, ControllerChannelMapTemplate};
const DURATION_HEADER: &str = "x-rakkr-duration-seconds";
const FILE_NAME_HEADER: &str = "x-rakkr-file-name";
const AGENT_ID_HEADER: &str = "x-rakkr-agent-id";
const JOB_ID_HEADER: &str = "x-rakkr-recording-job-id";
pub async fn fetch_channel_map_assignments(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<Vec<ControllerChannelMapBundle>> {
    config.validate_controller_transport()?;
    let url = node_url(
        &config.controller_url,
        &config.node_id,
        "channel-map-assignments",
    );
    let response = controller_http_client(config)?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch channel map assignments")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("controller rejected channel map assignment request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<Vec<ControllerChannelMapBundle>>>()
        .await
        .context("decode channel map assignments")?;

    Ok(envelope.data)
}

pub async fn attach_cache_file(config: &AgentConfig) -> anyhow::Result<()> {
    let recording_id = config
        .attach_cache_recording_id
        .as_deref()
        .context("missing --attach-cache-recording-id")?;
    let file_path = config
        .attach_cache_file
        .as_deref()
        .context("missing --attach-cache-file")?;
    let token = config
        .controller_token
        .as_deref()
        .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
    let file_name = config.attach_cache_file_name.clone().or_else(|| {
        file_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
    });

    upload_cache_file(CacheFileUpload {
        allow_insecure_controller: config.allow_insecure_controller,
        content_type: &config.attach_cache_content_type,
        controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
        controller_url: &config.controller_url,
        duration_seconds: config.attach_cache_duration_seconds,
        file_name,
        file_path,
        job_id: None,
        recording_id,
        rendition: None,
        chunk_index: None,
        chunk_total: None,
        token,
    })
    .await
}

pub async fn run_next_recording_job(config: &AgentConfig) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let token = config
        .controller_token
        .as_deref()
        .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
    let mut group = match claim_next_recording_group(config, token).await {
        Ok(group) => group,
        Err(error) => {
            let reason = error.to_string();
            let event = health_log::append_health_event(
                config,
                "agent.recording_job.claim_next_failed",
                "warning",
                json!({ "error": reason.as_str(), "nodeId": config.node_id.as_str() }),
            )?;
            if let Err(sync_error) = sync_health_event(config, token, &event).await {
                warn!(error = %sync_error, "failed to sync claim-next health event");
            }

            return Err(error);
        }
    };

    if group.is_empty() {
        info!(node_id = %config.node_id, "no queued recording job for node");
        return Ok(());
    }

    // The first claimed job is the capture-session primary; any remaining jobs
    // share its single device capture and render their own channel subsets from
    // the same raw (capture-once, split-many).
    let job = group.remove(0);
    let secondaries = group;
    write_job_state(config, &job, "running", None, None)?;
    info!(
        job_id = %job.id,
        node_id = %job.node_id,
        recording_id = %job.recording_id,
        track_group_id = ?job.command.track_group_id,
        track_index = ?job.command.track_index,
        track_total = ?job.command.track_total,
        "claimed recording job"
    );
    let channel_maps = if job.command.channel_map.is_some() {
        Vec::new()
    } else {
        match fetch_channel_map_assignments(config, token).await {
            Ok(assignments) => assignments,
            Err(error) => {
                let reason = error.to_string();

                warn!(error = %reason, "failed to fetch channel map assignments for recording job");
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.channel_map_lookup_failed",
                    "warning",
                    json!({
                        "error": reason.as_str(),
                        "jobId": job.id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
                Vec::new()
            }
        }
    };
    let mut capture_plan = capture_plan_for_job(config, &job, &channel_maps);
    refresh_capture_device_from_inventory(config, token, &job, &mut capture_plan).await?;

    if !secondaries.is_empty() {
        // Capture the full channel span the whole group needs in one pass; each
        // member renders its own subset from this shared raw afterwards.
        capture_plan.channels = session_capture_channels(capture_plan.channels, &secondaries);
        info!(
            job_id = %job.id,
            capture_group_id = ?job.command.capture_group_id,
            members = secondaries.len() + 1,
            session_channels = capture_plan.channels,
            "capturing shared session for recording job group"
        );
    }

    if let Some(channel_map) = &capture_plan.channel_map {
        info!(
            assignment_id = %channel_map.assignment_id,
            capture_channels = channel_map.source_channels,
            channel_mode = %channel_map.channel_mode,
            template_id = %channel_map.template_id,
            "applied channel map to recording job capture plan"
        );
        append_job_health_event(
            config,
            token,
            &job,
            "agent.recording_job.channel_map_applied",
            "info",
            json!({
                "assignmentId": channel_map.assignment_id.as_str(),
                "captureChannels": channel_map.source_channels,
                "channelMode": channel_map.channel_mode.as_str(),
                "configuredCaptureChannels": job.command.capture_channels,
                "entryCount": channel_map.entries.len(),
                "jobId": job.id.as_str(),
                "recordingId": job.recording_id.as_str(),
                "targetId": channel_map.target_id.as_str(),
                "targetType": channel_map.target_type.as_str(),
                "templateId": channel_map.template_id.as_str(),
                "templateName": channel_map.template_name.as_str(),
            }),
        )
        .await?;
    }

    // Chunked recordings: one gapless capture emits fixed-length chunk files that
    // are each rendered + uploaded as they close. Only the lone-job path supports
    // chunking; capture-once-split-many groups stay on the single-file flow. Decide
    // before the disk preflight so chunked jobs are sized per-chunk, not full-duration.
    let chunk_seconds = job.command.chunk_seconds.or(config.capture_chunk_seconds);
    let chunked_plan = secondaries
        .is_empty()
        .then(|| chunked_capture::chunk_plan_for(&capture_plan, chunk_seconds))
        .flatten();
    let disk_plan = recording_job_chunked::chunked_disk_plan(&capture_plan, chunked_plan.as_ref());

    if let Err(error) = ensure_capture_disk_space(config, token, &job, &disk_plan).await {
        write_job_state(config, &job, "failed", None, Some(&error.to_string()))?;

        return Err(error);
    }

    write_recoverable_job_state(
        config,
        &job,
        "running",
        Some(&capture_plan.output_path),
        None,
        &[],
    )?;

    if let Some(chunk_plan) = chunked_plan {
        return recording_job_chunked::run_chunked_recording_job(
            config,
            token,
            &job,
            &capture_plan,
            &chunk_plan,
        )
        .await;
    }

    recording_job_chunked::report_chunked_fallback(
        config,
        token,
        &job,
        &capture_plan,
        chunk_seconds,
        !secondaries.is_empty(),
    )
    .await?;

    let mut capture =
        match spawn_capture_plan_with_recovery(config, token, &job, &capture_plan).await {
            Ok(capture) => capture,
            Err(error) => {
                let reason = error.to_string();

                let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.capture_start_failed",
                    "critical",
                    json!({
                        "command": capture_plan.command.as_str(),
                        "device": capture_plan.device.as_str(),
                        "error": reason.as_str(),
                        "jobId": job.id.as_str(),
                        "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                        "outputPath": capture_plan.output_path.display().to_string(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
                write_job_state(config, &job, "failed", None, Some(&reason))?;

                return Err(error);
            }
        };
    let mut control_plane_sync_failed = false;
    let mut capture_attempt = 1_u8;
    let mut runtime_disk_recovery_attempted = false;
    let mut recovered_segments = Vec::new();
    let raw_output_path = loop {
        match capture.try_complete() {
            Ok(Some(output_path)) => {
                write_recoverable_job_state(
                    config,
                    &job,
                    "captured",
                    Some(&output_path),
                    None,
                    &recovered_segments,
                )?;
                break output_path;
            }
            Ok(None) => match capture.check_growth() {
                Ok(growth) => {
                    if let Some(disk_usage) = crate::system_health::disk_usage(
                        &config.system_health_df_command,
                        &config.system_health_disk_path,
                    ) && let Some(shortfall) =
                        capture_disk_space_shortfall(&capture_plan, &growth, disk_usage)
                    {
                        let reason = shortfall.reason();

                        let _ = capture.stop();
                        if !runtime_disk_recovery_attempted
                            && let Some(recovered_capture) = recover_runtime_capture_disk_space(
                                config,
                                token,
                                &job,
                                &capture_plan,
                                RuntimeCaptureDiskRecoveryEvidence {
                                    disk_usage,
                                    growth: growth.clone(),
                                    shortfall: shortfall.clone(),
                                },
                                capture_attempt,
                            )
                            .await?
                        {
                            runtime_disk_recovery_attempted = true;
                            capture_attempt += 1;
                            if let Some(segment) = recovered_capture.segment {
                                recovered_segments.push(segment);
                            }
                            capture = recovered_capture.capture;
                            write_recoverable_job_state(
                                config,
                                &job,
                                "running",
                                Some(&capture_plan.output_path),
                                None,
                                &recovered_segments,
                            )?;
                            continue;
                        }
                        report_capture_disk_space_shortfall(
                            config,
                            token,
                            &job,
                            &capture_plan,
                            &growth,
                            &shortfall,
                        )
                        .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(anyhow::anyhow!(reason));
                    }
                }
                Err(error) => {
                    let reason = error.to_string();
                    let growth = error.snapshot();

                    let _ = capture.stop();
                    let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
                    append_job_health_event(
                            config,
                            token,
                            &job,
                            "agent.recording_job.capture_output_stalled",
                            "critical",
                            json!({
                                "device": capture_plan.device.as_str(),
                                "error": reason.as_str(),
                                "growthAgeSeconds": growth.age_seconds,
                                "growthGraceSeconds": capture_plan.growth_grace_seconds,
                                "lastGrowthSecondsAgo": growth.last_growth_seconds_ago,
                                "jobId": job.id.as_str(),
                                "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                                "outputPath": capture_plan.output_path.display().to_string(),
                                "recordingId": job.recording_id.as_str(),
                                "sizeBytes": growth.size_bytes,
                                "stalledSeconds": capture_plan.stalled_seconds,
                            }),
                        )
                        .await?;
                    write_job_state(config, &job, "failed", None, Some(&reason))?;

                    return Err(error.into());
                }
            },
            Err(error) => {
                match recover_runtime_capture_device_loss(
                    config,
                    token,
                    &job,
                    &mut capture_plan,
                    &error,
                    capture_attempt,
                )
                .await
                {
                    Ok(Some(recovered_capture)) => {
                        capture_attempt += 1;
                        if let Some(segment) = recovered_capture.segment {
                            recovered_segments.push(segment);
                        }
                        capture = recovered_capture.capture;
                        write_recoverable_job_state(
                            config,
                            &job,
                            "running",
                            Some(&capture_plan.output_path),
                            None,
                            &recovered_segments,
                        )?;
                        continue;
                    }
                    Ok(None) => {
                        let reason = error.to_string();

                        report_capture_command_failure(config, token, &job, &capture_plan, &error)
                            .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(error);
                    }
                    Err(recovery_error) => {
                        let reason = recovery_error.to_string();

                        report_capture_command_failure(
                            config,
                            token,
                            &job,
                            &capture_plan,
                            &recovery_error,
                        )
                        .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(recovery_error);
                    }
                }
            }
        }

        for secondary in &secondaries {
            if let Err(error) = heartbeat_recording_job(config, token, &secondary.id).await {
                warn!(
                    error = %error,
                    job_id = %secondary.id,
                    "failed to heartbeat shared-capture member; lease may expire"
                );
            }
        }

        if let Err(error) = heartbeat_recording_job(config, token, &job.id).await {
            control_plane_sync_failed = report_control_plane_sync_failure(
                config,
                token,
                &job,
                "agent.recording_job.control_plane_failed",
                error.to_string(),
                control_plane_sync_failed,
            )
            .await?;

            if let Ok(latest) = fetch_recording_job(config, token, &job.id).await
                && handle_terminal_controller_job(config, token, &job, &latest, &mut capture)
                    .await?
            {
                return Ok(());
            }

            tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
            continue;
        }

        if control_plane_sync_failed {
            control_plane_sync_failed = false;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.control_plane_recovered",
                "info",
                json!({
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
        }

        let latest = match fetch_recording_job(config, token, &job.id).await {
            Ok(latest) => latest,
            Err(error) => {
                control_plane_sync_failed = report_control_plane_sync_failure(
                    config,
                    token,
                    &job,
                    "agent.recording_job.status_poll_failed",
                    error.to_string(),
                    control_plane_sync_failed,
                )
                .await?;

                tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
                continue;
            }
        };

        if handle_terminal_controller_job(config, token, &job, &latest, &mut capture).await? {
            return Ok(());
        }

        tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
    };
    let stitch_ctx = StitchContext {
        config,
        token,
        recording_id: &job.recording_id,
        job_id: &job.id,
        render_command: &capture_plan.render_command,
        output_path: &capture_plan.output_path,
    };
    let raw_output_path =
        match stitch_recovered_capture_segments(&stitch_ctx, &recovered_segments, &raw_output_path)
            .await?
        {
            StitchOutcome::NoSegments => raw_output_path,
            StitchOutcome::Stitched(stitched_path) => stitched_path,
            StitchOutcome::Failed { preserved } => {
                // The pre-loss segments could not be merged. Never silent-complete:
                // preserve the audio on disk, emit a critical health event, and fail
                // the job so the recording reflects the loss (GH-1).
                report_unrecoverable_capture_segments(&stitch_ctx, &preserved).await?;
                write_job_state(
                    config,
                    &job,
                    "failed",
                    Some(&raw_output_path),
                    Some(STITCH_FAILED_REASON),
                )?;

                return Err(anyhow::anyhow!(STITCH_FAILED_REASON));
            }
        };
    let output_path = match render_capture_output(&capture_plan, &raw_output_path) {
        Ok(rendered_path) => {
            if rendered_path != raw_output_path {
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.output_rendered",
                    "info",
                    json!({
                        "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                        "jobId": job.id.as_str(),
                        "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                        "outputCodec": capture_plan.output_codec.as_str(),
                        "outputVbr": capture_plan.output_vbr,
                        "rawOutputPath": raw_output_path.display().to_string(),
                        "recordingId": job.recording_id.as_str(),
                        "renderedOutputPath": rendered_path.display().to_string(),
                    }),
                )
                .await?;
                write_job_state(config, &job, "rendered", Some(&rendered_path), None)?;
            }

            rendered_path
        }
        Err(error) => {
            let reason = error.to_string();
            let raw_output_bytes = fs::metadata(&raw_output_path)
                .ok()
                .map(|metadata| metadata.len());

            let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.output_render_failed",
                "critical",
                json!({
                    "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                    "outputCodec": capture_plan.output_codec.as_str(),
                    "outputVbr": capture_plan.output_vbr,
                    "rawOutputPath": raw_output_path.display().to_string(),
                    "rawOutputBytes": raw_output_bytes,
                    "recordingId": job.recording_id.as_str(),
                    "renderCommand": capture_plan.render_command.as_str(),
                    "renderedOutputPath": capture_plan.final_output_path.display().to_string(),
                }),
            )
            .await?;
            write_job_state(
                config,
                &job,
                "failed",
                Some(&raw_output_path),
                Some(&reason),
            )?;

            return Err(error);
        }
    };

    let upload_content_type =
        content_type_for_codec(job.command.output_codec.as_deref(), &output_path);
    let upload_file_name = job.command.output_file_name.clone();
    let upload_output_bytes = fs::metadata(&output_path)
        .ok()
        .map(|metadata| metadata.len());
    let upload_checkpoint = UploadCheckpoint {
        content_type: upload_content_type,
        duration_seconds: Some(job.command.duration_seconds),
        file_name: Some(upload_file_name.as_str()),
        output_path: &output_path,
        raw_output_path: &raw_output_path,
        recorder_cache_retention: job.command.recorder_cache_retention.clone(),
        recovered_segments: &recovered_segments,
    };
    write_upload_checkpoint_state(config, &job, "upload_pending", &upload_checkpoint, None)?;

    // Produce the best-effort enhanced rendition and upload both renditions.
    let upload_result = upload_recording_renditions(RenditionUploadInputs {
        capture_plan: &capture_plan,
        config,
        content_type: upload_content_type,
        duration_seconds: job.command.duration_seconds,
        file_name: &upload_file_name,
        job: &job,
        output_path: &output_path,
        raw_output_path: &raw_output_path,
        chunk_index: None,
        chunk_total: None,
        token,
    })
    .await;

    match upload_result {
        Ok(()) => {
            write_upload_checkpoint_state(config, &job, "uploaded", &upload_checkpoint, None)?;
            // Render and upload every shared-capture member from the same raw
            // before the primary's retention can reclaim it.
            finalize_secondary_members(config, token, &secondaries, &raw_output_path).await;
            apply_recorder_cache_retention(config, token, &job, &raw_output_path, &output_path)
                .await?;
            write_job_state(config, &job, "completed", Some(&output_path), None)?;
            Ok(())
        }
        Err(error) => {
            let reason = error.to_string();
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.cache_upload_failed",
                "warning",
                json!({
                    "contentType": upload_content_type,
                    "durationSeconds": job.command.duration_seconds,
                    "error": reason.as_str(),
                    "fileName": upload_file_name.as_str(),
                    "jobId": job.id.as_str(),
                    "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                    "outputBytes": upload_output_bytes,
                    "outputCodec": capture_plan.output_codec.as_str(),
                    "outputPath": output_path.display().to_string(),
                    "outputVbr": capture_plan.output_vbr,
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_upload_checkpoint_state(
                config,
                &job,
                "upload_pending",
                &upload_checkpoint,
                Some(&reason),
            )?;
            Err(error)
        }
    }
}

async fn handle_terminal_controller_job(
    config: &AgentConfig,
    token: &str,
    claimed_job: &ControllerRecordingJob,
    latest: &ControllerRecordingJob,
    capture: &mut CaptureChild,
) -> anyhow::Result<bool> {
    if matches!(latest.status.as_str(), "stop_requested" | "cancelled") {
        capture.stop()?;
        mark_recording_job_cancelled(config, token, &claimed_job.id, "controller_stop_requested")
            .await?;
        write_job_state(
            config,
            latest,
            "cancelled",
            None,
            Some("controller_stop_requested"),
        )?;
        return Ok(true);
    }

    if matches!(latest.status.as_str(), "failed" | "completed") {
        capture.stop()?;
        write_job_state(
            config,
            latest,
            latest.status.as_str(),
            None,
            latest.failure_reason.as_deref(),
        )?;
        return Ok(true);
    }

    Ok(false)
}

// Shared POST to a node-scoped controller endpoint. Validates transport, posts
// the JSON body, and bails on a non-success status (the `label` keeps the
// failure messages that health evidence + smokes assert on). Returns the
// validated response so callers can read headers (e.g. heartbeat clock skew).
async fn post_node_endpoint<T: serde::Serialize + ?Sized>(
    config: &AgentConfig,
    token: &str,
    suffix: &str,
    body: &T,
    label: &str,
) -> anyhow::Result<reqwest::Response> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, suffix);
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .with_context(|| format!("post {label} to controller"))?;
    let status = response.status();

    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected {label} with {status}: {detail}");
    }

    Ok(response)
}

pub async fn post_meter_frame(
    config: &AgentConfig,
    token: &str,
    frame: &MeterFrame,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "meter-frame", frame, "meter frame").await?;

    Ok(())
}

pub async fn post_node_heartbeat(
    config: &AgentConfig,
    token: &str,
    inventory: &NodeInventory,
) -> anyhow::Result<Option<i64>> {
    let response =
        post_node_endpoint(config, token, "heartbeat", inventory, "node heartbeat").await?;

    Ok(response
        .headers()
        .get(DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(controller_clock_skew_seconds))
}

pub async fn post_node_inventory(
    config: &AgentConfig,
    token: &str,
    inventory: &NodeInventory,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "inventory", inventory, "node inventory").await?;

    Ok(())
}

pub async fn sync_health_event(
    config: &AgentConfig,
    token: &str,
    event: &AgentHealthEvent,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "health-events", event, "health event").await?;

    Ok(())
}

pub(crate) async fn heartbeat_recording_job(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
) -> anyhow::Result<ControllerRecordingJob> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}/heartbeat",
        config.controller_url.trim_end_matches('/'),
        job_id
    );
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .header(AGENT_ID_HEADER, config.node_id.as_str())
        .send()
        .await
        .context("heartbeat recording job")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected job heartbeat with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode heartbeat recording job")?;

    Ok(envelope.data)
}

pub(crate) async fn fetch_recording_job(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
) -> anyhow::Result<ControllerRecordingJob> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}",
        config.controller_url.trim_end_matches('/'),
        job_id
    );
    let response = controller_http_client(config)?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch recording job status")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("controller rejected job status request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode recording job status")?;

    Ok(envelope.data)
}

pub(crate) async fn mark_recording_job_cancelled(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    mark_recording_job_terminal(config, token, job_id, "cancelled", reason).await
}

pub(crate) async fn mark_recording_job_failed(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    mark_recording_job_terminal(config, token, job_id, "failed", reason).await
}

async fn mark_recording_job_terminal(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    terminal_state: &str,
    reason: &str,
) -> anyhow::Result<()> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}/{}",
        config.controller_url.trim_end_matches('/'),
        job_id,
        terminal_state
    );
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .header("x-rakkr-reason", reason)
        .send()
        .await
        .with_context(|| format!("mark recording job {terminal_state}"))?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("controller rejected job terminal update with {status}: {body}");
    }

    Ok(())
}

fn controller_clock_skew_seconds(date_header: &str) -> Option<i64> {
    controller_clock_skew_seconds_at(date_header, OffsetDateTime::now_utc())
}

fn controller_clock_skew_seconds_at(date_header: &str, now: OffsetDateTime) -> Option<i64> {
    let controller_time = OffsetDateTime::parse(date_header, &Rfc2822).ok()?;
    let skew = controller_time - now;

    Some(skew.whole_seconds())
}

pub(crate) fn node_url(controller_url: &str, node_id: &str, suffix: &str) -> String {
    format!(
        "{}/api/v1/nodes/{}/{}",
        controller_url.trim_end_matches('/'),
        node_id,
        suffix.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests;
