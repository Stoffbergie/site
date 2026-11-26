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

enum Body {
    Bytes(Vec<u8>),
    File(PathBuf),
}

pub struct Pack {
    header: Vec<u8>,
    bodies: Vec<(Body, u64)>,
    pub total: u64,
}

impl Pack {
    pub fn collect(arguments: &[String], spa: bool) -> Result<Pack> {
        let sources = sources(arguments)?;
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
            let (body, length, gzip) = prepare(source, compressible(&path))?;
            entries.push(Entry {
                path,
                offset,
                length,
                content_type,
                gzip,
            });
            bodies.push((body, length));
            offset += length;
        }
        let json = serde_json::to_vec(&Index {
            spa,
            files: &entries,
        })?;
        let mut header = Vec::with_capacity(MAGIC.len() + 4 + json.len());
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&(json.len() as u32).to_be_bytes());
        header.extend_from_slice(&json);
        let total = header.len() as u64 + offset;
        if total > MAX_DEPLOY_BYTES {
            bail!(
                "this deploy is {} and the limit is 100 MB; leave out large files or host them elsewhere",
                crate::output::size(total)
            );
        }
        Ok(Pack {
            header,
            bodies,
            total,
        })
    }

    pub fn into_reader(self) -> PackReader {
        let mut parts = vec![Part::Bytes(std::io::Cursor::new(self.header))];
        for (body, length) in self.bodies {
            match body {
                Body::Bytes(bytes) => parts.push(Part::Bytes(std::io::Cursor::new(bytes))),
                Body::File(path) => parts.push(Part::File {
                    path,
                    length,
                    open: None,
                }),
            }
        }
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
            walk(&root, "", &mut found)?;
            if found.is_empty() {
                bail!("{} has nothing to deploy", root.display());
            }
            found.sort_by(|left, right| left.0.cmp(&right.0));
            return Ok(found);
        }
    }

    let mut loose: Vec<(String, Source)> = Vec::new();
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
        if loose.iter().any(|(existing, _)| existing == &name) {
            bail!("two files are named {name}; each loose file lands at the root under its name");
        }
        loose.push((name, Source::Path(path)));
    }
    Ok(loose)
}

fn walk(directory: &Path, prefix: &str, found: &mut Vec<(String, Source)>) -> Result<()> {
    let entries = std::fs::read_dir(directory)
        .with_context(|| format!("could not read {}", directory.display()))?;
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            bail!("{} has a name site cannot use", entry.path().display());
        };
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let relative = format!("{prefix}{name}");
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        if metadata.is_dir() {
            walk(&path, &format!("{relative}/"), found)?;
        } else if metadata.is_file() {
            found.push((relative, Source::Path(path)));
        }
    }
    Ok(())
}

fn prepare(source: Source, compress: bool) -> Result<(Body, u64, bool)> {
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
    Ok((Body::File(path), length, false))
}

fn smaller(bytes: Vec<u8>, compress: bool) -> (Body, u64, bool) {
    if compress {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        let compressed = encoder.write_all(&bytes).and_then(|()| encoder.finish());
        if let Ok(compressed) = compressed
            && compressed.len() < bytes.len()
        {
            let length = compressed.len() as u64;
            return (Body::Bytes(compressed), length, true);
        }
    }
    let length = bytes.len() as u64;
    (Body::Bytes(bytes), length, false)
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
    match extension(path).as_str() {
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

enum Part {
    Bytes(std::io::Cursor<Vec<u8>>),
    File {
        path: PathBuf,
        length: u64,
        open: Option<std::io::Take<File>>,
    },
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
                Part::Bytes(cursor) => cursor.read(buffer)?,
                Part::File { path, length, open } => {
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
                    count
                }
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
