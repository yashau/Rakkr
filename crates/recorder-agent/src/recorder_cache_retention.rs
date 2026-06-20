use std::fs;
use std::io::ErrorKind;
use std::path::Path;

#[derive(Debug, Eq, PartialEq)]
pub struct RecorderCacheRetentionCleanup {
    pub deleted_paths: Vec<String>,
    pub errors: Vec<String>,
}

pub fn delete_recorder_cache_files(
    raw_output_path: &Path,
    output_path: &Path,
) -> RecorderCacheRetentionCleanup {
    let mut deleted_paths = Vec::new();
    let mut errors = Vec::new();

    for path in unique_cache_paths(raw_output_path, output_path) {
        match fs::remove_file(path) {
            Ok(()) => deleted_paths.push(path.display().to_string()),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                deleted_paths.push(path.display().to_string());
            }
            Err(error) => errors.push(format!("{}: {}", path.display(), error)),
        }
    }

    RecorderCacheRetentionCleanup {
        deleted_paths,
        errors,
    }
}

fn unique_cache_paths<'a>(raw_output_path: &'a Path, output_path: &'a Path) -> Vec<&'a Path> {
    if raw_output_path == output_path {
        vec![output_path]
    } else {
        vec![raw_output_path, output_path]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "filesystem cleanup is covered by fake-controller smoke"]
    fn deletes_distinct_raw_and_rendered_outputs() {
        let root = temp_dir("distinct");
        let raw = root.join("recording.raw.wav");
        let rendered = root.join("recording.mp3");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(&raw, b"raw").unwrap();
        fs::write(&rendered, b"rendered").unwrap();

        let cleanup = delete_recorder_cache_files(&raw, &rendered);

        assert!(cleanup.errors.is_empty());
        assert_eq!(cleanup.deleted_paths.len(), 2);
        assert!(!raw.exists());
        assert!(!rendered.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "filesystem cleanup is covered by fake-controller smoke"]
    fn deletes_direct_wav_once() {
        let root = temp_dir("direct");
        let output = root.join("recording.wav");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(&output, b"wav").unwrap();

        let cleanup = delete_recorder_cache_files(&output, &output);

        assert!(cleanup.errors.is_empty());
        assert_eq!(cleanup.deleted_paths.len(), 1);
        assert!(!output.exists());

        let _ = fs::remove_dir_all(root);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rakkr-recorder-cache-retention-{name}"))
    }
}
