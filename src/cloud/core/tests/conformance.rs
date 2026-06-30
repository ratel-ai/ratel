//! Conformance suite over the shared fixtures in `../fixtures`. The TS and Python
//! clients run the identical suite against the same files, so these fixtures are
//! the cross-language contract (ADR-0013).

use std::fs;
use std::path::{Path, PathBuf};

use ratel_ai_cloud::{Event, validate};
use serde_json::Value;

fn fixtures(kind: &str) -> Vec<(PathBuf, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(kind);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}")) {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            out.push((path.clone(), fs::read_to_string(&path).unwrap()));
        }
    }
    assert!(!out.is_empty(), "no fixtures in {dir:?}");
    out
}

#[test]
fn valid_fixtures_deserialize_validate_and_round_trip() {
    for (path, raw) in fixtures("valid") {
        let event: Event =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("deserialize {path:?}: {e}"));
        validate(&event).unwrap_or_else(|e| panic!("validate {path:?}: {e}"));

        let reserialized = serde_json::to_value(&event).expect("re-serialize");
        let original: Value = serde_json::from_str(&raw).expect("parse original");
        assert_eq!(reserialized, original, "round-trip mismatch for {path:?}");
    }
}

#[test]
fn invalid_fixtures_deserialize_but_fail_validation() {
    for (path, raw) in fixtures("invalid") {
        // Invalid fixtures are structurally well-formed (so every language's
        // parser accepts them) but break a semantic rule, so `validate` rejects.
        let event: Event = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("invalid fixture {path:?} should still deserialize: {e}"));
        assert!(
            validate(&event).is_err(),
            "expected validation failure for {path:?}"
        );
    }
}
