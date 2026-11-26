use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const REMEMBERED_DEPLOYS: usize = 16;

#[derive(Clone, Deserialize, Serialize)]
pub struct StoredFile {
    pub hash: String,
    pub length: u64,
    pub encoding: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RememberedDeploy {
    server: String,
    key: String,
    id: String,
    files: Vec<StoredFile>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Memory {
    deploys: Vec<RememberedDeploy>,
}

#[derive(Clone)]
pub struct Earlier {
    pub id: String,
    pub file: usize,
    pub length: u64,
    pub encoding: Option<String>,
}

pub type Known = HashMap<String, Vec<Earlier>>;

pub fn hash_hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn content_hash(bytes: &[u8]) -> String {
    hash_hex(&ring::digest::digest(&ring::digest::SHA256, bytes).as_ref()[..16])
}

fn key_fingerprint(key: &str) -> String {
    content_hash(key.as_bytes())
}

fn path() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join("site/deploys.json"))
}

fn load() -> Memory {
    let Some(path) = path() else {
        return Memory::default();
    };
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Memory::default(),
    }
}

fn save(memory: &Memory) {
    let Some(path) = path() else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(directory).is_err() {
        return;
    }
    let partial = path.with_extension(format!("json.{}.part", std::process::id()));
    let Ok(bytes) = serde_json::to_vec(memory) else {
        return;
    };
    if std::fs::write(&partial, bytes).is_ok() && std::fs::rename(&partial, &path).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
}

pub fn known(server: &str, key: &str) -> Known {
    let fingerprint = key_fingerprint(key);
    let mut known = Known::new();
    for deploy in load().deploys {
        if deploy.server != server || deploy.key != fingerprint {
            continue;
        }
        for (position, file) in deploy.files.into_iter().enumerate() {
            known.entry(file.hash).or_default().push(Earlier {
                id: deploy.id.clone(),
                file: position,
                length: file.length,
                encoding: file.encoding,
            });
        }
    }
    known
}

pub fn remember(server: &str, key: &str, id: &str, files: Vec<StoredFile>) {
    let mut memory = load();
    memory.deploys.insert(
        0,
        RememberedDeploy {
            server: server.to_string(),
            key: key_fingerprint(key),
            id: id.to_string(),
            files,
        },
    );
    memory.deploys.truncate(REMEMBERED_DEPLOYS);
    save(&memory);
}

pub fn forget_deploy(id: &str) {
    let mut memory = load();
    let before = memory.deploys.len();
    memory.deploys.retain(|deploy| deploy.id != id);
    if memory.deploys.len() != before {
        save(&memory);
    }
}

pub fn forget_all(server: &str, key: &str) {
    let fingerprint = key_fingerprint(key);
    let mut memory = load();
    memory
        .deploys
        .retain(|deploy| deploy.server != server || deploy.key != fingerprint);
    save(&memory);
}
