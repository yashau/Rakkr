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
use serde_json::json;
use telemetry::synthetic_meter_frame;
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
    let mut ticker = tokio::time::interval(Duration::from_secs(config.heartbeat_seconds));
    let mut tick = 0_u64;
    let mut meter_sync_failed = false;
    let token = config.controller_token.as_deref();
    let started_event = health_log::append_health_event(
        &config,
        "agent.started",
        "info",
        json!({
            "alias": inventory.alias,
            "controllerUrl": config.controller_url,
            "nodeId": inventory.id,
        }),
    )
    .context("append startup health event")?;

    if let Some(token) = token
        && let Err(error) = controller::sync_health_event(&config, token, &started_event).await
    {
        warn!(error = %error, "failed to sync startup health event");
    }

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                warn!("shutdown signal received");
                break;
            }
            _ = ticker.tick() => {
                tick += 1;
                let frame = synthetic_meter_frame(
                    &inventory.id,
                    &meter_interface_id,
                    meter_channel_count,
                    tick,
                )
                .context("failed to create synthetic meter frame")?;

                info!(
                    captured_at = %frame.captured_at,
                    channels = frame.levels.len(),
                    "recorder heartbeat"
                );

                if let Some(token) = token {
                    match controller::post_meter_frame(&config, token, &frame).await {
                        Ok(()) if meter_sync_failed => {
                            meter_sync_failed = false;
                            let event = health_log::append_health_event(
                                &config,
                                "agent.meter_frame.sync_recovered",
                                "info",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "nodeId": inventory.id,
                                }),
                            )
                            .context("append meter sync recovery event")?;

                            if let Err(error) = controller::sync_health_event(&config, token, &event).await {
                                warn!(error = %error, "failed to sync meter recovery health event");
                            }
                        }
                        Ok(()) => {}
                        Err(error) if !meter_sync_failed => {
                            meter_sync_failed = true;
                            let event = health_log::append_health_event(
                                &config,
                                "agent.meter_frame.sync_failed",
                                "warning",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "error": error.to_string(),
                                    "nodeId": inventory.id,
                                }),
                            )
                            .context("append meter sync failure event")?;

                            warn!(error = %error, "failed to post meter frame");

                            if let Err(sync_error) = controller::sync_health_event(&config, token, &event).await {
                                warn!(error = %sync_error, "failed to sync meter failure health event");
                            }
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
