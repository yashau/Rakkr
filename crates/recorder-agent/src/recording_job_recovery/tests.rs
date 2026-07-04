use super::*;
use clap::Parser;

#[test]
fn classifies_capture_device_unavailable_errors() {
    assert!(is_capture_device_unavailable(&anyhow::anyhow!(
        "run capture command arecord: Unknown PCM hw:9,9"
    )));
    assert!(!is_capture_device_unavailable(&anyhow::anyhow!(
        "run capture command arecord: permission denied"
    )));
}

#[test]
fn classifies_mid_capture_device_lost_errors() {
    assert!(is_capture_device_lost(&anyhow::anyhow!(
        "capture command arecord failed with status exit code: 1: arecord: pcm_read: Input/output error"
    )));
    assert!(is_capture_device_lost(&anyhow::anyhow!(
        "capture command pw-record failed with status exit code: 1: Broken pipe"
    )));
    assert!(!is_capture_device_lost(&anyhow::anyhow!(
        "capture command fake failed with status exit code: 43: simulated capture failure"
    )));
}

#[test]
fn classifies_alsa_capture_device_refs() {
    assert!(is_alsa_capture_device_ref("hw:CARD=XUSB,DEV=0"));
    assert!(is_alsa_capture_device_ref("plughw:2,0"));
    assert!(!is_alsa_capture_device_ref("usb-1-1"));
    assert!(!is_alsa_capture_device_ref("jack:system:capture_1"));
}

#[test]
#[cfg_attr(miri, ignore)]
fn restart_recovery_rejects_tiny_partial_capture() {
    let root = PathBuf::from("target").join("rakkr-restart-tiny-partial");
    let output_path = root.join("partial.wav");
    fs::create_dir_all(&root).expect("create temp root");
    fs::write(&output_path, b"tiny").expect("write tiny output");
    let state_file = root.join("state.json");
    let state_file_arg = state_file.to_string_lossy().into_owned();
    let output_path_arg = output_path.to_string_lossy().into_owned();
    let config = AgentConfig::parse_from([
        "test",
        "--agent-state-file",
        state_file_arg.as_str(),
        "--capture-min-output-bytes",
        "44",
    ]);
    let state = AgentJobState {
        job_id: "job_tiny_partial".to_string(),
        node_id: "node_tiny_partial".to_string(),
        output_path: Some(output_path_arg),
        reason: None,
        raw_output_path: None,
        recording_id: "rec_tiny_partial".to_string(),
        recorder_cache_retention: None,
        recovered_segments: Vec::new(),
        status: "running".to_string(),
        updated_at: "2026-06-25T00:00:00Z".to_string(),
        upload_content_type: None,
        upload_duration_seconds: None,
        upload_file_name: None,
        chunk_total: None,
        uploaded_chunk_count: None,
        pending_chunks: Vec::new(),
    };

    assert!(recoverable_restart_output_path(&config, &state).is_none());

    let _ = fs::remove_dir_all(root);
}
