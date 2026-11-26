use crate::output;
use crate::pack::Pack;
use anyhow::{Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const DEFAULT_URL: &str = "https://site.stoff.dev";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployed {
    pub id: String,
    pub url: String,
    pub name_url: Option<String>,
    pub files: u64,
    pub size: u64,
}

#[derive(Deserialize)]
pub struct Listing {
    pub names: Vec<NameEntry>,
    pub deploys: Vec<DeployEntry>,
}

#[derive(Deserialize)]
pub struct NameEntry {
    pub name: String,
    pub url: String,
    pub id: Option<String>,
    #[serde(default)]
    pub encrypted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkHint {
    pub name: Option<String>,
    pub link_salt: Option<String>,
}

pub struct Pointed {
    pub url: String,
    pub encrypted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployEntry {
    pub url: String,
    pub created_at: String,
    pub size: u64,
    pub files: u64,
    #[serde(default)]
    pub encrypted: Option<LinkHint>,
}

pub fn base_url() -> String {
    match std::env::var("SITE_URL") {
        Ok(url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
        _ => DEFAULT_URL.to_string(),
    }
}

type Response = ureq::http::Response<ureq::Body>;

const ATTEMPTS: u32 = 4;
const STALLS_ALLOWED: u32 = 1;
const STALL_SECONDS: f64 = 60.0;
const SEND_BUFFER_ESTIMATE: f64 = 262_144.0;
const LONGEST_RETRY_WAIT: u64 = 60;

pub struct Progress {
    started: Instant,
    bytes: AtomicU64,
    first_millis: AtomicU64,
    last_millis: AtomicU64,
}

impl Progress {
    fn new() -> Progress {
        Progress {
            started: Instant::now(),
            bytes: AtomicU64::new(0),
            first_millis: AtomicU64::new(u64::MAX),
            last_millis: AtomicU64::new(0),
        }
    }

    pub fn advance(&self, count: u64) {
        self.bytes.fetch_add(count, Ordering::Relaxed);
        let now = self.started.elapsed().as_millis() as u64;
        self.first_millis.fetch_min(now, Ordering::Relaxed);
        self.last_millis.store(now, Ordering::Relaxed);
    }

    fn stalled(&self) -> bool {
        let first = self.first_millis.load(Ordering::Relaxed);
        let last = self.last_millis.load(Ordering::Relaxed);
        let idle = self.started.elapsed().as_secs_f64() - last as f64 / 1000.0;
        let bytes = self.bytes.load(Ordering::Relaxed) as f64;
        let active = last.saturating_sub(first) as f64 / 1000.0;
        let mut allowed = STALL_SECONDS;
        if first != u64::MAX && active > 1.0 {
            let rate = bytes / active;
            allowed = allowed.max(3.0 * SEND_BUFFER_ESTIMATE / rate);
        }
        idle > allowed
    }
}

enum Attempt {
    Answered(Response),
    Failed(ureq::Error),
    Stalled,
}

#[derive(Clone, Copy, PartialEq)]
enum Retry {
    Always,
    BeforeServerActs,
}

fn agent() -> ureq::Agent {
    let crypto = Arc::new(rustls::crypto::ring::default_provider());
    ureq::Agent::config_builder()
        .user_agent(concat!("site/", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .unversioned_rustls_crypto_provider(crypto)
                .build(),
        )
        .build()
        .new_agent()
}

fn attempt<Job>(job: Job) -> Attempt
where
    Job: FnOnce(Arc<Progress>) -> Result<Response, ureq::Error> + Send + 'static,
{
    let progress = Arc::new(Progress::new());
    let (sender, receiver) = mpsc::channel();
    let shared = Arc::clone(&progress);
    std::thread::spawn(move || {
        let _ = sender.send(job(shared));
    });
    loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(response)) => return Attempt::Answered(response),
            Ok(Err(error)) => return Attempt::Failed(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Attempt::Stalled,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if progress.stalled() {
                    return Attempt::Stalled;
                }
            }
        }
    }
}

fn send<Job>(retry: Retry, job: Job) -> Result<Response>
where
    Job: Fn(Arc<Progress>) -> Result<Response, ureq::Error> + Send + Sync + 'static,
{
    let job = Arc::new(job);
    let mut stalls = 0;
    let mut tries = 0;
    loop {
        tries += 1;
        let shared = Arc::clone(&job);
        let outcome = attempt(move |progress| shared(progress));
        let last_try = tries >= ATTEMPTS;
        match outcome {
            Attempt::Answered(response) => {
                let status = response.status().as_u16();
                if last_try || !retryable_status(status, retry) {
                    return Ok(response);
                }
                wait_before_retry(&response, tries);
            }
            Attempt::Failed(error) => {
                if last_try || !retryable_error(&error, retry) {
                    bail!(
                        "could not reach {}; check your connection and try again",
                        base_url()
                    );
                }
                std::thread::sleep(backoff(tries));
            }
            Attempt::Stalled => {
                stalls += 1;
                if stalls > STALLS_ALLOWED || last_try {
                    bail!(
                        "the connection to {} stalled; check your connection and try again",
                        base_url()
                    );
                }
            }
        }
    }
}

fn retryable_status(status: u16, retry: Retry) -> bool {
    match status {
        429 | 503 => true,
        502 | 504 => true,
        500 | 520..=530 => retry == Retry::Always,
        _ => false,
    }
}

fn retryable_error(error: &ureq::Error, retry: Retry) -> bool {
    match error {
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::BadUri(_) => false,
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => true,
        _ => retry == Retry::Always,
    }
}

fn backoff(tries: u32) -> Duration {
    Duration::from_secs(1 << (tries - 1).min(4))
}

fn wait_before_retry(response: &Response, tries: u32) {
    let asked = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let Some(seconds) = asked else {
        std::thread::sleep(backoff(tries));
        return;
    };
    let seconds = seconds.min(LONGEST_RETRY_WAIT);
    if seconds >= 5 {
        output::note(&format!("The server is busy; trying again in {seconds}s"));
    }
    std::thread::sleep(Duration::from_secs(seconds));
}

pub fn is_deploy_id(value: &str) -> bool {
    value.len() == 8
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().any(|byte| byte.is_ascii_digit())
}

pub enum Outcome {
    Deployed(Deployed),
    Stale,
}

pub fn deploy(key: &str, pack: Pack, name: Option<&str>) -> Result<Outcome> {
    let total = pack.total;
    let mut url = format!("{}/", base_url());
    if let Some(name) = name {
        url = format!("{url}?name={name}");
    }
    let pack = Arc::new(pack);
    let authorization = format!("Bearer {key}");
    let sent = send(Retry::Always, move |progress| {
        let mut reader = Pack::reader(&pack, progress);
        agent()
            .post(&url)
            .header("Authorization", &authorization)
            .header("Accept", "application/json")
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", total.to_string())
            .send(ureq::SendBody::from_reader(&mut reader))
    });
    if output::stderr_is_terminal() && total > 1_000_000 {
        output::clear_progress();
    }
    let response = sent?;
    if response.status() == 412 {
        return Ok(Outcome::Stale);
    }
    Ok(Outcome::Deployed(json(refused_or(response)?)?))
}

pub fn list(key: &str) -> Result<Listing> {
    let url = format!("{}/list", base_url());
    let authorization = format!("Bearer {key}");
    let response = send(Retry::Always, move |_| {
        agent()
            .get(&url)
            .header("Authorization", &authorization)
            .call()
    })?;
    json(refused_or(response)?)
}

pub fn point(key: &str, name: &str, id: &str) -> Result<Pointed> {
    let url = format!("{}/names/{name}", base_url());
    let authorization = format!("Bearer {key}");
    let body = serde_json::to_vec(&serde_json::json!({ "id": id }))?;
    let response = send(Retry::BeforeServerActs, move |_| {
        agent()
            .put(&url)
            .header("Authorization", &authorization)
            .header("Content-Type", "application/json")
            .send(&body[..])
    })?;
    let response = refused_or(response)?;
    let encrypted = response.headers().contains_key("x-site-encrypted");
    let url = text(response).trim().to_string();
    Ok(Pointed { url, encrypted })
}

pub fn delete_deploy(key: &str, id: &str) -> Result<()> {
    remove(key, format!("{}/deploys/{id}", base_url()))
}

pub fn release_name(key: &str, name: &str) -> Result<()> {
    remove(key, format!("{}/names/{name}", base_url()))
}

fn remove(key: &str, url: String) -> Result<()> {
    let authorization = format!("Bearer {key}");
    let response = send(Retry::BeforeServerActs, move |_| {
        agent()
            .delete(&url)
            .header("Authorization", &authorization)
            .call()
    })?;
    refused_or(response)?;
    Ok(())
}

fn json<T: DeserializeOwned>(mut response: Response) -> Result<T> {
    let body = response.body_mut().read_to_vec()?;
    Ok(serde_json::from_slice(&body)?)
}

fn text(mut response: Response) -> String {
    response.body_mut().read_to_string().unwrap_or_default()
}

fn refused_or(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let text = text(response);
    let message = text.trim().trim_end_matches('.');
    if message.is_empty() {
        bail!("the server refused the request; try again");
    }
    let mut characters = message.chars();
    let first = characters
        .next()
        .map(|first| first.to_lowercase().to_string());
    bail!("{}{}", first.unwrap_or_default(), characters.as_str())
}
