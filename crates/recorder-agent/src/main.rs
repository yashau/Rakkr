mod capture;
mod config;
mod controller;
mod health_log;
mod inventory;
mod state;
mod telemetry;

use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use config::AgentConfig;
use serde_json::{Value, json};
use telemetry::{MeterCaptureConfig, MeterFrame, alsa_meter_frame, synthetic_meter_frame};
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

    let meter_interface_id = inventory
        .interfaces
        .first()
        .map(|audio_interface| audio_interface.id.clone())
        .unwrap_or_else(|| "iface_default_capture".to_string());
    let meter_channel_count = inventory
        .interfaces
        .first()
        .map(|audio_interface| audio_interface.channel_count.max(1))
        .unwrap_or(2);
    let meter_capture = MeterCaptureConfig {
        channel_count: meter_channel_count,
        clip_dbfs: config.meter_clip_dbfs,
        command: &config.capture_command,
        device: &config.capture_device,
        format: &config.capture_format,
        sample_rate: config.capture_sample_rate,
        sample_seconds: config.meter_sample_seconds,
    };
    let mut ticker = tokio::time::interval(Duration::from_secs(config.heartbeat_seconds));
    let mut tick = 0_u64;
    let mut meter_capture_failed = false;
    let mut meter_clipping_active = false;
    let mut meter_flatline_active = false;
    let mut meter_sync_failed = false;
    let token = config.controller_token.as_deref();
    let meter_context = MeterLoopContext {
        capture: &meter_capture,
        channel_count: meter_channel_count,
        interface_id: &meter_interface_id,
        node_id: &inventory.id,
        token,
    };

    append_and_sync_health_event(
        &config,
        token,
        "agent.started",
        "info",
        json!({
            "alias": inventory.alias,
            "controllerUrl": config.controller_url,
            "meterBackend": config.meter_backend,
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
                let frame = next_meter_frame(
                    &config,
                    &meter_context,
                    tick,
                    &mut meter_capture_failed,
                ).await?;

                info!(
                    captured_at = %frame.captured_at,
                    channels = frame.levels.len(),
                    "recorder heartbeat"
                );

                update_meter_health(
                    &config,
                    token,
                    &frame,
                    &mut meter_clipping_active,
                    &mut meter_flatline_active,
                ).await?;

                if let Some(token) = token {
                    match controller::post_meter_frame(&config, token, &frame).await {
                        Ok(()) if meter_sync_failed => {
                            meter_sync_failed = false;
                            append_and_sync_health_event(
                                &config,
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
                                &config,
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
                }
            }
        }
    }

    Ok(())
}

struct MeterLoopContext<'a> {
    capture: &'a MeterCaptureConfig<'a>,
    channel_count: u16,
    interface_id: &'a str,
    node_id: &'a str,
    token: Option<&'a str>,
}

async fn next_meter_frame(
    config: &AgentConfig,
    context: &MeterLoopContext<'_>,
    tick: u64,
    meter_capture_failed: &mut bool,
) -> anyhow::Result<MeterFrame> {
    match config.meter_backend.to_ascii_lowercase().as_str() {
        "synthetic" => synthetic_meter_frame(
            context.node_id,
            context.interface_id,
            context.channel_count,
            tick,
        )
        .context("failed to create synthetic meter frame"),
        "alsa" => match alsa_meter_frame(context.node_id, context.interface_id, context.capture) {
            Ok(frame) => {
                if *meter_capture_failed {
                    *meter_capture_failed = false;
                    append_and_sync_health_event(
                        config,
                        context.token,
                        "agent.meter.capture_recovered",
                        "info",
                        json!({
                            "backend": "alsa",
                            "device": config.capture_device,
                            "format": config.capture_format,
                            "nodeId": context.node_id,
                        }),
                    )
                    .await
                    .context("append meter capture recovery event")?;
                }

                Ok(frame)
            }
            Err(error) => {
                if !*meter_capture_failed {
                    *meter_capture_failed = true;
                    append_and_sync_health_event(
                        config,
                        context.token,
                        "agent.meter.capture_failed",
                        "warning",
                        json!({
                            "backend": "alsa",
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
                synthetic_meter_frame(
                    context.node_id,
                    context.interface_id,
                    context.channel_count,
                    tick,
                )
                .context("failed to create fallback synthetic meter frame")
            }
        },
        backend => {
            warn!(backend, "unknown meter backend; using synthetic fallback");
            synthetic_meter_frame(
                context.node_id,
                context.interface_id,
                context.channel_count,
                tick,
            )
            .context("failed to create synthetic meter frame")
        }
    }
}

async fn update_meter_health(
    config: &AgentConfig,
    token: Option<&str>,
    frame: &MeterFrame,
    clipping_active: &mut bool,
    flatline_active: &mut bool,
) -> anyhow::Result<()> {
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
