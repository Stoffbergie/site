use crate::output;
use crate::pack::Pack;
use anyhow::{Context, Result, bail};
use reqwest::blocking::{Body, Client, RequestBuilder, Response};
use serde::Deserialize;
use std::time::Duration;

const DEFAULT_URL: &str = "https://site.stoff.dev";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployed {
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
    pub url: String,
    pub id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployEntry {
    pub url: String,
    pub created_at: String,
    pub size: u64,
    pub files: u64,
}

pub fn base_url() -> String {
    match std::env::var("SITE_URL") {
        Ok(url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
        _ => DEFAULT_URL.to_string(),
    }
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(concat!("site/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(None)
        .build()?)
}

pub fn is_deploy_id(value: &str) -> bool {
    value.len() == 8
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().any(|byte| byte.is_ascii_digit())
}

pub fn deploy(key: &str, pack: Pack, name: Option<&str>) -> Result<Deployed> {
    let total = pack.total;
    let mut url = format!("{}/", base_url());
    if let Some(name) = name {
        url = format!("{url}?name={name}");
    }
    let request = client()?
        .post(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream")
        .body(Body::sized(pack.into_reader(), total));
    let result = checked(request);
    if output::stderr_is_terminal() && total > 1_000_000 {
        output::clear_progress();
    }
    Ok(result?.json()?)
}

pub fn list(key: &str) -> Result<Listing> {
    let request = client()?
        .get(format!("{}/list", base_url()))
        .bearer_auth(key);
    Ok(checked(request)?.json()?)
}

pub fn point(key: &str, name: &str, id: &str) -> Result<String> {
    let request = client()?
        .put(format!("{}/names/{name}", base_url()))
        .bearer_auth(key)
        .json(&serde_json::json!({ "id": id }));
    Ok(checked(request)?.text()?.trim().to_string())
}

pub fn delete_deploy(key: &str, id: &str) -> Result<()> {
    let request = client()?
        .delete(format!("{}/deploys/{id}", base_url()))
        .bearer_auth(key);
    checked(request)?;
    Ok(())
}

pub fn release_name(key: &str, name: &str) -> Result<()> {
    let request = client()?
        .delete(format!("{}/names/{name}", base_url()))
        .bearer_auth(key);
    checked(request)?;
    Ok(())
}

fn checked(request: RequestBuilder) -> Result<Response> {
    let response = request
        .send()
        .with_context(|| format!("could not reach {}; check your connection", base_url()))?;
    if response.status().is_success() {
        return Ok(response);
    }
    let text = response.text().unwrap_or_default();
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
