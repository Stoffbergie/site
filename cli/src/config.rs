use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, ErrorKind, IsTerminal, Write};
use std::path::PathBuf;

const KEY_PREFIX: &str = "site_";
const KEY_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RANDOM_LENGTH: usize = 32;

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub key: Option<String>,
}

pub fn key() -> Result<String> {
    if let Ok(key) = std::env::var("SITE_KEY")
        && !key.is_empty()
    {
        return Ok(key);
    }
    let mut config = load()?;
    if let Some(key) = config.key {
        return Ok(key);
    }
    let key = generate()?;
    config.key = Some(key.clone());
    save(&config)?;
    Ok(key)
}

pub fn replace(new_key: &str) -> Result<()> {
    let new_key = new_key.trim();
    if !valid(new_key) {
        bail!(
            "that is not a site key; copy the whole key printed by site key, starting with site_"
        );
    }
    let mut config = load()?;
    if let Some(existing) = &config.key {
        if existing == new_key {
            eprintln!("This key is already saved on this machine.");
            return Ok(());
        }
        if !confirm_replace(existing)? {
            bail!("kept the existing key");
        }
    }
    config.key = Some(new_key.to_string());
    save(&config)?;
    eprintln!("Saved. Deploys and names made with this key can now be managed from this machine.");
    Ok(())
}

fn confirm_replace(existing: &str) -> Result<bool> {
    let path = path()?;
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        bail!(
            "this machine already has a different key; run site key in a terminal to replace it, or delete {} first",
            path.display()
        );
    }
    eprintln!("This machine already has another key:");
    eprintln!("  {existing}");
    eprintln!(
        "Deploys and names made with it stay with that key. Save it somewhere before replacing it."
    );
    eprint!("Replace it? [y/N] ");
    std::io::stderr().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "Yes"))
}

fn valid(key: &str) -> bool {
    let Some(random) = key.strip_prefix(KEY_PREFIX) else {
        return false;
    };
    (26..=64).contains(&random.len()) && random.bytes().all(|byte| KEY_ALPHABET.contains(&byte))
}

fn generate() -> Result<String> {
    let mut key = String::from(KEY_PREFIX);
    while key.len() < KEY_PREFIX.len() + KEY_RANDOM_LENGTH {
        let mut bytes = [0u8; KEY_RANDOM_LENGTH];
        getrandom::fill(&mut bytes)
            .map_err(|error| anyhow::anyhow!("could not make a key: {error}"))?;
        for byte in bytes {
            let usable = 256 - 256 % KEY_ALPHABET.len();
            if (byte as usize) >= usable {
                continue;
            }
            key.push(KEY_ALPHABET[byte as usize % KEY_ALPHABET.len()] as char);
            if key.len() == KEY_PREFIX.len() + KEY_RANDOM_LENGTH {
                break;
            }
        }
    }
    Ok(key)
}

fn load() -> Result<Config> {
    let path = path()?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("could not read {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.into()),
    }
}

fn save(config: &Config) -> Result<()> {
    let path = path()?;
    std::fs::create_dir_all(path.parent().context("config directory is missing")?)?;
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_vec_pretty(config)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(partial, &path)?;
    Ok(())
}

fn path() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("could not find a config directory")?
        .join("site/config.json"))
}
