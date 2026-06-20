use anyhow::anyhow;

pub struct CommandTemplateValues<'a> {
    pub channels: u16,
    pub device: &'a str,
    pub format: &'a str,
    pub output: &'a str,
    pub sample_rate: u32,
    pub seconds: u64,
}

pub fn command_template_args(
    template: &str,
    values: &CommandTemplateValues<'_>,
) -> anyhow::Result<Vec<String>> {
    let Some(args) = shlex::split(template) else {
        return Err(anyhow!("parse command args template"));
    };

    if args.is_empty() {
        anyhow::bail!("command args template must not be empty");
    }

    Ok(args
        .into_iter()
        .map(|arg| command_template_arg(&arg, values))
        .collect())
}

fn command_template_arg(arg: &str, values: &CommandTemplateValues<'_>) -> String {
    arg.replace("{device}", values.device)
        .replace("{format}", values.format)
        .replace("{sample_rate}", &values.sample_rate.to_string())
        .replace("{channels}", &values.channels.to_string())
        .replace("{seconds}", &values.seconds.to_string())
        .replace("{output_path}", values.output)
        .replace("{output}", values.output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values() -> CommandTemplateValues<'static> {
        CommandTemplateValues {
            channels: 2,
            device: "hw:2,0",
            format: "S16_LE",
            output: "/tmp/recording with spaces.wav",
            sample_rate: 48_000,
            seconds: 15,
        }
    }

    #[test]
    fn expands_placeholders_in_shell_split_args() {
        assert_eq!(
            command_template_args(
                "--target {device} --rate {sample_rate} --file {output}",
                &values()
            )
            .unwrap(),
            vec![
                "--target",
                "hw:2,0",
                "--rate",
                "48000",
                "--file",
                "/tmp/recording with spaces.wav",
            ]
        );
    }

    #[test]
    fn keeps_quoted_segments_as_single_args() {
        assert_eq!(
            command_template_args("--property media.name='Rakkr Capture'", &values()).unwrap(),
            vec!["--property", "media.name=Rakkr Capture"]
        );
    }

    #[test]
    fn rejects_invalid_templates() {
        let error = command_template_args("--target 'unterminated", &values())
            .expect_err("unterminated quote should fail");

        assert!(error.to_string().contains("parse command args template"));
    }
}
