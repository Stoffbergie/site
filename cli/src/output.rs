use anyhow::{Result, bail};
use std::io::{IsTerminal, Write};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn color(stream_is_terminal: bool) -> bool {
    stream_is_terminal
        && std::env::var_os("NO_COLOR").is_none()
        && !std::env::var("TERM").is_ok_and(|term| term == "dumb")
}

pub fn stdout_is_terminal() -> bool {
    std::io::stdout().is_terminal()
}

pub fn stderr_is_terminal() -> bool {
    std::io::stderr().is_terminal()
}

pub fn dim(text: &str) -> String {
    if color(stdout_is_terminal()) {
        format!("\x1b[90m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn note(message: &str) {
    if color(stderr_is_terminal()) {
        eprintln!("\x1b[90m{message}\x1b[0m");
    } else {
        eprintln!("{message}");
    }
}

pub fn progress(sent: u64, total: u64) {
    let percent = sent * 100 / total.max(1);
    eprint!(
        "\r\x1b[2KUploading {percent:>3}%  {} of {}",
        size(sent),
        size(total)
    );
    let _ = std::io::stderr().flush();
}

pub fn clear_progress() {
    eprint!("\r\x1b[2K");
    let _ = std::io::stderr().flush();
}

pub fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn age(iso: &str) -> String {
    let Some(then) = unix_seconds(iso) else {
        return "?".to_string();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(then);
    let seconds = (now - then).max(0);
    if seconds < 60 {
        "just now".to_string()
    } else if seconds < 3600 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h ago", seconds / 3600)
    } else {
        format!("{}d ago", seconds / 86_400)
    }
}

fn unix_seconds(iso: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| iso.get(range)?.parse::<i64>().ok();
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

pub fn copy(text: &str) -> Result<()> {
    for (program, args) in clipboard_commands() {
        let child = Command::new(program)
            .args(*args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else { continue };
        if let Some(mut input) = child.stdin.take() {
            input.write_all(text.as_bytes())?;
        }
        if child.wait()?.success() {
            return Ok(());
        }
    }
    bail!("no clipboard command worked")
}

#[cfg(target_os = "macos")]
fn clipboard_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("pbcopy", &[])]
}

#[cfg(target_os = "windows")]
fn clipboard_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("clip", &[])]
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn clipboard_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ]
}
