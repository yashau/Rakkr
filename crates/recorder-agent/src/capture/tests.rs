use super::*;

fn config() -> AgentConfig {
    AgentConfig {
        agent_health_log_file: PathBuf::from("health-events.jsonl"),
        agent_health_log_max_bytes: 1_048_576,
        agent_health_log_retained_files: 3,
        agent_health_log_store: crate::config::AgentHealthLogStore::Jsonl,
        agent_health_sqlite_file: PathBuf::from("health-events.sqlite3"),
        allow_insecure_controller: false,
        alias: "Node".to_string(),
        attach_cache_content_type: "audio/mpeg".to_string(),
        attach_cache_duration_seconds: None,
        attach_cache_file: None,
        attach_cache_file_name: None,
        attach_cache_recording_id: None,
        agent_state_file: PathBuf::from("state.json"),
        capture_args_template: None,
        capture_backend: crate::config::CaptureBackend::Alsa,
        capture_channels: 1,
        channel_render_command: "ffmpeg".to_string(),
        capture_command: "arecord".to_string(),
        capture_device: "hw:2,0".to_string(),
        capture_format: "S16_LE".to_string(),
        capture_growth_grace_seconds: 10,
        capture_min_output_bytes: 128,
        capture_output: Some(PathBuf::from("/tmp/rec.wav")),
        capture_output_bitrate_kbps: None,
        capture_output_codec: None,
        capture_output_vbr: true,
        capture_recording_id: Some("rec_123".to_string()),
        capture_sample_rate: 48_000,
        capture_seconds: 15,
        capture_chunk_seconds: None,
        capture_stalled_seconds: 30,
        controller_ca_cert_path: None,
        controller_token: Some("token".to_string()),
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
        meter_backend: crate::config::MeterBackend::Alsa,
        meter_args_template: None,
        meter_clip_dbfs: -1.0,
        meter_flatline_dbfs: -120.0,
        meter_low_signal_dbfs: -55.0,
        meter_sample_seconds: 1,
        monitor_chunk_sync_enabled: true,
        max_concurrent_recordings: 1,
        node_id: "node".to_string(),
        print_channel_map_assignments: false,
        print_inventory: false,
        print_meter_frame: false,
        recorder_cache_manifest_file: PathBuf::from("recorder-cache-manifest.json"),
        run_next_job: false,
        room: "Room".to_string(),
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

#[test]
fn builds_arecord_capture_args() {
    assert_eq!(
        capture_command_args(
            &capture_plan_from_config(&config()).unwrap(),
            "/tmp/rec.wav"
        )
        .unwrap(),
        vec![
            "-D",
            "hw:2,0",
            "-f",
            "S16_LE",
            "-r",
            "48000",
            "-c",
            "1",
            "-d",
            "15",
            "/tmp/rec.wav",
        ]
    );
}

#[test]
fn builds_templated_capture_args() {
    let mut config = config();

    config.capture_args_template = Some(
        "--target {device} --rate {sample_rate} --channels {channels} --format {format} --duration {seconds} --file {output}"
            .to_string(),
    );

    assert_eq!(
        capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav").unwrap(),
        vec![
            "--target",
            "hw:2,0",
            "--rate",
            "48000",
            "--channels",
            "1",
            "--format",
            "S16_LE",
            "--duration",
            "15",
            "--file",
            "/tmp/rec.wav",
        ]
    );
}

#[test]
fn builds_pipewire_capture_args() {
    let mut config = config();
    config.capture_backend = crate::config::CaptureBackend::Pipewire;
    config.capture_device = "alsa_input.usb-recorder".to_string();
    config.capture_format = "S16_LE".to_string();
    config.capture_sample_rate = 48_000;
    config.capture_seconds = 2;
    config.capture_channels = 2;

    assert_eq!(
        capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav").unwrap(),
        vec![
            "--record",
            "--target",
            "alsa_input.usb-recorder",
            "--rate",
            "48000",
            "--channels",
            "2",
            "--format",
            "s16",
            "--sample-count",
            "96000",
            "--container",
            "wav",
            "/tmp/rec.wav",
        ]
    );
}

#[test]
fn builds_jack_capture_args() {
    let mut config = config();
    config.capture_backend = crate::config::CaptureBackend::Jack;
    config.capture_device = "system:capture_1".to_string();
    config.capture_seconds = 2;
    config.capture_channels = 2;

    assert_eq!(
        capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav").unwrap(),
        vec![
            "--channels",
            "2",
            "--duration",
            "2",
            "--format",
            "wav",
            "--disable-console",
            "--port",
            "system:capture_1",
            "/tmp/rec.wav",
        ]
    );
}

#[test]
fn chunk_disk_estimate_uses_working_copy_headroom() {
    // Four chunk-lengths of headroom for the open chunk + raw/rendered/enhanced
    // working copies, and at least one second even for a zero input.
    assert_eq!(chunk_disk_estimate_seconds(5), 20);
    assert_eq!(chunk_disk_estimate_seconds(0), 4);
}

#[test]
fn chunk_plan_clone_gives_per_chunk_unique_final_stem() {
    let plan = capture_plan_from_config(&config()).unwrap();
    let dir = Path::new("/tmp/chunks");
    let chunk_wav = dir.join("rec.chunk-0003.wav");
    let chunk_plan = plan.chunk_plan(dir, "rec", 3, &chunk_wav);

    assert_eq!(chunk_plan.output_path, chunk_wav);
    assert!(chunk_plan.final_output_path.ends_with("rec.chunk-0003.wav"));
    // The clone preserves capture parameters.
    assert_eq!(chunk_plan.sample_rate, plan.sample_rate);
    assert_eq!(chunk_plan.channels, plan.channels);
}

#[test]
fn chunk_plan_channel_mapped_wav_renders_to_a_distinct_path() {
    let mut plan = capture_plan_from_config(&config()).unwrap();
    plan.channel_map = Some(CaptureChannelMap {
        assignment_id: "assignment".to_string(),
        channel_mode: "mono".to_string(),
        entries: Vec::new(),
        source_channels: 1,
        target_id: "target".to_string(),
        target_type: "node".to_string(),
        template_id: "template".to_string(),
        template_name: "Template".to_string(),
    });
    let dir = Path::new("/tmp/chunks");
    let chunk_wav = dir.join("rec.chunk-0003.wav");
    let chunk_plan = plan.chunk_plan(dir, "rec", 3, &chunk_wav);

    // Pre-fix final_output_path == output_path == chunk_wav, so a wav
    // channel-map render read and wrote the same file in place.
    assert_eq!(chunk_plan.output_path, chunk_wav);
    assert_ne!(chunk_plan.final_output_path, chunk_wav);
    assert!(
        chunk_plan
            .final_output_path
            .ends_with("rec.chunk-0003.rendered.wav")
    );
}

#[test]
fn estimates_capture_bytes_from_format_rate_channels_and_duration() {
    let mut config = config();
    config.capture_channels = 2;
    config.capture_format = "S32_LE".to_string();
    config.capture_sample_rate = 48_000;
    config.capture_seconds = 10;
    let plan = capture_plan_from_config(&config).expect("plan");

    assert_eq!(estimated_capture_bytes(&plan), 3_844_096);
}

#[test]
fn keeps_quoted_capture_template_segments_as_single_args() {
    let mut config = config();

    config.capture_args_template =
        Some("--property media.name='Rakkr Capture' {output_path}".to_string());

    assert_eq!(
        capture_command_args(
            &capture_plan_from_config(&config).unwrap(),
            "/tmp/recording with spaces.wav"
        )
        .unwrap(),
        vec![
            "--property",
            "media.name=Rakkr Capture",
            "/tmp/recording with spaces.wav",
        ]
    );
}

#[test]
fn rejects_invalid_capture_args_template() {
    let mut config = config();

    config.capture_args_template = Some("--target 'unterminated".to_string());
    let error = capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav")
        .expect_err("unterminated quote should fail");

    assert!(error.to_string().contains("capture args template"));
}

#[test]
fn sanitizes_default_capture_output_name() {
    let mut config = config();

    config.capture_output = None;
    config.capture_recording_id = Some("rec/with spaces".to_string());

    assert!(
        capture_output_path(&config)
            .unwrap()
            .ends_with("rakkr-capture-rec_with_spaces.wav")
    );
}

#[test]
fn direct_capture_defaults_to_wav_without_render_step() {
    let mut config = config();

    config.capture_output = None;
    config.capture_recording_id = Some("rec_default".to_string());
    let plan = capture_plan_from_config(&config).expect("plan");

    assert!(plan.output_path.ends_with("rakkr-capture-rec_default.wav"));
    assert_eq!(plan.output_path, plan.final_output_path);
    assert_eq!(plan.output_codec, "wav");
    assert_eq!(plan.output_bitrate_kbps, None);
    assert!(!plan.output_vbr);
}

#[test]
fn direct_mp3_capture_uses_raw_wav_and_profile_encoding_defaults() {
    let mut config = config();

    config.capture_output = None;
    config.capture_output_codec = Some("mp3".to_string());
    config.capture_recording_id = Some("rec_mp3".to_string());
    let plan = capture_plan_from_config(&config).expect("plan");

    assert!(
        plan.final_output_path
            .ends_with("rakkr-capture-rec_mp3.mp3")
    );
    assert!(plan.output_path.ends_with("rakkr-capture-rec_mp3.raw.wav"));
    assert_eq!(plan.output_codec, "mp3");
    assert_eq!(plan.output_bitrate_kbps, Some(128));
    assert!(plan.output_vbr);
}

#[test]
fn direct_capture_codec_can_follow_output_extension() {
    let mut config = config();

    config.capture_output = Some(PathBuf::from("/tmp/meeting.flac"));
    let plan = capture_plan_from_config(&config).expect("plan");

    assert!(plan.final_output_path.ends_with("meeting.flac"));
    assert!(plan.output_path.ends_with("meeting.raw.wav"));
    assert_eq!(plan.output_codec, "flac");
}

#[test]
fn direct_capture_explicit_codec_normalizes_final_extension() {
    let mut config = config();

    config.capture_output = Some(PathBuf::from("/tmp/meeting.wav"));
    config.capture_output_codec = Some("mp3".to_string());
    let plan = capture_plan_from_config(&config).expect("plan");

    assert!(plan.final_output_path.ends_with("meeting.mp3"));
    assert!(plan.output_path.ends_with("meeting.raw.wav"));
    assert_eq!(plan.output_codec, "mp3");
}

#[test]
fn local_capture_path_preserves_safe_extension() {
    assert!(
        local_capture_path("../rec with spaces.mp3").ends_with(Path::new("rec_with_spaces.mp3"))
    );
}

#[test]
fn rejects_too_small_capture_output() {
    let error = validate_capture_output_size(&PathBuf::from("small.wav"), 44, 128)
        .expect_err("small file should fail");

    assert!(error.to_string().contains("too small"));
}

#[test]
fn detects_stalled_capture_output_after_grace_period() {
    let started_at = Instant::now();
    let mut monitor = CaptureGrowthMonitor::new(5, 10, started_at);

    monitor
        .observe(None, started_at + Duration::from_secs(6))
        .expect("inside stalled period");
    let error = monitor
        .observe(None, started_at + Duration::from_secs(16))
        .expect_err("missing output should stall");

    assert!(error.to_string().contains("capture output stalled"));
    assert_eq!(
        error.snapshot(),
        &CaptureGrowthSnapshot {
            age_seconds: 16,
            last_growth_seconds_ago: 16,
            size_bytes: None,
        },
    );
}
