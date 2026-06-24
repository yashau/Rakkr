use super::*;

#[test]
fn builds_recording_cache_url_without_double_slashes() {
    assert_eq!(
        recording_cache_url("https://controller.local/", "rec_123"),
        "https://controller.local/api/v1/recordings/rec_123/cache-file"
    );
}

#[test]
fn builds_node_url_without_double_slashes() {
    assert_eq!(
        node_url("https://controller.local/", "node_1", "/meter-frame"),
        "https://controller.local/api/v1/nodes/node_1/meter-frame"
    );
}
