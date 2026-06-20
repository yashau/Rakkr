use std::path::Path;

pub fn content_type_for_codec(codec: Option<&str>, path: &Path) -> &'static str {
    match codec.map(str::to_ascii_lowercase).as_deref() {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => content_type_for_path(path),
    }
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_encoded_recording_content_types() {
        assert_eq!(
            content_type_for_codec(Some("mp3"), Path::new("recording.wav")),
            "audio/mpeg"
        );
        assert_eq!(
            content_type_for_codec(None, Path::new("recording.flac")),
            "audio/flac"
        );
    }
}
