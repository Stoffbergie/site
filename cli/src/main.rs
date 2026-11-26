use anyhow::Result;
use clap::{Parser, Subcommand};

mod api;
mod config;
mod output;
mod pack;

#[derive(Parser)]
#[command(
    name = "site",
    version,
    about = "Static sites, live in one command",
    args_conflicts_with_subcommands = true,
    after_help = "Examples:\n  site dist                      Deploy a folder and print its URL\n  site dist -n todo              Also point todo.site.stoff.dev at it\n  site index.html style.css      Deploy loose files at the root\n  cat page.html | site -         Deploy stdin as index.html\n  site dist --spa                Serve index.html for client-side routes\n  site ls                        List your names and deploys\n  site point todo k3m9xq2a       Point a name at an earlier deploy\n  site rm k3m9xq2a               Delete a deploy (or release a name)\n  site key                       Print your key, to use on another machine\n\nSet SITE_KEY to use a key without saving it, and SITE_URL to use another server."
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
            let url = api::point(&config::key()?, &name, &id)?;
            println!("{url}");
            Ok(())
        }
        Some(Command::Rm { target }) => {
            let key = config::key()?;
            if api::is_deploy_id(&target) {
                api::delete_deploy(&key, &target)?;
                output::note(&format!("Deleted {target}"));
            } else {
                api::release_name(&key, &target)?;
                output::note(&format!("Released {target}"));
            }
            Ok(())
        }
        Some(Command::Key { key: None }) => {
            println!("{}", config::key()?);
            Ok(())
        }
        Some(Command::Key { key: Some(key) }) => config::replace(&key),
        None => deploy(cli.paths, cli.name, cli.spa, cli.no_copy),
    }
}

fn deploy(paths: Vec<String>, name: Option<String>, spa: bool, no_copy: bool) -> Result<()> {
    let pack = pack::Pack::collect(&paths, spa)?;
    let key = config::key()?;
    let deployed = api::deploy(&key, pack, name.as_deref())?;
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

fn list() -> Result<()> {
    let listing = api::list(&config::key()?)?;
    if listing.names.is_empty() && listing.deploys.is_empty() {
        output::note("No deploys yet. Deploy a folder with: site <folder>");
        return Ok(());
    }
    if !listing.names.is_empty() {
        println!("{}", output::dim("NAMES"));
        for name in &listing.names {
            let target = name.id.as_deref().unwrap_or("-");
            println!("{:<40} {}", name.url, output::dim(&format!("→ {target}")));
        }
    }
    if !listing.deploys.is_empty() {
        if !listing.names.is_empty() {
            println!();
        }
        println!("{}", output::dim("DEPLOYS"));
        for deploy in &listing.deploys {
            let files = if deploy.files == 1 { "file" } else { "files" };
            let details = format!(
                "{:>8}  {:>9}  {} {files}",
                output::age(&deploy.created_at),
                output::size(deploy.size),
                deploy.files
            );
            println!("{:<40} {}", deploy.url, output::dim(&details));
        }
    }
    Ok(())
}
