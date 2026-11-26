use anyhow::Result;
use clap::{Parser, Subcommand};
use crypto::LinkKey;

mod api;
mod charset;
mod config;
mod crypto;
mod dotfiles;
mod output;
mod pack;
mod rules;
mod types;

const PRIVATE_LINKS_NEED_WHOLE_KEY: &str = "Private links need the whole key, including the part after the dot; use the key that made them";

#[derive(Parser)]
#[command(
    name = "site",
    version,
    about = "Static sites, live in one command",
    args_conflicts_with_subcommands = true,
    after_help = "Examples:\n  site dist                      Deploy a folder and print its URL\n  site dist -n todo              Also point todo.site.stoff.dev at it\n  site dist -e                   Encrypt it; only the full link opens it\n  site index.html style.css      Deploy loose files at the root\n  cat page.html | site -         Deploy stdin as index.html\n  site dist --spa                Serve index.html for client-side routes\n  site ls                        List your names and deploys\n  site point todo k3m9xq2a       Point a name at an earlier deploy\n  site rm k3m9xq2a               Delete a deploy (or release a name)\n  site key                       Print your key, to use on another machine\n\nSet SITE_KEY to use a key without saving it, and SITE_URL to use another server."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(help = "A folder, files, or - for stdin")]
    paths: Vec<String>,

    #[arg(
        short,
        long,
        help = "Point this name at the deploy, like todo for todo.site.stoff.dev"
    )]
    name: Option<String>,

    #[arg(
        short,
        long,
        help = "Encrypt the site on this machine; only the printed link, with its key after #, opens it"
    )]
    encrypt: bool,

    #[arg(
        long,
        help = "Serve index.html for unknown paths without a file extension"
    )]
    spa: bool,

    #[arg(long, help = "Leave the clipboard unchanged after deploying")]
    no_copy: bool,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "List your names and deploys")]
    Ls,
    #[command(about = "Point a name at one of your deploys")]
    Point {
        #[arg(help = "Name, like todo")]
        name: String,
        #[arg(help = "Deploy id, like k3m9xq2a")]
        id: String,
    },
    #[command(about = "Delete a deploy or release a name")]
    Rm {
        #[arg(help = "Deploy id or name")]
        target: String,
    },
    #[command(about = "Print your key, or save a key from another machine")]
    Key {
        #[arg(help = "A key printed by site key on another machine")]
        key: Option<String>,
    },
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("site: {error:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Command::Ls) => list(),
        Some(Command::Point { name, id }) => {
            let key = config::key()?;
            let pointed = api::point(&key.api, &name, &id)?;
            let mut link = pointed.url.clone();
            if pointed.encrypted {
                match key.secret() {
                    Ok(secret) => {
                        let fragment = LinkKey::for_name(secret, &name)?.fragment();
                        link = with_key(&pointed.url, &fragment);
                    }
                    Err(_) => output::note(PRIVATE_LINKS_NEED_WHOLE_KEY),
                }
            }
            println!("{link}");
            Ok(())
        }
        Some(Command::Rm { target }) => {
            let key = config::key()?;
            if api::is_deploy_id(&target) {
                api::delete_deploy(&key.api, &target)?;
                output::note(&format!("Deleted {target}"));
            } else {
                api::release_name(&key.api, &target)?;
                output::note(&format!("Released {target}"));
            }
            Ok(())
        }
        Some(Command::Key { key: None }) => {
            println!("{}", config::key()?.full());
            Ok(())
        }
        Some(Command::Key { key: Some(key) }) => config::replace(&key),
        None => deploy(cli.paths, cli.name, cli.spa, cli.no_copy, cli.encrypt),
    }
}

fn deploy(
    paths: Vec<String>,
    name: Option<String>,
    spa: bool,
    no_copy: bool,
    encrypt: bool,
) -> Result<()> {
    let key = config::key()?;
    let link_key = match (encrypt, &name) {
        (false, _) => None,
        (true, Some(name)) => Some(LinkKey::for_name(key.secret()?, name)?),
        (true, None) => Some(LinkKey::fresh(key.secret()?)?),
    };
    let pack = pack::Pack::collect(&paths, spa, link_key.as_ref())?;
    let mut deployed = api::deploy(&key.api, pack, name.as_deref())?;
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
                    link = with_key(
                        &name.url,
                        &LinkKey::for_name(secret, &name.name)?.fragment(),
                    );
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
                        (Some(name), _) => LinkKey::for_name(secret, name)?,
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
