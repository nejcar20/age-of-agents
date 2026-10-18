//! Bounded, read-only repository inspection for the town work panel.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_DIFF_BYTES: usize = 256 * 1024;
const MAX_STATUS_BYTES: usize = 1024 * 1024;
const MAX_CHANGE_ENTRIES: usize = 2000;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    Typechanged,
}

#[derive(Debug, Serialize)]
pub struct ChangeEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: ChangeStatus,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Serialize)]
pub struct RepoChanges {
    pub root: String,
    pub branch: Option<String>,
    pub entries: Vec<ChangeEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Text,
    Binary,
    Directory,
    Missing,
}

#[derive(Debug, Serialize)]
pub struct FileInspection {
    pub path: String,
    pub kind: FileKind,
    pub content: Option<String>,
    pub truncated: bool,
    pub staged_diff: String,
    pub unstaged_diff: String,
    pub diff_truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct TextSearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectTextSearch {
    pub root: String,
    pub query: String,
    pub matches: Vec<TextSearchMatch>,
    pub truncated: bool,
    pub files_searched: usize,
    pub files_skipped: usize,
}

struct SearchLimits {
    files: usize,
    file_bytes: usize,
    total_bytes: usize,
    matches: usize,
    candidate_bytes: usize,
    snippet_chars: usize,
    timeout: Duration,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            files: 10_000,
            file_bytes: 2 * 1024 * 1024,
            total_bytes: 32 * 1024 * 1024,
            matches: 250,
            candidate_bytes: 1024 * 1024,
            snippet_chars: 2000,
            timeout: Duration::from_secs(5),
        }
    }
}

fn read_project_search(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    limits: SearchLimits,
) -> Result<ProjectTextSearch, String> {
    if query.is_empty() || query.chars().count() > 500 || query.contains(['\n', '\r', '\0']) {
        return Err(
            "Search query must contain 1–500 characters on a single line without NUL bytes".into(),
        );
    }
    Repository::open_with_deadline(root, Instant::now() + limits.timeout)?.search_text(
        query,
        case_sensitive,
        limits,
    )
}

#[tauri::command]
pub async fn search_project_text(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<ProjectTextSearch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_project_search(
            Path::new(&root),
            &query,
            case_sensitive,
            SearchLimits::default(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn repo_changes(root: String) -> Result<RepoChanges, String> {
    tauri::async_runtime::spawn_blocking(move || read_repo_changes(Path::new(&root)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn inspect_project_path(root: String, path: String) -> Result<FileInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_project_path(Path::new(&root), Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

/// Pipe readers retain at most limit + 1 bytes. The caller owns and reaps the
/// child, including on timeout. Waiting for pipe completion shares the same
/// deadline, so an inherited pipe can never extend the command's time budget.
fn run_bounded(
    mut command: Command,
    limit: usize,
    deadline: Instant,
) -> Result<BoundedOutput, String> {
    if Instant::now() >= deadline {
        return Err("Git inspection timed out".into());
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start Git: {error}"))?;
    let stdout = child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr unavailable")?;
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
                    return Err(format!("Could not read Git output: {error}"));
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
                    return Err(format!("Could not wait for Git: {error}"));
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
            return Err("Git inspection timed out".into());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

struct Repository {
    root: PathBuf,
    directory: Arc<File>,
    deadline: Instant,
    disabled_filters: Vec<String>,
}

impl Repository {
    fn search_text(
        mut self,
        query: &str,
        case_sensitive: bool,
        limits: SearchLimits,
    ) -> Result<ProjectTextSearch, String> {
        self.deadline = self.deadline.min(Instant::now() + limits.timeout);
        // Git supplies both tracked and nonignored untracked paths without
        // touching file contents, running filters, or traversing submodules.
        let output = self.git(
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            limits.candidate_bytes,
        )?;
        let mut result = ProjectTextSearch {
            root: self.root.to_string_lossy().into_owned(),
            query: query.to_string(),
            matches: Vec::new(),
            truncated: output.truncated,
            files_searched: 0,
            files_skipped: 0,
        };
        let mut paths = BTreeSet::new();
        for record in output.stdout.split_inclusive(|byte| *byte == 0) {
            if record.last() != Some(&0) {
                // A capped filename is never usable; the number of paths past
                // this output bound is unknown and is not invented in counts.
                result.truncated = true;
                break;
            }
            match status_path(&record[..record.len() - 1]) {
                Ok(path) => {
                    paths.insert(path);
                }
                Err(_) => result.files_skipped += 1,
            }
        }
        let needle = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };
        let path_count = paths.len();
        let mut bytes_read = 0;
        for (index, path) in paths.into_iter().enumerate() {
            if index >= limits.files
                || bytes_read >= limits.total_bytes
                || Instant::now() >= self.deadline
            {
                result.truncated = true;
                result.files_skipped += path_count - index;
                break;
            }
            // Every path component is opened relative to the retained root
            // descriptor; symlinks and special files are never followed.
            let file = match open_preview_path(&self.directory, Path::new(&path)) {
                Ok(Some(file)) => file,
                _ => {
                    result.files_skipped += 1;
                    continue;
                }
            };
            let metadata = match file.metadata() {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => {
                    result.files_skipped += 1;
                    continue;
                }
            };
            let available = limits.total_bytes.saturating_sub(bytes_read);
            let read_limit = limits.file_bytes.min(available);
            if metadata.len() > read_limit as u64 {
                result.files_skipped += 1;
                result.truncated = true;
                continue;
            }
            let mut bytes = Vec::new();
            // The extra byte detects a file growing after fstat. Retained and
            // searched text obeys both budgets; at most one probe byte can
            // exceed the total read budget before all further reads stop.
            let read = file.take(read_limit as u64 + 1).read_to_end(&mut bytes);
            bytes_read += bytes.len();
            if read.is_err() || bytes.len() > read_limit {
                result.files_skipped += 1;
                result.truncated = true;
                continue;
            }
            let content = match std::str::from_utf8(&bytes) {
                Ok(content) if !bytes.contains(&0) => content,
                _ => {
                    result.files_skipped += 1;
                    continue;
                }
            };
            // Count text files searched, including one stopped partway by a
            // match or time limit. files_skipped counts known unopened or
            // excluded files, so the two counts never double-count a file.
            result.files_searched += 1;
            for (line_index, line) in content.lines().enumerate() {
                if Instant::now() >= self.deadline {
                    result.truncated = true;
                    result.files_skipped += path_count - index - 1;
                    return Ok(result);
                }
                let column = if case_sensitive {
                    line.find(&needle)
                        .map(|byte| line[..byte].chars().count() + 1)
                } else {
                    line.to_lowercase().find(&needle).map(|byte| {
                        // Lowercasing can expand a codepoint (İ -> i + dot),
                        // so folded byte offsets must be mapped to the original
                        // line before exposing a 1-based codepoint column.
                        let mut offset = 0;
                        for (column, character) in line.chars().enumerate() {
                            offset += character.to_lowercase().map(char::len_utf8).sum::<usize>();
                            if offset > byte {
                                return column + 1;
                            }
                        }
                        1
                    })
                };
                let Some(column) = column else {
                    continue;
                };
                // Look for one additional matching line so an exact fit is
                // complete, rather than reporting truncation at the cap alone.
                if result.matches.len() == limits.matches {
                    result.truncated = true;
                    result.files_skipped += path_count - index - 1;
                    return Ok(result);
                }
                let end = line
                    .char_indices()
                    .nth(limits.snippet_chars)
                    .map(|(byte, _)| byte);
                result.matches.push(TextSearchMatch {
                    path: path.clone(),
                    line: line_index + 1,
                    column,
                    text: line[..end.unwrap_or(line.len())].to_string(),
                    truncated: end.is_some(),
                });
            }
        }
        Ok(result)
    }

    fn open(root: &Path) -> Result<Self, String> {
        Self::open_with_deadline(root, Instant::now() + GIT_TIMEOUT)
    }

    fn open_with_deadline(root: &Path, deadline: Instant) -> Result<Self, String> {
        if Instant::now() >= deadline {
            return Err("Git inspection timed out".into());
        }
        let root = fs::canonicalize(root)
            .map_err(|error| format!("Cannot access project root: {error}"))?;
        if !root.is_dir() || contains_git_component(&root) {
            return Err("Project root must be a working-tree directory".into());
        }
        let directory = Arc::new(open_root_descriptor(&root)?);
        let mut repo = Self {
            root,
            directory,
            deadline,
            disabled_filters: Vec::new(),
        };
        let output = repo.git(&["rev-parse", "--show-toplevel"], 16 * 1024)?;
        if output.truncated {
            return Err("Git repository path exceeded the inspection limit".into());
        }
        let top =
            std::str::from_utf8(&output.stdout).map_err(|_| "Repository path is not UTF-8")?;
        let top = fs::canonicalize(top.trim_end_matches('\n'))
            .map_err(|error| format!("Cannot resolve Git root: {error}"))?;
        if top != repo.root {
            return Err("Selected project root must be the repository's working-tree root".into());
        }
        // Even builtin status/diff may run attribute clean/process filters.
        // Discover their names without exposing values, then disable them for
        // all subsequent commands so inspection cannot execute repository code.
        let configuration = repo.git(&["config", "--null", "--name-only", "--list"], 128 * 1024)?;
        if configuration.truncated {
            return Err("Git configuration exceeded the inspection limit".into());
        }
        for key in configuration
            .stdout
            .split(|byte| *byte == 0)
            .filter(|key| !key.is_empty())
        {
            let key = std::str::from_utf8(key).map_err(|_| "Git configuration key is not UTF-8")?;
            if key.starts_with("filter.") {
                if key.ends_with(".clean") || key.ends_with(".smudge") || key.ends_with(".process")
                {
                    repo.disabled_filters.push(format!("{key}="));
                } else if key.ends_with(".required") {
                    repo.disabled_filters.push(format!("{key}=false"));
                }
            }
        }
        Ok(repo)
    }

    fn command(&self) -> Command {
        let mut command = Command::new("git");
        // Do not inherit a shell's alternate index, repository, pathspec mode,
        // or injected Git configuration. The selected root defines the query.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;
            let directory = self.directory.clone();
            // The Arc keeps this descriptor alive until spawn. The child only
            // makes the async-signal-safe fchdir call between fork and exec;
            // no pathname is re-resolved after validating/opening the root.
            unsafe {
                command.pre_exec(move || {
                    if libc::fchdir(directory.as_raw_fd()) == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::last_os_error())
                    }
                });
            }
        }
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            // Missing partial-clone objects must fail locally. Even builtin
            // diff can otherwise fetch a blob and execute a remote helper.
            .env("GIT_NO_LAZY_FETCH", "1")
            // Older Git builds may ignore GIT_NO_LAZY_FETCH. An empty protocol
            // allowlist also blocks transport startup, overriding repository
            // protocol.<name>.allow configuration without contacting remotes.
            .env("GIT_ALLOW_PROTOCOL", "")
            .args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "status.renames=true",
            ]);
        for setting in &self.disabled_filters {
            command.args(["-c", setting]);
        }
        command
    }

    fn git(&self, args: &[&str], limit: usize) -> Result<BoundedOutput, String> {
        let mut command = self.command();
        command.args(args);
        let output = run_bounded(command, limit, self.deadline)?;
        if !output.status.success() && !output.truncated {
            return Err(format!(
                "Git inspection failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(output)
    }

    fn changes(&self) -> Result<RepoChanges, String> {
        let output = self.git(
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
                "--ignore-submodules=all",
            ],
            MAX_STATUS_BYTES,
        )?;
        parse_changes(&self.root, &output.stdout, output.truncated)
    }
}

fn contains_git_component(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))
}

fn relative_path(root: &Path, requested_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = if path.is_absolute() {
        path.strip_prefix(requested_root)
            .or_else(|_| path.strip_prefix(root))
            .map_err(|_| "Path is outside the selected project")?
    } else {
        path
    };
    if relative.components().any(|part| {
        matches!(
            part,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) || contains_git_component(relative)
    {
        return Err("Path traversal and .git internals cannot be inspected".into());
    }
    let relative: PathBuf = relative
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect();
    Ok(relative)
}

fn parse_changes(root: &Path, bytes: &[u8], truncated: bool) -> Result<RepoChanges, String> {
    let mut changes = RepoChanges {
        root: root.to_string_lossy().into_owned(),
        branch: None,
        entries: Vec::new(),
        truncated,
    };
    let mut records = bytes.split_inclusive(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.last() != Some(&0) {
            if truncated {
                break;
            }
            return Err("Git returned an incomplete status record".into());
        }
        let record = &record[..record.len() - 1];
        if record.starts_with(b"# branch.head ") {
            let branch =
                std::str::from_utf8(&record[14..]).map_err(|_| "Git branch name is not UTF-8")?;
            if branch != "(detached)" {
                changes.branch = Some(branch.into());
            }
            continue;
        }
        if record.starts_with(b"# ") {
            continue;
        }
        if changes.entries.len() == MAX_CHANGE_ENTRIES {
            changes.truncated = true;
            break;
        }
        let (path, xy, mut status, previous_path) = match record.first() {
            Some(b'?') => (
                &record[2..],
                b".?".as_slice(),
                ChangeStatus::Untracked,
                None,
            ),
            Some(kind @ (b'1' | b'2' | b'u')) => {
                let count = match kind {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let fields: Vec<_> = record.splitn(count, |byte| *byte == b' ').collect();
                if fields.len() != count || fields[1].len() != 2 {
                    return Err("Git returned an invalid status record".into());
                }
                let previous = if *kind == b'2' {
                    let Some(previous) = records.next() else {
                        if truncated {
                            break;
                        }
                        return Err("Git returned an incomplete rename record".into());
                    };
                    if previous.last() != Some(&0) {
                        if truncated {
                            break;
                        }
                        return Err("Git returned an incomplete rename path".into());
                    }
                    Some(status_path(&previous[..previous.len() - 1])?)
                } else {
                    None
                };
                let status = match kind {
                    b'u' => ChangeStatus::Conflicted,
                    b'2' => ChangeStatus::Renamed,
                    _ => ChangeStatus::Modified,
                };
                (fields[count - 1], fields[1], status, previous)
            }
            _ => return Err("Git returned an unsupported status record".into()),
        };
        if status == ChangeStatus::Modified {
            status = if xy.contains(&b'U') {
                ChangeStatus::Conflicted
            } else if xy.contains(&b'D') {
                ChangeStatus::Deleted
            } else if xy.contains(&b'A') {
                ChangeStatus::Added
            } else if xy.contains(&b'T') {
                ChangeStatus::Typechanged
            } else {
                ChangeStatus::Modified
            };
        }
        changes.entries.push(ChangeEntry {
            path: status_path(path)?,
            previous_path,
            status,
            staged: xy[0] != b'.',
            unstaged: xy[1] != b'.',
        });
    }
    Ok(changes)
}

fn status_path(bytes: &[u8]) -> Result<String, String> {
    let path =
        std::str::from_utf8(bytes).map_err(|_| "Git contains a filename that is not UTF-8")?;
    if path.is_empty()
        || Path::new(path).is_absolute()
        || contains_git_component(Path::new(path))
        || Path::new(path)
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Git returned a path outside the project".into());
    }
    Ok(path.into())
}

fn read_repo_changes(root: &Path) -> Result<RepoChanges, String> {
    Repository::open(root)?.changes()
}

fn open_root_descriptor(root: &Path) -> Result<File, String> {
    let filesystem_root =
        File::open("/").map_err(|error| format!("Cannot open filesystem root: {error}"))?;
    let relative = root
        .strip_prefix("/")
        .map_err(|_| "Project root must be absolute")?;
    let directory =
        open_preview_path(&filesystem_root, relative)?.ok_or("Project root disappeared")?;
    if !directory
        .metadata()
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Project root must be a directory".into());
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_preview_path(directory: &File, relative: &Path) -> Result<Option<File>, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let mut directory = directory
        .try_clone()
        .map_err(|error| format!("Cannot retain project directory: {error}"))?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("Project paths must contain only normal path components".into());
        };
        if name.eq_ignore_ascii_case(".git") {
            return Err("Git internals cannot be inspected".into());
        }
        let name = CString::new(name.as_bytes()).map_err(|_| "Project path contains a NUL byte")?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        if components.peek().is_some() {
            flags |= libc::O_DIRECTORY;
        }
        // openat resolves exactly one component against an already-owned
        // directory descriptor. NOFOLLOW prevents symlink substitution; a
        // final FIFO opens without blocking and is rejected by fstat below.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(format!("Cannot safely open project path: {error}"));
        }
        // SAFETY: openat returned a new descriptor; File takes sole ownership.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    let metadata = directory
        .metadata()
        .map_err(|error| format!("Cannot inspect project file: {error}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Only regular files and directories can be inspected".into());
    }
    Ok(Some(directory))
}

#[cfg(not(unix))]
fn open_preview_path(_directory: &File, _relative: &Path) -> Result<Option<File>, String> {
    Err("Safe project inspection is not supported on this platform".into())
}

fn read_project_path(requested_root: &Path, path: &Path) -> Result<FileInspection, String> {
    let repo = Repository::open(requested_root)?;
    let relative = relative_path(&repo.root, requested_root, path)?;
    let path = relative
        .to_str()
        .ok_or("Project path is not UTF-8")?
        .to_string();
    let opened = open_preview_path(&repo.directory, &relative)?;
    let metadata = opened
        .as_ref()
        .map(File::metadata)
        .transpose()
        .map_err(|error| format!("Cannot inspect project file: {error}"))?;
    let (kind, content, truncated) = match metadata {
        Some(metadata) if metadata.is_dir() => (FileKind::Directory, None, false),
        Some(metadata) if metadata.is_file() => {
            let file = opened.ok_or("Project file disappeared")?;
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Cannot read project file: {error}"))?;
            let truncated = bytes.len() > MAX_FILE_BYTES;
            bytes.truncate(MAX_FILE_BYTES);
            let text = if bytes.contains(&0) {
                None
            } else {
                match std::str::from_utf8(&bytes) {
                    Ok(text) => Some(text.to_string()),
                    Err(error) if truncated && error.error_len().is_none() => Some(
                        std::str::from_utf8(&bytes[..error.valid_up_to()])
                            .unwrap()
                            .to_string(),
                    ),
                    Err(_) => None,
                }
            };
            (
                if text.is_some() {
                    FileKind::Text
                } else {
                    FileKind::Binary
                },
                text,
                truncated,
            )
        }
        Some(_) => return Err("Only regular files and directories can be inspected".into()),
        None => (FileKind::Missing, None, false),
    };
    let diff_path = if path.is_empty() { "." } else { &path };
    let changes = repo.changes()?;
    let previous_path = changes
        .entries
        .iter()
        .find(|entry| entry.path == path)
        .and_then(|entry| entry.previous_path.as_deref());
    let diff_options = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--ignore-submodules=all",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    let mut staged_args = diff_options.to_vec();
    staged_args.extend(["--cached", "--", diff_path]);
    if let Some(previous) = previous_path {
        staged_args.push(previous);
    }
    let staged = repo.git(&staged_args, MAX_DIFF_BYTES)?;
    let mut unstaged_args = diff_options.to_vec();
    unstaged_args.extend(["--", diff_path]);
    if let Some(previous) = previous_path {
        unstaged_args.push(previous);
    }
    let unstaged = repo.git(&unstaged_args, MAX_DIFF_BYTES)?;
    Ok(FileInspection {
        path,
        kind,
        content,
        truncated,
        staged_diff: String::from_utf8_lossy(&staged.stdout).into_owned(),
        unstaged_diff: String::from_utf8_lossy(&unstaged.stdout).into_owned(),
        diff_truncated: staged.truncated || unstaged.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=Inspection Test",
                "-c",
                "user.email=inspection@example.invalid",
            ])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "inspection-test"]);
        dir
    }

    fn commit(root: &Path) {
        git(root, &["add", "--all"]);
        git(root, &["commit", "-m", "fixture"]);
    }

    #[test]
    fn search_finds_tracked_and_untracked_literal_text_but_respects_ignores() {
        let dir = repository();
        fs::write(dir.path().join("tracked.txt"), "old\n").unwrap();
        commit(dir.path());
        fs::write(dir.path().join("tracked.txt"), "first\r\nNeedle.* here\r\n").unwrap();
        fs::write(dir.path().join("new [x];$(literal).txt"), "needle.*\n").unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(dir.path().join("ignored.txt"), "needle.*\n").unwrap();
        fs::write(dir.path().join(".git/private"), "needle.*\n").unwrap();
        let index_before = fs::read(dir.path().join(".git/index")).unwrap();

        let result =
            read_project_search(dir.path(), "needle.*", false, SearchLimits::default()).unwrap();
        assert_eq!(result.query, "needle.*");
        assert_eq!(
            Path::new(&result.root),
            fs::canonicalize(dir.path()).unwrap()
        );
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].path, "new [x];$(literal).txt");
        assert_eq!(result.matches[1].path, "tracked.txt");
        assert_eq!(result.matches[1].line, 2);
        assert_eq!(result.matches[1].column, 1);
        assert_eq!(result.matches[1].text, "Needle.* here");
        assert!(!result.truncated);
        assert_eq!(result.files_searched, 3);
        assert_eq!(result.files_skipped, 0);
        assert_eq!(
            fs::read(dir.path().join(".git/index")).unwrap(),
            index_before
        );

        let exact =
            read_project_search(dir.path(), "needle.*", true, SearchLimits::default()).unwrap();
        assert_eq!(exact.matches.len(), 1);
        assert_eq!(exact.matches[0].path, "new [x];$(literal).txt");
    }

    #[test]
    fn search_uses_unicode_columns_and_returns_the_first_occurrence_per_line() {
        let dir = repository();
        fs::write(dir.path().join("unicode.txt"), "🦀İ ÉCOLE école\n\n界école").unwrap();
        let result =
            read_project_search(dir.path(), "école", false, SearchLimits::default()).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!((result.matches[0].line, result.matches[0].column), (1, 4));
        assert_eq!((result.matches[1].line, result.matches[1].column), (3, 2));
        let exact =
            read_project_search(dir.path(), "école", true, SearchLimits::default()).unwrap();
        assert_eq!(exact.matches[0].column, 10);
        let expanded =
            read_project_search(dir.path(), "İ", false, SearchLimits::default()).unwrap();
        assert_eq!(expanded.matches[0].column, 2);
    }

    #[test]
    fn search_skips_binary_missing_and_oversized_files_with_honest_counts() {
        let dir = repository();
        fs::write(dir.path().join("gone.txt"), "needle").unwrap();
        commit(dir.path());
        fs::remove_file(dir.path().join("gone.txt")).unwrap();
        fs::write(dir.path().join("binary.bin"), b"needle\0").unwrap();
        fs::write(dir.path().join("invalid.bin"), b"needle\xff").unwrap();
        fs::write(dir.path().join("large.txt"), "needle".repeat(10)).unwrap();
        fs::write(dir.path().join("ok.txt"), "needle").unwrap();
        let result = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                file_bytes: 16,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "ok.txt");
        assert_eq!(result.files_searched, 1);
        assert_eq!(result.files_skipped, 4);
        assert!(result.truncated);
    }

    #[test]
    fn search_caps_results_without_calling_an_exact_fit_truncated() {
        let dir = repository();
        fs::write(dir.path().join("a.txt"), "needle\nneedle\n").unwrap();
        let exact = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                matches: 2,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(exact.matches.len(), 2);
        assert!(!exact.truncated);
        fs::write(dir.path().join("b.txt"), "needle\n").unwrap();
        fs::write(dir.path().join("c.txt"), "needle\n").unwrap();
        let capped = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                matches: 2,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(capped.matches.len(), 2);
        assert!(capped.truncated);
        assert_eq!(capped.files_searched, 2);
        assert_eq!(capped.files_skipped, 1);
    }

    #[test]
    fn search_caps_file_count_total_bytes_and_long_unicode_snippets() {
        let dir = repository();
        fs::write(dir.path().join("a.txt"), "界界needle\n").unwrap();
        fs::write(dir.path().join("b.txt"), "needle\n").unwrap();
        let by_files = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                files: 1,
                snippet_chars: 3,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(by_files.files_searched, 1);
        assert_eq!(by_files.files_skipped, 1);
        assert!(by_files.truncated);
        assert_eq!(by_files.matches[0].text, "界界n");
        assert_eq!(by_files.matches[0].column, 3);
        assert!(by_files.matches[0].truncated);
        let by_bytes = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                total_bytes: 13,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(by_bytes.matches.len(), 1);
        assert_eq!(by_bytes.files_searched, 1);
        assert_eq!(by_bytes.files_skipped, 1);
        assert!(by_bytes.truncated);
    }

    #[test]
    fn search_rejects_empty_multiline_nul_and_excessive_queries() {
        let dir = repository();
        for query in [
            "",
            "first\nsecond",
            "first\rsecond",
            "needle\0",
            &"界".repeat(501),
        ] {
            let error =
                read_project_search(dir.path(), query, false, SearchLimits::default()).unwrap_err();
            assert!(error.contains("query"), "{error}");
        }
        fs::write(dir.path().join("space.txt"), "a b").unwrap();
        assert_eq!(
            read_project_search(dir.path(), " ", false, SearchLimits::default())
                .unwrap()
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn search_candidate_output_cap_never_turns_a_partial_path_into_a_file() {
        let dir = repository();
        fs::write(dir.path().join("a.txt"), "needle").unwrap();
        fs::write(dir.path().join("b-long-name.txt"), "needle").unwrap();
        let result = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                candidate_bytes: 10,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "a.txt");
        assert!(result.truncated);
    }

    #[test]
    fn search_deadline_covers_repository_setup() {
        let dir = repository();
        let started = Instant::now();
        let result = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                timeout: Duration::ZERO,
                ..SearchLimits::default()
            },
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn search_stops_opening_files_when_the_total_read_budget_is_exhausted() {
        let dir = repository();
        fs::write(dir.path().join("a.txt"), "needle").unwrap();
        fs::write(dir.path().join("empty.txt"), "").unwrap();
        let result = read_project_search(
            dir.path(),
            "needle",
            false,
            SearchLimits {
                total_bytes: 6,
                ..SearchLimits::default()
            },
        )
        .unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.files_searched, 1);
        assert_eq!(result.files_skipped, 1);
        assert!(result.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn search_rejects_replaced_parent_symlinks_and_special_files() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let dir = repository();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("parent")).unwrap();
        fs::write(dir.path().join("parent/file.txt"), "needle").unwrap();
        fs::write(dir.path().join("fifo.txt"), "needle").unwrap();
        commit(dir.path());
        let repo = Repository::open(dir.path()).unwrap();
        fs::write(outside.path().join("file.txt"), "needle secret").unwrap();
        fs::remove_file(dir.path().join("parent/file.txt")).unwrap();
        fs::remove_dir(dir.path().join("parent")).unwrap();
        symlink(outside.path(), dir.path().join("parent")).unwrap();
        symlink(
            outside.path().join("file.txt"),
            dir.path().join("escape.txt"),
        )
        .unwrap();
        fs::remove_file(dir.path().join("fifo.txt")).unwrap();
        let fifo = CString::new(dir.path().join("fifo.txt").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        let result = repo
            .search_text("needle", false, SearchLimits::default())
            .unwrap();
        assert!(result.matches.is_empty());
        assert_eq!(result.files_searched, 0);
        assert!(result.files_skipped >= 3);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn search_retains_its_root_descriptor_if_the_root_is_replaced() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repository");
        let outside = dir.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        git(&root, &["init", "-b", "inspection-test"]);
        fs::write(root.join("inside.txt"), "needle inside").unwrap();
        fs::write(outside.join("secret.txt"), "needle secret").unwrap();
        let repo = Repository::open(&root).unwrap();
        fs::rename(&root, dir.path().join("original-root")).unwrap();
        symlink(&outside, &root).unwrap();
        let result = repo
            .search_text("needle", false, SearchLimits::default())
            .unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "inside.txt");
        assert_eq!(result.matches[0].text, "needle inside");
    }

    #[test]
    fn search_never_runs_repository_filters_textconv_or_fsmonitor() {
        let dir = repository();
        fs::write(dir.path().join("file.txt"), "needle").unwrap();
        commit(dir.path());
        fs::write(
            dir.path().join(".gitattributes"),
            "file.txt filter=search diff=search\n",
        )
        .unwrap();
        for key in [
            "filter.search.clean",
            "filter.search.process",
            "diff.search.command",
            "diff.search.textconv",
            "core.fsmonitor",
        ] {
            git(dir.path(), &["config", key, "touch search-executed; cat"]);
        }
        let result =
            read_project_search(dir.path(), "needle", false, SearchLimits::default()).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert!(!dir.path().join("search-executed").exists());
    }

    #[test]
    fn reports_index_and_worktree_changes_including_literal_names() {
        let dir = repository();
        let root = dir.path();
        for name in ["both.txt", "removed.txt", "old name.txt", "unstaged.txt"] {
            fs::write(root.join(name), "original\n").unwrap();
        }
        commit(root);
        fs::write(root.join("both.txt"), "staged\n").unwrap();
        git(root, &["add", "both.txt"]);
        fs::write(root.join("both.txt"), "working\n").unwrap();
        fs::remove_file(root.join("removed.txt")).unwrap();
        git(root, &["mv", "old name.txt", "new name.txt"]);
        fs::write(root.join("unstaged.txt"), "changed\n").unwrap();
        fs::write(root.join("new [x];$(literal).txt"), "untracked\n").unwrap();
        fs::write(root.join("added.txt"), "added\n").unwrap();
        git(root, &["add", "added.txt"]);

        let changes = read_repo_changes(root).unwrap();
        assert_eq!(changes.branch.as_deref(), Some("inspection-test"));
        assert_eq!(changes.entries.len(), 6);
        assert!(!changes.truncated);
        let entry = |path: &str| {
            changes
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap()
        };
        assert_eq!(
            (entry("both.txt").staged, entry("both.txt").unstaged),
            (true, true)
        );
        assert_eq!(entry("removed.txt").status, ChangeStatus::Deleted);
        assert_eq!(
            (entry("removed.txt").staged, entry("removed.txt").unstaged),
            (false, true)
        );
        assert_eq!(entry("new name.txt").status, ChangeStatus::Renamed);
        assert_eq!(
            entry("new name.txt").previous_path.as_deref(),
            Some("old name.txt")
        );
        assert_eq!(entry("added.txt").status, ChangeStatus::Added);
        assert_eq!(
            entry("new [x];$(literal).txt").status,
            ChangeStatus::Untracked
        );
        assert_eq!(
            (entry("unstaged.txt").staged, entry("unstaged.txt").unstaged),
            (false, true)
        );
    }

    #[test]
    fn preview_separates_staged_and_unstaged_diffs_without_expanding_pathspecs() {
        let dir = repository();
        let root = dir.path();
        let name = ":(glob)* [a];$(literal).txt";
        fs::write(root.join(name), "original\n").unwrap();
        fs::write(root.join("other.txt"), "other original\n").unwrap();
        commit(root);
        fs::write(root.join(name), "staged version\n").unwrap();
        git(root, &["--literal-pathspecs", "add", "--", name]);
        fs::write(root.join(name), "working version\n").unwrap();
        fs::write(root.join("other.txt"), "unrelated secret\n").unwrap();
        let file = read_project_path(root, Path::new(name)).unwrap();
        assert_eq!(file.kind, FileKind::Text);
        assert_eq!(file.content.as_deref(), Some("working version\n"));
        assert!(file.staged_diff.contains("-original\n+staged version"));
        assert!(!file.staged_diff.contains("working version"));
        assert!(file
            .unstaged_diff
            .contains("-staged version\n+working version"));
        assert!(!file.unstaged_diff.contains("unrelated secret"));
        assert!(!file.diff_truncated);
    }

    #[test]
    fn preview_reports_binary_directory_missing_and_bounded_utf8_text() {
        let dir = repository();
        let root = dir.path();
        fs::write(root.join("deleted.txt"), "gone\n").unwrap();
        commit(root);
        fs::remove_file(root.join("deleted.txt")).unwrap();
        fs::write(root.join("nul.bin"), b"a\0b").unwrap();
        fs::write(root.join("invalid.bin"), [0xff, 0xfe]).unwrap();
        fs::write(root.join("large.txt"), "é".repeat(MAX_FILE_BYTES)).unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        for name in ["nul.bin", "invalid.bin"] {
            let file = read_project_path(root, Path::new(name)).unwrap();
            assert_eq!(file.kind, FileKind::Binary);
            assert!(file.content.is_none());
        }
        let file = read_project_path(root, Path::new("large.txt")).unwrap();
        assert_eq!(file.kind, FileKind::Text);
        assert!(file.truncated);
        assert!(file.content.unwrap().len() <= MAX_FILE_BYTES);
        assert_eq!(
            read_project_path(root, Path::new("folder")).unwrap().kind,
            FileKind::Directory
        );
        let missing = read_project_path(root, Path::new("deleted.txt")).unwrap();
        assert_eq!(missing.kind, FileKind::Missing);
        assert!(missing.unstaged_diff.contains("-gone"));
    }

    #[test]
    fn rejects_traversal_git_internals_and_non_repository_roots() {
        let dir = repository();
        for path in ["../outside", ".git/config", ".git", "folder/../../outside"] {
            assert!(
                read_project_path(dir.path(), Path::new(path)).is_err(),
                "{path}"
            );
        }
        let plain = tempfile::tempdir().unwrap();
        assert!(read_repo_changes(plain.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes_and_special_files() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        let dir = repository();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "private").unwrap();
        symlink(outside.path(), dir.path().join("escape")).unwrap();
        symlink(dir.path().join(".git"), dir.path().join("git-alias")).unwrap();
        symlink(
            outside.path().join("nonexistent"),
            dir.path().join("dangling"),
        )
        .unwrap();
        let _socket = UnixListener::bind(dir.path().join("socket")).unwrap();
        for path in [
            "escape/secret",
            "escape/missing",
            "git-alias/config",
            "dangling",
            "socket",
        ] {
            assert!(
                read_project_path(dir.path(), Path::new(path)).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn renamed_file_preview_includes_both_sides_of_the_rename() {
        let dir = repository();
        fs::write(dir.path().join("before.txt"), "same text\n").unwrap();
        commit(dir.path());
        git(dir.path(), &["mv", "before.txt", "after.txt"]);
        let file = read_project_path(dir.path(), Path::new("after.txt")).unwrap();
        assert!(file.staged_diff.contains("rename from before.txt"));
        assert!(file.staged_diff.contains("rename to after.txt"));
        assert!(file.unstaged_diff.is_empty());
    }

    #[test]
    fn reports_staged_deletion_unborn_branch_and_detached_head() {
        let dir = repository();
        fs::write(dir.path().join("file.txt"), "content\n").unwrap();
        let untracked = read_repo_changes(dir.path()).unwrap();
        assert_eq!(untracked.branch.as_deref(), Some("inspection-test"));
        assert_eq!(untracked.entries[0].status, ChangeStatus::Untracked);
        let preview = read_project_path(dir.path(), Path::new("file.txt")).unwrap();
        assert!(preview.staged_diff.is_empty());
        assert!(preview.unstaged_diff.is_empty());
        commit(dir.path());
        git(dir.path(), &["checkout", "--detach"]);
        git(dir.path(), &["rm", "file.txt"]);
        let changes = read_repo_changes(dir.path()).unwrap();
        assert!(changes.branch.is_none());
        assert_eq!(changes.entries[0].status, ChangeStatus::Deleted);
        assert!(changes.entries[0].staged);
        assert!(!changes.entries[0].unstaged);
        let file = read_project_path(dir.path(), Path::new("file.txt")).unwrap();
        assert_eq!(file.kind, FileKind::Missing);
        assert!(file.staged_diff.contains("-content"));
        assert!(file.unstaged_diff.is_empty());
    }

    #[test]
    fn limits_large_diffs_and_status_lists_without_partial_paths() {
        let dir = repository();
        fs::write(dir.path().join("large.txt"), "before\n").unwrap();
        commit(dir.path());
        fs::write(
            dir.path().join("large.txt"),
            "long line for a bounded patch\n".repeat(30_000),
        )
        .unwrap();
        let preview = read_project_path(dir.path(), Path::new("large.txt")).unwrap();
        assert!(preview.diff_truncated);
        assert!(preview.unstaged_diff.len() <= MAX_DIFF_BYTES);
        assert!(preview
            .unstaged_diff
            .contains("+long line for a bounded patch"));

        let records = (0..2001)
            .map(|i| format!("? path-{i}\0"))
            .collect::<String>();
        let changes = parse_changes(dir.path(), records.as_bytes(), false).unwrap();
        assert!(changes.truncated);
        assert_eq!(changes.entries.len(), 2000);
        let partial = parse_changes(dir.path(), b"? complete\0? incompl", true).unwrap();
        assert_eq!(partial.entries.len(), 1);
        assert_eq!(partial.entries[0].path, "complete");
        assert!(parse_changes(dir.path(), b"? incompl", false).is_err());
    }

    #[test]
    fn command_deadline_bounds_a_slow_process() {
        let mut command = Command::new("sleep");
        command.arg("2");
        let start = Instant::now();
        let result = run_bounded(command, 64, start + Duration::from_millis(30));
        assert!(result.err().unwrap().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn never_runs_external_diff_textconv_or_fsmonitor() {
        let dir = repository();
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        fs::write(
            dir.path().join(".gitattributes"),
            "file.txt diff=inspection\n",
        )
        .unwrap();
        commit(dir.path());
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        git(
            dir.path(),
            &[
                "config",
                "diff.inspection.command",
                "touch external-command-ran",
            ],
        );
        git(
            dir.path(),
            &["config", "diff.inspection.textconv", "touch textconv-ran"],
        );
        git(
            dir.path(),
            &["config", "core.fsmonitor", "touch fsmonitor-ran"],
        );
        let file = read_project_path(dir.path(), Path::new("file.txt")).unwrap();
        assert!(file.unstaged_diff.contains("-before\n+after"));
        read_repo_changes(dir.path()).unwrap();
        for path in ["external-command-ran", "textconv-ran", "fsmonitor-ran"] {
            assert!(!dir.path().join(path).exists(), "{path}");
        }
    }

    #[test]
    fn read_only_inspection_does_not_execute_clean_filters() {
        let dir = repository();
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        commit(dir.path());
        fs::write(
            dir.path().join(".gitattributes"),
            "file.txt filter=inspection\n",
        )
        .unwrap();
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        git(
            dir.path(),
            &[
                "config",
                "filter.inspection.clean",
                "touch clean-filter-ran; cat",
            ],
        );
        read_repo_changes(dir.path()).unwrap();
        read_project_path(dir.path(), Path::new("file.txt")).unwrap();
        assert!(!dir.path().join("clean-filter-ran").exists());
    }

    #[cfg(unix)]
    #[test]
    fn missing_partial_clone_blob_reports_error_without_running_remote_helper() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repository();
        let root = dir.path();
        fs::write(root.join("file.txt"), "before\n").unwrap();
        commit(root);
        let object = Command::new("git")
            .args(["rev-parse", "HEAD:file.txt"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(object.status.success());
        let object = String::from_utf8(object.stdout).unwrap();
        let object = object.trim();
        assert!(object.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let object_path = root
            .join(".git/objects")
            .join(&object[..2])
            .join(&object[2..]);
        fs::remove_file(&object_path).unwrap();

        // A local marker-only remote helper proves whether Git starts any
        // transport. This fixture never contacts a network or real remote.
        let helper = root.join("promisor-helper");
        fs::write(
            &helper,
            "#!/bin/sh\nprintf invoked > \"$0.invoked\"\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let remote = format!(
            "ext::{}",
            helper
                .to_str()
                .unwrap()
                .replace('%', "%%")
                .replace(' ', "% ")
        );
        git(root, &["config", "remote.origin.url", &remote]);
        git(root, &["config", "remote.origin.promisor", "true"]);
        git(root, &["config", "extensions.partialClone", "origin"]);
        git(root, &["config", "protocol.ext.allow", "always"]);
        fs::write(root.join("file.txt"), "after\n").unwrap();

        let result = read_project_path(root, Path::new("file.txt"));
        assert!(result.unwrap_err().contains("Git inspection failed"));
        assert!(!root.join("promisor-helper.invoked").exists());
        assert!(!object_path.exists());

        // Characterize the compatibility guard with lazy-fetch suppression
        // removed: protocol denial alone must prevent helper execution even
        // though the repository explicitly allows the ext transport.
        let repo = Repository::open(root).unwrap();
        let mut command = repo.command();
        command.env_remove("GIT_NO_LAZY_FETCH").args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            "file.txt",
        ]);
        let output = run_bounded(command, MAX_DIFF_BYTES, repo.deadline).unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("transport 'ext' not allowed"));
        assert!(!root.join("promisor-helper.invoked").exists());
        assert!(!object_path.exists());
    }

    #[test]
    fn utf8_preview_truncation_keeps_an_incomplete_final_codepoint_as_text() {
        let dir = repository();
        fs::write(dir.path().join("unicode.txt"), "界".repeat(MAX_FILE_BYTES)).unwrap();
        let file = read_project_path(dir.path(), Path::new("unicode.txt")).unwrap();
        assert_eq!(file.kind, FileKind::Text);
        assert!(file.truncated);
        assert_eq!(file.content.unwrap().len(), MAX_FILE_BYTES - 1);
    }

    #[test]
    fn status_distinguishes_unmerged_paths() {
        let dir = repository();
        fs::write(dir.path().join("conflict.txt"), "base\n").unwrap();
        commit(dir.path());
        git(dir.path(), &["checkout", "-b", "other"]);
        fs::write(dir.path().join("conflict.txt"), "other\n").unwrap();
        commit(dir.path());
        git(dir.path(), &["checkout", "inspection-test"]);
        fs::write(dir.path().join("conflict.txt"), "main\n").unwrap();
        commit(dir.path());
        let merge = Command::new("git")
            .args([
                "-c",
                "user.name=Inspection Test",
                "-c",
                "user.email=inspection@example.invalid",
                "merge",
                "other",
            ])
            .current_dir(dir.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(!merge.status.success());
        let changes = read_repo_changes(dir.path()).unwrap();
        assert_eq!(changes.entries.len(), 1);
        assert_eq!(changes.entries[0].path, "conflict.txt");
        assert_eq!(changes.entries[0].status, ChangeStatus::Conflicted);
        assert!(changes.entries[0].staged);
        assert!(changes.entries[0].unstaged);
    }

    #[cfg(unix)]
    #[test]
    fn status_preserves_typechanges_while_preview_rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = repository();
        fs::write(dir.path().join("target.txt"), "target\n").unwrap();
        fs::write(dir.path().join("changed.txt"), "ordinary\n").unwrap();
        commit(dir.path());
        fs::remove_file(dir.path().join("changed.txt")).unwrap();
        symlink("target.txt", dir.path().join("changed.txt")).unwrap();
        let changes = read_repo_changes(dir.path()).unwrap();
        assert_eq!(changes.entries[0].status, ChangeStatus::Typechanged);
        assert!(read_project_path(dir.path(), Path::new("changed.txt")).is_err());
    }

    #[test]
    fn accepts_absolute_in_project_paths_without_refreshing_the_index() {
        let dir = repository();
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        commit(dir.path());
        let index_before = fs::read(dir.path().join(".git/index")).unwrap();
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        let preview = read_project_path(dir.path(), &dir.path().join("file.txt")).unwrap();
        assert_eq!(preview.path, "file.txt");
        assert_eq!(preview.content.as_deref(), Some("after\n"));
        read_repo_changes(dir.path()).unwrap();
        assert_eq!(
            fs::read(dir.path().join(".git/index")).unwrap(),
            index_before
        );
    }

    #[cfg(unix)]
    #[test]
    fn preview_open_rejects_parent_replaced_after_path_validation() {
        use std::os::unix::fs::symlink;
        let dir = repository();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("parent")).unwrap();
        fs::write(dir.path().join("parent/file.txt"), "inside\n").unwrap();
        fs::write(outside.path().join("file.txt"), "outside\n").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        let relative = relative_path(&repo.root, dir.path(), Path::new("parent/file.txt")).unwrap();
        fs::rename(
            dir.path().join("parent"),
            dir.path().join("original-parent"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join("parent")).unwrap();
        assert!(open_preview_path(&repo.directory, &relative).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preview_open_retains_selected_root_when_its_path_is_replaced() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repository");
        let outside = dir.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        git(&root, &["init", "-b", "inspection-test"]);
        fs::write(root.join("file.txt"), "inside\n").unwrap();
        fs::write(outside.join("file.txt"), "outside\n").unwrap();
        let repo = Repository::open(&root).unwrap();
        fs::rename(&root, dir.path().join("original-root")).unwrap();
        symlink(&outside, &root).unwrap();
        let mut file = open_preview_path(&repo.directory, Path::new("file.txt"))
            .unwrap()
            .unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        assert_eq!(content, "inside\n");
        let changes = repo.changes().unwrap();
        assert_eq!(changes.branch.as_deref(), Some("inspection-test"));
        assert_eq!(changes.entries[0].path, "file.txt");
    }

    #[cfg(unix)]
    #[test]
    fn preview_open_rejects_final_symlink_after_regular_file_validation() {
        use std::os::unix::fs::symlink;
        let dir = repository();
        let outside = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("file.txt");
        fs::write(&file_path, "inside\n").unwrap();
        fs::write(outside.path().join("file.txt"), "outside\n").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        assert!(fs::symlink_metadata(&file_path).unwrap().is_file());
        fs::remove_file(&file_path).unwrap();
        symlink(outside.path().join("file.txt"), &file_path).unwrap();
        assert!(open_preview_path(&repo.directory, Path::new("file.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preview_open_rejects_replacement_fifo_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = repository();
        let file_path = dir.path().join("file.txt");
        fs::write(&file_path, "inside\n").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        assert!(fs::symlink_metadata(&file_path).unwrap().is_file());
        fs::remove_file(&file_path).unwrap();
        let fifo_path = CString::new(file_path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);

        let (sender, receiver) = mpsc::channel();
        let directory = repo.directory.clone();
        let worker = thread::spawn(move || {
            let result = open_preview_path(&directory, Path::new("file.txt"));
            let _ = sender.send(result.map(|file| file.is_some()));
        });
        let result = receiver.recv_timeout(Duration::from_secs(1));
        if result.is_err() {
            // Make a regression failure terminate cleanly: connecting a writer
            // releases an accidentally blocking read-open, without writing data.
            let writer = fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&file_path);
            drop(writer);
        }
        assert!(result
            .expect("FIFO preview blocked waiting for a writer")
            .is_err());
        worker.join().unwrap();
    }
}
