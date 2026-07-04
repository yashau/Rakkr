use super::*;
use crate::config::CaptureBackend;
use crate::controller::{
    ControllerChannelMapAssignment, ControllerChannelMapEntry, ControllerChannelMapTemplate,
};

#[test]
fn pinned_job_channel_map_wins_over_live_assignments() {
    let selected = capture_channel_map_for_job(
        "node_1",
        &command_with_pinned_channel_map(),
        &[channel_map_bundle(
            "live_assignment",
            "node",
            "node_1",
            "live_template",
            &[8],
        )],
    )
    .expect("selected channel map");

    assert_eq!(selected.assignment_id, "pinned_assignment");
    assert_eq!(selected.source_channels, 3);
    assert_eq!(selected.template_id, "pinned_template");
}

#[test]
fn selects_interface_channel_map_before_node_channel_map() {
    let selected = select_capture_channel_map(
        "node_1",
        Some("interface_1"),
        "hw:1,0",
        &[
            channel_map_bundle("node_assignment", "node", "node_1", "node_template", &[4]),
            channel_map_bundle(
                "interface_assignment",
                "interface",
                "interface_1",
                "interface_template",
                &[2],
            ),
        ],
    )
    .expect("selected channel map");

    assert_eq!(selected.assignment_id, "interface_assignment");
    assert_eq!(selected.source_channels, 2);
}

#[test]
fn node_channel_map_uses_highest_included_source_channel() {
    let selected = select_capture_channel_map(
        "node_1",
        None,
        "default",
        &[channel_map_bundle(
            "node_assignment",
            "node",
            "node_1",
            "node_template",
            &[1, 8],
        )],
    )
    .expect("selected channel map");

    assert_eq!(selected.source_channels, 8);
    assert_eq!(selected.template_id, "node_template");
}

#[test]
fn ignores_channel_map_without_included_entries() {
    assert!(
        select_capture_channel_map(
            "node_1",
            None,
            "default",
            &[channel_map_bundle(
                "node_assignment",
                "node",
                "node_1",
                "node_template",
                &[],
            )],
        )
        .is_none()
    );
}

fn command_with_pinned_channel_map() -> ControllerCaptureCommand {
    ControllerCaptureCommand {
        capture_backend: None,
        capture_channels: 2,
        capture_channel_selection: None,
        capture_device: "default".to_string(),
        capture_format: "S16_LE".to_string(),
        capture_group_id: None,
        capture_interface_id: Some("interface_1".to_string()),
        capture_sample_rate: 48_000,
        enhancement: None,
        channel_map: Some(ControllerRecordingJobChannelMap {
            assignment_id: "pinned_assignment".to_string(),
            channel_mode: "mono_to_stereo_mix".to_string(),
            entries: channel_map_entries(&[3]),
            source_channels: 3,
            target_id: "interface_1".to_string(),
            target_type: "interface".to_string(),
            template_id: "pinned_template".to_string(),
            template_name: "Pinned Template".to_string(),
        }),
        chunk_seconds: None,
        duration_seconds: 60,
        output_bitrate_kbps: Some(128),
        output_codec: Some("mp3".to_string()),
        output_file_name: "rec.wav".to_string(),
        output_vbr: Some(true),
        recorder_cache_retention: None,
        track_group_id: None,
        track_index: None,
        track_total: None,
    }
}

#[test]
fn builds_mono_to_stereo_mix_pan_filter() {
    let channel_map = capture_channel_map("mono_to_stereo_mix", &[1, 3]);
    let plan = channel_render_plan(&channel_map).expect("render plan");

    assert_eq!(
        plan.filter,
        "pan=stereo|c0=0.500000*c0+0.500000*c2|c1=0.500000*c0+0.500000*c2"
    );
    assert_eq!(plan.output_channels, 2);
}

#[test]
fn builds_stereo_pan_filter_from_output_indexes() {
    let mut channel_map = capture_channel_map("stereo", &[5, 2]);

    channel_map.entries[1].output_channel_index = Some(2);
    channel_map.entries[2].output_channel_index = Some(1);
    let plan = channel_render_plan(&channel_map).expect("render plan");

    assert_eq!(plan.filter, "pan=stereo|c0=c1|c1=c4");
}

#[test]
fn rendered_capture_path_preserves_original_extension() {
    assert_eq!(raw_capture_file_name("rec.mp3"), "rec.raw.wav");
}

#[test]
fn mp3_vbr_render_args_use_profile_bitrate_quality() {
    let plan = render_test_plan("mp3", Some(128), true, "rec.mp3");
    let args = render_command_args(&plan, Path::new("rec.raw.wav"), None);
    let text_args = string_args(args);

    assert!(
        text_args
            .windows(2)
            .any(|args| args[0] == "-codec:a" && args[1] == "libmp3lame")
    );
    assert!(
        text_args
            .windows(2)
            .any(|args| args[0] == "-q:a" && args[1] == "5")
    );
    assert_eq!(text_args.last().map(String::as_str), Some("rec.mp3"));
}

#[test]
fn flac_render_args_use_flac_encoder() {
    let plan = render_test_plan("flac", None, false, "rec.flac");
    let args = string_args(render_command_args(&plan, Path::new("rec.raw.wav"), None));

    assert!(
        args.windows(2)
            .any(|args| args[0] == "-codec:a" && args[1] == "flac")
    );
}

#[test]
fn wav_without_channel_map_uses_direct_capture_output() {
    let mut command = command_with_pinned_channel_map();

    command.channel_map = None;
    command.output_codec = Some("wav".to_string());
    command.output_file_name = "rec_123.wav".to_string();
    command.output_vbr = Some(false);
    let job = ControllerRecordingJob {
        command,
        failure_reason: None,
        id: "job_1".to_string(),
        node_id: "node_1".to_string(),
        recording_id: "rec_123".to_string(),
        status: "running".to_string(),
    };
    let plan = capture_plan_for_job(&test_config(), &job, &[]);

    assert!(plan.output_path.ends_with("rec_123.wav"));
    assert_eq!(plan.output_path, plan.final_output_path);
}

#[test]
fn mp3_job_captures_raw_wav_and_finishes_as_profile_output() {
    let config = AgentConfig {
        capture_backend: CaptureBackend::Alsa,
        capture_command: "arecord".to_string(),
        channel_render_command: "ffmpeg".to_string(),
        capture_growth_grace_seconds: 10,
        capture_min_output_bytes: 128,
        capture_stalled_seconds: 30,
        node_id: "node_1".to_string(),
        ..test_config()
    };
    let job = ControllerRecordingJob {
        command: ControllerCaptureCommand {
            output_file_name: "rec_123.mp3".to_string(),
            ..command_with_pinned_channel_map()
        },
        failure_reason: None,
        id: "job_1".to_string(),
        node_id: "node_1".to_string(),
        recording_id: "rec_123".to_string(),
        status: "running".to_string(),
    };
    let plan = capture_plan_for_job(&config, &job, &[]);

    assert!(plan.output_path.ends_with("rec_123.raw.wav"));
    assert!(plan.final_output_path.ends_with("rec_123.mp3"));
    assert_eq!(plan.output_codec, "mp3");
}

#[test]
fn pipewire_job_uses_pipewire_capture_backend_and_default_command() {
    let job = ControllerRecordingJob {
        command: ControllerCaptureCommand {
            capture_backend: Some(CaptureBackend::Pipewire),
            capture_device: "alsa_input.usb-recorder".to_string(),
            output_file_name: "rec_123.wav".to_string(),
            output_codec: Some("wav".to_string()),
            output_vbr: Some(false),
            ..command_with_pinned_channel_map()
        },
        failure_reason: None,
        id: "job_1".to_string(),
        node_id: "node_1".to_string(),
        recording_id: "rec_123".to_string(),
        status: "running".to_string(),
    };
    let plan = capture_plan_for_job(&test_config(), &job, &[]);

    assert_eq!(plan.backend, CaptureBackend::Pipewire);
    assert_eq!(plan.command, "pw-record");
    assert_eq!(
        crate::capture::capture_command_args(&plan, "/tmp/rec.wav").unwrap(),
        vec![
            "--record",
            "--target",
            "alsa_input.usb-recorder",
            "--rate",
            "48000",
            "--channels",
            "3",
            "--format",
            "s16",
            "--sample-count",
            "2880000",
            "--container",
            "wav",
            "/tmp/rec.wav",
        ]
    );
}

#[test]
fn jack_job_uses_jack_capture_backend_and_default_command() {
    let job = ControllerRecordingJob {
        command: ControllerCaptureCommand {
            capture_backend: Some(CaptureBackend::Jack),
            capture_device: "system:capture_1".to_string(),
            output_file_name: "rec_123.wav".to_string(),
            output_codec: Some("wav".to_string()),
            output_vbr: Some(false),
            ..command_with_pinned_channel_map()
        },
        failure_reason: None,
        id: "job_1".to_string(),
        node_id: "node_1".to_string(),
        recording_id: "rec_123".to_string(),
        status: "running".to_string(),
    };
    let plan = capture_plan_for_job(&test_config(), &job, &[]);

    assert_eq!(plan.backend, CaptureBackend::Jack);
    assert_eq!(plan.command, "jack_capture");
    assert_eq!(
        crate::capture::capture_command_args(&plan, "/tmp/rec.wav").unwrap(),
        vec![
            "--channels",
            "3",
            "--duration",
            "60",
            "--format",
            "wav",
            "--disable-console",
            "--port",
            "system:capture_1",
            "/tmp/rec.wav",
        ]
    );
}

fn render_test_plan(
    output_codec: &str,
    output_bitrate_kbps: Option<u32>,
    output_vbr: bool,
    final_output_path: &str,
) -> CapturePlan {
    CapturePlan {
        args_template: None,
        backend: CaptureBackend::Alsa,
        channel_map: None,
        channels: 2,
        command: "arecord".to_string(),
        device: "default".to_string(),
        enhancement: None,
        final_output_path: PathBuf::from(final_output_path),
        format: "S16_LE".to_string(),
        growth_grace_seconds: 10,
        min_output_bytes: 128,
        output_bitrate_kbps,
        output_codec: output_codec.to_string(),
        output_path: PathBuf::from("rec.raw.wav"),
        output_vbr,
        render_command: "ffmpeg".to_string(),
        sample_rate: 48_000,
        seconds: 60,
        stalled_seconds: 30,
    }
}

fn string_args(args: Vec<std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect()
}

fn channel_map_bundle(
    assignment_id: &str,
    target_type: &str,
    target_id: &str,
    template_id: &str,
    included_sources: &[u16],
) -> ControllerChannelMapBundle {
    ControllerChannelMapBundle {
        assignment: ControllerChannelMapAssignment {
            assigned_at: "2026-06-18T00:00:00Z".to_string(),
            id: assignment_id.to_string(),
            target_id: target_id.to_string(),
            target_type: target_type.to_string(),
            template_id: template_id.to_string(),
        },
        template: ControllerChannelMapTemplate {
            channel_mode: "mono_to_stereo_mix".to_string(),
            entries: channel_map_entries(included_sources),
            id: template_id.to_string(),
            name: format!("Template {template_id}"),
            tags: vec![],
        },
    }
}

fn channel_map_entries(included_sources: &[u16]) -> Vec<ControllerChannelMapEntry> {
    let mut entries = vec![ControllerChannelMapEntry {
        included: false,
        label: "Muted".to_string(),
        output_channel_index: None,
        source_channel_index: 16,
    }];

    entries.extend(
        included_sources
            .iter()
            .copied()
            .map(|source_channel_index| ControllerChannelMapEntry {
                included: true,
                label: format!("Channel {source_channel_index}"),
                output_channel_index: Some(source_channel_index),
                source_channel_index,
            }),
    );

    entries
}

fn capture_channel_map(channel_mode: &str, included_sources: &[u16]) -> CaptureChannelMap {
    CaptureChannelMap {
        assignment_id: "assignment".to_string(),
        channel_mode: channel_mode.to_string(),
        entries: channel_map_entries(included_sources)
            .iter()
            .map(controller_entry)
            .collect(),
        source_channels: included_sources.iter().copied().max().unwrap_or(1),
        target_id: "node_1".to_string(),
        target_type: "node".to_string(),
        template_id: "template".to_string(),
        template_name: "Template".to_string(),
    }
}

fn test_config() -> AgentConfig {
    AgentConfig {
        agent_health_log_file: PathBuf::from("health-events.jsonl"),
        agent_health_log_max_bytes: 1_048_576,
        agent_health_log_retained_files: 3,
        agent_health_log_store: crate::config::AgentHealthLogStore::Jsonl,
        agent_health_sqlite_file: PathBuf::from("health-events.sqlite3"),
        agent_state_file: PathBuf::from("state.json"),
        allow_insecure_controller: false,
        alias: "Node".to_string(),
        attach_cache_content_type: "audio/mpeg".to_string(),
        attach_cache_duration_seconds: None,
        attach_cache_file: None,
        attach_cache_file_name: None,
        attach_cache_recording_id: None,
        capture_args_template: None,
        capture_backend: CaptureBackend::Alsa,
        capture_channels: 2,
        capture_command: "arecord".to_string(),
        capture_device: "default".to_string(),
        capture_format: "S16_LE".to_string(),
        capture_growth_grace_seconds: 10,
        capture_min_output_bytes: 128,
        capture_output: None,
        capture_output_bitrate_kbps: None,
        capture_output_codec: None,
        capture_output_vbr: true,
        capture_recording_id: None,
        capture_sample_rate: 48_000,
        capture_seconds: 60,
        capture_chunk_seconds: None,
        capture_stalled_seconds: 30,
        channel_render_command: "ffmpeg".to_string(),
        controller_ca_cert_path: None,
        controller_token: None,
        bootstrap: false,
        bootstrap_token: None,
        bootstrap_authorized_keys_path: PathBuf::from("/var/lib/rakkr/agent/.ssh/authorized_keys"),
        bootstrap_env_file: PathBuf::from("/etc/rakkr/recorder-agent.env"),
        ssh_keygen_command: "ssh-keygen".to_string(),
        controller_url: "http://localhost:8787".to_string(),
        heartbeat_seconds: 5,
        inventory_arecord_command: "arecord".to_string(),
        inventory_proc_asound_pcm_path: PathBuf::from("/proc/asound/pcm"),
        job_poll_seconds: 2,
        meter_backend: crate::config::MeterBackend::Synthetic,
        meter_args_template: None,
        meter_clip_dbfs: -1.0,
        meter_flatline_dbfs: -120.0,
        meter_low_signal_dbfs: -55.0,
        meter_sample_seconds: 1,
        monitor_chunk_sync_enabled: true,
        max_concurrent_recordings: 1,
        node_id: "node_1".to_string(),
        print_channel_map_assignments: false,
        print_inventory: false,
        print_meter_frame: false,
        recorder_cache_manifest_file: PathBuf::from("recorder-cache-manifest.json"),
        room: "Room".to_string(),
        run_next_job: false,
        site: "Site".to_string(),
        system_health_disk_critical_percent: 95.0,
        system_health_df_command: "df".to_string(),
        system_health_disk_path: PathBuf::from("."),
        system_health_disk_warning_percent: 85.0,
        system_health_enabled: true,
        system_health_load_critical_per_core: 4.0,
        system_health_load_warning_per_core: 2.0,
        system_health_loadavg_path: PathBuf::from("/proc/loadavg"),
    }
}
