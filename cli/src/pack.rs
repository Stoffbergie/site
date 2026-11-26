use crate::charset::{fit_charset, fit_charset_streamed};
use crate::crypto::{self, LinkHint, LinkKey, Sealer};
use crate::dotfiles::{self, DotName};
use crate::reuse::{Earlier, Known, StoredFile, content_hash, hash_hex};
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
use std::sync::Arc;

pub const PUBLIC_MAGIC: &[u8] = b"SITEPACK2\n";
pub const ENCRYPTED_MAGIC: &[u8] = b"SITEPACK1\n";
pub const MAX_DEPLOY_BYTES: u64 = 100_000_000;
pub const MAX_FILES: usize = 5000;
const MAX_INDEX_BYTES: usize = 2_000_000;
const MAX_COMPRESSED_INDEX_BYTES: usize = 262_144;
const LONGEST_ORIGIN: &str = "00000000-0000";
const MAX_REUSED_RUNS: usize = 100;
const LEAST_WORTH_REUSING: u64 = 4096;
const BROTLI: &str = "br";
const GZIP: &str = "gzip";

#[derive(Serialize)]
struct CompactIndex<'a> {
    spa: bool,
    files: &'a [CompactEntry],
    #[serde(skip_serializing_if = "Option::is_none")]
    rules: Option<&'a Rules>,
}

#[derive(Serialize)]
struct CompactEntry {
    path: String,
    length: u64,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    content_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reuse: Option<ReuseRef>,
}

#[derive(Serialize)]
struct ReuseRef {
    id: String,
    file: usize,
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
struct StoredIndex<'a> {
    spa: bool,
    files: Vec<StoredEntry<'a>>,
}

#[derive(Serialize)]
struct StoredEntry<'a> {
    path: &'a str,
    offset: u64,
    length: u64,
    #[serde(rename = "type")]
    content_type: &'static str,
    gzip: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    br: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<&'static str>,
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

pub enum Source {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

enum Body {
    Bytes(Vec<u8>),
    File { path: PathBuf, length: u64 },
}

impl Body {
    fn length(&self) -> u64 {
        match self {
            Body::Bytes(bytes) => bytes.len() as u64,
            Body::File { length, .. } => *length,
        }
    }
}

enum Content<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
    Decoded(&'a Path, Encoding),
}

struct Inspected<'a> {
    path: &'a str,
    content: Content<'a>,
    content_type: &'static str,
    hash: String,
    compress: bool,
}

struct Prepared {
    body: Option<Body>,
    placed: Placed,
}

struct Placed {
    stored: StoredFile,
    reused: Option<Earlier>,
}

pub struct Pack {
    header: Vec<u8>,
    bodies: Vec<Body>,
    sealer: Option<Sealer>,
    pub total: u64,
    pub files: Vec<StoredFile>,
    pub reuses: bool,
}

impl Pack {
    pub fn build(
        sources: &[(String, Source)],
        spa: bool,
        link_key: Option<&LinkKey>,
        known: &Known,
    ) -> Result<Pack> {
        if link_key.is_some() {
            dotfiles::note_private_well_known(sources.iter().map(|(path, _)| path.as_str()));
        }
        let originals: HashMap<String, PathBuf> = sources
            .iter()
            .filter_map(|(path, source)| match source {
                Source::Path(file) => Some((path.clone(), file.clone())),
                Source::Bytes(_) => None,
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
        let rule_texts = rule_texts(sources)?;
        let inspected = parallel_map(sources, |(path, source)| inspect(path, source, &originals))?;
        let copies_left_out = inspected.iter().filter(|file| file.is_none()).count();
        let inspected: Vec<Inspected> = inspected.into_iter().flatten().collect();
        if inspected.len() > MAX_FILES {
            bail!(
                "that is {} files; a deploy holds at most {MAX_FILES}",
                inspected.len()
            );
        }
        if copies_left_out > 0 {
            crate::output::note(&format!(
                "Left out {copies_left_out} precompressed copies of files in the deploy; site compresses those itself"
            ));
        }
        let compression = match link_key {
            None => Compression::Brotli,
            Some(_) => Compression::Gzip,
        };
        let mut choices = vec![None; inspected.len()];
        if link_key.is_none() {
            choices = choose_reuse(&inspected, known);
        }
        let work: Vec<(&Inspected, Option<Earlier>)> = inspected.iter().zip(choices).collect();
        let prepared = parallel_map(&work, |(file, choice)| {
            prepare(file, choice.clone(), compression)
        })?;
        let mut bodies = Vec::with_capacity(prepared.len());
        let mut placed = Vec::with_capacity(prepared.len());
        for file in prepared {
            bodies.extend(file.body);
            placed.push(file.placed);
        }
        let mut rules = None;
        if rule_texts.redirects.is_some() || rule_texts.headers.is_some() {
            let room =
                MAX_INDEX_BYTES.saturating_sub(stored_index_length(spa, &inspected, &placed)?);
            rules = site_rules(rule_texts, &inspected, room);
        }
        let (header, bodies, sealer, data_length) = match link_key {
            None => compact(spa, &inspected, &placed, bodies, &mut rules)?,
            Some(link_key) => seal(spa, &inspected, &placed, rules.as_ref(), bodies, link_key)?,
        };
        if let Some(summary) = rules.as_ref().and_then(Rules::summary) {
            crate::output::note(&summary);
        }
        let total = header.len() as u64 + data_length;
        if total > MAX_DEPLOY_BYTES {
            bail!(
                "this deploy is {} and the limit is 100 MB; leave out large files or host them elsewhere",
                crate::output::size(total)
            );
        }
        let reuses = placed.iter().any(|file| file.reused.is_some());
        let files = placed.into_iter().map(|file| file.stored).collect();
        Ok(Pack {
            header,
            bodies,
            sealer,
            total,
            files,
            reuses,
        })
    }

    pub fn reader(pack: &Arc<Pack>) -> PackReader {
        PackReader {
            pack: Arc::clone(pack),
            part: 0,
            current: None,
            sent: 0,
            show_progress: crate::output::stderr_is_terminal() && pack.total > 1_000_000,
            last_percent: u64::MAX,
        }
    }
}

type Assembled = (Vec<u8>, Vec<Body>, Option<Sealer>, u64);

fn compact(
    spa: bool,
    inspected: &[Inspected],
    placed: &[Placed],
    bodies: Vec<Body>,
    rules: &mut Option<Rules>,
) -> Result<Assembled> {
    let mut entries = Vec::with_capacity(placed.len());
    for (file, placed) in inspected.iter().zip(placed) {
        let mut content_type = Some(file.content_type);
        if types::known(file.path) == content_type {
            content_type = None;
        }
        let reuse = placed.reused.as_ref().map(|earlier| ReuseRef {
            id: earlier.id.clone(),
            file: earlier.file,
        });
        entries.push(CompactEntry {
            path: file.path.to_string(),
            length: placed.stored.length,
            content_type,
            encoding: stored_encoding(&placed.stored),
            reuse,
        });
    }
    let data_length = bodies.iter().map(Body::length).sum();
    let mut compressed = compact_index(spa, &entries, rules.as_ref())?;
    while compressed.len() > MAX_COMPRESSED_INDEX_BYTES
        && let Some(kept) = rules.as_mut()
    {
        let rules_length = serde_json::to_vec(kept)?.len();
        let room = rules_length * MAX_COMPRESSED_INDEX_BYTES / compressed.len() * 9 / 10;
        kept.fit(room);
        if kept.is_empty() {
            *rules = None;
        }
        compressed = compact_index(spa, &entries, rules.as_ref())?;
    }
    Ok((
        with_preamble(PUBLIC_MAGIC, &compressed),
        bodies,
        None,
        data_length,
    ))
}

fn compact_index(spa: bool, entries: &[CompactEntry], rules: Option<&Rules>) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(&CompactIndex {
        spa,
        files: entries,
        rules,
    })?;
    Ok(brotli_bytes(&json)?)
}

fn stored_index_length(spa: bool, inspected: &[Inspected], placed: &[Placed]) -> Result<usize> {
    let mut files = Vec::with_capacity(placed.len());
    let mut offset = 0;
    for (file, placed) in inspected.iter().zip(placed) {
        let encoding = stored_encoding(&placed.stored);
        let mut origin = None;
        if placed.reused.is_some() {
            origin = Some(LONGEST_ORIGIN);
        }
        files.push(StoredEntry {
            path: file.path,
            offset,
            length: placed.stored.length,
            content_type: file.content_type,
            gzip: encoding == Some(GZIP),
            br: encoding == Some(BROTLI),
            origin,
        });
        offset += placed.stored.length;
    }
    Ok(serde_json::to_vec(&StoredIndex { spa, files })?.len())
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

fn site_rules(texts: RuleTexts, inspected: &[Inspected], room: usize) -> Option<Rules> {
    let paths: HashSet<&str> = inspected
        .iter()
        .map(|file| file.path)
        .filter(|path| *path != rules::REDIRECTS_FILE && *path != rules::HEADERS_FILE)
        .collect();
    let mut parsed = rules::parse(texts.redirects.as_deref(), texts.headers.as_deref(), &paths);
    parsed.fit(room);
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

fn seal(
    spa: bool,
    inspected: &[Inspected],
    placed: &[Placed],
    rules: Option<&Rules>,
    files: Vec<Body>,
    link_key: &LinkKey,
) -> Result<Assembled> {
    let content_salt = crypto::random_salt()?;
    let sealer = link_key.sealer(&content_salt)?;
    let sealed_index = serde_json::to_vec(&SealedIndex {
        spa,
        files: inspected
            .iter()
            .zip(placed)
            .map(|(file, placed)| SealedEntry {
                path: file.path,
                content_type: file.content_type,
                gzip: stored_encoding(&placed.stored) == Some(GZIP),
                length: placed.stored.length,
            })
            .collect(),
        rules,
    })?;
    if files.len() != placed.len() {
        bail!("a private deploy cannot reuse files from earlier deploys");
    }
    let mut bodies = vec![Body::Bytes(sealed_index)];
    bodies.extend(files);

    let mut entries = Vec::with_capacity(bodies.len());
    let mut offset = 0;
    for body in &bodies {
        let length = crypto::sealed_length(body.length());
        entries.push(OpaqueEntry { offset, length });
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
        files: entries,
    })?;
    Ok((
        with_preamble(ENCRYPTED_MAGIC, &json),
        bodies,
        Some(sealer),
        offset,
    ))
}

fn with_preamble(magic: &[u8], index: &[u8]) -> Vec<u8> {
    let mut header = Vec::with_capacity(magic.len() + 4 + index.len());
    header.extend_from_slice(magic);
    header.extend_from_slice(&(index.len() as u32).to_be_bytes());
    header.extend_from_slice(index);
    header
}

fn stored_encoding(stored: &StoredFile) -> Option<&'static str> {
    match stored.encoding.as_deref() {
        Some(BROTLI) => Some(BROTLI),
        Some(GZIP) => Some(GZIP),
        _ => None,
    }
}

fn choose_reuse(inspected: &[Inspected], known: &Known) -> Vec<Option<Earlier>> {
    let mut choices: Vec<Option<Earlier>> = Vec::with_capacity(inspected.len());
    for file in inspected {
        let candidates = known.get(&file.hash).map(Vec::as_slice).unwrap_or_default();
        let previous = choices.last().and_then(Option::as_ref);
        let continuing = previous.and_then(|last| {
            candidates
                .iter()
                .find(|candidate| candidate.id == last.id && candidate.file == last.file + 1)
        });
        let chosen = continuing.or(candidates.first()).cloned();
        choices.push(chosen);
    }
    limit_runs(&mut choices);
    let reused: u64 = choices.iter().flatten().map(|earlier| earlier.length).sum();
    if reused < LEAST_WORTH_REUSING {
        choices.iter_mut().for_each(|choice| *choice = None);
    }
    choices
}

fn limit_runs(choices: &mut [Option<Earlier>]) {
    let mut runs: Vec<(usize, usize, u64)> = Vec::new();
    for position in 0..choices.len() {
        let Some(earlier) = &choices[position] else {
            continue;
        };
        let continues = position > 0
            && choices[position - 1]
                .as_ref()
                .is_some_and(|last| last.id == earlier.id && last.file + 1 == earlier.file);
        match runs.last_mut() {
            Some(run) if continues => {
                run.1 = position;
                run.2 += earlier.length;
            }
            _ => runs.push((position, position, earlier.length)),
        }
    }
    if runs.len() <= MAX_REUSED_RUNS {
        return;
    }
    runs.sort_by_key(|run| run.2);
    let dropped = runs.len() - MAX_REUSED_RUNS;
    for (start, end, _) in runs.into_iter().take(dropped) {
        for choice in &mut choices[start..=end] {
            *choice = None;
        }
    }
}

fn inspect<'a>(
    path: &'a str,
    source: &'a Source,
    originals: &HashMap<String, PathBuf>,
) -> Result<Option<Inspected<'a>>> {
    let file = match source {
        Source::Bytes(bytes) => {
            let head = &bytes[..bytes.len().min(types::SNIFF_BYTES as usize)];
            let content_type = fit_charset(content_type(path, head), bytes);
            return Ok(Some(Inspected {
                path,
                content: Content::Bytes(bytes),
                content_type,
                hash: content_hash(bytes),
                compress: compressible(path),
            }));
        }
        Source::Path(file) => file,
    };
    if let Some((inner, encoding)) = precompressed(path) {
        match unpack(path, inner, encoding, file, originals)? {
            Unpacked::CopyOfOriginal => return Ok(None),
            Unpacked::Decoded(content_type, decoded) => {
                return Ok(Some(Inspected {
                    path,
                    content: Content::Decoded(file, encoding),
                    content_type: fit_charset(content_type, &decoded),
                    hash: content_hash(&decoded),
                    compress: true,
                }));
            }
            Unpacked::AsIs => {}
        }
    }
    let unreadable = || format!("could not read {}", file.display());
    let mut head = Vec::new();
    File::open(file)
        .with_context(unreadable)?
        .take(types::SNIFF_BYTES)
        .read_to_end(&mut head)
        .with_context(unreadable)?;
    let mut reader = Hashing::new(File::open(file).with_context(unreadable)?);
    let content_type =
        fit_charset_streamed(content_type(path, &head), &mut reader).with_context(unreadable)?;
    let hash = reader.finish().with_context(unreadable)?;
    Ok(Some(Inspected {
        path,
        content: Content::File(file),
        content_type,
        hash,
        compress: compressible(path),
    }))
}

struct Hashing<R: Read> {
    inner: R,
    context: ring::digest::Context,
}

impl<R: Read> Hashing<R> {
    fn new(inner: R) -> Hashing<R> {
        Hashing {
            inner,
            context: ring::digest::Context::new(&ring::digest::SHA256),
        }
    }

    fn finish(mut self) -> std::io::Result<String> {
        std::io::copy(&mut self, &mut std::io::sink())?;
        Ok(hash_hex(&self.context.finish().as_ref()[..16]))
    }
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.context.update(&buffer[..count]);
        Ok(count)
    }
}

fn prepare(
    file: &Inspected,
    choice: Option<Earlier>,
    compression: Compression,
) -> Result<Prepared> {
    let hash = file.hash.clone();
    if let Some(earlier) = choice {
        return Ok(Prepared {
            body: None,
            placed: Placed {
                stored: StoredFile {
                    hash,
                    length: earlier.length,
                    encoding: earlier.encoding.clone(),
                },
                reused: Some(earlier),
            },
        });
    }
    let bytes = match &file.content {
        Content::File(path) if !file.compress => {
            let length = std::fs::metadata(path)
                .with_context(|| format!("could not read {}", path.display()))?
                .len();
            return Ok(Prepared {
                body: Some(Body::File {
                    path: path.to_path_buf(),
                    length,
                }),
                placed: Placed {
                    stored: StoredFile {
                        hash,
                        length,
                        encoding: None,
                    },
                    reused: None,
                },
            });
        }
        Content::File(path) => {
            std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?
        }
        Content::Bytes(bytes) => bytes.to_vec(),
        Content::Decoded(path, encoding) => decode_within_limit(file.path, path, *encoding)?
            .with_context(|| format!("{} changed while deploying; deploy again", file.path))?,
    };
    let (body, encoding) = smaller(bytes, file.compress.then_some(compression));
    Ok(Prepared {
        placed: Placed {
            stored: StoredFile {
                hash,
                length: body.length(),
                encoding: encoding.map(str::to_string),
            },
            reused: None,
        },
        body: Some(body),
    })
}

#[derive(Clone, Copy)]
enum Compression {
    Brotli,
    Gzip,
}

fn smaller(bytes: Vec<u8>, compress: Option<Compression>) -> (Body, Option<&'static str>) {
    let compressed = match compress {
        None => None,
        Some(Compression::Brotli) => brotli_bytes(&bytes).ok().map(|out| (out, BROTLI)),
        Some(Compression::Gzip) => gzip_bytes(&bytes).ok().map(|out| (out, GZIP)),
    };
    if let Some((compressed, encoding)) = compressed
        && compressed.len() < bytes.len()
    {
        return (Body::Bytes(compressed), Some(encoding));
    }
    (Body::Bytes(bytes), None)
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

fn parallel_map<'a, Item, Output, Work>(items: &'a [Item], work: Work) -> Result<Vec<Output>>
where
    Item: Sync,
    Output: Send,
    Work: Fn(&'a Item) -> Result<Output> + Sync,
{
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    let queue = std::sync::Mutex::new(items.iter().enumerate());
    let results = std::sync::Mutex::new(Vec::with_capacity(items.len()));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let next = queue.lock().expect("queue lock").next();
                    let Some((position, item)) = next else {
                        break;
                    };
                    let output = work(item);
                    results
                        .lock()
                        .expect("results lock")
                        .push((position, output));
                }
            });
        }
    });
    let mut results = results.into_inner().expect("results lock");
    results.sort_by_key(|(position, _)| *position);
    results.into_iter().map(|(_, output)| output).collect()
}

pub fn sources(arguments: &[String]) -> Result<Vec<(String, Source)>> {
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
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes)?;
        return Ok(vec![("index.html".to_string(), Source::Bytes(bytes))]);
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

fn content_type(path: &str, head: &[u8]) -> &'static str {
    if let Some(content_type) = types::known(path) {
        return content_type;
    }
    if let Some(content_type) = dotfiles::well_known_type(path) {
        return content_type;
    }
    types::sniffed(head)
}

enum PartReader {
    Header,
    Plain(BodyReader),
    Sealed(Box<Sealing>),
}

struct BodyReader {
    pack: Arc<Pack>,
    number: usize,
    position: usize,
    open: Option<std::io::Take<File>>,
}

impl Read for BodyReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match &self.pack.bodies[self.number] {
            Body::Bytes(bytes) => {
                let rest = &bytes[self.position..];
                let count = rest.len().min(buffer.len());
                buffer[..count].copy_from_slice(&rest[..count]);
                self.position += count;
                Ok(count)
            }
            Body::File { path, length } => {
                if self.open.is_none() {
                    self.open = Some(File::open(path)?.take(*length));
                }
                let reader = self.open.as_mut().expect("file was just opened");
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
    plain: BodyReader,
    plain_length: u64,
    entry: u32,
    next_chunk: u64,
    chunks: u64,
    sealer: Sealer,
    sealed: std::io::Cursor<Vec<u8>>,
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

pub struct PackReader {
    pack: Arc<Pack>,
    part: usize,
    current: Option<(PartReader, usize)>,
    sent: u64,
    show_progress: bool,
    last_percent: u64,
}

impl PackReader {
    fn report(&mut self) {
        if !self.show_progress {
            return;
        }
        let total = self.pack.total;
        let percent = self.sent * 100 / total.max(1);
        if percent != self.last_percent {
            self.last_percent = percent;
            crate::output::progress(self.sent, total);
        }
    }

    fn open_part(&self) -> Option<PartReader> {
        if self.part == 0 {
            return Some(PartReader::Header);
        }
        let number = self.part - 1;
        let body = self.pack.bodies.get(number)?;
        let plain = BodyReader {
            pack: Arc::clone(&self.pack),
            number,
            position: 0,
            open: None,
        };
        let Some(sealer) = &self.pack.sealer else {
            return Some(PartReader::Plain(plain));
        };
        let plain_length = body.length();
        Some(PartReader::Sealed(Box::new(Sealing {
            plain,
            plain_length,
            entry: number as u32,
            next_chunk: 0,
            chunks: crypto::chunk_count(plain_length),
            sealer: sealer.clone(),
            sealed: std::io::Cursor::new(Vec::new()),
        })))
    }
}

impl Read for PackReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.current.is_none() {
                let Some(part) = self.open_part() else {
                    return Ok(0);
                };
                self.current = Some((part, 0));
            }
            let (part, header_position) = self.current.as_mut().expect("a part is open");
            let count = match part {
                PartReader::Header => {
                    let rest = &self.pack.header[*header_position..];
                    let count = rest.len().min(buffer.len());
                    buffer[..count].copy_from_slice(&rest[..count]);
                    *header_position += count;
                    count
                }
                PartReader::Plain(plain) => plain.read(buffer)?,
                PartReader::Sealed(sealing) => sealing.read(buffer)?,
            };
            if count > 0 {
                self.sent += count as u64;
                self.report();
                return Ok(count);
            }
            self.current = None;
            self.part += 1;
        }
    }
}
