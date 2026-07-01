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

// A meter condition must hold for this many consecutive frames before its
// warning is emitted, and clear for this many before recovery. Debouncing stops
// a single transient frame from producing a warning+recovery flap in the
// evidence log (the controller watchdog carries the authoritative sustained
// math; this keeps the agent's local evidence stream clean).
pub(crate) const METER_HEALTH_MIN_CONSECUTIVE_FRAMES: u8 = 3;

/// Debounced edge detector for one meter condition.
#[derive(Debug, Default)]
struct MeterConditionState {
    active: bool,
    streak: u8,
}

impl MeterConditionState {
    /// Feed the frame's raw condition. Returns `Some(true)` on a debounced
    /// rising edge (emit warning), `Some(false)` on a debounced falling edge
    /// (emit recovery), and `None` while steady or still within the debounce.
    fn transition(&mut self, present: bool, min_consecutive: u8) -> Option<bool> {
        if present == self.active {
            // Agrees with the reported state — reset progress toward a flip.
            self.streak = 0;
            return None;
        }

        self.streak = self.streak.saturating_add(1);

        if self.streak >= min_consecutive.max(1) {
            self.active = present;
            self.streak = 0;
            return Some(present);
        }

        None
    }
}

/// Per-condition debounced state for the agent meter-health events, threaded
/// across frames by the meter loop.
#[derive(Debug, Default)]
pub(crate) struct MeterHealthState {
    channel_correlation: MeterConditionState,
    clipping: MeterConditionState,
    flatline: MeterConditionState,
    low_signal: MeterConditionState,
}

pub(crate) async fn update_meter_health(
    config: &AgentConfig,
    token: Option<&str>,
    frame: &MeterFrame,
    state: &mut MeterHealthState,
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

    // Debounced rising/falling edges — a condition must persist (or clear) for
    // METER_HEALTH_MIN_CONSECUTIVE_FRAMES before its event fires.
    let correlation_edge = state.channel_correlation.transition(
        !correlated_pairs.is_empty(),
        METER_HEALTH_MIN_CONSECUTIVE_FRAMES,
    );
    let clipping_edge = state.clipping.transition(
        !clipping_channels.is_empty(),
        METER_HEALTH_MIN_CONSECUTIVE_FRAMES,
    );
    let flatline_edge = state
        .flatline
        .transition(flatline, METER_HEALTH_MIN_CONSECUTIVE_FRAMES);
    let low_signal_edge = state
        .low_signal
        .transition(low_signal, METER_HEALTH_MIN_CONSECUTIVE_FRAMES);

    if correlation_edge == Some(true) {
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
    } else if correlation_edge == Some(false) {
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

    if clipping_edge == Some(true) {
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
    } else if clipping_edge == Some(false) {
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

    if flatline_edge == Some(true) {
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
    } else if flatline_edge == Some(false) {
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

    if low_signal_edge == Some(true) {
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
    } else if low_signal_edge == Some(false) {
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

#[cfg(test)]
mod tests {
    use super::{METER_HEALTH_MIN_CONSECUTIVE_FRAMES, MeterConditionState};

    #[test]
    fn a_single_transient_frame_does_not_flap() {
        let mut state = MeterConditionState::default();
        let min = METER_HEALTH_MIN_CONSECUTIVE_FRAMES;

        // One bad frame then back to good — no warning, no recovery.
        assert_eq!(state.transition(true, min), None);
        assert_eq!(state.transition(false, min), None);
        assert!(!state.active);
    }

    #[test]
    fn sustained_condition_raises_then_recovers_once() {
        let mut state = MeterConditionState::default();
        let min = METER_HEALTH_MIN_CONSECUTIVE_FRAMES; // 3

        // Rising edge only fires after `min` consecutive bad frames.
        assert_eq!(state.transition(true, min), None);
        assert_eq!(state.transition(true, min), None);
        assert_eq!(state.transition(true, min), Some(true));
        // Steady bad frames do not re-fire.
        assert_eq!(state.transition(true, min), None);

        // Falling edge only fires after `min` consecutive good frames.
        assert_eq!(state.transition(false, min), None);
        assert_eq!(state.transition(false, min), None);
        assert_eq!(state.transition(false, min), Some(false));
        assert_eq!(state.transition(false, min), None);
    }

    #[test]
    fn interrupted_streak_resets() {
        let mut state = MeterConditionState::default();

        // Two bad frames, one good frame resets, so it never latches.
        assert_eq!(state.transition(true, 3), None);
        assert_eq!(state.transition(true, 3), None);
        assert_eq!(state.transition(false, 3), None); // resets progress
        assert_eq!(state.transition(true, 3), None);
        assert_eq!(state.transition(true, 3), None);
        assert_eq!(state.transition(true, 3), Some(true));
    }

    #[test]
    fn min_of_zero_is_treated_as_one() {
        let mut state = MeterConditionState::default();

        assert_eq!(state.transition(true, 0), Some(true));
    }
}
