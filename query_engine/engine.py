"""Absolute-path source scanning, hash-only sync and local lexical retrieval."""
import hashlib
import os
import stat
import subprocess
from contextlib import closing
from pathlib import Path

from .retrieval import rank_sources
from .store import location, open_index, pending_files, read_index, read_rows

SOURCE_EXTENSIONS = set(".py .js .jsx .mjs .cjs .md .ts .tsx .html .css .svelte .txt .sh .bash .yaml .yml .toml".split())
IGNORED_DIRECTORIES = set("node_modules .venv venv .git __pycache__ .pytest_cache .mypy_cache .ruff_cache .cache .svelte-kit .next dist build coverage hf-cache .tmp".split())


def canonical(folder):
    """Require an absolute existing folder and resolve its canonical identity."""
    if not isinstance(folder, str) or not folder.strip() or not os.path.isabs(folder):
        raise ValueError("An explicit absolute folder path is required")
    root = Path(folder).resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"Not a folder: {root}")
    return str(root)


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
    """Read every eligible UTF-8 source with SHA-256 byte hashes and absolute paths."""
    root = canonical(root)
    in_git = respect_gitignore and is_git_repo(root)
    files = {}

    def walk(directory):
        with os.scandir(directory) as iterator:
            entries = sorted(iterator, key=lambda entry: entry.name)
        tokenizer = any(e.name in ("tokenizer.json", "tokenizer_config.json")
                        and e.is_file(follow_symlinks=False) for e in entries)
        candidates = []
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name not in IGNORED_DIRECTORIES:
                    candidates.append(entry)
            elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in SOURCE_EXTENSIONS:
                if not (tokenizer and entry.name in ("merges.txt", "vocab.txt")):
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
            content = raw.decode("utf-8")
            if "\0" in content:
                raise ValueError(f"Source contains binary data: {path}")
            files[str(path)] = {"path": str(path), "content": content, "content_hash": hashlib.sha256(raw).hexdigest()}

    walk(root)
    return dict(sorted(files.items()))


def same_sources(a, b):
    """Compare content hashes only, never timestamps or sizes."""
    return {k: v["content_hash"] for k, v in a.items()} == {k: v["content_hash"] for k, v in b.items()}


def plan_project(folder, store_dir=None):
    """Preview exact hash changes without writes, migrations or network calls."""
    root = canonical(folder)
    database = location(root, store_dir)
    files, old = scan_sources(root), read_index(root, database)
    pending = pending_files(files, old)
    return {"dryRun": True, "folder": root, "database": str(database), "indexed": len(old),
            "eligible": len(files), "pending": pending,
            "sync": {"updated": len(pending["added"]) + len(pending["changed"]),
                     "deleted": len(pending["deleted"]), "unchanged": len(pending["unchanged"])}}


def sync_index(root, database, progress=lambda text: None, reindex=False):
    """Delete stale rows first, then atomically override current hashes; invalidate failed syncs."""
    with closing(open_index(root, database)) as db:
        try:
            db.execute("BEGIN IMMEDIATE")
            files = scan_sources(root)
            old = read_rows(db)
            pending = pending_files(files, old)
            changed = sorted(files) if reindex else sorted(pending["added"] + pending["changed"])
            stale = list(old) if reindex else pending["deleted"] + pending["changed"]
            db.executemany("DELETE FROM files WHERE path=?", ((path,) for path in stale))
            progress(f"Sync: {len(files)} files; {len(changed)} indexed; {len(pending['deleted'])} deleted")
            db.executemany("INSERT INTO files(path,content_hash) VALUES (?,?)",
                           ((path, files[path]["content_hash"]) for path in changed))
            if not same_sources(files, read_rows(db)):
                raise RuntimeError("Index hash mismatch; index invalidated, rerun query")
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
    return files, {"updated": len(changed), "deleted": len(pending["deleted"]),
                   "unchanged": 0 if reindex else len(pending["unchanged"])}


def query_project(folder, question=None, dry_run=False, index_only=False, store_dir=None,
                  progress=lambda text: None, reindex=False):
    """Synchronize hashes and return locally ranked source evidence with no inference."""
    if any(not isinstance(flag, bool) for flag in (dry_run, index_only, reindex)):
        raise ValueError("dry_run, index_only and reindex must be booleans")
    if dry_run:
        if reindex:
            raise ValueError("dry_run cannot be combined with reindex")
        return plan_project(folder, store_dir)
    if not index_only and (not isinstance(question, str) or not question.strip()):
        raise ValueError("A non-empty question is required")
    root = canonical(folder)
    database = location(root, store_dir)
    files, sync = sync_index(root, database, progress, reindex)
    result = {"dryRun": False, "folder": root, "database": str(database), "indexed": len(files), "sync": sync}
    if index_only:
        result["indexOnly"] = True
    else:
        ranked = rank_sources(files, question)
        result.update({"answer": f"Found {len(ranked)} lexical matches ranked by BM25 + TF-IDF (RRF)." if ranked
                       else "No lexical matches found; try exact symbols or different search terms.",
                       "files": ranked, "limitations": ["Lexical retrieval, not semantic inference; read full sources before editing."]})
    return result
