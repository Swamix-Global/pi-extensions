"""Absolute-path source scanning for the fanout evidence engine.

Reads every eligible UTF-8 source with SHA-256 byte hashes and absolute paths.
No index, no embeddings, no network: fanout windows are scored from these
scans directly, so nothing here depends on external services.
"""
import hashlib
import os
import stat
import subprocess
from pathlib import Path

# Source and build text only; data/config formats (txt, html, json, yaml, toml) and
# unlisted Markdown stay out so evidence maps code structure, not noise.
# Contract scope overrides below add contract Markdown and YAML.
SOURCE_EXTENSIONS = {
    # C, C++, systems and other compiled languages
    ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".cxx", ".hxx", ".ino", ".m", ".mm",
    ".cs", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".groovy", ".swift", ".dart",
    ".zig", ".nim", ".v", ".asm", ".s", ".f90", ".f95", ".f03", ".f08",
    # Interpreted, functional and concurrent languages
    ".py", ".rb", ".rake", ".php", ".pl", ".pm", ".lua", ".r", ".jl", ".ex", ".exs",
    ".erl", ".hrl", ".clj", ".cljs", ".cljc", ".hs", ".lhs", ".ml", ".mli", ".fs",
    ".fsi", ".fsx", ".vb", ".elm", ".awk", ".sed", ".tcl",
    # Shells, batch files and PowerShell
    ".sh", ".bash", ".zsh", ".ksh", ".dash", ".csh", ".tcsh", ".fish", ".nu", ".bat",
    ".cmd", ".ps1", ".psm1", ".psd1",
    # Frontend sources, components and stylesheets
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".svelte", ".vue", ".astro",
    ".css", ".scss", ".sass", ".less", ".styl",
    # SQL and build sources
    ".sql", ".cmake", ".mk", ".mak", ".ninja", ".gradle", ".bazel", ".bzl", ".sbt",
    ".m4", ".am", ".ac", ".nix", ".pro", ".pri", ".spec", ".dockerfile",
}
NAMED_SOURCE_FILES = {"Makefile", "makefile", "GNUmakefile", "Dockerfile", "Jenkinsfile"}
MARKDOWN_FILENAMES = {"readme.md", "agents.md", "claude.md", "contributing.md", "architecture.md"}
IGNORED_DIRECTORIES = set("node_modules .venv venv .git __pycache__ .pytest_cache .mypy_cache .ruff_cache .cache .svelte-kit .next dist build coverage hf-cache .tmp".split())

# A query whose canonical root itself is this relative path gets contract scope:
# contract Markdown is eligible and Git ignore checks are skipped only there.
CONTRACT_SCOPE_PARTS = (".pi", "subagents", "contracts")


def canonical(folder):
    """Require an absolute existing folder and resolve its canonical identity."""
    if not isinstance(folder, str) or not folder.strip() or not os.path.isabs(folder):
        raise ValueError("An explicit absolute folder path is required")
    root = Path(folder).resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"Not a folder: {root}")
    return str(root)


def is_contract_scope(root):
    """True only when the canonical root itself is a .pi/subagents/contracts folder."""
    return Path(root).parts[-len(CONTRACT_SCOPE_PARTS):] == CONTRACT_SCOPE_PARTS


def is_git_repo(root):
    """Detect Git scope without inspecting credentials or following external files."""
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                            capture_output=True, text=True, timeout=5)
    return result.returncode == 0 and result.stdout.strip() == "true"


def git_ignored(root, paths):
    """Batch Git ignore checks with NUL delimiters, including paths containing newlines."""
    if not paths:
        return set()
    result = subprocess.run(["git", "-C", root, "check-ignore", "-z", "--stdin"],
                            input="\0".join(paths) + "\0", capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1):
        raise RuntimeError(f"Git ignore check failed for {root}: {result.stderr.strip()}")
    return set(result.stdout.rstrip("\0").split("\0")) if result.stdout else set()


def scan_sources(root, respect_gitignore=True):
    """Read every eligible UTF-8 source with SHA-256 byte hashes and absolute paths.

    Contract-scope roots additionally read contract Markdown and YAML, skip Git
    ignore checks and never descend into ``*.claim`` directories.
    """
    root = canonical(root)
    contracts = is_contract_scope(root)
    in_git = respect_gitignore and not contracts and is_git_repo(root)
    files = {}

    def is_source(entry):
        """Select curated names, known suffixes or executable extensionless scripts."""
        if entry.name in NAMED_SOURCE_FILES or entry.name.lower() in MARKDOWN_FILENAMES:
            return True
        suffix = Path(entry.name).suffix.lower()
        if suffix in {".md", ".yaml"} and contracts:
            return True
        if suffix:
            return suffix in SOURCE_EXTENSIONS
        return bool(entry.stat(follow_symlinks=False).st_mode & 0o111)

    def walk(directory):
        with os.scandir(directory) as iterator:
            entries = sorted(iterator, key=lambda entry: entry.name)
        candidates = []
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name not in IGNORED_DIRECTORIES and not (contracts and entry.name.endswith(".claim")):
                    candidates.append(entry)
            elif entry.is_file(follow_symlinks=False) and is_source(entry):
                candidates.append(entry)
        ignored = git_ignored(root, [e.path + ("/" if e.is_dir(follow_symlinks=False) else "")
                                     for e in candidates]) if in_git else set()
        for entry in candidates:
            path = Path(entry.path)
            if str(path) in ignored or str(path) + "/" in ignored:
                continue
            if entry.is_dir(follow_symlinks=False):
                walk(str(path))
                continue
            if path.resolve() != path or not path.is_relative_to(root):
                raise RuntimeError(f"Source path changed: {path}")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise RuntimeError(f"Source is not a regular file: {path}")
                raw = handle.read()
            if not path.suffix and path.name not in NAMED_SOURCE_FILES and not raw.startswith(b"#!"):
                continue
            content = raw.decode("utf-8")
            if "\0" in content:
                raise ValueError(f"Source contains binary data: {path}")
            files[str(path)] = {"path": str(path), "content": content, "content_hash": hashlib.sha256(raw).hexdigest()}

    walk(root)
    return dict(sorted(files.items()))


def enumerate_files(folder):
    """List eligible files with physical line counts; no model or network calls."""
    files = scan_sources(folder)
    return {"eligible": len(files),
            "files": [{"path": entry["path"], "lines": len(entry["content"].split("\n"))}
                      for entry in files.values()]}
