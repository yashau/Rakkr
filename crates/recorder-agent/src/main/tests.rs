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

#[test]
fn meter_health_score_helpers_track_max_signal_values() {
    let frame = MeterFrame {
        captured_at: "2026-06-18T00:00:00Z".to_string(),
        interface_id: "iface_1".to_string(),
        levels: vec![
            level_with_signal(1, -62.0, 0.2),
            level_with_signal(2, -64.0, 0.47),
        ],
        node_id: "node_1".to_string(),
    };
    let quality = meter_quality_evidence(&frame);

    assert_eq!(meter_max_rms_dbfs(&frame), Some(-62.0));
    assert_eq!(quality.max_speech_score, Some(0.47));
    assert_eq!(quality.max_noise_score, Some(0.12));
    assert_eq!(quality.min_estimated_snr_db, Some(8.0));
    assert_eq!(quality.min_intelligibility_score, Some(0.35));
}

#[test]
fn meter_fault_scores_are_normalized() {
    let low_frame = meter_frame(vec![level_with_signal(1, -62.0, 0.2)]);
    let flatline_frame = meter_frame(vec![level_with_signal(1, -160.0, 0.0)]);
    let clipping_frame = meter_frame(vec![level_with_signal(1, -20.0, 0.2)]);
    let correlated_frame = meter_frame(vec![level_with_correlation(1, 2, 0.99, "same")]);

    assert_eq!(
        meter_fault_score(&low_frame, MeterFaultKind::LowSignal(-55.0),),
        Some(0.23)
    );
    assert_eq!(
        meter_fault_score(&flatline_frame, MeterFaultKind::Flatline(-120.0),),
        Some(1.0)
    );
    assert_eq!(
        meter_fault_score(&clipping_frame, MeterFaultKind::Clipping(-1.0)),
        Some(1.0)
    );
    assert_eq!(
        meter_fault_score(
            &correlated_frame,
            MeterFaultKind::ChannelCorrelation(CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE),
        ),
        Some(0.5)
    );
}

#[tokio::test]
#[cfg_attr(miri, ignore)]
async fn meter_health_logs_low_signal_and_recovery() {
    let health_log_file = temp_health_log_path("low-signal");
    let config = AgentConfig::parse_from([
        "rakkr-recorder-agent",
        "--agent-health-log-file",
        health_log_file.to_str().expect("utf8 health log path"),
        "--meter-low-signal-dbfs=-55",
    ]);
    let low_frame = MeterFrame {
        captured_at: "2026-06-18T00:00:00Z".to_string(),
        interface_id: "iface_1".to_string(),
        levels: vec![
            level_with_signal(1, -62.0, 0.2),
            level_with_signal(2, -64.0, 0.47),
        ],
        node_id: "node_1".to_string(),
    };
    let recovered_frame = MeterFrame {
        captured_at: "2026-06-18T00:00:02Z".to_string(),
        interface_id: "iface_1".to_string(),
        levels: vec![
            level_with_signal(1, -30.0, 0.82),
            level_with_signal(2, -31.0, 0.8),
        ],
        node_id: "node_1".to_string(),
    };
    let mut channel_correlation_active = false;
    let mut clipping_active = false;
    let mut flatline_active = false;
    let mut low_signal_active = false;

    update_meter_health(
        &config,
        None,
        &low_frame,
        &mut channel_correlation_active,
        &mut clipping_active,
        &mut flatline_active,
        &mut low_signal_active,
    )
    .await
    .expect("log low signal");
    update_meter_health(
        &config,
        None,
        &recovered_frame,
        &mut channel_correlation_active,
        &mut clipping_active,
        &mut flatline_active,
        &mut low_signal_active,
    )
    .await
    .expect("log low signal recovery");

    let contents = std::fs::read_to_string(&health_log_file).expect("read health log");

    assert!(contents.contains(r#""type":"agent.meter.low_signal""#));
    assert!(contents.contains(r#""type":"agent.meter.low_signal_recovered""#));
    assert!(contents.contains(r#""lowSignalDbfs":-55.0"#));
    assert!(contents.contains(r#""maxRmsDbfs":-62.0"#));
    let low_signal = contents
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("parse health event"))
        .find(|event| event["type"] == "agent.meter.low_signal")
        .expect("low-signal event");
    assert_json_f32(&low_signal["details"]["faultScore"], 0.23);
    assert_json_f32(&low_signal["details"]["maxSpeechScore"], 0.47);
    assert_json_f32(
        &low_signal["details"]["quality"]["maxBroadbandNoiseScore"],
        0.02,
    );
    assert_json_f32(&low_signal["details"]["quality"]["minEstimatedSnrDb"], 8.0);
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
            broadband_noise_score: 0.18,
            crest_factor_db: 10.0,
            estimated_snr_db: 18.0,
            hum_score: 0.0,
            intelligibility_score: 0.72,
            noise_score: 0.1,
            speech_like: true,
            speech_score: 0.8,
            static_score: 0.0,
            zero_crossing_rate: 0.1,
        },
        rms_dbfs: -24.0,
    }
}

fn level_with_signal(channel_index: u16, rms_dbfs: f32, speech_score: f32) -> AudioLevel {
    AudioLevel {
        channel_index,
        clipping: false,
        label: format!("Input {channel_index}"),
        peak_dbfs: rms_dbfs + 20.0,
        quality: AudioQuality {
            channel_correlation: None,
            broadband_noise_score: 0.02,
            crest_factor_db: 10.0,
            estimated_snr_db: 8.0,
            hum_score: 0.0,
            intelligibility_score: 0.35,
            noise_score: 0.12,
            speech_like: speech_score >= 0.55,
            speech_score,
            static_score: 0.0,
            zero_crossing_rate: 0.1,
        },
        rms_dbfs,
    }
}

fn meter_frame(levels: Vec<AudioLevel>) -> MeterFrame {
    MeterFrame {
        captured_at: "2026-06-18T00:00:00Z".to_string(),
        interface_id: "iface_1".to_string(),
        levels,
        node_id: "node_1".to_string(),
    }
}

fn temp_health_log_path(name: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let process_id = std::process::id();
    let directory = std::path::PathBuf::from("target").join(format!(
        "rakkr-agent-main-test-{name}-{process_id}-{counter}"
    ));
    std::fs::create_dir_all(&directory).expect("create temp health log directory");

    directory.join("health-events.jsonl")
}

fn assert_json_f32(value: &Value, expected: f64) {
    let actual = value.as_f64().expect("json number");

    assert!(
        (actual - expected).abs() < 0.001,
        "expected {expected}, got {actual}"
    );
}
