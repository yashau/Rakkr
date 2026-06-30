use super::*;

#[test]
fn builds_recording_cache_url_without_double_slashes() {
    assert_eq!(
        recording_cache_url("https://controller.local/", "rec_123"),
        "https://controller.local/api/v1/recordings/rec_123/cache-file"
    );
}

#[test]
fn builds_node_url_without_double_slashes() {
    assert_eq!(
        node_url("https://controller.local/", "node_1", "/meter-frame"),
        "https://controller.local/api/v1/nodes/node_1/meter-frame"
    );
}

#[test]
fn parses_controller_date_header_skew() {
    let now = OffsetDateTime::parse("Wed, 25 Jun 2036 11:59:55 GMT", &Rfc2822).expect("parse now");
    let skew = controller_clock_skew_seconds_at("Wed, 25 Jun 2036 12:00:00 GMT", now)
        .expect("parse future date header");

    assert_eq!(skew, 5);
    assert!(controller_clock_skew_seconds_at("not a date", now).is_none());
}

fn capture_command(
    channel_map_source: Option<u16>,
    selection: Option<Vec<u16>>,
    capture_channels: u16,
) -> ControllerCaptureCommand {
    ControllerCaptureCommand {
        capture_backend: None,
        capture_channels,
        capture_channel_selection: selection,
        capture_device: "hw:0".to_string(),
        capture_format: "S16_LE".to_string(),
        capture_group_id: Some("cap_session".to_string()),
        capture_interface_id: Some("iface".to_string()),
        capture_sample_rate: 48_000,
        channel_map: channel_map_source.map(|source_channels| ControllerRecordingJobChannelMap {
            assignment_id: "assignment".to_string(),
            channel_mode: "stereo".to_string(),
            entries: Vec::new(),
            source_channels,
            target_id: "iface".to_string(),
            target_type: "interface".to_string(),
            template_id: "template".to_string(),
            template_name: "Template".to_string(),
        }),
        duration_seconds: 60,
        enhancement: None,
        output_bitrate_kbps: None,
        output_codec: Some("wav".to_string()),
        output_file_name: "rec.wav".to_string(),
        output_vbr: None,
        recorder_cache_retention: None,
        track_group_id: None,
        track_index: None,
        track_total: None,
    }
}

fn group_member(command: ControllerCaptureCommand, id: &str) -> ControllerRecordingJob {
    ControllerRecordingJob {
        command,
        failure_reason: None,
        id: id.to_string(),
        node_id: "node_1".to_string(),
        recording_id: format!("rec_{id}"),
        status: "running".to_string(),
    }
}

#[test]
fn member_channel_span_prefers_map_then_selection_then_count() {
    assert_eq!(member_channel_span(&capture_command(Some(32), None, 2)), 32);
    assert_eq!(
        member_channel_span(&capture_command(None, Some(vec![5, 6]), 2)),
        6
    );
    assert_eq!(member_channel_span(&capture_command(None, None, 8)), 8);
}

#[test]
fn session_capture_channels_uses_widest_member_span() {
    let secondaries = vec![
        group_member(capture_command(Some(4), None, 2), "b"),
        group_member(capture_command(Some(32), None, 2), "c"),
    ];

    // Primary owns ch1-2 but ch31-32 are claimed by a sibling, so the shared
    // capture must record all 32 channels.
    assert_eq!(session_capture_channels(2, &secondaries), 32);
    // A lone job (no siblings) keeps its own channel span.
    assert_eq!(session_capture_channels(2, &[]), 2);
}
