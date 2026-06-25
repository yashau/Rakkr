use anyhow::Context;
use serde_json::json;
use tracing::warn;

use crate::config::AgentConfig;
use crate::{append_and_sync_health_event, recording_job_recovery};

const CLOCK_SKEW_RECOVERY_SECONDS: i64 = 2;
const CLOCK_SKEW_WARNING_SECONDS: i64 = 5;

pub(crate) async fn reconcile_previous_recording_job_state(
    config: &AgentConfig,
    token: &str,
    was_pending: bool,
) -> anyhow::Result<bool> {
    match recording_job_recovery::reconcile_previous_recording_job(config, token).await {
        Ok(()) => {
            if was_pending {
                append_and_sync_health_event(
                    config,
                    Some(token),
                    "agent.recording_job.restart_recovery_synced",
                    "info",
                    json!({ "nodeId": config.node_id.as_str() }),
                )
                .await
                .context("append recording job recovery sync event")?;
            }

            Ok(false)
        }
        Err(error) => {
            warn!(error = %error, "recording job restart recovery remains pending");
            Ok(true)
        }
    }
}

pub(crate) async fn update_clock_skew_health(
    config: &AgentConfig,
    token: &str,
    skew_seconds: Option<i64>,
    clock_skew_active: &mut bool,
) -> anyhow::Result<()> {
    let Some(skew_seconds) = skew_seconds else {
        return Ok(());
    };
    let absolute_skew_seconds = skew_seconds.abs();

    if absolute_skew_seconds > CLOCK_SKEW_WARNING_SECONDS && !*clock_skew_active {
        *clock_skew_active = true;
        append_and_sync_health_event(
            config,
            Some(token),
            "agent.system.clock_skew",
            "warning",
            json!({
                "absoluteSkewSeconds": absolute_skew_seconds,
                "nodeId": config.node_id.as_str(),
                "skewSeconds": skew_seconds,
                "warningSeconds": CLOCK_SKEW_WARNING_SECONDS,
            }),
        )
        .await
        .context("append clock skew health event")?;
    } else if absolute_skew_seconds <= CLOCK_SKEW_RECOVERY_SECONDS && *clock_skew_active {
        *clock_skew_active = false;
        append_and_sync_health_event(
            config,
            Some(token),
            "agent.system.clock_skew_recovered",
            "info",
            json!({
                "absoluteSkewSeconds": absolute_skew_seconds,
                "nodeId": config.node_id.as_str(),
                "skewSeconds": skew_seconds,
            }),
        )
        .await
        .context("append clock skew recovery health event")?;
    }

    Ok(())
}
