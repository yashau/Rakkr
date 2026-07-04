mod agent_recovery;
mod alsa_device;
mod bootstrap;
mod cache_content_type;
mod capture;
mod capture_naming;
mod channel_map;
mod chunked_capture;
mod command_template;
mod config;
mod controller;
mod controller_http;
mod enhance;
mod enhanced_render;
mod health_log;
#[path = "main/health_tick.rs"]
mod health_tick;
mod inventory;
mod meter_command;
mod meter_health;
mod monitor_sync;
mod node_config;
mod recorder_cache_retention;
mod recording_job_chunked;
mod recording_job_disk;
mod recording_job_recovery;
mod recording_job_recovery_chunk_total;
mod recording_job_segments;
mod recording_job_upload;
mod state;
mod system_health;
mod telemetry;
mod version;

use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use config::{AgentConfig, CaptureBackend, MeterBackend};
use meter_command::MeterCaptureConfig;
use meter_health::{MeterFailureKind, MeterHealthState};
use serde_json::json;
use telemetry::{
    MeterFrame, MeterSample, alsa_meter_frame, alsa_meter_sample, synthetic_meter_frame,
    synthetic_meter_sample,
};
use tokio::task::JoinSet;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

// Per-tick health-evidence helpers were extracted to keep this file under the
// per-file LOC budget. Re-export so loop call sites stay unqualified, `super::*`
// resolves for `main/tests.rs`, and `crate::append_and_sync_health_event` still
// resolves for agent_recovery.rs / meter_health.rs.
pub(crate) use health_tick::append_and_sync_health_event;
use health_tick::apply_tick_health_updates;

#[cfg(test)]
use meter_health::{CHANNEL_CORRELATION_ALERT_MIN_ABS_SCORE, correlated_channel_pairs};
#[cfg(test)]
use telemetry::{MeterFaultKind, meter_fault_score, meter_max_rms_dbfs, meter_quality_evidence};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = AgentConfig::parse();
    let mut inventory = inventory::collect(&config);

    if config.print_inventory {
        println!("{}", serde_json::to_string_pretty(&inventory)?);
        return Ok(());
    }

    if config.bootstrap {
        bootstrap::run_bootstrap(&config).await?;
        return Ok(());
    }

    if config.print_meter_frame {
        let (meter_interface_id, meter_channel_count) = meter_target(&config, &inventory);
        let meter_capture = meter_capture_config(&config, meter_channel_count);
        let frame = strict_meter_frame(
            &config,
            &inventory.id,
            &meter_interface_id,
            meter_channel_count,
            0,
            &meter_capture,
        )?;

        println!("{}", serde_json::to_string_pretty(&frame)?);
        return Ok(());
    }

    if config.print_channel_map_assignments {
        let token = config
            .controller_token
            .as_deref()
            .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
        let assignments = controller::fetch_channel_map_assignments(&config, token).await?;

        println!("{}", serde_json::to_string_pretty(&assignments)?);
        return Ok(());
    }

    if config.attach_cache_file.is_some() || config.attach_cache_recording_id.is_some() {
        controller::attach_cache_file(&config).await?;
        return Ok(());
    }

    if config.run_next_job {
        controller::run_next_recording_job(&config).await?;
        return Ok(());
    }

    if config.capture_recording_id.is_some() {
        let token = config
            .controller_token
            .as_deref()
            .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
        let capture_plan = capture::capture_plan_from_config(&config)?;
        let raw_output_path = capture::run_capture_plan(&capture_plan)?;
        let output_path = channel_map::render_capture_output(&capture_plan, &raw_output_path)?;
        let content_type = cache_content_type::content_type_for_codec(
            Some(capture_plan.output_codec.as_str()),
            &output_path,
        );

        controller::upload_cache_file(controller::CacheFileUpload {
            allow_insecure_controller: config.allow_insecure_controller,
            content_type,
            controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
            controller_url: &config.controller_url,
            duration_seconds: Some(config.capture_seconds),
            file_name: output_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string),
            file_path: &output_path,
            job_id: None,
            recording_id: config
                .capture_recording_id
                .as_deref()
                .context("missing --capture-recording-id")?,
            rendition: None,
            chunk_index: None,
            chunk_total: None,
            token,
        })
        .await?;
        return Ok(());
    }

    info!(
        alias = %inventory.alias,
        controller_url = %config.controller_url,
        node_id = %inventory.id,
        "starting recorder agent scaffold"
    );

    let mut active_config = config.clone();
    let mut ticker = tokio::time::interval(Duration::from_secs(config.heartbeat_seconds));
    let mut tick = 0_u64;
    let mut meter_capture_failure = None;
    let mut meter_health_state = MeterHealthState::default();
    let mut clock_skew_active = false;
    let mut heartbeat_sync_failed = false;
    let mut monitor_sync_failed = false;
    let mut meter_sync_failed = false;
    let mut node_config_sync_failed = false;
    let mut recording_job_recovery_pending = false;
    let mut recording_jobs = JoinSet::new();
    let mut recording_job_limit = config.max_concurrent_recordings.max(1);
    let mut system_health_state = system_health::SystemHealthState::default();
    // Live-monitor denoiser: created on demand when a listener requests enhanced
    // audio (driven by the controller node-config poll) and dropped when no one is
    // listening enhanced, so DSP only runs while it is actually consumed.
    let mut monitor_enhancer: Option<enhance::Enhancer> = None;
    let mut monitor_enhancer_engine: Option<enhance::EnhancementEngine> = None;
    let token = config.controller_token.as_deref();

    append_and_sync_health_event(
        &config,
        token,
        "agent.started",
        "info",
        json!({
            "alias": inventory.alias,
            "controllerUrl": config.controller_url,
            "meterBackend": config.meter_backend.as_str(),
            "nodeId": inventory.id,
        }),
    )
    .await
    .context("append startup health event")?;

    // The agent owns hardware truth: reconcile the discovered interfaces with the
    // controller on startup so node.interfaces reflect the real devices (operator
    // labels + channel-map assignments are preserved controller-side by stable id).
    if let Some(token) = token {
        match controller::post_node_inventory(&config, token, &inventory).await {
            Ok(()) => {
                info!(
                    interface_count = inventory.interfaces.len(),
                    "reconciled node inventory with controller"
                );
            }
            Err(error) => {
                warn!(error = %error, "failed to reconcile node inventory with controller");
                append_and_sync_health_event(
                    &config,
                    Some(token),
                    "agent.node_inventory.sync_failed",
                    "warning",
                    inventory::heartbeat_health_details(&inventory, Some(error.to_string())),
                )
                .await
                .context("append node inventory sync failure event")?;
            }
        }
    }

    if let Some(token) = token {
        match recording_job_recovery::reconcile_previous_recording_job(&config, token).await {
            Ok(()) => {}
            Err(error) => {
                recording_job_recovery_pending = true;
                warn!(error = %error, "failed to reconcile previous recording job state");
            }
        }
    }

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                warn!("shutdown signal received");
                break;
            }
            _ = ticker.tick() => {
                tick += 1;
                inventory = inventory::collect(&active_config);
                let (meter_interface_id, meter_channel_count) =
                    meter_target(&active_config, &inventory);
                let meter_capture = meter_capture_config(&active_config, meter_channel_count);
                let meter_context = MeterLoopContext {
                    capture: &meter_capture,
                    channel_count: meter_channel_count,
                    interface_id: &meter_interface_id,
                    node_id: &inventory.id,
                    token,
                };
                let sample = next_meter_sample(
                    &active_config,
                    &meter_context,
                    tick,
                    &mut meter_capture_failure,
                    monitor_enhancer.as_mut(),
                ).await?;
                let frame = &sample.frame;

                info!(
                    captured_at = %frame.captured_at,
                    channels = frame.levels.len(),
                    "recorder heartbeat"
                );

                apply_tick_health_updates(
                    &active_config,
                    token,
                    frame,
                    &inventory,
                    &mut meter_health_state,
                    &mut system_health_state,
                ).await;

                reap_recording_job_workers(&mut recording_jobs);

                if let Some(token) = token {
                    let heartbeat = inventory::heartbeat_snapshot(&inventory);

                    match controller::post_node_heartbeat(&active_config, token, &heartbeat).await {
                        Ok(clock_skew_seconds) if heartbeat_sync_failed => {
                            heartbeat_sync_failed = false;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.node_heartbeat.sync_recovered",
                                "info",
                                inventory::heartbeat_health_details(&heartbeat, None),
                            )
                            .await
                            .context("append node heartbeat sync recovery event")?;
                            agent_recovery::update_clock_skew_health(
                                &active_config,
                                token,
                                clock_skew_seconds,
                                &mut clock_skew_active,
                            ).await?;
                            recording_job_recovery_pending = agent_recovery::reconcile_previous_recording_job_state(
                                &active_config,
                                token,
                                recording_job_recovery_pending,
                            )
                            .await?;
                        }
                        Ok(clock_skew_seconds) if recording_job_recovery_pending => {
                            agent_recovery::update_clock_skew_health(
                                &active_config,
                                token,
                                clock_skew_seconds,
                                &mut clock_skew_active,
                            ).await?;
                            recording_job_recovery_pending = agent_recovery::reconcile_previous_recording_job_state(
                                &active_config,
                                token,
                                recording_job_recovery_pending,
                            )
                            .await?;
                        }
                        Ok(clock_skew_seconds) => {
                            agent_recovery::update_clock_skew_health(
                                &active_config,
                                token,
                                clock_skew_seconds,
                                &mut clock_skew_active,
                            ).await?;
                        }
                        Err(error) if !heartbeat_sync_failed => {
                            heartbeat_sync_failed = true;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.node_heartbeat.sync_failed",
                                "warning",
                                inventory::heartbeat_health_details(&heartbeat, Some(error.to_string())),
                            )
                            .await
                            .context("append node heartbeat sync failure event")?;

                            warn!(error = %error, "failed to post node heartbeat");
                        }
                        Err(error) => {
                            warn!(error = %error, "failed to post node heartbeat");
                        }
                    }

                    match controller::post_meter_frame(&active_config, token, frame).await {
                        Ok(()) if meter_sync_failed => {
                            meter_sync_failed = false;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.meter_frame.sync_recovered",
                                "info",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "channelCount": frame.levels.len(),
                                    "interfaceId": frame.interface_id,
                                    "nodeId": inventory.id,
                                }),
                            )
                            .await
                            .context("append meter sync recovery event")?;
                        }
                        Ok(()) => {}
                        Err(error) if !meter_sync_failed => {
                            meter_sync_failed = true;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.meter_frame.sync_failed",
                                "warning",
                                json!({
                                    "capturedAt": frame.captured_at,
                                    "channelCount": frame.levels.len(),
                                    "error": error.to_string(),
                                    "interfaceId": frame.interface_id,
                                    "nodeId": inventory.id,
                                }),
                            )
                            .await
                            .context("append meter sync failure event")?;

                            warn!(error = %error, "failed to post meter frame");
                        }
                        Err(error) => {
                            warn!(error = %error, "failed to post meter frame");
                        }
                    }

                    sync_monitor_chunk(
                        &active_config,
                        token,
                        &sample,
                        &mut monitor_sync_failed,
                    ).await?;

                    match node_config::fetch_node_config(&active_config, token).await {
                        Ok(node_config) => {
                            let mut next_config = config.clone();
                            node_config.apply_audio_defaults(&mut next_config);

                            if audio_runtime_defaults_changed(&active_config, &next_config) {
                                active_config = next_config;
                                info!(
                                    capture_command = %active_config.capture_command,
                                    capture_device = %active_config.capture_device,
                                    "updated audio command defaults from controller config"
                                );
                            }

                            if let Some(next_limit) = node_config.max_concurrent_recordings() {
                                if next_limit != recording_job_limit {
                                    info!(
                                        max_concurrent_recordings = next_limit,
                                        "updated recording job concurrency from controller config"
                                    );
                                }

                                recording_job_limit = next_limit;
                            }

                            reconcile_monitor_enhancer(
                                node_config.monitor_enhancement_engine(),
                                &mut monitor_enhancer,
                                &mut monitor_enhancer_engine,
                            );

                            if node_config_sync_failed {
                                node_config_sync_failed = false;
                                append_and_sync_health_event(
                                    &active_config,
                                    Some(token),
                                    "agent.node_config.sync_recovered",
                                    "info",
                                    node_config.health_details(&inventory.id, None),
                                )
                                .await
                                .context("append node config sync recovery event")?;
                                info!("controller node config sync recovered");
                            }

                            if recording_jobs.is_empty() {
                                run_idle_recorder_cache_sweep(&active_config, Some(token), &node_config)
                                    .await?;
                            }
                        }
                        Err(error) if !node_config_sync_failed => {
                            node_config_sync_failed = true;
                            append_and_sync_health_event(
                                &active_config,
                                Some(token),
                                "agent.node_config.sync_failed",
                                "warning",
                                node_config::ControllerNodeConfig::failure_health_details(
                                    &inventory.id,
                                    error.to_string(),
                                ),
                            )
                            .await
                            .context("append node config sync failure event")?;
                            warn!(error = %error, "failed to fetch controller node config");
                        }
                        Err(_) => {}
                    }
                }

                reap_recording_job_workers(&mut recording_jobs);
                spawn_recording_job_workers(&active_config, &mut recording_jobs, recording_job_limit);
            }
        }
    }

    if !recording_jobs.is_empty() {
        warn!(
            active_recording_jobs = recording_jobs.len(),
            "waiting for active recording jobs before shutdown"
        );
        drain_recording_job_workers(&mut recording_jobs).await;
    }

    Ok(())
}

async fn run_idle_recorder_cache_sweep(
    config: &AgentConfig,
    token: Option<&str>,
    node_config: &node_config::ControllerNodeConfig,
) -> anyhow::Result<()> {
    if node_config.recorder_cache_policies.is_empty() {
        return Ok(());
    }

    // Best-effort, like the health-event append below: the sweep does local manifest
    // I/O (load/save), and a failure there (full disk, unwritable manifest dir) must
    // NOT propagate out of the heartbeat tick and kill the daemon — idle cache
    // maintenance failing is not fatal. Log and skip this tick.
    let summary = match recorder_cache_retention::run_recorder_cache_sweep(
        &config.recorder_cache_manifest_file,
        &node_config.recorder_cache_policies,
        system_health::disk_usage(
            &config.system_health_df_command,
            &config.system_health_disk_path,
        )
        .map(|usage| recorder_cache_retention::RecorderCacheDiskUsage {
            free_bytes: usage.free_bytes,
            free_percent: usage.free_percent,
            total_bytes: usage.total_bytes,
        }),
        std::time::SystemTime::now(),
    ) {
        Ok(summary) => summary,
        Err(error) => {
            warn!(error = %error, "recorder cache sweep failed; continuing");
            return Ok(());
        }
    };

    if summary.deleted == 0 && summary.errors == 0 {
        return Ok(());
    }

    let severity = if summary.errors > 0 {
        "warning"
    } else {
        "info"
    };

    append_and_sync_health_event(
        config,
        token,
        "agent.recorder_cache.sweep_completed",
        severity,
        json!({
            "deleted": summary.deleted,
            "errors": summary.errors,
            "items": summary.items,
            "scanned": summary.scanned,
        }),
    )
    .await
}

/// Bring the live-monitor denoiser in line with the controller's requested engine.
/// Creates the enhancer when an engine is first requested, rebuilds it on an engine
/// change, and drops it once no listener wants enhanced audio, so DSP only runs
/// on demand.
fn reconcile_monitor_enhancer(
    requested: Option<enhance::EnhancementEngine>,
    enhancer: &mut Option<enhance::Enhancer>,
    current_engine: &mut Option<enhance::EnhancementEngine>,
) {
    match requested {
        Some(engine) if *current_engine == Some(engine) => {}
        Some(engine) => match enhance::Enhancer::new(engine) {
            Ok(ready) => {
                *enhancer = Some(ready);
                *current_engine = Some(engine);
                info!(engine = ?engine, "live monitor enhancement enabled");
            }
            Err(error) => {
                *enhancer = None;
                *current_engine = None;
                warn!(error = %error, "failed to initialize live monitor enhancer");
            }
        },
        None => {
            if enhancer.is_some() {
                info!("live monitor enhancement disabled");
            }
            *enhancer = None;
            *current_engine = None;
        }
    }
}

async fn sync_monitor_chunk(
    config: &AgentConfig,
    token: &str,
    sample: &MeterSample,
    monitor_sync_failed: &mut bool,
) -> anyhow::Result<()> {
    if !config.monitor_chunk_sync_enabled {
        return Ok(());
    }

    match monitor_sync::post_monitor_chunk(config, token, sample, &sample.monitor_wav, None).await {
        Ok(()) if *monitor_sync_failed => {
            *monitor_sync_failed = false;
            append_and_sync_health_event(
                config,
                Some(token),
                "agent.listen_monitor.chunk_sync_recovered",
                "info",
                monitor_sync::monitor_chunk_health_details(&config.node_id, sample, None),
            )
            .await
            .context("append monitor chunk sync recovery event")?;
        }
        Ok(()) => {}
        Err(error) if !*monitor_sync_failed => {
            *monitor_sync_failed = true;
            append_and_sync_health_event(
                config,
                Some(token),
                "agent.listen_monitor.chunk_sync_failed",
                "warning",
                monitor_sync::monitor_chunk_health_details(
                    &config.node_id,
                    sample,
                    Some(error.to_string()),
                ),
            )
            .await
            .context("append monitor chunk sync failure event")?;
            warn!(error = %error, "failed to post monitor chunk");
        }
        Err(error) => {
            warn!(error = %error, "failed to post monitor chunk");
        }
    }

    // Enhanced monitor audio is best-effort: only produced when a listener has
    // requested it, and posted alongside (not instead of) the raw chunk. Failures
    // here must not flip the raw sync health state, so they are logged only.
    if let Some(enhanced) = sample.enhanced_monitor_wav.as_deref()
        && let Err(error) =
            monitor_sync::post_monitor_chunk(config, token, sample, enhanced, Some("enhanced"))
                .await
    {
        warn!(error = %error, "failed to post enhanced monitor chunk");
    }

    Ok(())
}

fn reap_recording_job_workers(jobs: &mut JoinSet<anyhow::Result<()>>) {
    while let Some(result) = jobs.try_join_next() {
        log_recording_job_result(result);
    }
}

fn spawn_recording_job_workers(
    config: &AgentConfig,
    jobs: &mut JoinSet<anyhow::Result<()>>,
    limit: usize,
) {
    if config.controller_token.is_none() {
        return;
    }

    let limit = limit.max(1);

    while jobs.len() < limit {
        let worker_config = config.clone();

        jobs.spawn(async move { controller::run_next_recording_job(&worker_config).await });
    }
}

async fn drain_recording_job_workers(jobs: &mut JoinSet<anyhow::Result<()>>) {
    while let Some(result) = jobs.join_next().await {
        log_recording_job_result(result);
    }
}

fn log_recording_job_result(result: Result<anyhow::Result<()>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(error = %error, "recording job worker failed"),
        Err(error) => warn!(error = %error, "recording job worker task failed"),
    }
}

fn meter_target(config: &AgentConfig, inventory: &inventory::NodeInventory) -> (String, u16) {
    let selected_interface =
        alsa_device::capture_device_interface_id(&config.capture_device, inventory)
            .and_then(|id| {
                inventory
                    .interfaces
                    .iter()
                    .find(|audio_interface| audio_interface.id == id)
            })
            .or_else(|| inventory.interfaces.first());

    let interface_id = selected_interface
        .map(|audio_interface| audio_interface.id.clone())
        .unwrap_or_else(|| "iface_default_capture".to_string());
    let channel_count = selected_interface
        .map(|audio_interface| audio_interface.channel_count.max(1))
        .unwrap_or(2);

    (interface_id, channel_count)
}

fn meter_capture_config<'a>(config: &'a AgentConfig, channel_count: u16) -> MeterCaptureConfig<'a> {
    let backend = meter_capture_backend(config);

    MeterCaptureConfig {
        args_template: config.meter_args_template.as_deref(),
        backend,
        channel_count,
        clip_dbfs: config.meter_clip_dbfs,
        command: config.effective_capture_command(backend),
        device: &config.capture_device,
        format: &config.capture_format,
        sample_rate: config.capture_sample_rate,
        sample_seconds: config.meter_sample_seconds,
    }
}

fn audio_runtime_defaults_changed(left: &AgentConfig, right: &AgentConfig) -> bool {
    left.capture_args_template != right.capture_args_template
        || left.capture_backend != right.capture_backend
        || left.capture_channels != right.capture_channels
        || left.capture_command != right.capture_command
        || left.capture_device != right.capture_device
        || left.capture_format != right.capture_format
        || left.capture_sample_rate != right.capture_sample_rate
        || left.meter_args_template != right.meter_args_template
}

fn strict_meter_frame(
    config: &AgentConfig,
    node_id: &str,
    interface_id: &str,
    channel_count: u16,
    tick: u64,
    meter_capture: &MeterCaptureConfig<'_>,
) -> anyhow::Result<MeterFrame> {
    match config.meter_backend {
        MeterBackend::Synthetic => {
            synthetic_meter_frame(node_id, interface_id, channel_count, tick)
                .context("failed to create synthetic meter frame")
        }
        MeterBackend::Alsa => alsa_meter_frame(node_id, interface_id, meter_capture)
            .context("failed to create ALSA meter frame"),
        MeterBackend::Jack => alsa_meter_frame(node_id, interface_id, meter_capture)
            .context("failed to create JACK meter frame"),
        MeterBackend::Pipewire => alsa_meter_frame(node_id, interface_id, meter_capture)
            .context("failed to create PipeWire meter frame"),
    }
}

struct MeterLoopContext<'a> {
    capture: &'a MeterCaptureConfig<'a>,
    channel_count: u16,
    interface_id: &'a str,
    node_id: &'a str,
    token: Option<&'a str>,
}

async fn next_meter_sample(
    config: &AgentConfig,
    context: &MeterLoopContext<'_>,
    tick: u64,
    meter_capture_failure: &mut Option<MeterFailureKind>,
    enhancer: Option<&mut enhance::Enhancer>,
) -> anyhow::Result<MeterSample> {
    match config.meter_backend {
        MeterBackend::Synthetic => synthetic_meter_sample(
            context.node_id,
            context.interface_id,
            context.channel_count,
            tick,
        )
        .context("failed to create synthetic meter frame"),
        MeterBackend::Alsa | MeterBackend::Jack | MeterBackend::Pipewire => {
            match alsa_meter_sample(
                context.node_id,
                context.interface_id,
                context.capture,
                enhancer,
            ) {
                Ok(sample) => {
                    if let Some(kind) = meter_capture_failure.take() {
                        append_and_sync_health_event(
                            config,
                            context.token,
                            "agent.meter.capture_recovered",
                            "info",
                            json!({
                                "backend": config.meter_backend.as_str(),
                                "device": config.capture_device,
                                "format": config.capture_format,
                                "previousKind": kind.as_str(),
                                "previousType": kind.event_type(),
                                "nodeId": context.node_id,
                            }),
                        )
                        .await
                        .context("append meter capture recovery event")?;
                    }

                    Ok(sample)
                }
                Err(error) => {
                    let kind = MeterFailureKind::classify(&error.to_string());
                    if *meter_capture_failure != Some(kind) {
                        *meter_capture_failure = Some(kind);
                        append_and_sync_health_event(
                            config,
                            context.token,
                            kind.event_type(),
                            kind.severity(),
                            json!({
                                "backend": config.meter_backend.as_str(),
                                "classification": kind.as_str(),
                                "device": config.capture_device,
                                "error": error.to_string(),
                                "format": config.capture_format,
                                "nodeId": context.node_id,
                                "usingSyntheticFallback": true,
                            }),
                        )
                        .await
                        .context("append meter capture failure event")?;
                    }

                    warn!(error = %error, "meter sampling failed; using synthetic fallback");
                    synthetic_meter_sample(
                        context.node_id,
                        context.interface_id,
                        context.channel_count,
                        tick,
                    )
                    .context("failed to create fallback synthetic meter frame")
                }
            }
        }
    }
}

fn meter_capture_backend(config: &AgentConfig) -> CaptureBackend {
    match config.meter_backend {
        MeterBackend::Alsa | MeterBackend::Synthetic => config.capture_backend,
        MeterBackend::Jack => CaptureBackend::Jack,
        MeterBackend::Pipewire => CaptureBackend::Pipewire,
    }
}

#[cfg(test)]
#[path = "main/tests.rs"]
mod tests;
