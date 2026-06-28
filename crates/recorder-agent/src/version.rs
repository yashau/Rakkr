//! Recorder-agent release version.
//!
//! The version lives in `crates/recorder-agent/VERSION` and is the single source
//! of truth. It follows the calendar format `YYYY.MM.DD-N`: the build date plus a
//! same-day release counter that starts at `1`. `include_str!` embeds the file at
//! compile time, so the binary always reports the version it was built from and a
//! `VERSION` change forces a rebuild.
//!
//! Releases are driven by bumping this file: CI compares the value against the
//! GitHub release history and only packages and publishes when it names a release
//! that does not exist yet.

/// Recorder-agent version embedded from the checked-in `VERSION` file.
pub const AGENT_VERSION: &str = include_str!("../VERSION").trim_ascii_end();

#[cfg(test)]
mod tests {
    use super::AGENT_VERSION;

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
    fn version_uses_calendar_format() {
        let (date, counter) = AGENT_VERSION
            .split_once('-')
            .unwrap_or_else(|| panic!("version {AGENT_VERSION} must end with a '-N' counter"));

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
            .unwrap_or_else(|_| panic!("counter in {AGENT_VERSION} must be an integer"));
        assert!(counter >= 1, "same-day counter must be 1 or greater");
    }
}
