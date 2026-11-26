pub enum Command {
    Deploy {
        paths: Vec<String>,
        name: Option<String>,
        encrypt: bool,
        spa: bool,
        no_copy: bool,
    },
    Ls,
    Point {
        name: String,
        id: String,
    },
    Rm {
        target: String,
    },
    Key {
        key: Option<String>,
    },
}

const ROOT_HELP: &str = "Static sites, live in one command

Usage: site [OPTIONS] [PATHS]...
       site <COMMAND>

Commands:
  ls     List your names and deploys
  point  Point a name at one of your deploys
  rm     Delete a deploy or release a name
  key    Print your key, or save a key from another machine
  help   Print this message or the help of the given subcommand(s)

Arguments:
  [PATHS]...  A folder, files, or - for stdin

Options:
  -n, --name <NAME>  Point this name at the deploy, like todo for todo.site.stoff.dev
  -e, --encrypt      Encrypt the site on this machine; only the printed link, with its key after #, opens it
      --spa          Serve index.html for unknown paths without a file extension
      --no-copy      Leave the clipboard unchanged after deploying
  -h, --help         Print help
  -V, --version      Print version

Examples:
  site dist                      Deploy a folder and print its URL
  site dist -n todo              Also point todo.site.stoff.dev at it
  site dist -e                   Encrypt it; only the full link opens it
  site index.html style.css      Deploy loose files at the root
  cat page.html | site -         Deploy stdin as index.html
  site dist --spa                Serve index.html for client-side routes
  site ls                        List your names and deploys
  site point todo k3m9xq2a       Point a name at an earlier deploy
  site rm k3m9xq2a               Delete a deploy (or release a name)
  site key                       Print your key, to use on another machine

Set SITE_KEY to use a key without saving it, and SITE_URL to use another server.";

const ROOT_USAGE: &str = "site [OPTIONS] [PATHS]...\n       site <COMMAND>";
const MORE_INFORMATION: &str = "For more information, try '--help'.";
const SUGGESTION_THRESHOLD: f64 = 0.7;

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Value,
    Flag,
    Help,
    Version,
}

struct Flag {
    long: &'static str,
    short: Option<char>,
    action: Action,
    shown: &'static str,
    grouped: bool,
}

struct Positional {
    name: &'static str,
    required: bool,
    many: bool,
}

struct Spec {
    bin: &'static str,
    usage: &'static str,
    flags: &'static [Flag],
    positionals: &'static [Positional],
    grouped: bool,
}

const HELP_FLAG: Flag = Flag {
    long: "help",
    short: Some('h'),
    action: Action::Help,
    shown: "--help",
    grouped: false,
};

const ROOT: Spec = Spec {
    bin: "site",
    usage: ROOT_USAGE,
    flags: &[
        Flag {
            long: "name",
            short: Some('n'),
            action: Action::Value,
            shown: "--name <NAME>",
            grouped: true,
        },
        Flag {
            long: "encrypt",
            short: Some('e'),
            action: Action::Flag,
            shown: "--encrypt",
            grouped: true,
        },
        Flag {
            long: "spa",
            short: None,
            action: Action::Flag,
            shown: "--spa",
            grouped: true,
        },
        Flag {
            long: "no-copy",
            short: None,
            action: Action::Flag,
            shown: "--no-copy",
            grouped: true,
        },
        HELP_FLAG,
        Flag {
            long: "version",
            short: Some('V'),
            action: Action::Version,
            shown: "--version",
            grouped: false,
        },
    ],
    positionals: &[Positional {
        name: "PATHS",
        required: false,
        many: true,
    }],
    grouped: true,
};

struct Subcommand {
    name: &'static str,
    about: &'static str,
    arguments: &'static str,
    spec: Spec,
}

const SUBCOMMANDS: [Subcommand; 4] = [
    Subcommand {
        name: "ls",
        about: "List your names and deploys",
        arguments: "",
        spec: Spec {
            bin: "site ls",
            usage: "site ls",
            flags: &[HELP_FLAG],
            positionals: &[],
            grouped: false,
        },
    },
    Subcommand {
        name: "point",
        about: "Point a name at one of your deploys",
        arguments: "  <NAME>  Name, like todo\n  <ID>    Deploy id, like k3m9xq2a",
        spec: Spec {
            bin: "site point",
            usage: "site point <NAME> <ID>",
            flags: &[HELP_FLAG],
            positionals: &[
                Positional {
                    name: "NAME",
                    required: true,
                    many: false,
                },
                Positional {
                    name: "ID",
                    required: true,
                    many: false,
                },
            ],
            grouped: true,
        },
    },
    Subcommand {
        name: "rm",
        about: "Delete a deploy or release a name",
        arguments: "  <TARGET>  Deploy id or name",
        spec: Spec {
            bin: "site rm",
            usage: "site rm <TARGET>",
            flags: &[HELP_FLAG],
            positionals: &[Positional {
                name: "TARGET",
                required: true,
                many: false,
            }],
            grouped: true,
        },
    },
    Subcommand {
        name: "key",
        about: "Print your key, or save a key from another machine",
        arguments: "  [KEY]  A key printed by site key on another machine",
        spec: Spec {
            bin: "site key",
            usage: "site key [KEY]",
            flags: &[HELP_FLAG],
            positionals: &[Positional {
                name: "KEY",
                required: false,
                many: false,
            }],
            grouped: true,
        },
    },
];

const HELP_ABOUT: &str = "Print this message or the help of the given subcommand(s)";
const HELP_USAGE: &str = "site help [COMMAND]...";

#[derive(Clone, Copy, PartialEq)]
enum Id {
    Flag(usize),
    Positional(usize),
}

enum Stop {
    Print(String),
    Fail(String),
}

pub fn parse() -> Command {
    let mut arguments = Vec::new();
    let mut invalid = Vec::new();
    for argument in std::env::args_os().skip(1) {
        invalid.push(argument.to_str().is_none());
        arguments.push(argument.to_string_lossy().into_owned());
    }
    match parse_arguments(&arguments, &invalid) {
        Ok(command) => command,
        Err(Stop::Print(text)) => {
            println!("{text}");
            std::process::exit(0);
        }
        Err(Stop::Fail(text)) => {
            eprint!("{text}");
            std::process::exit(2);
        }
    }
}

fn parse_arguments(arguments: &[String], invalid: &[bool]) -> Result<Command, Stop> {
    let mut parser = Parser::new(&ROOT);
    let mut position = 0;
    while position < arguments.len() {
        let argument = &arguments[position];
        let argument_invalid = invalid[position];
        position += 1;
        if parser.may_start_subcommand() && !argument_invalid {
            if argument == "help" {
                return Err(help_subcommand(&arguments[position..]));
            }
            if let Some(subcommand) = SUBCOMMANDS.iter().find(|known| known.name == argument) {
                return parse_subcommand(subcommand, &arguments[position..], &invalid[position..]);
            }
        }
        parser.take(argument, argument_invalid)?;
    }
    parser.finish()?;
    let mut paths = Vec::new();
    if let Some(values) = parser.positional_values.first() {
        paths = values.clone();
    }
    Ok(Command::Deploy {
        paths,
        name: parser.flag_value(0),
        encrypt: parser.is_set(1),
        spa: parser.is_set(2),
        no_copy: parser.is_set(3),
    })
}

fn parse_subcommand(
    subcommand: &'static Subcommand,
    arguments: &[String],
    invalid: &[bool],
) -> Result<Command, Stop> {
    let mut parser = Parser::new(&subcommand.spec);
    parser.help_text = help_for(subcommand);
    for (argument, argument_invalid) in arguments.iter().zip(invalid) {
        parser.take(argument, *argument_invalid)?;
    }
    parser.finish()?;
    let mut values = parser
        .positional_values
        .iter()
        .map(|values| values.first().cloned());
    let first = values.next().flatten();
    let second = values.next().flatten();
    let command = match subcommand.name {
        "ls" => Command::Ls,
        "point" => Command::Point {
            name: first.unwrap_or_default(),
            id: second.unwrap_or_default(),
        },
        "rm" => Command::Rm {
            target: first.unwrap_or_default(),
        },
        _ => Command::Key { key: first },
    };
    Ok(command)
}

fn help_subcommand(topics: &[String]) -> Stop {
    let mut current: Option<&Subcommand> = None;
    let mut in_help = false;
    for topic in topics {
        let found = match (current, in_help) {
            (None, false) => {
                if topic == "help" {
                    in_help = true;
                    continue;
                }
                SUBCOMMANDS.iter().find(|known| known.name == topic)
            }
            _ => None,
        };
        match found {
            Some(subcommand) => current = Some(subcommand),
            None => {
                let usage = match (current, in_help) {
                    (Some(subcommand), _) => subcommand.spec.usage,
                    (None, true) => HELP_USAGE,
                    (None, false) => ROOT_USAGE,
                };
                let mut text =
                    format!("error: unrecognized subcommand '{topic}'\n\nUsage: {usage}\n");
                if !in_help {
                    text.push_str(&format!("\n{MORE_INFORMATION}\n"));
                }
                return Stop::Fail(text);
            }
        }
    }
    match (current, in_help) {
        (Some(subcommand), _) => Stop::Print(help_for(subcommand)),
        (None, true) => Stop::Print(format!(
            "{HELP_ABOUT}\n\nUsage: {HELP_USAGE}\n\nArguments:\n  [COMMAND]...  Print help for the subcommand(s)"
        )),
        (None, false) => Stop::Print(ROOT_HELP.to_string()),
    }
}

fn help_for(subcommand: &Subcommand) -> String {
    let mut text = format!(
        "{}\n\nUsage: {}\n\n",
        subcommand.about, subcommand.spec.usage
    );
    if !subcommand.arguments.is_empty() {
        text.push_str(&format!("Arguments:\n{}\n\n", subcommand.arguments));
    }
    text.push_str("Options:\n  -h, --help  Print help");
    text
}

enum State {
    Done,
    AwaitingValue,
    Positional,
}

struct Pending {
    id: Id,
    values: Vec<String>,
}

struct Parser {
    spec: &'static Spec,
    help_text: String,
    matched: Vec<Id>,
    group_started: bool,
    pending: Option<Pending>,
    state: State,
    trailing: bool,
    argument_invalid: bool,
    valid_argument_found: bool,
    next_positional: usize,
    flag_values: Vec<Option<String>>,
    positional_values: Vec<Vec<String>>,
}

impl Parser {
    fn new(spec: &'static Spec) -> Parser {
        Parser {
            spec,
            help_text: ROOT_HELP.to_string(),
            matched: Vec::new(),
            group_started: false,
            pending: None,
            state: State::Done,
            trailing: false,
            argument_invalid: false,
            valid_argument_found: false,
            next_positional: 0,
            flag_values: vec![None; spec.flags.len()],
            positional_values: vec![Vec::new(); spec.positionals.len()],
        }
    }

    fn may_start_subcommand(&self) -> bool {
        !self.trailing && !self.valid_argument_found && matches!(self.state, State::Done)
    }

    fn is_set(&self, flag: usize) -> bool {
        self.matched.contains(&Id::Flag(flag))
    }

    fn flag_value(&self, flag: usize) -> Option<String> {
        self.flag_values[flag].clone()
    }

    fn take(&mut self, argument: &str, argument_invalid: bool) -> Result<(), Stop> {
        self.argument_invalid = argument_invalid;
        if !self.trailing {
            if argument == "--" {
                self.trailing = true;
                return Ok(());
            }
            if let Some(long) = argument.strip_prefix("--") {
                return self.take_long(long);
            }
            if argument.len() > 1
                && let Some(shorts) = argument.strip_prefix('-')
            {
                return self.take_shorts(shorts);
            }
            if matches!(self.state, State::AwaitingValue) {
                if let Some(pending) = &mut self.pending {
                    pending.values.push(argument.to_string());
                }
                self.state = State::Done;
                if self.argument_invalid {
                    self.resolve_pending()?;
                    return Err(self.invalid_utf8());
                }
                return Ok(());
            }
        }
        self.take_positional(argument)
    }

    fn take_long(&mut self, long: &str) -> Result<(), Stop> {
        let (name, attached) = match long.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (long, None),
        };
        let Some(flag) = self.spec.flags.iter().position(|known| known.long == name) else {
            let _ = self.resolve_pending();
            return Err(self.unknown_long(name));
        };
        self.valid_argument_found = true;
        let action = self.spec.flags[flag].action;
        if action == Action::Value {
            return self.take_value(flag, attached);
        }
        if let Some(value) = attached {
            return Err(self.unneeded_value(flag, value));
        }
        self.react(Id::Flag(flag), Vec::new())?;
        self.state = State::Done;
        Ok(())
    }

    fn take_shorts(&mut self, shorts: &str) -> Result<(), Stop> {
        let characters: Vec<char> = shorts.chars().collect();
        for (index, character) in characters.iter().enumerate() {
            let found = self
                .spec
                .flags
                .iter()
                .position(|known| known.short == Some(*character));
            let Some(flag) = found else {
                let _ = self.resolve_pending();
                return Err(self.unknown_short(&format!("-{character}")));
            };
            self.valid_argument_found = true;
            if self.spec.flags[flag].action != Action::Value {
                self.react(Id::Flag(flag), Vec::new())?;
                self.state = State::Done;
                continue;
            }
            let rest: String = characters[index + 1..].iter().collect();
            let mut attached = None;
            if !rest.is_empty() {
                attached = Some(rest.strip_prefix('=').unwrap_or(&rest).to_string());
            }
            return self.take_value(flag, attached.as_deref());
        }
        Ok(())
    }

    fn take_value(&mut self, flag: usize, attached: Option<&str>) -> Result<(), Stop> {
        if let Some(value) = attached {
            self.react(Id::Flag(flag), vec![value.to_string()])?;
            if self.argument_invalid {
                return Err(self.invalid_utf8());
            }
            self.state = State::Done;
            return Ok(());
        }
        self.resolve_pending()?;
        self.pending = Some(Pending {
            id: Id::Flag(flag),
            values: Vec::new(),
        });
        self.state = State::AwaitingValue;
        Ok(())
    }

    fn take_positional(&mut self, argument: &str) -> Result<(), Stop> {
        let Some(positional) = self.spec.positionals.get(self.next_positional) else {
            let _ = self.resolve_pending();
            return Err(self.overflow(argument));
        };
        if self.argument_invalid {
            return Err(self.invalid_utf8());
        }
        let id = Id::Positional(self.next_positional);
        let continuing = matches!(&self.pending, Some(pending) if pending.id == id);
        if !continuing {
            self.resolve_pending()?;
            self.pending = Some(Pending {
                id,
                values: Vec::new(),
            });
        }
        if let Some(pending) = &mut self.pending {
            pending.values.push(argument.to_string());
        }
        if positional.many {
            self.state = State::Positional;
        } else {
            self.next_positional += 1;
            self.state = State::Done;
        }
        self.valid_argument_found = true;
        Ok(())
    }

    fn finish(&mut self) -> Result<(), Stop> {
        self.resolve_pending()?;
        let missing: Vec<&str> = self
            .spec
            .positionals
            .iter()
            .enumerate()
            .filter(|(index, positional)| {
                positional.required && !self.matched.contains(&Id::Positional(*index))
            })
            .map(|(_, positional)| positional.name)
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        let listed: Vec<String> = missing.iter().map(|name| format!("  <{name}>")).collect();
        Err(self.failure(
            &format!(
                "the following required arguments were not provided:\n{}",
                listed.join("\n")
            ),
            &self.usage(&self.matched_arguments()),
        ))
    }

    fn resolve_pending(&mut self) -> Result<(), Stop> {
        let Some(pending) = self.pending.take() else {
            return Ok(());
        };
        self.react(pending.id, pending.values)
    }

    fn react(&mut self, id: Id, values: Vec<String>) -> Result<(), Stop> {
        self.resolve_pending()?;
        let Id::Flag(flag) = id else {
            let Id::Positional(index) = id else {
                return Ok(());
            };
            self.positional_values[index].extend(values);
            self.start(id);
            return Ok(());
        };
        let definition = &self.spec.flags[flag];
        match definition.action {
            Action::Help => return Err(Stop::Print(self.help_text.clone())),
            Action::Version => {
                return Err(Stop::Print(
                    concat!("site ", env!("CARGO_PKG_VERSION")).to_string(),
                ));
            }
            Action::Value if values.is_empty() => {
                return Err(Stop::Fail(format!(
                    "error: a value is required for '{}' but none was supplied\n\n{MORE_INFORMATION}\n",
                    definition.shown
                )));
            }
            Action::Value | Action::Flag => {}
        }
        if let Some(existing) = self.matched.iter().position(|matched| *matched == id) {
            self.matched.remove(existing);
            return Err(self.failure(
                &format!(
                    "the argument '{}' cannot be used multiple times",
                    definition.shown
                ),
                &self.usage(&[]),
            ));
        }
        self.flag_values[flag] = values.into_iter().next();
        self.start(id);
        Ok(())
    }

    fn start(&mut self, id: Id) {
        if !self.matched.contains(&id) {
            self.matched.push(id);
        }
        if self.spec.grouped && self.is_grouped(id) {
            self.group_started = true;
        }
    }

    fn is_grouped(&self, id: Id) -> bool {
        match id {
            Id::Flag(flag) => self.spec.flags[flag].grouped,
            Id::Positional(_) => true,
        }
    }

    fn matched_arguments(&self) -> Vec<Id> {
        self.matched.clone()
    }

    fn unknown_long(&mut self, name: &str) -> Stop {
        let suggestion = self.suggest(name);
        let argument = format!("--{name}");
        let mut text = format!("unexpected argument '{argument}' found\n\n");
        if let Some(flag) = suggestion {
            text.push_str(&format!(
                "  tip: a similar argument exists: '--{}'\n\n",
                self.spec.flags[flag].long
            ));
            self.start(Id::Flag(flag));
        } else if !self.trailing && !self.spec.positionals.is_empty() {
            text.push_str(&trailing_tip(&argument));
        }
        let usage = self.usage(&self.matched_arguments());
        self.failure_with_tips(&text, &usage)
    }

    fn unknown_short(&self, argument: &str) -> Stop {
        let mut text = format!("unexpected argument '{argument}' found\n\n");
        if !self.trailing && !self.spec.positionals.is_empty() {
            text.push_str(&trailing_tip(argument));
        }
        self.failure_with_tips(&text, &self.usage(&[]))
    }

    fn overflow(&self, argument: &str) -> Stop {
        let text = format!("unexpected argument '{argument}' found\n\n");
        self.failure_with_tips(&text, &self.usage(&[]))
    }

    fn unneeded_value(&self, flag: usize, value: &str) -> Stop {
        let mut used = self.matched_arguments();
        used.push(Id::Flag(flag));
        let usage = self.attached_value_usage(&used);
        self.failure(
            &format!(
                "unexpected value '{value}' for '{}' found; no more were expected",
                self.spec.flags[flag].shown
            ),
            &usage,
        )
    }

    fn suggest(&self, name: &str) -> Option<usize> {
        let mut best: Option<(f64, usize)> = None;
        for (index, flag) in self.spec.flags.iter().enumerate() {
            let confidence = jaro(name, flag.long);
            if confidence <= SUGGESTION_THRESHOLD {
                continue;
            }
            let better = match best {
                Some((highest, _)) => confidence >= highest,
                None => true,
            };
            if better {
                best = Some((confidence, index));
            }
        }
        best.map(|(_, index)| index)
    }

    fn usage(&self, used: &[Id]) -> String {
        if used.is_empty() {
            return self.spec.usage.to_string();
        }
        let mut parts = vec![self.spec.bin.to_string()];
        for id in used {
            if let Id::Flag(flag) = id {
                parts.push(self.spec.flags[*flag].shown.to_string());
            }
        }
        parts.extend(self.positional_usage(used, false));
        parts.join(" ")
    }

    fn attached_value_usage(&self, used: &[Id]) -> String {
        let grouped = self.group_started;
        let mut parts = vec![self.spec.bin.to_string()];
        let mut shown_flags: Vec<usize> = Vec::new();
        for id in used {
            let Id::Flag(flag) = id else {
                continue;
            };
            let hidden_by_group = grouped && self.spec.flags[*flag].grouped;
            if hidden_by_group || shown_flags.contains(flag) {
                continue;
            }
            shown_flags.push(*flag);
            parts.push(self.spec.flags[*flag].shown.to_string());
        }
        if grouped {
            parts.push(self.group_usage());
        }
        parts.extend(self.positional_usage(used, grouped));
        parts.join(" ")
    }

    fn group_usage(&self) -> String {
        let mut members: Vec<&str> = self
            .spec
            .positionals
            .iter()
            .map(|positional| positional.name)
            .collect();
        members.extend(
            self.spec
                .flags
                .iter()
                .filter(|flag| flag.grouped)
                .map(|flag| flag.shown),
        );
        format!("<{}>", members.join("|"))
    }

    fn positional_usage(&self, used: &[Id], grouped: bool) -> Vec<String> {
        if grouped {
            return Vec::new();
        }
        let mut parts = Vec::new();
        for (index, positional) in self.spec.positionals.iter().enumerate() {
            let mut shown = format!("[{}]", positional.name);
            if positional.required || used.contains(&Id::Positional(index)) {
                shown = format!("<{}>", positional.name);
            }
            if positional.many {
                shown.push_str("...");
            }
            parts.push(shown);
        }
        parts
    }

    fn invalid_utf8(&self) -> Stop {
        self.failure(
            "invalid UTF-8 was detected in one or more arguments",
            self.spec.usage,
        )
    }

    fn failure(&self, message: &str, usage: &str) -> Stop {
        Stop::Fail(format!(
            "error: {message}\n\nUsage: {usage}\n\n{MORE_INFORMATION}\n"
        ))
    }

    fn failure_with_tips(&self, text: &str, usage: &str) -> Stop {
        Stop::Fail(format!(
            "error: {text}Usage: {usage}\n\n{MORE_INFORMATION}\n"
        ))
    }
}

fn trailing_tip(argument: &str) -> String {
    format!("  tip: to pass '{argument}' as a value, use '-- {argument}'\n\n")
}

fn jaro(left: &str, right: &str) -> f64 {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let search_range = (left.len().max(right.len()) / 2).saturating_sub(1);
    let mut left_matched = vec![false; left.len()];
    let mut right_matched = vec![false; right.len()];
    let mut matches = 0usize;
    for (index, character) in left.iter().enumerate() {
        let start = index.saturating_sub(search_range);
        let end = right.len().min(index + search_range + 1);
        for candidate in start..end {
            if !right_matched[candidate] && right[candidate] == *character {
                left_matched[index] = true;
                right_matched[candidate] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let left_in_order = left
        .iter()
        .zip(&left_matched)
        .filter(|(_, matched)| **matched)
        .map(|(character, _)| character);
    let right_in_order = right
        .iter()
        .zip(&right_matched)
        .filter(|(_, matched)| **matched)
        .map(|(character, _)| character);
    let transpositions = left_in_order
        .zip(right_in_order)
        .filter(|(left_character, right_character)| left_character != right_character)
        .count()
        / 2;
    let matches = matches as f64;
    (matches / left.len() as f64
        + matches / right.len() as f64
        + (matches - transpositions as f64) / matches)
        / 3.0
}
