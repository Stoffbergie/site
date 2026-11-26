use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

pub const SNIFF_BYTES: u64 = 512;
const TEXT: &str = "text/plain; charset=utf-8";
const BINARY: &str = "application/octet-stream";

#[derive(Deserialize)]
struct Table<'a> {
    #[serde(borrow)]
    paths: HashMap<&'a str, &'a str>,
    #[serde(borrow)]
    extensions: HashMap<&'a str, &'a str>,
}

static TABLE: LazyLock<Table<'static>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("types.json")).expect("types.json is a valid table")
});

pub fn known(path: &str) -> Option<&'static str> {
    if let Some(content_type) = TABLE.paths.get(path) {
        return Some(content_type);
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    TABLE.extensions.get(extension.as_str()).copied()
}

pub fn sniffed(head: &[u8]) -> &'static str {
    let binary = head
        .iter()
        .any(|byte| matches!(byte, 0x00..=0x08 | 0x0b | 0x0e..=0x1a | 0x1c..=0x1f));
    if binary { BINARY } else { TEXT }
}
