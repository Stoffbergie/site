use anyhow::Result;
use args::Command;
use crypto::LinkKey;

mod api;
mod args;
mod charset;
mod config;
mod crypto;
mod dotfiles;
mod output;
mod pack;
mod reuse;
mod rules;
mod types;

const PRIVATE_LINKS_NEED_WHOLE_KEY: &str = "Private links need the whole key, including the part after the dot; use the key that made them";

fn main() {
    if let Err(error) = run(args::parse()) {
        eprintln!("site: {error:#}");
        std::process::exit(1);
    }
}

fn run(command: Command) -> Result<()> {
    match command {
        Command::Ls => list(),
        Command::Point { name, id } => {
            let key = config::key()?;
            let pointed = api::point(&key.api, &name, &id)?;
            let mut link = pointed.url.clone();
            if pointed.encrypted {
                match key.secret() {
                    Ok(secret) => {
                        let link_key =
                            LinkKey::for_name(secret, &name, pointed.link_salt.as_deref())?;
                        let fragment = link_key.fragment();
                        link = with_key(&pointed.url, &fragment);
                    }
                    Err(_) => output::note(PRIVATE_LINKS_NEED_WHOLE_KEY),
                }
            }
            println!("{link}");
            Ok(())
        }
        Command::Rm { target } => {
            let key = config::key()?;
            if api::is_deploy_id(&target) {
                api::delete_deploy(&key.api, &target)?;
                reuse::forget_deploy(&target);
                output::note(&format!("Deleted {target}"));
            } else {
                api::release_name(&key.api, &target)?;
                output::note(&format!("Released {target}"));
            }
            Ok(())
        }
        Command::Key { key: None } => {
            println!("{}", config::key()?.full());
            Ok(())
        }
        Command::Key { key: Some(key) } => config::replace(&key),
        Command::Deploy {
            paths,
            name,
            encrypt,
            spa,
            no_copy,
            new_link,
        } => deploy(paths, name, spa, no_copy, encrypt, new_link),
    }
}

fn deploy(
    paths: Vec<String>,
    name: Option<String>,
    spa: bool,
    no_copy: bool,
    encrypt: bool,
    new_link: bool,
) -> Result<()> {
    let sources = pack::sources(&paths)?;
    let key = config::key()?;
    let link_key = match (encrypt, &name) {
        (false, _) => None,
        (true, Some(name)) => {
            let secret = key.secret()?;
            let link_salt = if new_link {
                Some(crypto::random_salt()?)
            } else {
                current_link_salt(&key.api, name)?
            };
            Some(LinkKey::for_name(secret, name, link_salt.as_deref())?)
        }
        (true, None) => Some(LinkKey::fresh(key.secret()?)?),
    };
    let server = api::base_url();
    let mut known = reuse::Known::new();
    if link_key.is_none() {
        known = reuse::known(&server, &key.api);
    }
    let pack = pack::Pack::build(&sources, spa, link_key.as_ref(), &known)?;
    let mut files = pack.files.clone();
    let reused = pack.reuses;
    let mut outcome = api::deploy(&key.api, pack, name.as_deref(), new_link)?;
    if reused && matches!(outcome, api::Outcome::Stale) {
        reuse::forget_all(&server, &key.api);
        let fresh = pack::Pack::build(&sources, spa, None, &reuse::Known::new())?;
        files = fresh.files.clone();
        outcome = api::deploy(&key.api, fresh, name.as_deref(), new_link)?;
    }
    let mut deployed = match outcome {
        api::Outcome::Deployed(deployed) => deployed,
        api::Outcome::Stale => anyhow::bail!("the server refused the request; try again"),
    };
    if link_key.is_none() {
        reuse::remember(&server, &key.api, &deployed.id, files);
    }
    if let Some(link_key) = &link_key {
        let fragment = link_key.fragment();
        deployed.url = with_key(&deployed.url, &fragment);
        deployed.name_url = deployed
            .name_url
            .map(|name_url| with_key(&name_url, &fragment));
    }
    let summary = format!(
        "{} {} · {}",
        deployed.files,
        if deployed.files == 1 { "file" } else { "files" },
        output::size(deployed.size)
    );
    let link = match &deployed.name_url {
        Some(name_url) => {
            output::note(&format!("{} · {summary}", deployed.url));
            name_url.clone()
        }
        None => {
            output::note(&summary);
            deployed.url.clone()
        }
    };
    println!("{link}");
    if !no_copy && output::stdout_is_terminal() {
        match output::copy(&link) {
            Ok(()) => output::note("Copied to clipboard"),
            Err(_) => output::note("Clipboard unavailable; copy the link above"),
        }
    }
    Ok(())
}

fn current_link_salt(api_key: &str, name: &str) -> Result<Option<String>> {
    let listing = api::list(api_key)?;
    let current = listing
        .names
        .into_iter()
        .find(|entry| entry.name == name && entry.encrypted);
    Ok(current.and_then(|entry| entry.link_salt))
}

fn with_key(url: &str, fragment: &str) -> String {
    format!("{url}/#{fragment}")
}

fn list() -> Result<()> {
    let key = config::key()?;
    let listing = api::list(&key.api)?;
    if listing.names.is_empty() && listing.deploys.is_empty() {
        output::note("No deploys yet. Deploy a folder with: site <folder>");
        return Ok(());
    }
    let secret = key.secret().ok();
    let lists_private_sites = listing.names.iter().any(|name| name.encrypted)
        || listing
            .deploys
            .iter()
            .any(|deploy| deploy.encrypted.is_some());
    if secret.is_none() && lists_private_sites {
        output::note(PRIVATE_LINKS_NEED_WHOLE_KEY);
    }
    if !listing.names.is_empty() {
        println!("{}", output::dim("NAMES"));
        for name in &listing.names {
            let target = name.id.as_deref().unwrap_or("-");
            if name.encrypted {
                let mut link = name.url.clone();
                if let Some(secret) = secret {
                    let link_key =
                        LinkKey::for_name(secret, &name.name, name.link_salt.as_deref())?;
                    link = with_key(&name.url, &link_key.fragment());
                }
                let details = format!("→ {target}  encrypted");
                println!("{link:<40} {}", output::dim(&details));
            } else {
                println!("{:<40} {}", name.url, output::dim(&format!("→ {target}")));
            }
        }
    }
    if !listing.deploys.is_empty() {
        if !listing.names.is_empty() {
            println!();
        }
        println!("{}", output::dim("DEPLOYS"));
        for deploy in &listing.deploys {
            let files = if deploy.files == 1 { "file" } else { "files" };
            let mut details = format!(
                "{:>8}  {:>9}  {} {files}",
                output::age(&deploy.created_at),
                output::size(deploy.size),
                deploy.files
            );
            let mut link = deploy.url.clone();
            if let Some(hint) = &deploy.encrypted {
                if let Some(secret) = secret {
                    let link_key = match (&hint.name, &hint.link_salt) {
                        (Some(name), link_salt) => {
                            LinkKey::for_name(secret, name, link_salt.as_deref())?
                        }
                        (None, Some(link_salt)) => LinkKey::for_salt(secret, link_salt)?,
                        (None, None) => {
                            anyhow::bail!(
                                "the server listed {} without its link details",
                                deploy.url
                            )
                        }
                    };
                    link = with_key(&deploy.url, &link_key.fragment());
                }
                details.push_str("  encrypted");
            }
            println!("{link:<40} {}", output::dim(&details));
        }
    }
    Ok(())
}
