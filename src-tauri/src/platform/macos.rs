use anyhow::{anyhow, Result};
use std::process::Command;

/// Terminal applications we know how to detect, in priority order.
///
/// Each entry is `(process name, "open -a" app name)`. The process name is
/// matched against the *basename* of a `ps -eo comm` line (those lines are
/// full executable paths, e.g.
/// `/Applications/iTerm.app/Contents/MacOS/iTerm2`), which is why iTerm's
/// entry looks mismatched at a glance: the running process is named
/// `iTerm2`, but the application bundle `open -a` must raise is `iTerm`.
const KNOWN_TERMINALS: &[(&str, &str)] = &[
    ("iTerm2", "iTerm"),
    ("Ghostty", "Ghostty"),
    ("Alacritty", "Alacritty"),
    ("kitty", "kitty"),
    ("WezTerm", "WezTerm"),
    ("Warp", "Warp"),
    ("Hyper", "Hyper"),
    ("Terminal", "Terminal"),
];

/// Pure matching logic over the text of `ps -eo comm` output (one process
/// command per line). Returns the `open -a` app name of the first known
/// terminal app found running, or `None` if none matched.
///
/// Kept separate from actually invoking `ps` so it can be unit-tested
/// against captured sample output, rather than depending on whatever
/// happens to be running on the machine executing the test.
pub fn match_running_terminal(ps_output: &str) -> Option<&'static str> {
    KNOWN_TERMINALS.iter().find_map(|(process_name, app_name)| {
        let running = ps_output
            .lines()
            .any(|line| line.rsplit('/').next().unwrap_or(line).trim() == *process_name);
        running.then_some(*app_name)
    })
}

/// Detects which known terminal application is actually running (the one
/// hosting herdr) and returns the name `open -a` should raise. Falls back
/// to `"Terminal"` when `ps` cannot be run or no known terminal process is
/// found — a reasonable default even though it may not exist on this
/// machine, since `activate_terminal`'s failure is already non-fatal at
/// the call site.
///
/// Task 12 hook: this is the ONLY place Phase-0 terminal detection lives.
/// Task 12's config override should read a configured `terminal_app`
/// first and only fall back to this function when none is set, e.g.:
/// `config.terminal_app.clone().unwrap_or_else(platform::detect_terminal_app)`
/// at the call site in `commands::jump_to_next`.
pub fn detect_terminal_app() -> String {
    match Command::new("ps").arg("-eo").arg("comm").output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            match_running_terminal(&text).unwrap_or("Terminal").to_string()
        }
        _ => "Terminal".to_string(),
    }
}

/// Raise the terminal application that hosts herdr.
pub fn activate_terminal(app_name: &str) -> Result<()> {
    let status = Command::new("open").arg("-a").arg(app_name).status()?;
    if status.success() { Ok(()) } else { Err(anyhow!("could not activate {app_name}")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_iterm_process_name_to_its_open_app_name() {
        let sample = "COMM\n/usr/libexec/something\n\
                       /Applications/iTerm.app/Contents/MacOS/iTerm2\nbash\n";
        assert_eq!(match_running_terminal(sample), Some("iTerm"));
    }

    #[test]
    fn matches_every_known_terminal_by_basename() {
        for (process_name, app_name) in KNOWN_TERMINALS {
            let sample = format!("bash\n/Applications/Foo.app/Contents/MacOS/{process_name}\n");
            assert_eq!(match_running_terminal(&sample), Some(*app_name), "for {process_name}");
        }
    }

    #[test]
    fn ignores_processes_that_merely_contain_a_terminal_name_as_a_substring() {
        // Matching must be on the exact basename, not a substring — e.g. a
        // helper process like "iTerm2Helper" must not be mistaken for the
        // real app.
        let sample = "bash\n/Applications/iTerm.app/Contents/Frameworks/iTerm2Helper\n";
        assert_eq!(match_running_terminal(sample), None);
    }

    #[test]
    fn returns_none_when_nothing_known_is_running() {
        let sample = "bash\nFinder\nDock\nlaunchd\n";
        assert_eq!(match_running_terminal(sample), None);
    }

    #[test]
    fn first_match_in_priority_order_wins_when_several_are_running() {
        let sample = "/Applications/Warp.app/Contents/MacOS/Warp\n\
                       /Applications/iTerm.app/Contents/MacOS/iTerm2\n";
        // iTerm2 is listed before Warp in KNOWN_TERMINALS.
        assert_eq!(match_running_terminal(sample), Some("iTerm"));
    }
}
