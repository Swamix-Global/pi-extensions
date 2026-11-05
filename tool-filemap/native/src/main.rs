// filemap — fast git-aware source file map of a folder.
// Git repos: honor .gitignore chains (root + nested, negation, dir-only, ** globs).
// Otherwise: standard ignore set + hidden entries. Folders first, then files,
// alphabetical per directory, depth-capped, item-capped.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

const DEFAULT_MAX_ITEMS: usize = 1000;
const DEFAULT_MAX_DEPTH: usize = 3;

const STD_IGNORES: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "coverage", ".venv", "venv",
    ".pi", "__pycache__", ".next", ".turbo", ".mypy_cache", ".pytest_cache", ".idea",
];

struct Rule {
    neg: bool,
    dir_only: bool,
    segs: Vec<String>,
}

struct IgnoreSet {
    base: PathBuf,
    rules: Vec<Rule>,
}

fn parse_gitignore(dir: &Path) -> Vec<Rule> {
    let text = match fs::read_to_string(dir.join(".gitignore")) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut rules = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut pat = line.to_string();
        let neg = pat.starts_with('!');
        if neg {
            pat.remove(0);
        }
        if pat.is_empty() {
            continue;
        }
        let dir_only = pat.ends_with('/');
        if dir_only {
            pat.pop();
        }
        if pat.is_empty() {
            continue;
        }
        let anchored = pat.trim_end_matches('/').contains('/') || line.starts_with('/');
        let pat = pat.trim_start_matches('/').to_string();
        if pat.is_empty() {
            continue;
        }
        let mut segs: Vec<String> = pat.split('/').map(|s| s.to_string()).collect();
        if !anchored {
            segs.insert(0, "**".to_string());
        }
        rules.push(Rule { neg, dir_only, segs });
    }
    rules
}

fn seg_match(p: &[char], s: &[char]) -> bool {
    if p.is_empty() {
        return s.is_empty();
    }
    match p[0] {
        '*' => (0..=s.len()).any(|k| seg_match(&p[1..], &s[k..])),
        '?' => !s.is_empty() && seg_match(&p[1..], &s[1..]),
        '[' => {
            if s.is_empty() {
                return false;
            }
            let mut i = 1;
            let negate = i < p.len() && (p[i] == '!' || p[i] == '^');
            if negate {
                i += 1;
            }
            let mut hit = false;
            let mut first = true;
            while i < p.len() {
                if p[i] == ']' && !first {
                    break;
                }
                first = false;
                if i + 2 < p.len() && p[i + 1] == '-' && p[i + 2] != ']' {
                    if s[0] >= p[i] && s[0] <= p[i + 2] {
                        hit = true;
                    }
                    i += 3;
                } else {
                    if s[0] == p[i] {
                        hit = true;
                    }
                    i += 1;
                }
            }
            if i >= p.len() {
                return false; // unterminated class
            }
            if hit != negate {
                seg_match(&p[i + 1..], &s[1..])
            } else {
                false
            }
        }
        '\\' if p.len() > 1 => !s.is_empty() && s[0] == p[1] && seg_match(&p[2..], &s[1..]),
        c => !s.is_empty() && s[0] == c && seg_match(&p[1..], &s[1..]),
    }
}

fn glob_match(pats: &[String], name: &[String]) -> bool {
    if pats.is_empty() {
        return name.is_empty();
    }
    if pats[0] == "**" {
        return (0..=name.len()).any(|k| glob_match(&pats[1..], &name[k..]));
    }
    if name.is_empty() {
        return false;
    }
    let pc: Vec<char> = pats[0].chars().collect();
    let nc: Vec<char> = name[0].chars().collect();
    seg_match(&pc, &nc) && glob_match(&pats[1..], &name[1..])
}

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
                max_items = argv.get(i).and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_MAX_ITEMS);
            }
            "--max-depth" => {
                i += 1;
                max_depth = argv.get(i).and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_MAX_DEPTH);
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
    let mut lines: Vec<String> = Vec::new();
    let mut state = State { items: 0, more: 0, truncated: false, max_items };

    let mut root_chain: Vec<IgnoreSet> = Vec::new();
    if let Some(gr) = &git_root {
        // gitignores from repo root down to (and including) the walk root
        let mut cur = gr.clone();
        root_chain.push(IgnoreSet { base: cur.clone(), rules: parse_gitignore(&cur) });
        if let Ok(rel_from_root) = root.strip_prefix(gr) {
            for seg in rel_from_root.components() {
                cur = cur.join(seg);
                root_chain.push(IgnoreSet { base: cur.clone(), rules: parse_gitignore(&cur) });
            }
        }
    }

    lines.push(format!(
        "{} ({}, depth<={}, {} items)",
        root.display(),
        if git_root.is_some() { "git ignores" } else { "standard ignores" },
        max_depth,
        0
    ));
    walk(&root, &mut Vec::new(), 1, max_depth, &git_root.is_some(), &mut root_chain, &mut lines, &mut state);
    if state.truncated {
        lines.push(format!("... {} more entries not shown (raise --max-items)", state.more));
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

fn ci_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    al.cmp(&bl).then(a.cmp(b))
}

#[allow(clippy::too_many_arguments)]
fn walk(
    dir: &Path,
    rel: &[String],
    depth: usize,
    max_depth: usize,
    git_mode: &bool,
    chain: &mut Vec<IgnoreSet>,
    lines: &mut Vec<String>,
    st: &mut State,
) {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let this_base = dir.to_path_buf();
    // snapshot ignore rules that apply to entries of this dir (chain covers ancestors)
    let applies = |set: &IgnoreSet| dir.starts_with(&set.base);

    let mut entries: Vec<Entry> = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let meta = match fs::symlink_metadata(e.path()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = meta.file_type().is_symlink();
        let is_dir = meta.is_dir(); // symlinked dirs treated as files (no cycles)

        if *git_mode {
            let mut verdict = false;
            for set in chain.iter().filter(|s| applies(s)) {
                let mut base_segs: Vec<String> = dir
                    .strip_prefix(&set.base)
                    .unwrap_or_else(|_| Path::new(""))
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect();
                base_segs.push(name.clone());
                let mut last: Option<&Rule> = None;
                for r in &set.rules {
                    if r.dir_only && !is_dir {
                        // dir-only patterns can still match an ancestor; ancestors were
                        // pruned during traversal, so only direct match matters here.
                        continue;
                    }
                    if r.dir_only {
                        // try the dir itself and any prefix path (a/b/ matches dir a/b)
                        for k in 1..=base_segs.len() {
                            if glob_match(&r.segs, &base_segs[..k]) {
                                last = Some(r);
                                break;
                            }
                        }
                    } else if glob_match(&r.segs, &base_segs) {
                        last = Some(r);
                    }
                }
                if let Some(r) = last {
                    verdict = !r.neg;
                }
            }
            if verdict {
                continue;
            }
        } else {
            if name.starts_with('.') {
                continue;
            }
            if is_dir && STD_IGNORES.contains(&name.as_str()) {
                continue;
            }
        }

        entries.push(Entry { name, is_dir: is_dir && !is_symlink });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => ci_cmp(&a.name, &b.name),
    });

    // nested gitignore (git mode only)
    let mut added_rules = false;
    if *git_mode {
        let rules = parse_gitignore(&this_base);
        if !rules.is_empty() {
            chain.push(IgnoreSet { base: this_base.clone(), rules });
            added_rules = true;
        }
    }

    let indent = "  ".repeat(depth.saturating_sub(1));
    for ent in &entries {
        let full = if st.truncated { None } else if st.items < st.max_items { Some(()) } else { None };        match full {
            Some(_) => {
                st.items += 1;
                lines.push(format!("{indent}{}{}", ent.name, if ent.is_dir { "/" } else { "" }));
            }
            None => {
                st.truncated = true;
                st.more += 1;
            }
        }
        if ent.is_dir && depth < max_depth {
            let mut child_rel: Vec<String> = rel.to_vec();
            child_rel.push(ent.name.clone());
            walk(&this_base.join(&ent.name), &child_rel, depth + 1, max_depth, git_mode, chain, lines, st);
        }
    }

    if added_rules {
        chain.pop();
    }
}
