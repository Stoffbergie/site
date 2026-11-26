const WELL_KNOWN: &str = ".well-known";
const QUIET: &[&str] = &[".git", ".svn", ".hg", ".DS_Store", ".gitkeep", ".nojekyll"];
const WELL_KNOWN_FOLDER: &str = ".well-known/";
const SHOWN_LEFT_OUT: usize = 8;

pub enum DotName {
    Deploy,
    SkipQuietly,
    LeaveOut,
}

pub fn classify(name: &str) -> DotName {
    if !name.starts_with('.') || name == WELL_KNOWN {
        return DotName::Deploy;
    }
    if QUIET.contains(&name) || name.starts_with("._") {
        return DotName::SkipQuietly;
    }
    DotName::LeaveOut
}

pub fn note_left_out(left_out: &[String]) {
    if left_out.is_empty() {
        return;
    }
    let mut sorted = left_out.to_vec();
    sorted.sort();
    let shown = sorted[..sorted.len().min(SHOWN_LEFT_OUT)].join(", ");
    let rest = left_out.len().saturating_sub(SHOWN_LEFT_OUT);
    let listed = if rest == 0 {
        shown
    } else {
        format!("{shown} and {rest} more")
    };
    crate::output::note(&format!(
        "Left out {listed}: names starting with a dot stay private, except {WELL_KNOWN}"
    ));
}

pub fn note_private_well_known<'a>(mut paths: impl Iterator<Item = &'a str>) {
    if paths.any(|path| inside_well_known(path).is_some()) {
        crate::output::note(
            ".well-known files on a private site open only in a browser with the link; apps and other services cannot read them",
        );
    }
}

fn inside_well_known(path: &str) -> Option<&str> {
    if let Some(name) = path.strip_prefix(WELL_KNOWN_FOLDER) {
        return Some(name);
    }
    let nested = format!("/{WELL_KNOWN_FOLDER}");
    let start = path.find(&nested)?;
    Some(&path[start + nested.len()..])
}

fn names_or_holds(name: &str, registered: &str) -> bool {
    match name.strip_prefix(registered) {
        Some(rest) => rest.is_empty() || rest.starts_with('/'),
        None => false,
    }
}

pub fn well_known_type(path: &str) -> Option<&'static str> {
    let name = inside_well_known(path)?;
    if name.starts_with("acme-challenge/") || name.starts_with("pki-validation/") {
        return Some("text/plain; charset=utf-8");
    }
    if names_or_holds(name, "oauth-authorization-server")
        || names_or_holds(name, "oauth-protected-resource")
        || names_or_holds(name, "openid-configuration")
    {
        return Some("application/json; charset=utf-8");
    }
    match name {
        "apple-app-site-association" | "nodeinfo" | "matrix/server" | "matrix/client" => {
            Some("application/json; charset=utf-8")
        }
        "webfinger" => Some("application/jrd+json; charset=utf-8"),
        "host-meta" => Some("application/xrd+xml; charset=utf-8"),
        "atproto-did" | "apple-developer-merchantid-domain-association" => {
            Some("text/plain; charset=utf-8")
        }
        _ => None,
    }
}
