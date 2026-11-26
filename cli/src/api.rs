use crate::output;
use crate::pack::Pack;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;
use std::time::Duration;

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
    let mut reader = Pack::reader(&Arc::new(pack));
    let sent = agent()
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", total.to_string())
        .send(ureq::SendBody::from_reader(&mut reader));
    if output::stderr_is_terminal() && total > 1_000_000 {
        output::clear_progress();
    }
    let response = reached(sent)?;
    if response.status() == 412 {
        return Ok(Outcome::Stale);
    }
    Ok(Outcome::Deployed(json(refused_or(response)?)?))
}

pub fn list(key: &str) -> Result<Listing> {
    let sent = agent()
        .get(format!("{}/list", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .call();
    json(refused_or(reached(sent)?)?)
}

pub fn point(key: &str, name: &str, id: &str) -> Result<Pointed> {
    let body = serde_json::to_vec(&serde_json::json!({ "id": id }))?;
    let sent = agent()
        .put(format!("{}/names/{name}", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(&body[..]);
    let response = refused_or(reached(sent)?)?;
    let encrypted = response.headers().contains_key("x-site-encrypted");
    let url = text(response).trim().to_string();
    Ok(Pointed { url, encrypted })
}

pub fn delete_deploy(key: &str, id: &str) -> Result<()> {
    let sent = agent()
        .delete(format!("{}/deploys/{id}", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .call();
    refused_or(reached(sent)?)?;
    Ok(())
}

pub fn release_name(key: &str, name: &str) -> Result<()> {
    let sent = agent()
        .delete(format!("{}/names/{name}", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .call();
    refused_or(reached(sent)?)?;
    Ok(())
}

fn reached(sent: Result<Response, ureq::Error>) -> Result<Response> {
    sent.with_context(|| format!("could not reach {}; check your connection", base_url()))
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
