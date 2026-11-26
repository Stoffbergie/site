use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const REDIRECTS_FILE: &str = "_redirects";
pub const HEADERS_FILE: &str = "_headers";

const MAX_REDIRECTS: usize = 10_000;
const MAX_DYNAMIC_REDIRECTS: usize = 1_000;
const MAX_HEADER_RULES: usize = 1_000;
const MAX_HEADER_LINES: usize = 2_000;
const MAX_LINE_LENGTH: usize = 2_000;
const MAX_HEADER_NAME: usize = 200;
const MAX_NOTES_PER_FILE: usize = 10;
const DEFAULT_STATUS: u16 = 302;
const RULES_FIELD_BYTES: usize = 64;

const FIXED_HEADERS: &[&str] = &[
    "accept-ranges",
    "age",
    "allow",
    "alt-svc",
    "cdn-cache-control",
    "clear-site-data",
    "cloudflare-cdn-cache-control",
    "connection",
    "content-encoding",
    "content-length",
    "content-range",
    "date",
    "etag",
    "keep-alive",
    "location",
    "nel",
    "origin-agent-cluster",
    "proxy-authenticate",
    "proxy-authorization",
    "report-to",
    "sec-session-challenge",
    "sec-session-registration",
    "secure-session-challenge",
    "secure-session-registration",
    "server",
    "set-cookie",
    "set-cookie2",
    "surrogate-control",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "vary",
    "x-content-type-options",
];

#[derive(Serialize, Default)]
pub struct Rules {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    redirects: Vec<Redirect>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    headers: Vec<HeaderRule>,
}

#[derive(Serialize)]
struct Redirect {
    from: String,
    to: String,
    status: u16,
    force: bool,
}

#[derive(Serialize)]
struct HeaderRule {
    path: String,
    headers: Vec<HeaderLine>,
}

#[derive(Serialize)]
struct HeaderLine {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

impl Rules {
    pub fn is_empty(&self) -> bool {
        self.redirects.is_empty() && self.headers.is_empty()
    }

    pub fn summary(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        Some(format!(
            "Rules: {} {} · {} header {}",
            self.redirects.len(),
            plural(self.redirects.len(), "redirect", "redirects"),
            self.headers.len(),
            plural(self.headers.len(), "rule", "rules")
        ))
    }

    pub fn fit(&mut self, room: usize) {
        let mut used = RULES_FIELD_BYTES;
        let redirects_kept = count_fitting(&self.redirects, &mut used, room);
        let headers_kept = count_fitting(&self.headers, &mut used, room);
        if redirects_kept < self.redirects.len() {
            crate::output::note(&format!(
                "{REDIRECTS_FILE}: only the first {} rules fit in a deploy's 2 MB index",
                thousands(redirects_kept)
            ));
            self.redirects.truncate(redirects_kept);
        }
        if headers_kept < self.headers.len() {
            crate::output::note(&format!(
                "{HEADERS_FILE}: only the first {} paths fit in a deploy's 2 MB index",
                thousands(headers_kept)
            ));
            self.headers.truncate(headers_kept);
        }
    }
}

fn count_fitting<T: Serialize>(items: &[T], used: &mut usize, room: usize) -> usize {
    for (kept, item) in items.iter().enumerate() {
        let size = serde_json::to_vec(item).map_or(usize::MAX, |json| json.len() + 1);
        if size > room.saturating_sub(*used) {
            *used = room;
            return kept;
        }
        *used += size;
    }
    items.len()
}

pub struct Notes {
    file: &'static str,
    shown: usize,
    hidden: usize,
}

impl Notes {
    fn new(file: &'static str) -> Notes {
        Notes {
            file,
            shown: 0,
            hidden: 0,
        }
    }

    fn line(&mut self, number: usize, message: &str) {
        if self.shown == MAX_NOTES_PER_FILE {
            self.hidden += 1;
            return;
        }
        self.shown += 1;
        crate::output::note(&format!("{} line {number}: {message}", self.file));
    }

    fn file(&self, message: &str) {
        crate::output::note(&format!("{}: {message}", self.file));
    }

    fn finish(&self) {
        if self.hidden > 0 {
            self.file(&format!("{} more lines ignored", self.hidden));
        }
    }
}

pub fn parse(redirects: Option<&str>, headers: Option<&str>, paths: &HashSet<&str>) -> Rules {
    let mut rules = Rules::default();
    if let Some(text) = redirects {
        rules.redirects = parse_redirects(text, paths);
    }
    if let Some(text) = headers {
        rules.headers = parse_headers(text);
    }
    rules
}

fn parse_redirects(text: &str, paths: &HashSet<&str>) -> Vec<Redirect> {
    let mut notes = Notes::new(REDIRECTS_FILE);
    let mut redirects = Vec::new();
    let mut line_numbers = Vec::new();
    let mut dynamic_count = 0;
    let mut over_total = false;
    let mut over_dynamic = false;
    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let redirect = match parse_redirect(line) {
            Ok(redirect) => redirect,
            Err(problem) => {
                notes.line(number, &format!("ignored, {problem}"));
                continue;
            }
        };
        let dynamic = is_dynamic(&redirect.from);
        if redirects.len() == MAX_REDIRECTS {
            over_total = true;
            continue;
        }
        if dynamic && dynamic_count == MAX_DYNAMIC_REDIRECTS {
            over_dynamic = true;
            continue;
        }
        if dynamic {
            dynamic_count += 1;
        }
        redirects.push(redirect);
        line_numbers.push(number);
    }
    let mut looping: HashSet<usize> = HashSet::new();
    for cycle in redirect_loops(&redirects, paths) {
        for (position, &rule) in cycle.iter().enumerate() {
            let next = cycle[(position + 1) % cycle.len()];
            notes.line(
                line_numbers[rule],
                &format!(
                    "ignored, it redirects in a loop with line {}",
                    line_numbers[next]
                ),
            );
            looping.insert(rule);
        }
    }
    let mut position = 0;
    redirects.retain(|_| {
        let keep = !looping.contains(&position);
        position += 1;
        keep
    });
    notes.finish();
    if over_total {
        notes.file(&format!(
            "only the first {} rules are used",
            thousands(MAX_REDIRECTS)
        ));
    }
    if over_dynamic {
        notes.file(&format!(
            "only the first {} rules with * or placeholders are used",
            thousands(MAX_DYNAMIC_REDIRECTS)
        ));
    }
    redirects
}

fn parse_redirect(line: &str) -> Result<Redirect, String> {
    if line.len() > MAX_LINE_LENGTH {
        return Err(format!("lines are limited to {MAX_LINE_LENGTH} characters"));
    }
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 2 {
        return Err("a rule needs a path and a destination".to_string());
    }
    let source = tokens[0];
    if is_absolute(source) {
        return Err("rules for other domains are not supported".to_string());
    }
    if !source.starts_with('/') {
        return Err("a rule's path must start with /".to_string());
    }
    let mut position = 1;
    while position < tokens.len() && is_condition(tokens[position]) {
        position += 1;
    }
    if position > 1 {
        return Err("rules that match query parameters are not supported".to_string());
    }
    let Some(destination) = tokens.get(position) else {
        return Err("a rule needs a destination".to_string());
    };
    position += 1;

    let mut status = DEFAULT_STATUS;
    let mut force = false;
    if let Some(token) = tokens.get(position)
        && let Some((code, forced)) = status_token(token)
    {
        status = code;
        force = forced;
        position += 1;
    }
    if let Some(condition) = tokens.get(position) {
        return Err(format!(
            "{condition} needs a server; site does not apply conditions"
        ));
    }
    if !matches!(status, 200 | 301 | 302 | 303 | 307 | 308 | 404) {
        return Err(format!("status {status} is not supported"));
    }

    let external = is_absolute(destination);
    if !external && !destination.starts_with('/') {
        return Err("a destination must start with / or https://".to_string());
    }
    if external && (status == 200 || status == 404) {
        return Err(
            "proxying to another site needs a server; use a 301 or 302 redirect instead"
                .to_string(),
        );
    }
    let Some(from) = percent_decode(source) else {
        return Err("the path has a broken %-escape".to_string());
    };
    if from.matches('*').count() > 1 {
        return Err("a rule can have only one *".to_string());
    }
    let to = encode_unsafe(destination);
    if to.len() > MAX_LINE_LENGTH {
        return Err(format!(
            "the destination is over {MAX_LINE_LENGTH} characters once %-encoded"
        ));
    }
    let keeps_query = !to.split('#').next().unwrap_or("").contains('?');
    if !external && status != 200 && status != 404 && !is_dynamic(&from) && keeps_query {
        let target = requested_path(&to);
        if target.is_some_and(|target| same_path(&target, &from)) {
            return Err("this rule redirects to itself".to_string());
        }
    }
    Ok(Redirect {
        from,
        to,
        status,
        force,
    })
}

fn parse_headers(text: &str) -> Vec<HeaderRule> {
    let mut notes = Notes::new(HEADERS_FILE);
    let mut rules: Vec<HeaderRule> = Vec::new();
    let mut skipping = false;
    let mut line_count = 0;
    let mut over_rules = false;
    let mut over_lines = false;
    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let indented = raw.starts_with([' ', '\t']);
        let is_path = !indented && (line.starts_with('/') || is_absolute(line));
        if is_path {
            skipping = true;
        }
        if raw.len() > MAX_LINE_LENGTH {
            notes.line(
                number,
                &format!("ignored, lines are limited to {MAX_LINE_LENGTH} characters"),
            );
            continue;
        }
        if is_path {
            if is_absolute(line) {
                notes.line(
                    number,
                    "ignored with its headers, rules for other domains are not supported",
                );
                continue;
            }
            let Some(path) = percent_decode(line) else {
                notes.line(
                    number,
                    "ignored with its headers, the path has a broken %-escape",
                );
                continue;
            };
            if path.matches('*').count() > 1 {
                notes.line(
                    number,
                    "ignored with its headers, a path can have only one *",
                );
                continue;
            }
            if rules.len() == MAX_HEADER_RULES {
                over_rules = true;
                continue;
            }
            skipping = false;
            rules.push(HeaderRule {
                path,
                headers: Vec::new(),
            });
            continue;
        }
        if skipping {
            continue;
        }
        let Some(rule) = rules.last_mut() else {
            notes.line(number, "ignored, a header needs a path line above it");
            continue;
        };
        let header = match parse_header_line(line) {
            Ok(header) => header,
            Err(problem) => {
                notes.line(number, &format!("ignored, {problem}"));
                continue;
            }
        };
        if line_count == MAX_HEADER_LINES {
            over_lines = true;
            continue;
        }
        line_count += 1;
        rule.headers.push(header);
    }
    notes.finish();
    if over_rules {
        notes.file(&format!(
            "only the first {} paths are used",
            thousands(MAX_HEADER_RULES)
        ));
    }
    if over_lines {
        notes.file(&format!(
            "only the first {} headers are used",
            thousands(MAX_HEADER_LINES)
        ));
    }
    rules.retain(|rule| !rule.headers.is_empty());
    rules
}

fn parse_header_line(line: &str) -> Result<HeaderLine, String> {
    if let Some(name) = line.strip_prefix('!') {
        let name = name.trim();
        check_header_name(name)?;
        return Ok(HeaderLine {
            name: name.to_string(),
            value: None,
        });
    }
    let Some((name, value)) = line.split_once(':') else {
        return Err("a header line looks like Name: value".to_string());
    };
    let name = name.trim();
    let value = value.trim();
    check_header_name(name)?;
    if !value
        .bytes()
        .all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
    {
        return Err(format!(
            "the value of {name} must be plain ASCII; %-encode other characters"
        ));
    }
    Ok(HeaderLine {
        name: name.to_string(),
        value: Some(value.to_string()),
    })
}

fn check_header_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_HEADER_NAME
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
    if !valid {
        return Err(format!("{name:?} is not a header name"));
    }
    if FIXED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("{name} is set by site and cannot be changed"));
    }
    Ok(())
}

fn is_absolute(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn is_condition(token: &str) -> bool {
    token.contains('=') && !token.starts_with('/') && !is_absolute(token)
}

fn status_token(token: &str) -> Option<(u16, bool)> {
    let (digits, force) = match token.strip_suffix('!') {
        Some(digits) => (digits, true),
        None => (token, false),
    };
    if digits.len() != 3 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, force))
}

fn is_dynamic(pattern: &str) -> bool {
    pattern.contains('*')
        || pattern.split('/').any(|segment| {
            let mut characters = segment.chars();
            characters.next() == Some(':')
                && characters
                    .next()
                    .is_some_and(|character| character.is_ascii_alphabetic())
        })
}

fn redirect_loops(redirects: &[Redirect], paths: &HashSet<&str>) -> Vec<Vec<usize>> {
    let first_dynamic = redirects
        .iter()
        .position(|redirect| is_dynamic(&redirect.from))
        .unwrap_or(redirects.len());
    let folded_paths: HashSet<String> = paths.iter().map(|path| fold(path)).collect();
    let mut first_static: HashMap<&str, usize> = HashMap::new();
    for (number, redirect) in redirects[..first_dynamic].iter().enumerate() {
        first_static
            .entry(without_trailing_slash(&redirect.from))
            .or_insert(number);
    }
    let follow = |requested: &str| -> Option<(usize, String)> {
        let &number = first_static.get(without_trailing_slash(requested))?;
        let redirect = &redirects[number];
        if !matches!(redirect.status, 301 | 302 | 303 | 307 | 308) {
            return None;
        }
        if !redirect.force && exists(&folded_paths, requested) {
            return None;
        }
        let next = requested_path(&redirect.to)?;
        if same_path(&next, requested) {
            return None;
        }
        Some((number, next))
    };

    let mut finished: HashSet<String> = HashSet::new();
    let mut loops: Vec<Vec<usize>> = Vec::new();
    for start in &redirects[..first_dynamic] {
        let mut walk: Vec<usize> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        let mut requested = start.from.clone();
        while !finished.contains(&requested) {
            if let Some(&position) = positions.get(&requested) {
                loops.push(walk[position..].to_vec());
                break;
            }
            let Some((number, next)) = follow(&requested) else {
                break;
            };
            positions.insert(requested, walk.len());
            walk.push(number);
            requested = next;
        }
        finished.extend(positions.into_keys());
    }
    loops
}

fn exists(folded_paths: &HashSet<String>, requested: &str) -> bool {
    if !requested.is_ascii() {
        return true;
    }
    let collapsed = collapse_slashes(requested);
    let relative = &collapsed[1..];
    let mut names: Vec<String> = Vec::new();
    if relative.is_empty() || relative.ends_with('/') {
        names.push(format!("{relative}index.html"));
        names.push(format!("{relative}index.htm"));
    }
    let page = relative.strip_suffix('/').unwrap_or(relative);
    if !page.is_empty() {
        for suffix in ["", ".html", ".htm", "/index.html", "/index.htm"] {
            names.push(format!("{page}{suffix}"));
        }
    }
    names.iter().any(|name| folded_paths.contains(&fold(name)))
}

fn collapse_slashes(path: &str) -> String {
    let mut collapsed = String::with_capacity(path.len());
    for character in path.chars() {
        if character == '/' && collapsed.ends_with('/') {
            continue;
        }
        collapsed.push(character);
    }
    collapsed
}

fn fold(path: &str) -> String {
    let segments: Vec<String> = path
        .split('/')
        .map(|segment| {
            if segment.starts_with('.') {
                segment.to_string()
            } else {
                segment.to_lowercase()
            }
        })
        .collect();
    segments.join("/")
}

fn requested_path(destination: &str) -> Option<String> {
    let path = destination.split(['?', '#']).next().unwrap_or("");
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    let decoded = percent_decode(path)?;
    let segments: Vec<&str> = decoded[1..].split('/').collect();
    let mut kept: Vec<&str> = Vec::new();
    for (position, segment) in segments.iter().enumerate() {
        let last = position + 1 == segments.len();
        match *segment {
            "." => {}
            ".." => {
                kept.pop();
            }
            other => {
                kept.push(other);
                continue;
            }
        }
        if last {
            kept.push("");
        }
    }
    Some(format!("/{}", kept.join("/")))
}

fn without_trailing_slash(path: &str) -> &str {
    path.strip_suffix('/')
        .filter(|path| !path.is_empty())
        .unwrap_or(path)
}

fn same_path(left: &str, right: &str) -> bool {
    without_trailing_slash(left) == without_trailing_slash(right)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] != b'%' {
            decoded.push(bytes[position]);
            position += 1;
            continue;
        }
        let hex = text.get(position + 1..position + 3)?;
        decoded.push(u8::from_str_radix(hex, 16).ok()?);
        position += 3;
    }
    String::from_utf8(decoded).ok()
}

fn encode_unsafe(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if (0x21..0x7f).contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn plural(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}
