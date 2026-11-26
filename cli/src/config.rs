use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, ErrorKind, IsTerminal, Write};
use std::path::PathBuf;

const KEY_PREFIX: &str = "site_";
const KEY_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RANDOM_LENGTH: usize = 32;
const SECRET_SEPARATOR: char = '.';

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

impl Config {
    fn saved_key(&self) -> Option<Key> {
        let api = self.key.as_deref()?;
        match &self.secret {
            Some(secret) => Key::parse(&format!("{api}{SECRET_SEPARATOR}{secret}")),
            None => Key::parse(api),
        }
    }

    fn hold(&mut self, key: &Key) {
        self.key = Some(key.api.clone());
        self.secret = key.secret.clone();
    }
}

pub struct Key {
    pub api: String,
    secret: Option<String>,
}

impl Key {
    pub fn full(&self) -> String {
        match &self.secret {
            Some(secret) => format!("{}{SECRET_SEPARATOR}{secret}", self.api),
            None => self.api.clone(),
        }
    }

    pub fn secret(&self) -> Result<&str> {
        self.secret.as_deref().context(
            "private sites need the whole key; set SITE_KEY to everything site key prints, including the part after the dot",
        )
    }

    fn parse(text: &str) -> Option<Key> {
        let (api, secret) = match text.split_once(SECRET_SEPARATOR) {
            Some((api, secret)) => (api, Some(secret)),
            None => (text, None),
        };
        let random = api.strip_prefix(KEY_PREFIX)?;
        if !(26..=64).contains(&random.len()) || !only_key_characters(random) {
            return None;
        }
        if let Some(secret) = secret
            && (secret.len() != KEY_RANDOM_LENGTH || !only_key_characters(secret))
        {
            return None;
        }
        Some(Key {
            api: api.to_string(),
            secret: secret.map(str::to_string),
        })
    }
}

pub fn key() -> Result<Key> {
    if let Ok(text) = std::env::var("SITE_KEY")
        && !text.trim().is_empty()
    {
        return Key::parse(text.trim())
            .context("SITE_KEY is not a site key; copy the whole key printed by site key");
    }
    let mut config = load()?;
    if config.key.is_some() {
        let mut key = config.saved_key().with_context(unreadable_key)?;
        if key.secret.is_none() {
            key.secret = Some(random_text()?);
            config.hold(&key);
            save(&config)?;
        }
        return Ok(key);
    }
    let key = Key {
        api: format!("{KEY_PREFIX}{}", random_text()?),
        secret: Some(random_text()?),
    };
    config.hold(&key);
    if save_first(&config)? {
        return Ok(key);
    }
    load()?.saved_key().with_context(unreadable_key)
}

fn unreadable_key() -> String {
    format!(
        "{} has no usable key; delete it and run the command again",
        path()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    )
}

pub fn replace(new_key: &str) -> Result<()> {
    let new_key = new_key.trim();
    let Some(parsed) = Key::parse(new_key) else {
        bail!(
            "that is not a site key; copy the whole key printed by site key, starting with site_"
        );
    };
    let mut config = load()?;
    if let Some(existing) = config.saved_key() {
        if existing.full() == parsed.full() {
            eprintln!("This key is already saved on this machine.");
            return Ok(());
        }
        if !confirm_replace(&existing.full())? {
            bail!("kept the existing key");
        }
    }
    config.hold(&parsed);
    save(&config)?;
    eprintln!("Saved. Deploys and names made with this key can now be managed from this machine.");
    if parsed.secret.is_none() {
        eprintln!(
            "This key has no part after a dot, so private links made here will not match your other machines. Update site there, run site key again and save that key here."
        );
    }
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

fn only_key_characters(text: &str) -> bool {
    text.bytes().all(|byte| KEY_ALPHABET.contains(&byte))
}

fn random_text() -> Result<String> {
    let mut text = String::new();
    while text.len() < KEY_RANDOM_LENGTH {
        let mut bytes = [0u8; KEY_RANDOM_LENGTH];
        getrandom::fill(&mut bytes)
            .map_err(|error| anyhow::anyhow!("could not make a key: {error}"))?;
        for byte in bytes {
            let usable = 256 - 256 % KEY_ALPHABET.len();
            if (byte as usize) >= usable {
                continue;
            }
            text.push(KEY_ALPHABET[byte as usize % KEY_ALPHABET.len()] as char);
            if text.len() == KEY_RANDOM_LENGTH {
                break;
            }
        }
    }
    Ok(text)
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
    let partial = write_partial(&path, config)?;
    std::fs::rename(partial, &path)?;
    Ok(())
}

fn save_first(config: &Config) -> Result<bool> {
    let path = path()?;
    let partial = write_partial(&path, config)?;
    let linked = std::fs::hard_link(&partial, &path);
    std::fs::remove_file(&partial)?;
    match linked {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn write_partial(path: &std::path::Path, config: &Config) -> Result<PathBuf> {
    std::fs::create_dir_all(path.parent().context("config directory is missing")?)?;
    let partial = path.with_extension(format!("json.{}.part", std::process::id()));
    let contents = serde_json::to_vec_pretty(config)?;
    #[cfg(unix)]
    write_private(&partial, &contents)?;
    #[cfg(not(unix))]
    std::fs::write(&partial, contents)?;
    Ok(partial)
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, contents: &[u8]) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(contents)?;
    Ok(())
}

fn path() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("could not find a config directory")?
        .join("site/config.json"))
}
