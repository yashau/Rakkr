//! Filesystem-safe capture file naming helpers. Extracted from `capture.rs` to
//! keep that module under the 1000-LOC budget.

pub(crate) fn safe_file_stem(value: &str) -> String {
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

pub fn safe_file_name(value: &str) -> String {
    let base_name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    let cleaned = base_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "recording.wav".to_string()
    } else {
        cleaned
    }
}
