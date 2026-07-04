use super::*;

#[test]
fn builds_chunk_upload_file_name_with_zero_padded_index() {
    assert_eq!(
        chunk_upload_file_name("rec_42.wav", 0),
        "rec_42.chunk-0000.wav"
    );
    assert_eq!(
        chunk_upload_file_name("rec_42.wav", 3),
        "rec_42.chunk-0003.wav"
    );
    assert_eq!(
        chunk_upload_file_name("meeting.flac", 12),
        "meeting.chunk-0012.flac"
    );
}

#[test]
fn chunk_upload_file_name_falls_back_for_extensionless_names() {
    assert_eq!(
        chunk_upload_file_name("recording", 1),
        "recording.chunk-0001.wav"
    );
}

#[test]
fn chunked_finish_completes_only_when_the_total_was_delivered() {
    // The completing chunkTotal reached the controller and nothing is pending.
    assert_eq!(
        chunked_finish_action(true, true),
        ChunkedFinishAction::Completed
    );
}

#[test]
fn chunked_finish_persists_a_partial_when_chunks_are_pending() {
    // Pending chunks are resumable regardless of whether the total went out.
    assert_eq!(
        chunked_finish_action(false, false),
        ChunkedFinishAction::PartialPending
    );
    assert_eq!(
        chunked_finish_action(true, false),
        ChunkedFinishAction::PartialPending
    );
}

#[test]
fn chunked_finish_finalizes_when_total_undelivered_and_nothing_pending() {
    // Regression for G62: the final chunk's render/upload never delivered the
    // total and nothing is pending to re-deliver on restart. The old code
    // wrote a terminal `completed` here, leaving the controller recording
    // hanging unfinalized; it must finalize instead.
    assert_eq!(
        chunked_finish_action(false, true),
        ChunkedFinishAction::FinalizeUndelivered
    );
}
