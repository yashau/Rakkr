mod alsa_device;
mod cache_content_type;
mod capture;
mod channel_map;
mod command_template;
mod config;
mod controller;
mod health_log;
mod inventory;
mod meter_command;
mod monitor_sync;
mod node_config;
mod recorder_cache_retention;
mod state;
mod system_health;
mod telemetry;

use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use config::{AgentConfig, MeterBackend};
use meter_command::MeterCaptureConfig;
use serde_json::{Value, json};
use telemetry::{
    MeterFrame, MeterSample, alsa_meter_frame, alsa_meter_sample, synthetic_meter_frame,
    synthetic_meter_sample,
};
use tokio::task::JoinSet;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = AgentConfig::parse();
    let inventory = inventory::collect(&config);

    if config.print_inventory {
        println!("{}", serde_json::to_string_pretty(&inventory)?);
        return Ok(());
    }

    if config.print_meter_frame {
        let (meter_interface_id, meter_channel_count) = meter_target(&config, &inventory);
        let meter_capture = meter_capture_config(&config, meter_channel_count);
        let frame = strict_meter_frame(
            &config,
            &inventory.id,
            &meter_interface_id,
            meter_channel_count,
            0,
            &meter_capture,
        )?;

        println!("{}", serde_json::to_string_pretty(&frame)?);
        return Ok(());
    }

    if config.print_channel_map_assignments {
        let token = config
            .controller_token
            .as_deref()
            .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
        let assignments = controller::fetch_channel_map_assignments(&config, token).await?;

        println!("{}", serde_json::to_string_pretty(&assignments)?);
        return Ok(());
    }

    if config.attach_cache_file.is_some() || config.attach_cache_recording_id.is_some() {
        controller::attach_cache_file(&config).await?;
        return Ok(());
    }

    if config.run_next_job {
        controller::run_next_recording_job(&config).await?;
        return Ok(());
    }

    if config.capture_recording_id.is_some() {
        let token = config
            .controller_token
            .as_deref()
            .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
        let output_path = capture::run_capture_job(&config)?;

        controller::upload_cache_file(controller::CacheFileUpload {
            allow_insecure_controller: config.allow_insecure_controller,
            content_type: "audio/wav",
            controller_url: &config.controller_url,
            duration_seconds: Some(config.capture_seconds),
            file_name: output_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string),
            file_path: &output_path,
            job_id: None,
            recording_id: config
                .capture_recording_id
                .as_deref()
                .context("missing --capture-recording-id")?,
            token,
        })
        .await?;
        return Ok(());
    }

    info!(
        alias = %inventory.alias,
        controller_url = %config.controller_url,
        node_id = %inventory.id,
        "starting recorder agent scaffold"
    );

    let mut active_config = config.clone();
    let mut ticker = tokio::time::interval(Duration::from_secs(config.heartbeat_seconds));
    let mut tick = 0_u64;
    let mut meter_capture_failure = None;
    let mut meter_channel_correlation_active = false;
    let mut meter_clipping_active = false;
    let mut meter_flatline_active = false;
    let mut monitor_sync_failed = false;
    let mut meter_sync_failed = false;
    let mut node_config_sync_failed = false;
    let mut recording_jobs = JoinSet::new();
    let mut recording_job_limit = config.max_concurrent_recordings.max(1);
    let mut system_health_state = system_health::SystemHealthState::default();
    let token = config.controller_token.as_deref();

    append_and_sync_health_event(
        &config,
        token,
        "agent.started",
        "info",
        json!({
            "alias": inventory.alias,
            "controllerUrl": config.controller_url,
            "meterBackend": config.meter_backend.as_str(),
            "nodeId": inventory.id,
        }),
    )
    .await
    .context("append startup health event")?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                warn!("shutdown signal received");
                break;
            }
            _ = ticker.tick() => {
                tick += 1;
                let (meter_interface_id, meter_channel_count) =
                    meter_target(&active_config, &inventory);
                let meter_capture = meter_capture_config(&active_config, meter_channel_count);
                let meter_context = MeterLoopContext {
                    capture: &meter_capture,
                    channel_count: meter_channel_count,
                    interface_id: &meter_interface_id,
                    node_id: &inventory.id,
                    token,
                };
                let sample = next_meter_sample(
                    &active_config,
                    &meter_context,
                    tick,
                    &mut meter_capture_failure,
                ).await?;
                let frame = &sample.frame;

                info!(
                    captured_at = %frame.captured_at,
                    channels = frame.levels.len(),
                    "recorder heartbeat"
                );

                update_meter_health(
                    &active_config,
                    token,
                    frame,
                    &mut meter_channel_correlation_active,
                    &mut meter_clipping_active,
                    &mut meter_flatline_active,
                ).await?;

                update_system_health(
                    &active_config,
                    token,
                    &inventory,
                    &mut system_health_state,
                ).await?;

                reap_recording_job_workers(&mut recording_jobs);

                if let Some(token) = token {
                    let heartbeat = inventory::heartbeat_snapshot(&inventory);

                    if let Err(error) = controller::post_node_heartbeat(
                        &active_config,
                        token,
                        &heartbeat,
                    ).await {
                        warn!(error = %error, "failed to post node heartbeat");
                    }

                    match controller::post_meter_frame(&active_config, token, frame).await {
                        Ok(()) if meter_sync_failed => {
                            meter_sync_failed = false;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.meter_frame.sync_recovered",
                                "info",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "nodeId": inventory.id,
                                }),
                            )
                            .await
                            .context("append meter sync recovery event")?;
                        }
                        Ok(()) => {}
                        Err(error) if !meter_sync_failed => {
                            meter_sync_failed = true;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.meter_frame.sync_failed",
                                "warning",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "error": error.to_string(),
                                    "nodeId": inventory.id,
                                }),
                            )
                            .await
                            .context("append meter sync failure event")?;

                            warn!(error = %error, "failed to post meter frame");
                        }
                        Err(error) => {
                            warn!(error = %error, "failed to post meter frame");
                        }
                    }

                    sync_monitor_chunk(
                        &active_config,
                        token,
                        &sample,
                        &mut monitor_sync_failed,
                    ).await?;

                    match node_config::fetch_node_config(&active_config, token).await {
                        Ok(node_config) => {
                            let mut next_config = config.clone();
                            node_config.apply_audio_defaults(&mut next_config);

                            if audio_runtime_defaults_changed(&active_config, &next_config) {
                                active_config = next_config;
                                info!(
                                    capture_command = %active_config.capture_command,
                                    capture_device = %active_config.capture_device,
                                    "updated audio command defaults from controller config"
                                );
                            }

                            if let Some(next_limit) = node_config.max_concurrent_recordings() {
                                if next_limit != recording_job_limit {
                                    info!(
                                        max_concurrent_recordings = next_limit,
                                        "updated recording job concurrency from controller config"
                                    );
                                }

                                recording_job_limit = next_limit;
                            }

                            if node_config_sync_failed {
                                node_config_sync_failed = false;
                                info!("controller node config sync recovered");
                            }

                            if recording_jobs.is_empty() {
                                run_idle_recorder_cache_sweep(&active_config, Some(token), &node_config)
                                    .await?;
                            }
                        }
                        Err(error) if !node_config_sync_failed => {
                            node_config_sync_failed = true;
                            warn!(error = %error, "failed to fetch controller node config");
                        }
                        Err(_) => {}
                    }
                }

                reap_recording_job_workers(&mut recording_jobs);
                spawn_recording_job_workers(&active_config, &mut recording_jobs, recording_job_limit);
            }
        }
    }

    if !recording_jobs.is_empty() {
        warn!(
            active_recording_jobs = recording_jobs.len(),
            "waiting for active recording jobs before shutdown"
        );
        drain_recording_job_workers(&mut recording_jobs).await;
    }

    Ok(())
}

async fn run_idle_recorder_cache_sweep(
    config: &AgentConfig,
    token: Option<&str>,
    node_config: &node_config::ControllerNodeConfig,
) -> anyhow::Result<()> {
    if node_config.recorder_cache_policies.is_empty() {
        return Ok(());
    }

    let summary = recorder_cache_retention::run_recorder_cache_sweep(
        &config.recorder_cache_manifest_file,
        &node_config.recorder_cache_policies,
        system_health::disk_usage(
            &config.system_health_df_command,
            &config.system_health_disk_path,
        )
        .map(|usage| recorder_cache_retention::RecorderCacheDiskUsage {
            free_bytes: usage.free_bytes,
            free_percent: usage.free_percent,
            total_bytes: usage.total_bytes,
        }),
        std::time::SystemTime::now(),
    )?;

    if summary.deleted == 0 && summary.errors == 0 {
        return Ok(());
    }

    let severity = if summary.errors > 0 {
        "warning"
    } else {
        "info"
    };

    append_and_sync_health_event(
        config,
        token,
        "agent.recorder_cache.sweep_completed",
        severity,
        json!({
            "deleted": summary.deleted,
            "errors": summary.errors,
            "items": summary.items,
            "scanned": summary.scanned,
        }),
    )
    .await
}

async fn sync_monitor_chunk(
    config: &AgentConfig,
    token: &str,
    sample: &MeterSample,
    monitor_sync_failed: &mut bool,
) -> anyhow::Result<()> {
    if !config.monitor_chunk_sync_enabled {
        return Ok(());
    }

    match monitor_sync::post_monitor_chunk(config, token, sample).await {
        Ok(()) if *monitor_sync_failed => {
            *monitor_sync_failed = false;
            append_and_sync_health_event(
                config,
                Some(token),
                "agent.listen_monitor.chunk_sync_recovered",
                "info",
                json!({
                    "capturedAt": sample.frame.captured_at,
                    "durationMs": sample.monitor_duration_ms,
                    "nodeId": config.node_id,
                }),
            )
            .await
            .context("append monitor chunk sync recovery event")?;
        }
        Ok(()) => {}
        Err(error) if !*monitor_sync_failed => {
            *monitor_sync_failed = true;
            append_and_sync_health_event(
                config,
                Some(token),
                "agent.listen_monitor.chunk_sync_failed",
                "warning",
                json!({
                    "capturedAt": sample.frame.captured_at,
                    "durationMs": sample.monitor_duration_ms,
                    "error": error.to_string(),
                    "nodeId": config.node_id,
                }),
            )
            .await
            .context("append monitor chunk sync failure event")?;
            warn!(error = %error, "failed to post monitor chunk");
        }
        Err(error) => {
            warn!(error = %error, "failed to post monitor chunk");
        }
    }

    Ok(())
}

fn reap_recording_job_workers(jobs: &mut JoinSet<anyhow::Result<()>>) {
    while let Some(result) = jobs.try_join_next() {
        log_recording_job_result(result);
    }
}

fn spawn_recording_job_workers(
    config: &AgentConfig,
    jobs: &mut JoinSet<anyhow::Result<()>>,
    limit: usize,
) {
    if config.controller_token.is_none() {
        return;
    }

    let limit = limit.max(1);

    while jobs.len() < limit {
        let worker_config = config.clone();

        jobs.spawn(async move { controller::run_next_recording_job(&worker_config).await });
    }
}

async fn drain_recording_job_workers(jobs: &mut JoinSet<anyhow::Result<()>>) {
    while let Some(result) = jobs.join_next().await {
        log_recording_job_result(result);
    }
}

fn log_recording_job_result(result: Result<anyhow::Result<()>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(error = %error, "recording job worker failed"),
        Err(error) => warn!(error = %error, "recording job worker task failed"),
    }
}

fn meter_target(config: &AgentConfig, inventory: &inventory::NodeInventory) -> (String, u16) {
    let selected_interface =
        alsa_device::capture_device_interface_id(&config.capture_device, inventory)
            .and_then(|id| {
                inventory
                    .interfaces
                    .iter()
                    .find(|audio_interface| audio_interface.id == id)
            })
            .or_else(|| inventory.interfaces.first());

    let interface_id = selected_interface
        .map(|audio_interface| audio_interface.id.clone())
        .unwrap_or_else(|| "iface_default_capture".to_string());
    let channel_count = selected_interface
        .map(|audio_interface| audio_interface.channel_count.max(1))
        .unwrap_or(2);

    (interface_id, channel_count)
}

fn meter_capture_config<'a>(config: &'a AgentConfig, channel_count: u16) -> MeterCaptureConfig<'a> {
    MeterCaptureConfig {
        args_template: config.meter_args_template.as_deref(),
        channel_count,
        clip_dbfs: config.meter_clip_dbfs,
        command: &config.capture_command,
        device: &config.capture_device,
        format: &config.capture_format,
        sample_rate: config.capture_sample_rate,
        sample_seconds: config.meter_sample_seconds,
    }
}

fn audio_runtime_defaults_changed(left: &AgentConfig, right: &AgentConfig) -> bool {
    left.capture_args_template != right.capture_args_template
        || left.capture_channels != right.capture_channels
        || left.capture_command != right.capture_command
        || left.capture_device != right.capture_device
        || left.capture_format != right.capture_format
        || left.capture_sample_rate != right.capture_sample_rate
        || left.meter_args_template != right.meter_args_template
}

fn strict_meter_frame(
    config: &AgentConfig,
    node_id: &str,
    interface_id: &str,
    channel_count: u16,
    tick: u64,
    meter_capture: &MeterCaptureConfig<'_>,
) -> anyhow::Result<MeterFrame> {
    match config.meter_backend {
        MeterBackend::Synthetic => {
            synthetic_meter_frame(node_id, interface_id, channel_count, tick)
                .context("failed to create synthetic meter frame")
        }
        MeterBackend::Alsa => alsa_meter_frame(node_id, interface_id, meter_capture)
            .context("failed to create ALSA meter frame"),
    }
}

struct MeterLoopContext<'a> {
    capture: &'a MeterCaptureConfig<'a>,
    channel_count: u16,
    interface_id: &'a str,
    node_id: &'a str,
    token: Option<&'a str>,
}

async fn next_meter_sample(
    config: &AgentConfig,
    context: &MeterLoopContext<'_>,
    tick: u64,
    meter_capture_failure: &mut Option<MeterFailureKind>,
) -> anyhow::Result<MeterSample> {
    match config.meter_backend {
        MeterBackend::Synthetic => synthetic_meter_sample(
            context.node_id,
            context.interface_id,
            context.channel_count,
            tick,
        )
        .context("failed to create synthetic meter frame"),
        MeterBackend::Alsa => {
            match alsa_meter_sample(context.node_id, context.interface_id, context.capture) {
                Ok(sample) => {
                    if let Some(kind) = meter_capture_failure.take() {
                        append_and_sync_health_event(
                            config,
                            context.token,
                            "agent.meter.capture_recovered",
                            "info",
                            json!({
                                "backend": "alsa",
                                "device": config.capture_device,
                                "format": config.capture_format,
                                "previousKind": kind.as_str(),
                                "previousType": kind.event_type(),
                                "nodeId": context.node_id,
                            }),
                        )
                        .await
                        .context("append meter capture recovery event")?;
                    }

                    Ok(sample)
                }
                Err(error) => {
                    let kind = MeterFailureKind::classify(&error.to_string());
                    if *meter_capture_failure != Some(kind) {
                        *meter_capture_failure = Some(kind);
                        append_and_sync_health_event(
                            config,
                            context.token,
                            kind.event_type(),
                            kind.severity(),
                            json!({
                                "backend": "alsa",
                                "classification": kind.as_str(),
                                "device": config.capture_device,
                                "error": error.to_string(),
                                "format": config.capture_format,
                                "nodeId": context.node_id,
                                "usingSyntheticFallback": true,
                            }),
                        )
                        .await
                        .context("append meter capture failure event")?;
                    }

                    warn!(error = %error, "ALSA meter sampling failed; using synthetic fallback");
                    synthetic_meter_sample(
                        context.node_id,
                        context.interface_id,
                        context.channel_count,
                        tick,
                    )
                    .context("failed to create fallback synthetic meter frame")
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MeterFailureKind {
    CaptureFailed,
    DeviceUnavailable,
    Xrun,
}

impl MeterFailureKind {
    fn classify(error: &str) -> Self {
        let error = error.to_ascii_lowercase();

        if error.contains("overrun")
            || error.contains("underrun")
            || error.contains("xrun")
            || error.contains("broken pipe")
        {
            return Self::Xrun;
        }

        if error.contains("no such device")
            || error.contains("no such file or directory")
            || error.contains("unknown pcm")
            || error.contains("cannot find card")
            || error.contains("device or resource busy")
            || error.contains("input/output error")
        {
            return Self::DeviceUnavailable;
        }

        Self::CaptureFailed
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::CaptureFailed => "capture_failed",
            Self::DeviceUnavailable => "device_unavailable",
            Self::Xrun => "xrun",
        }
    }

    fn event_type(self) -> &'static str {
        match self {
            Self::CaptureFailed => "agent.meter.capture_failed",
            Self::DeviceUnavailable => "agent.meter.device_unavailable",
            Self::Xrun => "agent.meter.xrun",
        }
    }

    fn severity(self) -> &'static str {
        match self {
            Self::CaptureFailed | Self::Xrun => "warning",
            Self::DeviceUnavailable => "critical",
        }
    }
}

const CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE: f32 = 0.98;

async fn update_meter_health(
    config: &AgentConfig,
    token: Option<&str>,
    frame: &MeterFrame,
    channel_correlation_active: &mut bool,
    clipping_active: &mut bool,
    flatline_active: &mut bool,
) -> anyhow::Result<()> {
    let correlated_pairs = correlated_channel_pairs(frame);
    let clipping_channels = frame
        .levels
        .iter()
        .filter(|level| level.clipping)
        .collect::<Vec<_>>();
    let flatline = !frame.levels.is_empty()
        && frame
            .levels
            .iter()
            .all(|level| level.rms_dbfs <= config.meter_flatline_dbfs);

    if !correlated_pairs.is_empty() && !*channel_correlation_active {
        *channel_correlation_active = true;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.channel_correlation",
            "warning",
            json!({
                "capturedAt": frame.captured_at,
                "correlationAbsScore": CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE,
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
                "pairs": correlated_pairs,
            }),
        )
        .await
        .context("append channel correlation health event")?;
    } else if correlated_pairs.is_empty() && *channel_correlation_active {
        *channel_correlation_active = false;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.channel_correlation_recovered",
            "info",
            json!({
                "capturedAt": frame.captured_at,
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
            }),
        )
        .await
        .context("append channel correlation recovery health event")?;
    }

    if !clipping_channels.is_empty() && !*clipping_active {
        *clipping_active = true;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.clipping",
            "warning",
            json!({
                "capturedAt": frame.captured_at,
                "channels": clipping_channels
                    .iter()
                    .map(|level| json!({
                        "channelIndex": level.channel_index,
                        "label": level.label,
                        "peakDbfs": level.peak_dbfs,
                    }))
                    .collect::<Vec<_>>(),
                "clipDbfs": config.meter_clip_dbfs,
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
            }),
        )
        .await
        .context("append clipping health event")?;
    } else if clipping_channels.is_empty() && *clipping_active {
        *clipping_active = false;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.clipping_recovered",
            "info",
            json!({
                "capturedAt": frame.captured_at,
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
            }),
        )
        .await
        .context("append clipping recovery health event")?;
    }

    if flatline && !*flatline_active {
        *flatline_active = true;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.flatline",
            "warning",
            json!({
                "capturedAt": frame.captured_at,
                "flatlineDbfs": config.meter_flatline_dbfs,
                "interfaceId": frame.interface_id,
                "maxRmsDbfs": max_rms_dbfs(frame),
                "nodeId": frame.node_id,
            }),
        )
        .await
        .context("append flatline health event")?;
    } else if !flatline && *flatline_active {
        *flatline_active = false;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.flatline_recovered",
            "info",
            json!({
                "capturedAt": frame.captured_at,
                "interfaceId": frame.interface_id,
                "maxRmsDbfs": max_rms_dbfs(frame),
                "nodeId": frame.node_id,
            }),
        )
        .await
        .context("append flatline recovery health event")?;
    }

    Ok(())
}

async fn update_system_health(
    config: &AgentConfig,
    token: Option<&str>,
    inventory: &inventory::NodeInventory,
    state: &mut system_health::SystemHealthState,
) -> anyhow::Result<()> {
    for event in system_health::collect_system_health_events(config, inventory, state) {
        append_and_sync_health_event(
            config,
            token,
            event.event_type,
            event.severity,
            event.details,
        )
        .await
        .context("append system health event")?;
    }

    Ok(())
}

async fn append_and_sync_health_event(
    config: &AgentConfig,
    token: Option<&str>,
    event_type: &str,
    severity: &str,
    details: Value,
) -> anyhow::Result<()> {
    let event = health_log::append_health_event(config, event_type, severity, details)?;

    if let Some(token) = token
        && let Err(error) = controller::sync_health_event(config, token, &event).await
    {
        warn!(event_type, error = %error, "failed to sync health event");
    }

    Ok(())
}

fn max_rms_dbfs(frame: &MeterFrame) -> Option<f32> {
    frame
        .levels
        .iter()
        .map(|level| level.rms_dbfs)
        .max_by(f32::total_cmp)
}

fn correlated_channel_pairs(frame: &MeterFrame) -> Vec<Value> {
    let mut pairs: Vec<Value> = Vec::new();

    for level in &frame.levels {
        let Some(correlation) = &level.quality.channel_correlation else {
            continue;
        };

        if correlation.score.abs() < CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE {
            continue;
        }

        let left = level.channel_index.min(correlation.peer_channel_index);
        let right = level.channel_index.max(correlation.peer_channel_index);

        if pairs.iter().any(|pair| {
            pair.get("leftChannelIndex").and_then(Value::as_u64) == Some(u64::from(left))
                && pair.get("rightChannelIndex").and_then(Value::as_u64) == Some(u64::from(right))
        }) {
            continue;
        }

        pairs.push(json!({
            "leftChannelIndex": left,
            "phase": correlation.phase,
            "rightChannelIndex": right,
            "score": correlation.score,
        }));
    }

    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{AudioLevel, AudioQuality, ChannelCorrelation};

    #[test]
    fn classifies_alsa_xrun_errors() {
        assert_eq!(
            MeterFailureKind::classify("ALSA meter command exited: overrun!!!"),
            MeterFailureKind::Xrun
        );
    }

    #[test]
    fn classifies_alsa_device_unavailable_errors() {
        assert_eq!(
            MeterFailureKind::classify("Unknown PCM hw:9,9,0: No such device"),
            MeterFailureKind::DeviceUnavailable
        );
    }

    #[test]
    fn channel_correlation_pairs_deduplicate_peer_entries() {
        let frame = MeterFrame {
            captured_at: "2026-06-18T00:00:00Z".to_string(),
            interface_id: "iface_1".to_string(),
            levels: vec![
                level_with_correlation(1, 2, 0.99, "same"),
                level_with_correlation(2, 1, 0.99, "same"),
                level_with_correlation(3, 4, 0.79, "same"),
            ],
            node_id: "node_1".to_string(),
        };
        let pairs = correlated_channel_pairs(&frame);

        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0]["leftChannelIndex"], 1);
        assert_eq!(pairs[0]["rightChannelIndex"], 2);
        assert_eq!(pairs[0]["phase"], "same");
    }

    fn level_with_correlation(
        channel_index: u16,
        peer_channel_index: u16,
        score: f32,
        phase: &'static str,
    ) -> AudioLevel {
        AudioLevel {
            channel_index,
            clipping: false,
            label: format!("Input {channel_index}"),
            peak_dbfs: -12.0,
            quality: AudioQuality {
                channel_correlation: Some(ChannelCorrelation {
                    peer_channel_index,
                    phase,
                    score,
                }),
                crest_factor_db: 10.0,
                hum_score: 0.0,
                noise_score: 0.1,
                speech_like: true,
                speech_score: 0.8,
                static_score: 0.0,
                zero_crossing_rate: 0.1,
            },
            rms_dbfs: -24.0,
        }
    }
}
