//! Per-tick health evidence helpers for the heartbeat loop.
//!
//! These wrap the best-effort meter/system-health updates and the shared
//! append-and-sync health-event write. They are extracted from the crate root
//! so the loop stays under the per-file LOC budget; behavior is unchanged.

use anyhow::Context;
use serde_json::Value;
use tracing::warn;

use crate::config::AgentConfig;
use crate::meter_health::{MeterHealthState, update_meter_health};
use crate::telemetry::MeterFrame;
use crate::{controller, health_log, inventory, system_health};

// Runs the per-tick meter and system health updates as best-effort work. A
// transient health-evidence write failure (full disk, unwritable path, poisoned
// lock) must not abort the heartbeat/meter/job loop and take the whole node dark
// — a node that stops heartbeating is worse than a gap in local evidence, and the
// controller's stale-heartbeat watchdog is the backstop for a genuinely dead node.
// Failures are logged and counted rather than propagated; returns the count.
pub(crate) async fn apply_tick_health_updates(
    config: &AgentConfig,
    token: Option<&str>,
    frame: &MeterFrame,
    inventory: &inventory::NodeInventory,
    meter_state: &mut MeterHealthState,
    system_state: &mut system_health::SystemHealthState,
) -> u32 {
    let mut failures = 0;

    if let Err(error) = update_meter_health(config, token, frame, meter_state).await {
        failures += 1;
        warn!(error = %error, "failed to update meter health; continuing heartbeat");
    }

    if let Err(error) = update_system_health(config, token, inventory, system_state).await {
        failures += 1;
        warn!(error = %error, "failed to update system health; continuing heartbeat");
    }

    failures
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

pub(crate) async fn append_and_sync_health_event(
    config: &AgentConfig,
    token: Option<&str>,
    event_type: &str,
    severity: &str,
    details: Value,
) -> anyhow::Result<()> {
    // Best-effort local evidence: a health-log append failure (full disk, unwritable
    // health-log dir) must NOT propagate out of the heartbeat/recovery tick and kill
    // the daemon — the agent can still capture audio and sync with the controller.
    // Log and move on, mirroring the controller-sync half below. R14-HEALTH-FATAL:
    // this is the complete guard; apply_tick_health_updates only covered the
    // meter/system-health call sites, but the tick also appends heartbeat/meter/
    // node-config/capture/monitor/cache-sweep sync-edge events through here.
    let event = match health_log::append_health_event(config, event_type, severity, details) {
        Ok(event) => event,
        Err(error) => {
            warn!(event_type, error = %error, "failed to append health event; continuing");
            return Ok(());
        }
    };

    if let Some(token) = token
        && let Err(error) = controller::sync_health_event(config, token, &event).await
    {
        warn!(event_type, error = %error, "failed to sync health event");
    }

    Ok(())
}
