// filemap — fast git-aware source file map of a folder.
// Git repos use Git's own ignore engine; standalone folders use a conservative
// standard ignore set. Folders sort before files, alphabetically per directory.
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

const DEFAULT_MAX_ITEMS: usize = 1000;
const DEFAULT_MAX_DEPTH: usize = 3;

const STD_IGNORES: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "coverage", ".venv", "venv",
    ".pi", "__pycache__", ".next", ".turbo", ".mypy_cache", ".pytest_cache", ".idea",
];

struct Entry {
    name: String,
    is_dir: bool,
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let mut root: Option<PathBuf> = None;
    let mut max_items = DEFAULT_MAX_ITEMS;
    let mut max_depth = DEFAULT_MAX_DEPTH;
    let mut i = 0;

    while i < argv.len() {
        match argv[i].as_str() {
            "--max-items" => {
                i += 1;
                max_items = argv
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_MAX_ITEMS);
            }
            "--max-depth" => {
                i += 1;
                max_depth = argv
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_MAX_DEPTH);
            }
            s if !s.starts_with('-') && root.is_none() => root = Some(PathBuf::from(s)),
            s => {
                eprintln!("filemap: unexpected argument: {s}");
                eprintln!("usage: filemap <root> [--max-items N] [--max-depth D]");
                exit(2);
            }
        }
        i += 1;
    }

    let Some(root) = root else {
        eprintln!("usage: filemap <root> [--max-items N] [--max-depth D]");
        exit(2);
    };
    let root = match fs::canonicalize(&root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("filemap: cannot resolve {}: {e}", root.display());
            exit(2);
        }
    };
    if !root.is_dir() {
        eprintln!("filemap: not a directory: {}", root.display());
        exit(2);
    }

    let max_depth = max_depth.clamp(1, 8);
    let max_items = max_items.clamp(1, 100_000);
    let git_root = find_git_root(&root);
    let mut lines = Vec::new();
    let mut state = State {
        items: 0,
        more: 0,
        truncated: false,
        max_items,
    };

    lines.push(format!(
        "{} ({}, depth<={}, {} items)",
        root.display(),
        if git_root.is_some() { "git ignores" } else { "standard ignores" },
        max_depth,
        0
    ));
    if let Err(error) = walk(
        &root,
        1,
        max_depth,
        git_root.as_deref(),
        &mut lines,
        &mut state,
    ) {
        eprintln!("filemap: {error}");
        exit(2);
    }
    if state.truncated {
        lines.push(format!(
            "... {} more entries not shown (raise --max-items)",
            state.more
        ));
    }
    lines[0] = format!(
        "{} ({}, depth<={}, {} items)",
        root.display(),
        if git_root.is_some() { "git ignores" } else { "standard ignores" },
        max_depth,
        state.items
    );
    println!("{}", lines.join("\n"));
}

struct State {
    items: usize,
    more: usize,
    truncated: bool,
    max_items: usize,
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

fn git_path(root: &Path, dir: &Path, name: &str, is_dir: bool) -> Result<String, String> {
    let rel_dir = dir
        .strip_prefix(root)
        .map_err(|e| format!("cannot make {} relative to {}: {e}", dir.display(), root.display()))?;
    let mut path = rel_dir.to_path_buf();
    path.push(name);
    let mut path = path.to_string_lossy().into_owned();
    if is_dir {
        path.push('/');
    }
    Ok(path)
}

fn git_ignored_paths(
    root: &Path,
    dir: &Path,
    entries: &[Entry],
) -> Result<HashSet<String>, String> {
    if entries.is_empty() {
        return Ok(HashSet::new());
    }

    let paths: Vec<String> = entries
        .iter()
        .map(|entry| git_path(root, dir, &entry.name, entry.is_dir))
        .collect::<Result<_, _>>()?;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run git check-ignore: {e}"))?;
    {
        let input = child
            .stdin
            .as_mut()
            .ok_or_else(|| "cannot open git check-ignore input".to_string())?;
        for path in &paths {
            input
                .write_all(path.as_bytes())
                .and_then(|_| input.write_all(&[0]))
                .map_err(|e| format!("cannot send paths to git check-ignore: {e}"))?;
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("cannot read git check-ignore result: {e}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("git check-ignore failed with {}", output.status)
        } else {
            format!("git check-ignore failed: {detail}")
        });
    }

    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect())
}

fn ci_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    al.cmp(&bl).then(a.cmp(b))
}

#[allow(clippy::too_many_arguments)]
fn walk(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    git_root: Option<&Path>,
    lines: &mut Vec<String>,
    state: &mut State,
) -> Result<(), String> {
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(_) => return Ok(()),
    };
    let mut candidates = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        candidates.push(Entry {
            name,
            is_dir: meta.is_dir(),
        });
    }

    let ignored = if let Some(root) = git_root {
        git_ignored_paths(root, dir, &candidates)?
    } else {
        HashSet::new()
    };
    let mut entries = Vec::new();
    for entry in candidates {
        if let Some(root) = git_root {
            if ignored.contains(&git_path(root, dir, &entry.name, entry.is_dir)?) {
                continue;
            }
        } else {
            if entry.name.starts_with('.') {
                continue;
            }
            if entry.is_dir && STD_IGNORES.contains(&entry.name.as_str()) {
                continue;
            }
        }
        entries.push(entry);
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => ci_cmp(&a.name, &b.name),
    });

    let indent = "  ".repeat(depth.saturating_sub(1));
    for entry in &entries {
        if state.items < state.max_items && !state.truncated {
            state.items += 1;
            lines.push(format!(
                "{indent}{}{}",
                entry.name,
                if entry.is_dir { "/" } else { "" }
            ));
        } else {
            state.truncated = true;
            state.more += 1;
        }
        if entry.is_dir && depth < max_depth {
            walk(
                &dir.join(&entry.name),
                depth + 1,
                max_depth,
                git_root,
                lines,
                state,
            )?;
        }
    }
    Ok(())
}
