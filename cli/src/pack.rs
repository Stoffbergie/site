use crate::crypto::{self, LinkHint, LinkKey, Sealer};
use crate::dotfiles::{self, DotName};
use anyhow::{Context, Result, bail};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;
use std::fs::File;
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8] = b"SITEPACK1\n";
pub const MAX_DEPLOY_BYTES: u64 = 100_000_000;
pub const MAX_FILES: usize = 5000;

#[derive(Serialize)]
struct Index<'a> {
    spa: bool,
    files: &'a [Entry],
}

#[derive(Serialize)]
struct Entry {
    path: String,
    offset: u64,
    length: u64,
    #[serde(rename = "type")]
    content_type: &'static str,
    gzip: bool,
}

#[derive(Serialize)]
struct SealedIndex<'a> {
    spa: bool,
    files: Vec<SealedEntry<'a>>,
}

#[derive(Serialize)]
struct SealedEntry<'a> {
    path: &'a str,
    #[serde(rename = "type")]
    content_type: &'static str,
    gzip: bool,
    length: u64,
}

#[derive(Serialize)]
struct EncryptedIndex {
    encrypted: Encrypted,
    files: Vec<OpaqueEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Encrypted {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_salt: Option<String>,
    content_salt: String,
}

#[derive(Serialize)]
struct OpaqueEntry {
    offset: u64,
    length: u64,
}

pub struct Pack {
    header: Vec<u8>,
    parts: Vec<Part>,
    pub total: u64,
}

impl Pack {
    pub fn collect(arguments: &[String], spa: bool, link_key: Option<&LinkKey>) -> Result<Pack> {
        let sources = sources(arguments)?;
        if link_key.is_some() {
            dotfiles::note_private_well_known(sources.iter().map(|(path, _)| path.as_str()));
        }
        if sources.len() > MAX_FILES {
            bail!(
                "that is {} files; a deploy holds at most {MAX_FILES}",
                sources.len()
            );
        }
        let mut entries = Vec::with_capacity(sources.len());
        let mut bodies = Vec::with_capacity(sources.len());
        let mut offset = 0;
        for (path, source) in sources {
            let content_type = content_type(&path);
            let (body, gzip) = prepare(source, compressible(&path))?;
            let length = body.length();
            entries.push(Entry {
                path,
                offset,
                length,
                content_type,
                gzip,
            });
            bodies.push(body);
            offset += length;
        }
        let (json, parts, data_length) = match link_key {
            None => {
                let json = serde_json::to_vec(&Index {
                    spa,
                    files: &entries,
                })?;
                let parts = bodies.into_iter().map(Part::Plain).collect();
                (json, parts, offset)
            }
            Some(link_key) => seal(spa, &entries, bodies, link_key)?,
        };
        let mut header = Vec::with_capacity(MAGIC.len() + 4 + json.len());
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&(json.len() as u32).to_be_bytes());
        header.extend_from_slice(&json);
        let total = header.len() as u64 + data_length;
        if total > MAX_DEPLOY_BYTES {
            bail!(
                "this deploy is {} and the limit is 100 MB; leave out large files or host them elsewhere",
                crate::output::size(total)
            );
        }
        Ok(Pack {
            header,
            parts,
            total,
        })
    }

    pub fn into_reader(self) -> PackReader {
        let mut parts = vec![Part::Plain(Plain::bytes(self.header))];
        parts.extend(self.parts);
        parts.reverse();
        PackReader {
            parts,
            sent: 0,
            total: self.total,
            show_progress: crate::output::stderr_is_terminal() && self.total > 1_000_000,
            last_percent: u64::MAX,
        }
    }
}

fn seal(
    spa: bool,
    entries: &[Entry],
    bodies: Vec<Plain>,
    link_key: &LinkKey,
) -> Result<(Vec<u8>, Vec<Part>, u64)> {
    let content_salt = crypto::random_salt()?;
    let sealer = link_key.sealer(&content_salt)?;
    let sealed_index = serde_json::to_vec(&SealedIndex {
        spa,
        files: entries
            .iter()
            .map(|entry| SealedEntry {
                path: &entry.path,
                content_type: entry.content_type,
                gzip: entry.gzip,
                length: entry.length,
            })
            .collect(),
    })?;
    let mut plains = vec![Plain::bytes(sealed_index)];
    plains.extend(bodies);

    let mut files = Vec::with_capacity(plains.len());
    let mut parts = Vec::with_capacity(plains.len());
    let mut offset = 0;
    for (entry, plain) in plains.into_iter().enumerate() {
        let length = crypto::sealed_length(plain.length());
        files.push(OpaqueEntry { offset, length });
        let sealing = Sealing::new(plain, entry as u32, sealer.clone());
        parts.push(Part::Sealed(Box::new(sealing)));
        offset += length;
    }

    let (name, link_salt) = match &link_key.hint {
        LinkHint::Name(name) => (Some(name.clone()), None),
        LinkHint::Salt(salt) => (None, Some(salt.clone())),
    };
    let json = serde_json::to_vec(&EncryptedIndex {
        encrypted: Encrypted {
            name,
            link_salt,
            content_salt,
        },
        files,
    })?;
    Ok((json, parts, offset))
}

enum Source {
    Path(PathBuf),
    Stdin,
}

fn sources(arguments: &[String]) -> Result<Vec<(String, Source)>> {
    if arguments.is_empty() {
        bail!("give a folder or files to deploy, like: site dist");
    }
    if arguments.iter().any(|argument| argument == "-") {
        if arguments.len() > 1 {
            bail!("- reads stdin on its own; deploy files separately");
        }
        if std::io::stdin().is_terminal() {
            bail!("pipe a page into site -, like: cat page.html | site -");
        }
        return Ok(vec![("index.html".to_string(), Source::Stdin)]);
    }

    if arguments.len() == 1 {
        let root = PathBuf::from(&arguments[0]);
        let metadata = std::fs::metadata(&root)
            .with_context(|| format!("could not find {}", root.display()))?;
        if metadata.is_dir() {
            let mut found = Vec::new();
            let mut left_out = Vec::new();
            walk(&root, "", &mut found, &mut left_out)?;
            dotfiles::note_left_out(&left_out);
            if found.is_empty() {
                bail!("{} has nothing to deploy", root.display());
            }
            found.sort_by(|left, right| left.0.cmp(&right.0));
            return Ok(found);
        }
    }

    let mut loose: Vec<(String, Source)> = Vec::new();
    let mut left_out = Vec::new();
    for argument in arguments {
        let path = PathBuf::from(argument);
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("could not find {}", path.display()))?;
        if metadata.is_dir() {
            bail!("deploy one folder on its own, or only files");
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .with_context(|| format!("{} has a name site cannot use", path.display()))?
            .to_string();
        match dotfiles::classify(&name) {
            DotName::Deploy => {}
            DotName::SkipQuietly => continue,
            DotName::LeaveOut => {
                left_out.push(name);
                continue;
            }
        }
        if loose.iter().any(|(existing, _)| existing == &name) {
            bail!("two files are named {name}; each loose file lands at the root under its name");
        }
        loose.push((name, Source::Path(path)));
    }
    dotfiles::note_left_out(&left_out);
    if loose.is_empty() {
        bail!("nothing to deploy: names starting with a dot stay private, except .well-known");
    }
    Ok(loose)
}

fn walk(
    directory: &Path,
    prefix: &str,
    found: &mut Vec<(String, Source)>,
    left_out: &mut Vec<String>,
) -> Result<()> {
    let entries = std::fs::read_dir(directory)
        .with_context(|| format!("could not read {}", directory.display()))?;
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            bail!("{} has a name site cannot use", entry.path().display());
        };
        if name == "node_modules" {
            continue;
        }
        let relative = format!("{prefix}{name}");
        match dotfiles::classify(&name) {
            DotName::Deploy => {}
            DotName::SkipQuietly => continue,
            DotName::LeaveOut => {
                left_out.push(relative);
                continue;
            }
        }
        let path = entry.path();
        if entry.file_type()?.is_symlink() {
            crate::output::note(&format!("Skipped {}: it is a symlink", path.display()));
            continue;
        }
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        if metadata.is_dir() {
            walk(&path, &format!("{relative}/"), found, left_out)?;
        } else if metadata.is_file() {
            found.push((relative, Source::Path(path)));
        }
    }
    Ok(())
}

fn prepare(source: Source, compress: bool) -> Result<(Plain, bool)> {
    let path = match source {
        Source::Stdin => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes)?;
            return Ok(smaller(bytes, compress));
        }
        Source::Path(path) => path,
    };
    if compress {
        let bytes =
            std::fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
        return Ok(smaller(bytes, true));
    }
    let length = std::fs::metadata(&path)?.len();
    let file = Plain::File {
        path,
        length,
        open: None,
    };
    Ok((file, false))
}

fn smaller(bytes: Vec<u8>, compress: bool) -> (Plain, bool) {
    if compress {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        let compressed = encoder.write_all(&bytes).and_then(|()| encoder.finish());
        if let Ok(compressed) = compressed
            && compressed.len() < bytes.len()
        {
            return (Plain::bytes(compressed), true);
        }
    }
    (Plain::bytes(bytes), false)
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((_, extension)) => extension.to_ascii_lowercase(),
        None => String::new(),
    }
}

fn compressible(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "json"
            | "map"
            | "webmanifest"
            | "svg"
            | "txt"
            | "md"
            | "csv"
            | "xml"
            | "wasm"
            | "ttf"
            | "otf"
            | "ico"
    )
}

fn content_type(path: &str) -> &'static str {
    let extension = extension(path);
    if extension.is_empty()
        && let Some(content_type) = dotfiles::well_known_type(path)
    {
        return content_type;
    }
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

enum Plain {
    Bytes(std::io::Cursor<Vec<u8>>),
    File {
        path: PathBuf,
        length: u64,
        open: Option<std::io::Take<File>>,
    },
}

impl Plain {
    fn bytes(bytes: Vec<u8>) -> Plain {
        Plain::Bytes(std::io::Cursor::new(bytes))
    }

    fn length(&self) -> u64 {
        match self {
            Plain::Bytes(cursor) => cursor.get_ref().len() as u64,
            Plain::File { length, .. } => *length,
        }
    }
}

impl Read for Plain {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Plain::Bytes(cursor) => cursor.read(buffer),
            Plain::File { path, length, open } => {
                if open.is_none() {
                    *open = Some(File::open(&*path)?.take(*length));
                }
                let reader = open.as_mut().expect("file was just opened");
                let count = reader.read(buffer)?;
                if count == 0 && reader.limit() > 0 {
                    return Err(std::io::Error::other(format!(
                        "{} changed while deploying; deploy again",
                        path.display()
                    )));
                }
                Ok(count)
            }
        }
    }
}

struct Sealing {
    plain: Plain,
    plain_length: u64,
    entry: u32,
    next_chunk: u64,
    chunks: u64,
    sealer: Sealer,
    sealed: std::io::Cursor<Vec<u8>>,
}

impl Sealing {
    fn new(plain: Plain, entry: u32, sealer: Sealer) -> Sealing {
        let plain_length = plain.length();
        Sealing {
            plain,
            plain_length,
            entry,
            next_chunk: 0,
            chunks: crypto::chunk_count(plain_length),
            sealer,
            sealed: std::io::Cursor::new(Vec::new()),
        }
    }
}

impl Read for Sealing {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let count = self.sealed.read(buffer)?;
            if count > 0 || self.next_chunk == self.chunks {
                return Ok(count);
            }
            let start = self.next_chunk * crypto::CHUNK_SIZE;
            let size = crypto::CHUNK_SIZE.min(self.plain_length - start);
            let mut chunk = vec![0u8; size as usize];
            self.plain.read_exact(&mut chunk)?;
            let last = self.next_chunk + 1 == self.chunks;
            self.sealer
                .seal(self.entry, self.next_chunk as u32, last, &mut chunk)
                .map_err(std::io::Error::other)?;
            self.sealed = std::io::Cursor::new(chunk);
            self.next_chunk += 1;
        }
    }
}

enum Part {
    Plain(Plain),
    Sealed(Box<Sealing>),
}

pub struct PackReader {
    parts: Vec<Part>,
    sent: u64,
    total: u64,
    show_progress: bool,
    last_percent: u64,
}

impl PackReader {
    fn report(&mut self) {
        if !self.show_progress {
            return;
        }
        let percent = self.sent * 100 / self.total.max(1);
        if percent != self.last_percent {
            self.last_percent = percent;
            crate::output::progress(self.sent, self.total);
        }
    }
}

impl Read for PackReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        while let Some(part) = self.parts.last_mut() {
            let count = match part {
                Part::Plain(plain) => plain.read(buffer)?,
                Part::Sealed(sealing) => sealing.read(buffer)?,
            };
            if count > 0 {
                self.sent += count as u64;
                self.report();
                return Ok(count);
            }
            self.parts.pop();
        }
        Ok(0)
    }
}
