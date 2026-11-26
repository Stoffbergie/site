use crate::charset::{fit_charset, fit_charset_streamed};
use crate::crypto::{self, LinkHint, LinkKey, Sealer};
use crate::dotfiles::{self, DotName};
use crate::rules::{self, Rules};
use crate::types;
use anyhow::{Context, Result, bail};
use flate2::bufread::GzDecoder;
use flate2::write::GzEncoder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8] = b"SITEPACK1\n";
pub const MAX_DEPLOY_BYTES: u64 = 100_000_000;
pub const MAX_FILES: usize = 5000;
const MAX_INDEX_BYTES: usize = 2_000_000;

#[derive(Serialize)]
struct Index<'a> {
    spa: bool,
    files: &'a [Entry],
    #[serde(skip_serializing_if = "Option::is_none")]
    rules: Option<&'a Rules>,
}

#[derive(Serialize)]
struct Entry {
    path: String,
    offset: u64,
    length: u64,
    #[serde(rename = "type")]
    content_type: &'static str,
    gzip: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    br: bool,
}

#[derive(Serialize)]
struct SealedIndex<'a> {
    spa: bool,
    files: Vec<SealedEntry<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rules: Option<&'a Rules>,
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
        let originals: HashMap<String, PathBuf> = sources
            .iter()
            .filter_map(|(path, source)| match source {
                Source::Path(file) => Some((path.clone(), file.clone())),
                Source::Stdin => None,
            })
            .collect();
        let copies = sources
            .iter()
            .filter(|(path, _)| original_of(path, &originals).is_some())
            .count();
        let files_to_keep = sources.len() - copies;
        if files_to_keep > MAX_FILES {
            bail!("that is {files_to_keep} files; a deploy holds at most {MAX_FILES}");
        }
        let rule_texts = rule_texts(&sources)?;
        let compression = match link_key {
            None => Compression::Brotli,
            Some(_) => Compression::Gzip,
        };
        let mut entries = Vec::with_capacity(sources.len());
        let mut bodies = Vec::with_capacity(sources.len());
        let mut copies_left_out = 0;
        let mut offset = 0;
        for (path, source) in sources {
            let unpacked = match (&source, precompressed(&path)) {
                (Source::Path(file), Some((inner, encoding))) => {
                    unpack(&path, inner, encoding, file, &originals)?
                }
                _ => Unpacked::AsIs,
            };
            let (content_type, body, stored) = match unpacked {
                Unpacked::CopyOfOriginal => {
                    copies_left_out += 1;
                    continue;
                }
                Unpacked::Decoded(content_type, decoded) => {
                    let content_type = fit_charset(content_type, &decoded);
                    let (body, stored) = smaller(decoded, Some(compression));
                    (content_type, body, stored)
                }
                Unpacked::AsIs => {
                    let content_type = content_type(&path, &source)?;
                    let compress = compressible(&path).then_some(compression);
                    let (body, stored, content_type) = prepare(source, compress, content_type)?;
                    (content_type, body, stored)
                }
            };
            let length = body.length();
            entries.push(Entry {
                path,
                offset,
                length,
                content_type,
                gzip: stored == Stored::Gzip,
                br: stored == Stored::Brotli,
            });
            bodies.push(body);
            offset += length;
        }
        if entries.len() > MAX_FILES {
            bail!(
                "that is {} files; a deploy holds at most {MAX_FILES}",
                entries.len()
            );
        }
        if copies_left_out > 0 {
            crate::output::note(&format!(
                "Left out {copies_left_out} precompressed copies of files in the deploy; site compresses those itself"
            ));
        }
        let mut rules = None;
        if rule_texts.redirects.is_some() || rule_texts.headers.is_some() {
            let index_without_rules = serde_json::to_vec(&Index {
                spa,
                files: &entries,
                rules: None,
            })?;
            let room = MAX_INDEX_BYTES.saturating_sub(index_without_rules.len());
            rules = site_rules(rule_texts, &entries, room);
        }
        let rules = rules.as_ref();
        let (json, parts, data_length) = match link_key {
            None => {
                let json = serde_json::to_vec(&Index {
                    spa,
                    files: &entries,
                    rules,
                })?;
                let parts = bodies.into_iter().map(Part::Plain).collect();
                (json, parts, offset)
            }
            Some(link_key) => seal(spa, &entries, rules, bodies, link_key)?,
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
    rules: Option<&Rules>,
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
        rules,
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

struct RuleTexts {
    redirects: Option<String>,
    headers: Option<String>,
}

fn rule_texts(sources: &[(String, Source)]) -> Result<RuleTexts> {
    Ok(RuleTexts {
        redirects: rule_file(sources, rules::REDIRECTS_FILE)?,
        headers: rule_file(sources, rules::HEADERS_FILE)?,
    })
}

fn site_rules(texts: RuleTexts, entries: &[Entry], room: usize) -> Option<Rules> {
    let paths: HashSet<&str> = entries
        .iter()
        .map(|entry| entry.path.as_str())
        .filter(|path| *path != rules::REDIRECTS_FILE && *path != rules::HEADERS_FILE)
        .collect();
    let mut parsed = rules::parse(texts.redirects.as_deref(), texts.headers.as_deref(), &paths);
    parsed.fit(room);
    if let Some(summary) = parsed.summary() {
        crate::output::note(&summary);
    }
    if parsed.is_empty() {
        return None;
    }
    Some(parsed)
}

fn rule_file(sources: &[(String, Source)], name: &str) -> Result<Option<String>> {
    let Some((_, Source::Path(path))) = sources.iter().find(|(relative, _)| relative == name)
    else {
        return Ok(None);
    };
    let bytes =
        std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some(text)),
        Err(_) => {
            crate::output::note(&format!("{name}: ignored, it is not UTF-8 text"));
            Ok(None)
        }
    }
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

fn prepare(
    source: Source,
    compress: Option<Compression>,
    content_type: &'static str,
) -> Result<(Plain, Stored, &'static str)> {
    let path = match source {
        Source::Stdin => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes)?;
            let content_type = fit_charset(content_type, &bytes);
            let (body, stored) = smaller(bytes, compress);
            return Ok((body, stored, content_type));
        }
        Source::Path(path) => path,
    };
    if compress.is_some() {
        let bytes =
            std::fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
        let content_type = fit_charset(content_type, &bytes);
        let (body, stored) = smaller(bytes, compress);
        return Ok((body, stored, content_type));
    }
    let file = File::open(&path).with_context(|| format!("could not read {}", path.display()))?;
    let content_type = fit_charset_streamed(content_type, file)
        .with_context(|| format!("could not read {}", path.display()))?;
    let length = std::fs::metadata(&path)?.len();
    let file = Plain::File {
        path,
        length,
        open: None,
    };
    Ok((file, Stored::Identity, content_type))
}

#[derive(Clone, Copy)]
enum Compression {
    Brotli,
    Gzip,
}

#[derive(Clone, Copy, PartialEq)]
enum Stored {
    Identity,
    Gzip,
    Brotli,
}

fn smaller(bytes: Vec<u8>, compress: Option<Compression>) -> (Plain, Stored) {
    let compressed = match compress {
        None => None,
        Some(Compression::Brotli) => brotli_bytes(&bytes).ok().map(|out| (out, Stored::Brotli)),
        Some(Compression::Gzip) => gzip_bytes(&bytes).ok().map(|out| (out, Stored::Gzip)),
    };
    if let Some((compressed, stored)) = compressed
        && compressed.len() < bytes.len()
    {
        return (Plain::bytes(compressed), stored);
    }
    (Plain::bytes(bytes), Stored::Identity)
}

fn gzip_bytes(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

fn brotli_bytes(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let quality = brotlic::Quality::best();
    let window = brotlic::WindowSize::default();
    let bound = brotlic::compress_bound(bytes.len(), quality).unwrap_or(bytes.len() + 1024);
    let mut compressed = vec![0; bound];
    let written = brotlic::compress(
        bytes,
        &mut compressed,
        quality,
        window,
        brotlic::CompressionMode::Generic,
    )
    .map_err(std::io::Error::other)?;
    compressed.truncate(written);
    Ok(compressed)
}

#[derive(Clone, Copy)]
enum Encoding {
    Gzip,
    Brotli,
    Detect,
}

enum Unpacked {
    CopyOfOriginal,
    Decoded(&'static str, Vec<u8>),
    AsIs,
}

enum Decoder {
    Gzip(GzDecoder<BufReader<File>>),
    Brotli(Box<brotlic::DecompressorReader<BufReader<File>>>),
}

impl Decoder {
    fn open(file: &Path, encoding: Encoding) -> Result<Decoder> {
        let opened =
            File::open(file).with_context(|| format!("could not read {}", file.display()))?;
        let mut input = BufReader::new(opened);
        let use_gzip = match encoding {
            Encoding::Gzip => true,
            Encoding::Brotli => false,
            Encoding::Detect => input.fill_buf()?.starts_with(&[0x1f, 0x8b]),
        };
        if use_gzip {
            return Ok(Decoder::Gzip(GzDecoder::new(input)));
        }
        let decompressor = brotlic::DecompressorReader::new(input);
        Ok(Decoder::Brotli(Box::new(decompressor)))
    }

    fn input_finished(&mut self) -> std::io::Result<bool> {
        match self {
            Decoder::Gzip(decoder) => Ok(decoder.get_mut().fill_buf()?.is_empty()),
            Decoder::Brotli(decoder) => Ok(decoder.get_mut().fill_buf()?.is_empty()),
        }
    }
}

impl Read for Decoder {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = match self {
            Decoder::Gzip(decoder) => decoder.read(buffer)?,
            Decoder::Brotli(decoder) => decoder.read(buffer)?,
        };
        if count == 0 && !buffer.is_empty() && !self.input_finished()? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bytes after the compressed stream",
            ));
        }
        Ok(count)
    }
}

fn precompressed(path: &str) -> Option<(&str, Encoding)> {
    let lower = path.to_ascii_lowercase();
    let suffixes = [
        (".gz", Encoding::Gzip),
        (".br", Encoding::Brotli),
        (".unityweb", Encoding::Detect),
    ];
    for (suffix, encoding) in suffixes {
        if lower.ends_with(suffix) && lower.len() > suffix.len() {
            return Some((&path[..path.len() - suffix.len()], encoding));
        }
    }
    None
}

fn original_of<'a>(path: &str, originals: &'a HashMap<String, PathBuf>) -> Option<&'a PathBuf> {
    match precompressed(path) {
        Some((inner, Encoding::Gzip | Encoding::Brotli)) => originals.get(inner),
        _ => None,
    }
}

fn unpack(
    path: &str,
    inner: &str,
    encoding: Encoding,
    file: &Path,
    originals: &HashMap<String, PathBuf>,
) -> Result<Unpacked> {
    let unity_file = matches!(encoding, Encoding::Detect);
    let served_decoded = unity_file || decoded_on_arrival(inner);
    let original = original_of(path, originals);
    if served_decoded {
        let Some(decoded) = decode_within_limit(path, file, encoding)? else {
            return Ok(Unpacked::AsIs);
        };
        if let Some(original) = original
            && same_contents(decoded.as_slice(), original)
        {
            return Ok(Unpacked::CopyOfOriginal);
        }
        let head_length = decoded.len().min(types::SNIFF_BYTES as usize);
        let content_type = match types::known(inner) {
            Some(known) => known,
            None => types::sniffed(&decoded[..head_length]),
        };
        return Ok(Unpacked::Decoded(content_type, decoded));
    }
    if let Some(original) = original
        && same_contents(Decoder::open(file, encoding)?, original)
    {
        return Ok(Unpacked::CopyOfOriginal);
    }
    Ok(Unpacked::AsIs)
}

fn decode_within_limit(path: &str, file: &Path, encoding: Encoding) -> Result<Option<Vec<u8>>> {
    let decoder = Decoder::open(file, encoding)?;
    let mut decoded = Vec::new();
    if decoder
        .take(MAX_DEPLOY_BYTES + 1)
        .read_to_end(&mut decoded)
        .is_err()
    {
        return Ok(None);
    }
    if decoded.len() as u64 > MAX_DEPLOY_BYTES {
        bail!("{path} unpacks to more than the 100 MB a deploy can hold");
    }
    Ok(Some(decoded))
}

fn same_contents(mut decoded: impl Read, original: &Path) -> bool {
    let Ok(mut original) = File::open(original) else {
        return false;
    };
    let mut decoded_chunk = vec![0u8; 65536];
    let mut original_chunk = vec![0u8; 65536];
    loop {
        let decoded_count = fill(&mut decoded, &mut decoded_chunk);
        let original_count = fill(&mut original, &mut original_chunk);
        let (Ok(decoded_count), Ok(original_count)) = (decoded_count, original_count) else {
            return false;
        };
        if decoded_chunk[..decoded_count] != original_chunk[..original_count] {
            return false;
        }
        if decoded_count == 0 {
            return true;
        }
    }
}

fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let count = reader.read(&mut buffer[filled..])?;
        if count == 0 {
            break;
        }
        filled += count;
    }
    Ok(filled)
}

fn decoded_on_arrival(inner: &str) -> bool {
    if inner.to_ascii_lowercase().ends_with(".symbols.json") {
        return true;
    }
    matches!(
        extension(inner).as_str(),
        "html" | "htm" | "css" | "js" | "mjs" | "svg" | "wasm" | "data" | "pck" | "mem"
    )
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

fn content_type(path: &str, source: &Source) -> Result<&'static str> {
    if let Some(content_type) = types::known(path) {
        return Ok(content_type);
    }
    if let Some(content_type) = dotfiles::well_known_type(path) {
        return Ok(content_type);
    }
    let mut head = Vec::new();
    if let Source::Path(file) = source {
        File::open(file)
            .with_context(|| format!("could not read {}", file.display()))?
            .take(types::SNIFF_BYTES)
            .read_to_end(&mut head)?;
    }
    Ok(types::sniffed(&head))
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
