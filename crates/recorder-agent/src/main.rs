mod config;
mod inventory;
mod telemetry;

use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use config::AgentConfig;
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
            }
        }
    }

    Ok(())
}
