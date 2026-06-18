use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};

use anyhow::Context;
use tracing::info;

use crate::config::AgentConfig;

pub struct CapturePlan {
    pub channels: u16,
    pub command: String,
    pub device: String,
    pub format: String,
    pub output_path: PathBuf,
    pub sample_rate: u32,
    pub seconds: u64,
}

pub fn capture_plan_from_config(config: &AgentConfig) -> anyhow::Result<CapturePlan> {
    Ok(CapturePlan {
        channels: config.capture_channels,
        command: config.capture_command.clone(),
        device: config.capture_device.clone(),
        format: config.capture_format.clone(),
        output_path: capture_output_path(config)?,
        sample_rate: config.capture_sample_rate,
        seconds: config.capture_seconds,
    })
}

pub fn capture_output_path(config: &AgentConfig) -> anyhow::Result<PathBuf> {
    if let Some(path) = &config.capture_output {
        return Ok(path.clone());
    }

    let recording_id = config
        .capture_recording_id
        .as_deref()
        .context("missing --capture-recording-id")?;

    Ok(PathBuf::from("data")
        .join("recordings")
        .join("local-captures")
        .join(format!(
            "rakkr-capture-{}.wav",
            safe_file_stem(recording_id)
        )))
}

pub fn local_capture_path(file_name: &str) -> PathBuf {
    PathBuf::from("data")
        .join("recordings")
        .join("local-captures")
        .join(safe_file_stem(file_name))
}

pub fn capture_command_args(plan: &CapturePlan, output_path: &str) -> Vec<String> {
    vec![
        "-D".to_string(),
        plan.device.clone(),
        "-f".to_string(),
        plan.format.clone(),
        "-r".to_string(),
        plan.sample_rate.to_string(),
        "-c".to_string(),
        plan.channels.to_string(),
        "-d".to_string(),
        plan.seconds.to_string(),
        output_path.to_string(),
    ]
}

pub fn run_capture_job(config: &AgentConfig) -> anyhow::Result<PathBuf> {
    run_capture_plan(&capture_plan_from_config(config)?)
}

pub fn run_capture_plan(plan: &CapturePlan) -> anyhow::Result<PathBuf> {
    spawn_capture_plan(plan)?.wait()
}

pub fn spawn_capture_plan(plan: &CapturePlan) -> anyhow::Result<CaptureChild> {
    if plan.seconds == 0 {
        anyhow::bail!("capture duration must be greater than zero");
    }

    if plan.channels == 0 {
        anyhow::bail!("capture channel count must be greater than zero");
    }

    let output_path = &plan.output_path;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create capture output directory {}", parent.display()))?;
    }

    let output_text = output_path.to_string_lossy().to_string();
    let args = capture_command_args(plan, &output_text);
    let child = Command::new(&plan.command)
        .args(&args)
        .spawn()
        .with_context(|| format!("run capture command {}", plan.command))?;

    Ok(CaptureChild {
        child,
        command: plan.command.clone(),
        output_path: output_path.clone(),
    })
}

pub struct CaptureChild {
    child: Child,
    command: String,
    output_path: PathBuf,
}

impl CaptureChild {
    pub fn try_complete(&mut self) -> anyhow::Result<Option<PathBuf>> {
        let Some(status) = self
            .child
            .try_wait()
            .with_context(|| format!("poll capture command {}", self.command))?
        else {
            return Ok(None);
        };

        if !status.success() {
            anyhow::bail!(
                "capture command {} failed with status {status}",
                self.command
            );
        }

        verify_capture_output(&self.output_path)?;

        Ok(Some(self.output_path.clone()))
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.child
            .kill()
            .with_context(|| format!("stop capture command {}", self.command))?;
        let _ = self.child.wait();

        Ok(())
    }

    fn wait(mut self) -> anyhow::Result<PathBuf> {
        let status = self
            .child
            .wait()
            .with_context(|| format!("wait for capture command {}", self.command))?;

        if !status.success() {
            anyhow::bail!(
                "capture command {} failed with status {status}",
                self.command
            );
        }

        verify_capture_output(&self.output_path)?;

        Ok(self.output_path)
    }
}

fn verify_capture_output(output_path: &PathBuf) -> anyhow::Result<()> {
    let metadata = fs::metadata(output_path)
        .with_context(|| format!("inspect capture output {}", output_path.display()))?;

    if metadata.len() == 0 {
        anyhow::bail!("capture output is empty: {}", output_path.display());
    }

    info!(
        output = %output_path.display(),
        size = metadata.len(),
        "recording capture job completed"
    );

    Ok(())
}

fn safe_file_stem(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    if cleaned.is_empty() {
        "recording".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AgentConfig {
        AgentConfig {
            agent_health_log_file: PathBuf::from("health-events.jsonl"),
            agent_health_log_max_bytes: 1_048_576,
            alias: "Node".to_string(),
            attach_cache_content_type: "audio/mpeg".to_string(),
            attach_cache_duration_seconds: None,
            attach_cache_file: None,
            attach_cache_file_name: None,
            attach_cache_recording_id: None,
            agent_state_file: PathBuf::from("state.json"),
            capture_channels: 1,
            capture_command: "arecord".to_string(),
            capture_device: "hw:2,0".to_string(),
            capture_format: "S16_LE".to_string(),
            capture_output: Some(PathBuf::from("/tmp/rec.wav")),
            capture_recording_id: Some("rec_123".to_string()),
            capture_sample_rate: 48_000,
            capture_seconds: 15,
            controller_token: Some("token".to_string()),
            controller_url: "http://localhost:8787".to_string(),
            heartbeat_seconds: 5,
            job_poll_seconds: 2,
            meter_backend: "alsa".to_string(),
            meter_clip_dbfs: -1.0,
            meter_flatline_dbfs: -120.0,
            meter_sample_seconds: 1,
            node_id: "node".to_string(),
            print_inventory: false,
            print_meter_frame: false,
            run_next_job: false,
            room: "Room".to_string(),
            site: "Site".to_string(),
        }
    }

    #[test]
    fn builds_arecord_capture_args() {
        assert_eq!(
            capture_command_args(
                &capture_plan_from_config(&config()).unwrap(),
                "/tmp/rec.wav"
            ),
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
}
