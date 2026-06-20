use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecorderCacheRetention {
    pub delete_after_upload: bool,
    pub max_age_days: Option<u64>,
    pub max_bytes: Option<u64>,
    pub min_free_disk_percent: Option<u8>,
    pub policy_id: String,
}

impl ControllerRecorderCacheRetention {
    pub fn has_deferred_sweep(&self) -> bool {
        self.max_age_days.is_some() || self.max_bytes.is_some()
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct RecorderCacheRetentionCleanup {
    pub deleted_paths: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderCacheSweepSummary {
    pub deleted: usize,
    pub errors: usize,
    pub items: Vec<RecorderCacheSweepItem>,
    pub scanned: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderCacheSweepItem {
    pub errors: Vec<String>,
    pub policy_id: String,
    pub reason: String,
    pub recording_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecorderCacheManifest {
    entries: Vec<RecorderCacheManifestEntry>,
    version: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecorderCacheManifestEntry {
    output_path: String,
    policy_id: String,
    raw_output_path: String,
    recording_id: String,
}

struct RecorderCacheCandidate {
    entry: RecorderCacheManifestEntry,
    modified_at: SystemTime,
    size: u64,
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

pub fn record_uploaded_cache_files(
    manifest_path: &Path,
    recording_id: &str,
    policy: &ControllerRecorderCacheRetention,
    raw_output_path: &Path,
    output_path: &Path,
) -> anyhow::Result<()> {
    if !policy.has_deferred_sweep() {
        return Ok(());
    }

    let mut manifest = load_manifest(manifest_path)?;

    manifest
        .entries
        .retain(|entry| entry.recording_id != recording_id);
    manifest.entries.push(RecorderCacheManifestEntry {
        output_path: output_path.display().to_string(),
        policy_id: policy.policy_id.clone(),
        raw_output_path: raw_output_path.display().to_string(),
        recording_id: recording_id.to_string(),
    });

    save_manifest(manifest_path, &manifest)
}

pub fn run_recorder_cache_sweep(
    manifest_path: &Path,
    policies: &[ControllerRecorderCacheRetention],
    now: SystemTime,
) -> anyhow::Result<RecorderCacheSweepSummary> {
    let mut manifest = load_manifest(manifest_path)?;
    let mut candidates = Vec::new();
    let mut missing_recordings = Vec::new();

    for entry in &manifest.entries {
        match candidate_for_entry(entry) {
            Some(candidate) => candidates.push(candidate),
            None => missing_recordings.push(entry.recording_id.clone()),
        }
    }

    let deletion_plan = deletion_plan(&candidates, policies, now);
    let mut summary = RecorderCacheSweepSummary {
        scanned: candidates.len(),
        ..RecorderCacheSweepSummary::default()
    };
    let mut deleted_recordings = missing_recordings;

    for (recording_id, reason) in deletion_plan {
        let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.entry.recording_id == recording_id)
        else {
            continue;
        };
        let cleanup = delete_recorder_cache_files(
            Path::new(&candidate.entry.raw_output_path),
            Path::new(&candidate.entry.output_path),
        );
        let status = if cleanup.errors.is_empty() {
            summary.deleted += 1;
            deleted_recordings.push(candidate.entry.recording_id.clone());
            "deleted"
        } else {
            summary.errors += 1;
            "failed"
        };

        summary.items.push(RecorderCacheSweepItem {
            errors: cleanup.errors,
            policy_id: candidate.entry.policy_id.clone(),
            reason,
            recording_id: candidate.entry.recording_id.clone(),
            status: status.to_string(),
        });
    }

    if !deleted_recordings.is_empty() {
        manifest
            .entries
            .retain(|entry| !deleted_recordings.contains(&entry.recording_id));
        save_manifest(manifest_path, &manifest)?;
    }

    Ok(summary)
}

fn deletion_plan(
    candidates: &[RecorderCacheCandidate],
    policies: &[ControllerRecorderCacheRetention],
    now: SystemTime,
) -> Vec<(String, String)> {
    let mut planned = Vec::new();

    for policy in policies {
        let mut policy_candidates = candidates
            .iter()
            .filter(|candidate| candidate.entry.policy_id == policy.policy_id)
            .collect::<Vec<_>>();
        let mut retained_bytes = policy_candidates
            .iter()
            .map(|candidate| candidate.size)
            .sum::<u64>();

        if let Some(max_age_days) = policy.max_age_days {
            let max_age = Duration::from_secs(max_age_days.saturating_mul(86_400));

            for candidate in &policy_candidates {
                if now
                    .duration_since(candidate.modified_at)
                    .is_ok_and(|age| age >= max_age)
                {
                    planned.push((candidate.entry.recording_id.clone(), "max_age".to_string()));
                    retained_bytes = retained_bytes.saturating_sub(candidate.size);
                }
            }
        }

        if let Some(max_bytes) = policy.max_bytes {
            policy_candidates.sort_by_key(|candidate| candidate.modified_at);

            for candidate in policy_candidates {
                if retained_bytes <= max_bytes {
                    break;
                }

                if planned
                    .iter()
                    .any(|(recording_id, _)| recording_id == &candidate.entry.recording_id)
                {
                    continue;
                }

                planned.push((
                    candidate.entry.recording_id.clone(),
                    "max_bytes".to_string(),
                ));
                retained_bytes = retained_bytes.saturating_sub(candidate.size);
            }
        }
    }

    planned
}

fn candidate_for_entry(entry: &RecorderCacheManifestEntry) -> Option<RecorderCacheCandidate> {
    let paths = unique_manifest_paths(entry);
    let mut modified_at = SystemTime::now();
    let mut size = 0_u64;
    let mut found = false;

    for path in paths {
        let metadata = fs::metadata(&path).ok()?;

        found = true;
        size += metadata.len();
        modified_at = modified_at.min(metadata.modified().ok()?);
    }

    found.then(|| RecorderCacheCandidate {
        entry: entry.clone(),
        modified_at,
        size,
    })
}

fn unique_manifest_paths(entry: &RecorderCacheManifestEntry) -> Vec<PathBuf> {
    if entry.raw_output_path == entry.output_path {
        vec![PathBuf::from(&entry.output_path)]
    } else {
        vec![
            PathBuf::from(&entry.raw_output_path),
            PathBuf::from(&entry.output_path),
        ]
    }
}

fn load_manifest(path: &Path) -> anyhow::Result<RecorderCacheManifest> {
    if !path.exists() {
        return Ok(RecorderCacheManifest {
            entries: Vec::new(),
            version: 1,
        });
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("read recorder cache manifest {}", path.display()))?;

    serde_json::from_str(&raw)
        .with_context(|| format!("decode recorder cache manifest {}", path.display()))
}

fn save_manifest(path: &Path, manifest: &RecorderCacheManifest) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "create recorder cache manifest directory {}",
                parent.display()
            )
        })?;
    }

    fs::write(path, serde_json::to_vec_pretty(manifest)?)
        .with_context(|| format!("write recorder cache manifest {}", path.display()))
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
