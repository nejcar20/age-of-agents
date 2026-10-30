//! Shared plumbing for running external tools: a bounded child-process runner
//! and executable lookup that works when the app is launched from Finder.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

/// Pipe readers retain at most limit + 1 bytes. The child is always reaped
/// here, on every exit path including a timeout or a read error. Waiting for pipe completion shares the same
/// deadline, so an inherited pipe can never extend the command's time budget.
pub fn run_bounded(
    mut command: Command,
    limit: usize,
    deadline: Instant,
    tool: &str,
) -> Result<BoundedOutput, String> {
    if Instant::now() >= deadline {
        return Err(format!("{tool} inspection timed out"));
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {tool}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{tool} stdout unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{tool} stderr unavailable"))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit as u64 + 1).read_to_end(&mut bytes);
        let _ = stdout_sender.send((true, result.map(|_| bytes)));
    });
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr.take(16 * 1024 + 1).read_to_end(&mut bytes);
        let _ = sender.send((false, result.map(|_| bytes)));
    });
    let mut out = None;
    let mut err = None;
    let mut status = None;
    loop {
        while let Ok((is_stdout, result)) = receiver.try_recv() {
            let bytes = match result {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Could not read {tool} output: {error}"));
                }
            };
            if is_stdout {
                out = Some(bytes);
            } else {
                err = Some(bytes);
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(result) => status = result,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Could not wait for {tool}: {error}"));
                }
            }
        }
        if status.is_some() && out.is_some() && err.is_some() {
            let mut stdout = out.unwrap();
            let truncated = stdout.len() > limit;
            stdout.truncate(limit);
            return Ok(BoundedOutput {
                status: status.unwrap(),
                stdout,
                stderr: err.unwrap(),
                truncated,
            });
        }
        // A reader stops at its cap and closes the pipe; kill promptly instead
        // of spending the remaining budget producing output we cannot display.
        let capped = out.as_ref().is_some_and(|bytes| bytes.len() > limit)
            || err.as_ref().is_some_and(|bytes| bytes.len() > 16 * 1024);
        if capped && status.is_none() {
            let _ = child.kill();
            status = child.wait().ok();
        }
        if Instant::now() >= deadline {
            if status.is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(format!("{tool} inspection timed out"));
        }
        thread::sleep(Duration::from_millis(5));
    }
}

pub fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// The first `name` on PATH, then in the places installers put it. The
/// fallbacks matter more than they look: an app opened from Finder inherits
/// a minimal PATH with no Homebrew directories, so `brew install herdr` —
/// the documented install — was never found outside a terminal launch. The
/// same holds for any tool this app shells out to.
pub fn find_executable(
    name: &str,
    path: Option<&OsStr>,
    home: &Path,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|directory| directory.is_absolute());
    let fallbacks = [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    on_path
        .chain(fallbacks)
        .map(|directory| directory.join(name))
        .find(|candidate| is_executable(candidate))
}

/// `find_executable` against the real PATH and home directory.
pub fn resolve_executable(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    find_executable(
        name,
        std::env::var_os("PATH").as_deref(),
        &home,
        &executable_file,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_executable_on_path_first_then_where_installers_put_it() {
        let home = Path::new("/Users/you");
        let at = |found: &'static [&'static str]| move |p: &Path| found.iter().any(|f| p == Path::new(f));
        let path = std::ffi::OsString::from("/usr/bin:relative/bin:/custom/bin");
        assert_eq!(
            find_executable("herdr", Some(&path), home, &at(&["/custom/bin/herdr", "/opt/homebrew/bin/herdr"])),
            Some(PathBuf::from("/custom/bin/herdr")),
        );
        // A Finder launch: PATH has no Homebrew, but brew installed it there.
        let finder = std::ffi::OsString::from("/usr/bin:/bin:/usr/sbin:/sbin");
        assert_eq!(
            find_executable("herdr", Some(&finder), home, &at(&["/opt/homebrew/bin/herdr"])),
            Some(PathBuf::from("/opt/homebrew/bin/herdr")),
        );
        assert_eq!(
            find_executable("herdr", None, home, &at(&["/Users/you/.local/bin/herdr", "/usr/local/bin/herdr"])),
            Some(PathBuf::from("/Users/you/.local/bin/herdr")),
        );
        // Relative PATH entries are never trusted.
        assert_eq!(find_executable("herdr", Some(&path), home, &at(&["relative/bin/herdr"])), None);
        assert_eq!(find_executable("herdr", Some(&finder), home, &at(&[])), None);
    }

    #[test]
    fn find_executable_finds_named_binary_in_homebrew_fallback() {
        let home = Path::new("/Users/you");
        let is_executable = |p: &Path| p == Path::new("/opt/homebrew/bin/osv-scanner");
        assert_eq!(
            find_executable("osv-scanner", None, home, &is_executable),
            Some(PathBuf::from("/opt/homebrew/bin/osv-scanner")),
        );
    }

    #[test]
    fn command_deadline_bounds_a_slow_process() {
        let mut command = Command::new("sleep");
        command.arg("2");
        let start = Instant::now();
        let result = run_bounded(command, 64, start + Duration::from_millis(30), "Git");
        assert_eq!(result.err().unwrap(), "Git inspection timed out");
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
