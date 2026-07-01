//! chunkTotal derivation for chunked crash-recovery. Extracted from
//! `recording_job_recovery.rs` to keep that module under the 1000-LOC budget.

use crate::state::AgentJobState;

/// The chunkTotal to stamp on recovered chunk uploads. If the persisted state
/// already knows the total (capture finished before the crash), use it. Otherwise
/// the agent crashed mid-capture — `chunk_total` was never persisted — so derive
/// it from the highest known chunk index across uploaded + pending chunks. That
/// lets a recovered chunk carry the total and the controller finalize the
/// recording (partial if a chunk is missing) instead of hanging until the lease
/// reaper fails it. Returns `None` only when nothing was captured.
///
/// Residual: when every chunk uploaded before the crash and no pending chunk
/// remains, there is no upload to carry the total; that case shares the
/// decoupled-finalize gap with the graceful-finish empty-`trailing` path and is
/// tracked separately (needs an agent->controller finalize signal independent of
/// a chunk-file upload).
pub(crate) fn recovered_chunk_total(state: &AgentJobState) -> Option<u32> {
    if state.chunk_total.is_some() {
        return state.chunk_total;
    }

    let uploaded = state.uploaded_chunk_count.unwrap_or(0);
    let highest_pending = state
        .pending_chunks
        .iter()
        .map(|chunk| chunk.index + 1)
        .max()
        .unwrap_or(0);
    let total = highest_pending.max(uploaded);

    (total > 0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::recovered_chunk_total;
    use crate::state::{AgentJobState, AgentPendingChunk};

    #[test]
    fn recovered_chunk_total_uses_persisted_total_or_derives_from_indices() {
        let state =
            |chunk_total: Option<u32>, uploaded: Option<u32>, pending: Vec<u32>| AgentJobState {
                chunk_total,
                job_id: "job".to_string(),
                node_id: "node".to_string(),
                output_path: None,
                pending_chunks: pending
                    .into_iter()
                    .map(|index| AgentPendingChunk {
                        index,
                        output_path: format!("chunk-{index}.wav"),
                        raw_output_path: format!("chunk-{index}.raw.wav"),
                    })
                    .collect(),
                raw_output_path: None,
                reason: None,
                recorder_cache_retention: None,
                recording_id: "rec".to_string(),
                recovered_segments: Vec::new(),
                status: "running".to_string(),
                upload_content_type: None,
                upload_duration_seconds: None,
                upload_file_name: None,
                updated_at: "2026-06-18T12:00:00.000Z".to_string(),
                uploaded_chunk_count: uploaded,
            };

        // A persisted total (capture finished before the crash) wins outright.
        assert_eq!(
            recovered_chunk_total(&state(Some(4), Some(1), vec![1, 2, 3])),
            Some(4)
        );
        // Crash mid-capture: derive from the highest pending index + 1 so a
        // recovered chunk carries the total (pre-fix this was None -> never sent).
        assert_eq!(
            recovered_chunk_total(&state(None, Some(1), vec![1, 2])),
            Some(3)
        );
        // Uploaded count dominates when it exceeds the pending indices.
        assert_eq!(
            recovered_chunk_total(&state(None, Some(5), Vec::new())),
            Some(5)
        );
        // Nothing captured -> None (recovery fails the job).
        assert_eq!(
            recovered_chunk_total(&state(None, Some(0), Vec::new())),
            None
        );
    }
}
