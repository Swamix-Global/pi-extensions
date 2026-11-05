use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "filemap-{label}-{}-{stamp}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temporary directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_file(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("file has parent")).expect("create parent");
    fs::write(path, text).expect("write fixture file");
}

fn init_git(root: &Path) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["init", "--quiet"])
        .output()
        .expect("run git init");
    assert!(
        output.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_filemap(root: &Path) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_filemap"))
        .arg(root)
        .args(["--max-depth", "8", "--max-items", "100000"])
        .output()
        .expect("run filemap");
    assert!(
        output.status.success(),
        "filemap failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("filemap output is UTF-8")
}

fn displayed_paths(output: &str) -> HashSet<String> {
    let mut actual = HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for line in output.lines().skip(1) {
        if line.starts_with("... ") || line.trim().is_empty() {
            continue;
        }
        let spaces = line.chars().take_while(|ch| *ch == ' ').count();
        let depth = spaces / 2;
        let item = line.trim();
        let name = item.strip_suffix('/').unwrap_or(item);
        parts.truncate(depth);
        parts.push(name.to_string());
        actual.insert(parts.join("/"));
    }
    actual
}

fn check_ignore(root: &Path, rel: &str, is_dir: bool) -> bool {
    let mut path = rel.to_string();
    if is_dir {
        path.push('/');
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-q", "--"])
        .arg(path)
        .output()
        .expect("run git check-ignore oracle");
    match output.status.code() {
        Some(0) => true,
        Some(1) => false,
        code => panic!(
            "git check-ignore failed for {rel}: {code:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        ),
    }
}

#[test]
fn matches_git_for_ancestor_nested_and_precedence_rules() {
    let temp = TempDir::new("nested-gitignore");
    let root = temp.path();
    init_git(root);

    write_file(
        root,
        ".gitignore",
        "/root-only.txt\n/cache/\n/parent/\n*.log\n!keep.log\n*.tmp\n!keep.tmp\nprecedence.tmp\n!precedence.tmp\nprecedence.tmp\n",
    );
    write_file(root, "root-only.txt", "ignored by anchored rule\n");
    write_file(root, "deep/root-only.txt", "not anchored here\n");
    write_file(root, "cache/cache.txt", "ignored directory\n");
    write_file(root, "keep.log", "re-included by later rule\n");
    write_file(root, "drop.log", "ignored by wildcard\n");
    write_file(root, "keep.tmp", "re-included by later rule\n");
    write_file(root, "drop.tmp", "ignored by wildcard\n");
    write_file(root, "precedence.tmp", "last matching rule wins\n");
    write_file(root, "parent/.gitignore", "!keep.txt\n");
    write_file(root, "parent/keep.txt", "cannot re-include through ignored parent\n");
    write_file(
        root,
        "sub/.gitignore",
        "!*.log\n*.tmp\n!allow.tmp\nnested-dir/\n!nested-dir/allow.txt\n/nested-only.txt\n",
    );
    write_file(root, "sub/drop.log", "nested rule overrides ancestor\n");
    write_file(root, "sub/nested.tmp", "ignored by nested pattern\n");
    write_file(root, "sub/drop.tmp", "ignored by nested pattern\n");
    write_file(root, "sub/allow.tmp", "re-included by nested rule\n");
    write_file(root, "sub/nested-only.txt", "nested anchored rule\n");
    write_file(root, "sub/nested-dir/child.txt", "ignored directory\n");
    write_file(root, "sub/nested-dir/allow.txt", "cannot re-include through ignored parent\n");
    write_file(root, "other/nested-only.txt", "nested rule does not apply here\n");
    write_file(root, "other/cache/file.txt", "root-anchored ignore does not apply here\n");
    write_file(root, "other/outside.txt", "visible\n");

    let actual = displayed_paths(&run_filemap(root));
    let candidates = [
        (".gitignore", false),
        ("root-only.txt", false),
        ("deep", true),
        ("deep/root-only.txt", false),
        ("cache", true),
        ("cache/cache.txt", false),
        ("keep.log", false),
        ("drop.log", false),
        ("keep.tmp", false),
        ("drop.tmp", false),
        ("precedence.tmp", false),
        ("parent", true),
        ("parent/.gitignore", false),
        ("parent/keep.txt", false),
        ("sub", true),
        ("sub/.gitignore", false),
        ("sub/drop.log", false),
        ("sub/nested.tmp", false),
        ("sub/drop.tmp", false),
        ("sub/allow.tmp", false),
        ("sub/nested-only.txt", false),
        ("sub/nested-dir", true),
        ("sub/nested-dir/child.txt", false),
        ("sub/nested-dir/allow.txt", false),
        ("other", true),
        ("other/nested-only.txt", false),
        ("other/cache", true),
        ("other/cache/file.txt", false),
        ("other/outside.txt", false),
    ];

    for (path, is_dir) in candidates {
        let ignored = check_ignore(root, path, is_dir);
        assert_eq!(
            actual.contains(path),
            !ignored,
            "filemap disagrees with git check-ignore for {path}: ignored={ignored}\n{}",
            run_filemap(root)
        );
    }
}

#[test]
fn retains_standard_ignores_outside_git_repositories() {
    let temp = TempDir::new("standalone");
    let root = temp.path();
    write_file(root, "visible.txt", "visible\n");
    write_file(root, "node_modules/package/index.js", "ignored directory\n");
    write_file(root, "target/debug/output", "ignored directory\n");
    write_file(root, ".hidden/secret.txt", "hidden\n");

    let output = run_filemap(root);
    let actual = displayed_paths(&output);
    assert!(actual.contains("visible.txt"), "{output}");
    assert!(!actual.contains("node_modules"), "{output}");
    assert!(!actual.contains("target"), "{output}");
    assert!(!actual.contains(".hidden"), "{output}");
}

#[test]
fn extension_checkout_hides_the_original_ignored_directories() {
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("native crate has package parent")
        .to_path_buf();
    let candidates = [("native/target", true), ("node_modules", true)];

    for (path, is_dir) in candidates {
        assert!(
            check_ignore(&package, path, is_dir),
            "the extension checkout must ignore {path}"
        );
    }
    let actual = displayed_paths(&run_filemap(&package));
    assert!(!actual.contains("native/target"), "native/target was listed");
    assert!(!actual.contains("node_modules"), "node_modules was listed");
}
