//! Recorder-agent release version.
//!
//! The version is stamped at build time from the release tag: the release
//! workflow derives the calendar `YYYY.MM.DD-N` from the pushed `agent-v…` tag,
//! sets `RAKKR_AGENT_VERSION` for the build, and `option_env!` embeds it into the
//! binary. Local and CI builds without that variable report `0.0.0-dev`. The value
//! is surfaced through `--version` and inventory `agent_version`.

/// Sentinel reported by builds that were not stamped from a release tag.
pub const DEV_VERSION: &str = "0.0.0-dev";

/// Recorder-agent version, stamped from the release tag at build time.
pub const AGENT_VERSION: &str = match option_env!("RAKKR_AGENT_VERSION") {
    Some(value) => value,
    None => DEV_VERSION,
};

#[cfg(test)]
mod tests {
    use super::{AGENT_VERSION, DEV_VERSION};

    fn assert_calendar_format(version: &str) {
        let (date, counter) = version
            .split_once('-')
            .unwrap_or_else(|| panic!("version {version} must end with a '-N' counter"));

        let fields: Vec<&str> = date.split('.').collect();
        assert_eq!(fields.len(), 3, "version date {date} must be YYYY.MM.DD");

        for (field, width) in fields.iter().zip([4usize, 2, 2]) {
            assert_eq!(
                field.len(),
                width,
                "date field {field} must be {width} digits"
            );
            assert!(
                field.bytes().all(|byte| byte.is_ascii_digit()),
                "date field {field} must be numeric",
            );
        }

        let month: u32 = fields[1].parse().expect("month must parse");
        let day: u32 = fields[2].parse().expect("day must parse");
        assert!((1..=12).contains(&month), "month {month} out of range");
        assert!((1..=31).contains(&day), "day {day} out of range");

        let counter: u32 = counter
            .parse()
            .unwrap_or_else(|_| panic!("counter in {version} must be an integer"));
        assert!(counter >= 1, "same-day counter must be 1 or greater");
    }

    #[test]
    fn version_has_no_surrounding_whitespace() {
        assert!(!AGENT_VERSION.is_empty(), "agent version must not be empty");
        assert_eq!(
            AGENT_VERSION,
            AGENT_VERSION.trim(),
            "agent version must not carry surrounding whitespace",
        );
    }

    #[test]
    fn embedded_version_is_dev_fallback_or_calendar() {
        if AGENT_VERSION == DEV_VERSION {
            return;
        }
        assert_calendar_format(AGENT_VERSION);
    }

    #[test]
    fn calendar_validator_accepts_a_release_version() {
        assert_calendar_format("2026.06.28-1");
    }
}
