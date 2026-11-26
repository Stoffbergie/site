const WELL_KNOWN: &str = ".well-known";
const QUIET: &[&str] = &[".git", ".svn", ".hg", ".DS_Store", ".gitkeep", ".nojekyll"];
const SHOWN_LEFT_OUT: usize = 3;

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
    if paths.any(|path| path.starts_with(".well-known/")) {
        crate::output::note(
            ".well-known files on a private site open only in a browser with the link; apps and other services cannot read them",
        );
    }
}

pub fn well_known_type(path: &str) -> Option<&'static str> {
    let name = path.strip_prefix(".well-known/")?;
    if name.starts_with("acme-challenge/") || name.starts_with("pki-validation/") {
        return Some("text/plain; charset=utf-8");
    }
    match name {
        "apple-app-site-association"
        | "openid-configuration"
        | "oauth-authorization-server"
        | "oauth-protected-resource"
        | "nodeinfo"
        | "matrix/server"
        | "matrix/client" => Some("application/json; charset=utf-8"),
        "webfinger" => Some("application/jrd+json; charset=utf-8"),
        "host-meta" => Some("application/xrd+xml; charset=utf-8"),
        "atproto-did" | "apple-developer-merchantid-domain-association" => {
            Some("text/plain; charset=utf-8")
        }
        _ => None,
    }
}
