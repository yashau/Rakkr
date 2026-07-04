use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use serde::{Deserialize, Serialize};

// Serializes every manifest read-modify-write. A node runs a single agent process,
// but that process runs up to `max_concurrent_recordings` recording-job workers as
// concurrent tasks, and each finalization (`record_uploaded_cache_files`) plus the
// idle sweep (`run_recorder_cache_sweep`) load the manifest, mutate it, and save it.
// Without serialization two concurrent finalizations both load the same manifest,
// each append their own entry, and the second save clobbers the first — dropping an
// entry so that recording's cache files leak untracked (never reclaimed by any
// age/bytes/min-free policy). It also collides the shared temp file used by the
// atomic save. An in-process mutex is sufficient because a single agent process owns
// the manifest; there is no second writer process to coordinate with.
static MANIFEST_MUTEX: Mutex<()> = Mutex::new(());

fn lock_manifest() -> MutexGuard<'static, ()> {
    // A panic while another writer held the lock must not permanently wedge cache
    // tracking, so recover the guard from a poisoned mutex rather than propagating.
    MANIFEST_MUTEX
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

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
        self.max_age_days.is_some()
            || self.max_bytes.is_some()
            || self.min_free_disk_percent.is_some()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RecorderCacheDiskUsage {
    pub free_bytes: u64,
    pub free_percent: f32,
    pub total_bytes: u64,
}

impl RecorderCacheDiskUsage {
    fn bytes_needed_for_min_free(self, min_free_disk_percent: u8) -> u64 {
        let required_free_bytes =
            ((self.total_bytes as f64) * (f64::from(min_free_disk_percent) / 100.0)).ceil() as u64;

        required_free_bytes.saturating_sub(self.free_bytes)
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

    // Hold the manifest lock across the whole load-modify-save so a concurrent
    // finalization or sweep cannot clobber this entry (or the shared temp file).
    let _guard = lock_manifest();
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
    disk_usage: Option<RecorderCacheDiskUsage>,
    now: SystemTime,
) -> anyhow::Result<RecorderCacheSweepSummary> {
    // Hold the lock across the sweep's own load-modify-save: a finalization that
    // lands mid-sweep must not have its new entry dropped by the pruned save below.
    let _guard = lock_manifest();
    let mut manifest = load_manifest(manifest_path)?;
    let mut candidates = Vec::new();
    let mut missing_recordings = Vec::new();

    for entry in &manifest.entries {
        match candidate_for_entry(entry) {
            Some(candidate) => candidates.push(candidate),
            None => missing_recordings.push(entry.recording_id.clone()),
        }
    }

    let deletion_plan = deletion_plan(&candidates, policies, disk_usage, now);
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
    disk_usage: Option<RecorderCacheDiskUsage>,
    now: SystemTime,
) -> Vec<(String, String)> {
    let mut freed_bytes = 0_u64;
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
                    && push_deletion(&mut planned, &mut freed_bytes, candidate, "max_age")
                {
                    retained_bytes = retained_bytes.saturating_sub(candidate.size);
                }
            }
        }

        if let Some(max_bytes) = policy.max_bytes {
            policy_candidates.sort_by_key(|candidate| candidate.modified_at);

            for candidate in &policy_candidates {
                if retained_bytes <= max_bytes {
                    break;
                }

                if push_deletion(&mut planned, &mut freed_bytes, candidate, "max_bytes") {
                    retained_bytes = retained_bytes.saturating_sub(candidate.size);
                }
            }
        }

        if let (Some(min_free_disk_percent), Some(disk_usage)) =
            (policy.min_free_disk_percent, disk_usage)
            && disk_usage.free_percent < f32::from(min_free_disk_percent)
        {
            let mut bytes_needed = disk_usage
                .bytes_needed_for_min_free(min_free_disk_percent)
                .saturating_sub(freed_bytes);

            policy_candidates.sort_by_key(|candidate| candidate.modified_at);

            for candidate in &policy_candidates {
                if bytes_needed == 0 {
                    break;
                }

                if push_deletion(&mut planned, &mut freed_bytes, candidate, "min_free_disk") {
                    bytes_needed = bytes_needed.saturating_sub(candidate.size);
                }
            }
        }
    }

    planned
}

fn push_deletion(
    planned: &mut Vec<(String, String)>,
    freed_bytes: &mut u64,
    candidate: &RecorderCacheCandidate,
    reason: &str,
) -> bool {
    if planned
        .iter()
        .any(|(recording_id, _)| recording_id == &candidate.entry.recording_id)
    {
        return false;
    }

    planned.push((candidate.entry.recording_id.clone(), reason.to_string()));
    *freed_bytes = freed_bytes.saturating_add(candidate.size);
    true
}

fn candidate_for_entry(entry: &RecorderCacheManifestEntry) -> Option<RecorderCacheCandidate> {
    let paths = unique_manifest_paths(entry);
    let mut modified_at = SystemTime::now();
    let mut size = 0_u64;
    let mut found = false;

    for path in paths {
        // Treat a missing path as already-gone (skip it) rather than aborting
        // the whole entry. Aborting sent the entry down the `missing_recordings`
        // path, which drops it from the manifest WITHOUT deleting the surviving
        // sibling — leaking that file on disk, untracked and unreclaimable by any
        // age/bytes/min-free policy. Keeping a partially-present entry as a real
        // candidate lets `delete_recorder_cache_files` reclaim the survivor (it
        // already tolerates the missing sibling).
        let Some(metadata) = fs::metadata(&path).ok() else {
            continue;
        };

        found = true;
        size += metadata.len();

        if let Ok(modified) = metadata.modified() {
            modified_at = modified_at.min(modified);
        }
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

    // Atomic write (temp + rename): a crash mid-write must not leave a torn manifest
    // that fails to decode on the next sweep (load_manifest would then error every
    // idle tick — best-effort-swallowed by run_idle_recorder_cache_sweep, but the
    // sweep would never make progress).
    let mut temp = path.as_os_str().to_os_string();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp_path = std::path::PathBuf::from(temp);

    fs::write(&temp_path, serde_json::to_vec_pretty(manifest)?)
        .with_context(|| format!("write recorder cache manifest {}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .with_context(|| format!("replace recorder cache manifest {}", path.display()))
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

    #[test]
    #[cfg_attr(miri, ignore)]
    fn reports_cache_delete_failures() {
        let root = temp_dir("delete-failure");
        let raw = root.join("recording.raw.wav");
        let rendered = root.join("recording.mp3");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&raw).unwrap();
        fs::write(&rendered, b"rendered").unwrap();

        let cleanup = delete_recorder_cache_files(&raw, &rendered);

        assert_eq!(cleanup.deleted_paths, vec![rendered.display().to_string()]);
        assert_eq!(cleanup.errors.len(), 1);
        assert!(cleanup.errors[0].contains(&raw.display().to_string()));
        assert!(raw.is_dir());
        assert!(!rendered.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn sweeps_surviving_file_when_sibling_is_already_gone() {
        let root = temp_dir("orphan-survivor");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // The raw output is already gone; only the rendered output survives.
        let raw = root.join("recording.raw.wav");
        let rendered = root.join("recording.mp3");
        fs::write(&rendered, b"rendered").unwrap();
        let manifest_path = root.join("manifest.json");
        save_manifest(
            &manifest_path,
            &RecorderCacheManifest {
                entries: vec![RecorderCacheManifestEntry {
                    output_path: rendered.display().to_string(),
                    policy_id: "retain-1d".to_string(),
                    raw_output_path: raw.display().to_string(),
                    recording_id: "rec_orphan".to_string(),
                }],
                version: 1,
            },
        )
        .unwrap();

        let mut policy = policy("retain-1d");
        policy.max_age_days = Some(1);
        // Far past the age bound for the just-written survivor.
        let now = SystemTime::now() + Duration::from_secs(3 * 86_400);

        let summary = run_recorder_cache_sweep(&manifest_path, &[policy], None, now).unwrap();

        // Pre-fix: the missing raw aborted candidate_for_entry, the entry was
        // dropped from the manifest, and the surviving rendered file leaked
        // (deleted == 0, file still present). Now it is reclaimed.
        assert_eq!(summary.deleted, 1);
        assert!(!rendered.exists());

        let _ = fs::remove_dir_all(root);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let process_id = std::process::id();
        std::env::temp_dir().join(format!(
            "rakkr-recorder-cache-retention-{name}-{process_id}"
        ))
    }

    fn candidate(
        recording_id: &str,
        policy_id: &str,
        modified_offset: u64,
        size: u64,
    ) -> RecorderCacheCandidate {
        RecorderCacheCandidate {
            entry: RecorderCacheManifestEntry {
                output_path: format!("{recording_id}.mp3"),
                policy_id: policy_id.to_string(),
                raw_output_path: format!("{recording_id}.raw.wav"),
                recording_id: recording_id.to_string(),
            },
            modified_at: SystemTime::UNIX_EPOCH + Duration::from_secs(modified_offset),
            size,
        }
    }

    fn policy(policy_id: &str) -> ControllerRecorderCacheRetention {
        ControllerRecorderCacheRetention {
            delete_after_upload: false,
            max_age_days: None,
            max_bytes: None,
            min_free_disk_percent: None,
            policy_id: policy_id.to_string(),
        }
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn concurrent_uploads_do_not_lose_manifest_entries() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        // Multiple recording-job workers (max_concurrent_recordings >= 2) finalize
        // at once and each records its cache files in the shared manifest. Without a
        // serialized read-modify-write, two concurrent finalizations both load the
        // same manifest, each append their entry, and the second save clobbers the
        // first — dropping an entry so that recording's cache file leaks untracked
        // and is never swept. Every concurrently recorded entry must survive.
        let root = temp_dir("concurrent-manifest");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let manifest_path = root.join("manifest.json");

        let writers = 16;
        let barrier = Arc::new(Barrier::new(writers));
        let mut handles = Vec::new();
        for index in 0..writers {
            let manifest_path = manifest_path.clone();
            let root = root.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let mut policy = policy("retain-concurrent");
                policy.max_age_days = Some(1);
                let raw = root.join(format!("rec_{index}.raw.wav"));
                let rendered = root.join(format!("rec_{index}.mp3"));
                // Align every writer's load so the read-modify-write windows overlap.
                barrier.wait();
                record_uploaded_cache_files(
                    &manifest_path,
                    &format!("rec_{index}"),
                    &policy,
                    &raw,
                    &rendered,
                )
                .unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let manifest = load_manifest(&manifest_path).unwrap();
        assert_eq!(
            manifest.entries.len(),
            writers,
            "all concurrent manifest entries must survive the race"
        );
        for index in 0..writers {
            assert!(
                manifest
                    .entries
                    .iter()
                    .any(|entry| entry.recording_id == format!("rec_{index}")),
                "entry rec_{index} was lost to a concurrent write"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn treats_min_free_disk_as_deferred_sweep() {
        let mut policy = policy("retention-min-free");
        policy.min_free_disk_percent = Some(70);

        assert!(policy.has_deferred_sweep());
    }

    #[test]
    fn plans_oldest_cache_until_min_free_target_is_met() {
        let mut policy = policy("retention-min-free");
        policy.min_free_disk_percent = Some(70);
        let candidates = vec![
            candidate("newer", "retention-min-free", 20, 300),
            candidate("oldest", "retention-min-free", 10, 300),
            candidate("other-policy", "retention-other", 1, 900),
        ];
        let disk_usage = RecorderCacheDiskUsage {
            free_bytes: 400,
            free_percent: 40.0,
            total_bytes: 1000,
        };

        let planned = deletion_plan(
            &candidates,
            &[policy],
            Some(disk_usage),
            SystemTime::UNIX_EPOCH,
        );

        assert_eq!(
            planned,
            vec![("oldest".to_string(), "min_free_disk".to_string())]
        );
    }

    #[test]
    fn skips_min_free_sweep_without_disk_usage() {
        let mut policy = policy("retention-min-free");
        policy.min_free_disk_percent = Some(70);
        let candidates = vec![candidate("oldest", "retention-min-free", 10, 300)];

        let planned = deletion_plan(&candidates, &[policy], None, SystemTime::UNIX_EPOCH);

        assert!(planned.is_empty());
    }
}
