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

#[test]
fn parses_controller_date_header_skew() {
    let now = OffsetDateTime::parse("Wed, 25 Jun 2036 11:59:55 GMT", &Rfc2822).expect("parse now");
    let skew = controller_clock_skew_seconds_at("Wed, 25 Jun 2036 12:00:00 GMT", now)
        .expect("parse future date header");

    assert_eq!(skew, 5);
    assert!(controller_clock_skew_seconds_at("not a date", now).is_none());
}
