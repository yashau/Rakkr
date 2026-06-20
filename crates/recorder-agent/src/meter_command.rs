use crate::capture::{pipewire_sample_count, pipewire_sample_format};
use crate::command_template::{CommandTemplateValues, command_template_args};
use crate::config::CaptureBackend;

pub struct MeterCaptureConfig<'a> {
    pub args_template: Option<&'a str>,
    pub backend: CaptureBackend,
    pub channel_count: u16,
    pub clip_dbfs: f32,
    pub command: &'a str,
    pub device: &'a str,
    pub format: &'a str,
    pub sample_rate: u32,
    pub sample_seconds: u64,
}

pub fn meter_command_args(config: &MeterCaptureConfig<'_>) -> anyhow::Result<Vec<String>> {
    let sample_seconds = config.sample_seconds.max(1);

    if let Some(template) = config.args_template {
        return command_template_args(
            template,
            &CommandTemplateValues {
                channels: config.channel_count,
                device: config.device,
                format: config.format,
                output: "-",
                sample_rate: config.sample_rate,
                seconds: sample_seconds,
            },
        )
        .map_err(|error| error.context("meter args template"));
    }

    match config.backend {
        CaptureBackend::Alsa => Ok(vec![
            "-D".to_string(),
            config.device.to_string(),
            "-f".to_string(),
            config.format.to_string(),
            "-r".to_string(),
            config.sample_rate.to_string(),
            "-c".to_string(),
            config.channel_count.to_string(),
            "-d".to_string(),
            sample_seconds.to_string(),
            "-t".to_string(),
            "raw".to_string(),
            "-q".to_string(),
        ]),
        CaptureBackend::Jack => {
            let mut args = vec![
                "--channels".to_string(),
                config.channel_count.to_string(),
                "--duration".to_string(),
                sample_seconds.to_string(),
                "--write-to-stdout".to_string(),
                "--disable-console".to_string(),
            ];

            args.extend(jack_capture_port_args(config.device));

            Ok(args)
        }
        CaptureBackend::Pipewire => Ok(vec![
            "--record".to_string(),
            "--target".to_string(),
            config.device.to_string(),
            "--rate".to_string(),
            config.sample_rate.to_string(),
            "--channels".to_string(),
            config.channel_count.to_string(),
            "--format".to_string(),
            pipewire_sample_format(config.format).to_string(),
            "--raw".to_string(),
            "--sample-count".to_string(),
            pipewire_sample_count(config.sample_rate, sample_seconds).to_string(),
            "-".to_string(),
        ]),
    }
}

fn jack_capture_port_args(device: &str) -> Vec<String> {
    if device == "default" {
        Vec::new()
    } else {
        vec!["--port".to_string(), device.to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meter_config() -> MeterCaptureConfig<'static> {
        MeterCaptureConfig {
            args_template: None,
            backend: CaptureBackend::Alsa,
            channel_count: 2,
            clip_dbfs: -1.0,
            command: "arecord",
            device: "hw:2,0",
            format: "S16_LE",
            sample_rate: 48_000,
            sample_seconds: 1,
        }
    }

    #[test]
    fn builds_default_arecord_meter_args() {
        assert_eq!(
            meter_command_args(&meter_config()).unwrap(),
            vec![
                "-D", "hw:2,0", "-f", "S16_LE", "-r", "48000", "-c", "2", "-d", "1", "-t", "raw",
                "-q",
            ]
        );
    }

    #[test]
    fn builds_templated_meter_args_for_stdout_pcm() {
        let config = MeterCaptureConfig {
            args_template: Some(
                "--target {device} --rate {sample_rate} --channels {channels} --format {format} --duration {seconds} --raw {output}",
            ),
            sample_seconds: 2,
            ..meter_config()
        };

        assert_eq!(
            meter_command_args(&config).unwrap(),
            vec![
                "--target",
                "hw:2,0",
                "--rate",
                "48000",
                "--channels",
                "2",
                "--format",
                "S16_LE",
                "--duration",
                "2",
                "--raw",
                "-",
            ]
        );
    }

    #[test]
    fn builds_pipewire_meter_args_for_stdout_pcm() {
        let config = MeterCaptureConfig {
            backend: CaptureBackend::Pipewire,
            device: "alsa_input.usb-recorder",
            sample_seconds: 2,
            ..meter_config()
        };

        assert_eq!(
            meter_command_args(&config).unwrap(),
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
                "--raw",
                "--sample-count",
                "96000",
                "-",
            ]
        );
    }

    #[test]
    fn builds_jack_meter_args_for_stdout_pcm() {
        let config = MeterCaptureConfig {
            backend: CaptureBackend::Jack,
            device: "system:capture_1",
            sample_seconds: 2,
            ..meter_config()
        };

        assert_eq!(
            meter_command_args(&config).unwrap(),
            vec![
                "--channels",
                "2",
                "--duration",
                "2",
                "--write-to-stdout",
                "--disable-console",
                "--port",
                "system:capture_1",
            ]
        );
    }

    #[test]
    fn rejects_invalid_meter_args_template() {
        let config = MeterCaptureConfig {
            args_template: Some("--target 'unterminated"),
            ..meter_config()
        };
        let error = meter_command_args(&config).expect_err("unterminated quote should fail");

        assert!(error.to_string().contains("meter args template"));
    }
}
