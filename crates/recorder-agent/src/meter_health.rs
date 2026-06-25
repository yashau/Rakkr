use anyhow::Context;
use serde_json::{Value, json};

use crate::append_and_sync_health_event;
use crate::config::AgentConfig;
use crate::telemetry::{
    MeterFaultKind, MeterFrame, meter_fault_score, meter_max_rms_dbfs, meter_quality_evidence,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MeterFailureKind {
    CaptureFailed,
    DeviceUnavailable,
    Xrun,
}

impl MeterFailureKind {
    pub(crate) fn classify(error: &str) -> Self {
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

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CaptureFailed => "capture_failed",
            Self::DeviceUnavailable => "device_unavailable",
            Self::Xrun => "xrun",
        }
    }

    pub(crate) fn event_type(self) -> &'static str {
        match self {
            Self::CaptureFailed => "agent.meter.capture_failed",
            Self::DeviceUnavailable => "agent.meter.device_unavailable",
            Self::Xrun => "agent.meter.xrun",
        }
    }

    pub(crate) fn severity(self) -> &'static str {
        match self {
            Self::CaptureFailed | Self::Xrun => "warning",
            Self::DeviceUnavailable => "critical",
        }
    }
}

pub(crate) const CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE: f32 = 0.98;

pub(crate) async fn update_meter_health(
    config: &AgentConfig,
    token: Option<&str>,
    frame: &MeterFrame,
    channel_correlation_active: &mut bool,
    clipping_active: &mut bool,
    flatline_active: &mut bool,
    low_signal_active: &mut bool,
) -> anyhow::Result<()> {
    let correlated_pairs = correlated_channel_pairs(frame);
    let quality_evidence = meter_quality_evidence(frame);
    let clipping_channels = frame
        .levels
        .iter()
        .filter(|level| level.clipping)
        .collect::<Vec<_>>();
    let frame_max_rms_dbfs = meter_max_rms_dbfs(frame);
    let flatline = !frame.levels.is_empty()
        && frame
            .levels
            .iter()
            .all(|level| level.rms_dbfs <= config.meter_flatline_dbfs);
    let low_signal = !frame.levels.is_empty()
        && !flatline
        && frame_max_rms_dbfs.is_some_and(|value| value <= config.meter_low_signal_dbfs);
    let correlation_fault_score = meter_fault_score(
        frame,
        MeterFaultKind::ChannelCorrelation(CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE),
    );

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
                "faultScore": correlation_fault_score,
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
                "pairs": correlated_pairs,
                "quality": quality_evidence,
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
                "faultScore": meter_fault_score(frame, MeterFaultKind::Clipping(config.meter_clip_dbfs)),
                "interfaceId": frame.interface_id,
                "nodeId": frame.node_id,
                "quality": quality_evidence,
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
                "faultScore": meter_fault_score(frame, MeterFaultKind::Flatline(config.meter_flatline_dbfs)),
                "flatlineDbfs": config.meter_flatline_dbfs,
                "interfaceId": frame.interface_id,
                "maxRmsDbfs": frame_max_rms_dbfs,
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
                "maxRmsDbfs": frame_max_rms_dbfs,
                "nodeId": frame.node_id,
                "quality": quality_evidence,
            }),
        )
        .await
        .context("append flatline recovery health event")?;
    }

    if low_signal && !*low_signal_active {
        *low_signal_active = true;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.low_signal",
            "warning",
            json!({
                "capturedAt": frame.captured_at,
                "faultScore": meter_fault_score(frame, MeterFaultKind::LowSignal(config.meter_low_signal_dbfs)),
                "interfaceId": frame.interface_id,
                "lowSignalDbfs": config.meter_low_signal_dbfs,
                "maxRmsDbfs": frame_max_rms_dbfs,
                "maxSpeechScore": quality_evidence.max_speech_score,
                "nodeId": frame.node_id,
                "quality": quality_evidence,
            }),
        )
        .await
        .context("append low signal health event")?;
    } else if !low_signal && *low_signal_active {
        *low_signal_active = false;
        append_and_sync_health_event(
            config,
            token,
            "agent.meter.low_signal_recovered",
            "info",
            json!({
                "capturedAt": frame.captured_at,
                "interfaceId": frame.interface_id,
                "maxRmsDbfs": frame_max_rms_dbfs,
                "maxSpeechScore": quality_evidence.max_speech_score,
                "nodeId": frame.node_id,
                "quality": quality_evidence,
            }),
        )
        .await
        .context("append low signal recovery health event")?;
    }

    Ok(())
}

pub(crate) fn correlated_channel_pairs(frame: &MeterFrame) -> Vec<Value> {
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
