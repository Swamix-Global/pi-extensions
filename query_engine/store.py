"""Private evidence cache store for the fanout engine.

Pure Python stdlib. Callers must supply a canonical folder; identical realpaths
share one store. ``open_index`` returns a live connection the caller closes
(e.g. with ``contextlib.closing``). Only ``project`` identity and the
content-hash-keyed ``evidence_cache`` table live here; window payloads
invalidate themselves when a file's hash changes.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
from pathlib import Path
from urllib.parse import quote

__all__ = [
    "location",
    "open_index",
]


def _default_store_dir() -> str:
    override = os.environ.get("PI_QUERY_STORE_DIR")
    if override:
        return override
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".pi", "agent"
    )
    return os.path.join(agent_dir, "query-engine")


def location(folder: str, store_dir=None) -> Path:
    """Return the canonical per-folder database path ``<sha256(folder)>.db``."""
    raw = store_dir if store_dir is not None else _default_store_dir()
    directory = os.fspath(raw)
    if not os.path.isabs(directory) or not os.path.isabs(folder):
        raise ValueError("Folder and store paths must be absolute")
    directory = os.path.abspath(directory)
    key = hashlib.sha256(os.fspath(folder).encode("utf-8")).hexdigest()
    return Path(directory) / f"{key}.db"


def _mkdir_private(directory: Path) -> None:
    """Create ``directory`` and any missing parents with mode 0700."""
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        parent = current.parent
        if parent == current:
            break
        current = parent
    for path_ in reversed(missing):
        os.mkdir(path_, 0o700)


def _safe_directory(directory: Path, create: bool) -> bool:
    """Validate ancestors, then optionally create and chmod the store dir."""
    current = directory
    while True:
        try:
            st = os.lstat(current)
            if not stat.S_ISDIR(st.st_mode):
                raise RuntimeError(
                    f"Index store ancestor must be a directory, not a symlink: {current}"
                )
        except FileNotFoundError:
            pass
        parent = current.parent
        if parent == current:
            break
        current = parent

    if create:
        _mkdir_private(directory)

    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        if not create:
            return False
        raise

    if not stat.S_ISDIR(st.st_mode) or os.path.realpath(directory) != str(directory):
        raise RuntimeError(
            f"Index store must be a real directory, not a symlink: {directory}"
        )
    if create:
        os.chmod(directory, 0o700)
    return True


def _safe_database(database: Path) -> None:
    """Refuse symlinked/hardlinked databases and SQLite sidecars."""
    for suffix in ("", "-journal", "-wal", "-shm"):
        candidate = Path(f"{database}{suffix}")
        try:
            st = os.lstat(candidate)
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise RuntimeError(
                f"Unsafe index database or sidecar (symlink/hardlink): {candidate}"
            )


def _verify_folder(db: sqlite3.Connection, folder: str) -> None:
    row = db.execute("SELECT folder FROM project WHERE id = 1").fetchone()
    if row is None or row["folder"] != folder:
        raise RuntimeError(
            "Index folder identity mismatch; refusing another folder's index."
        )


def open_index(folder: str, database: Path) -> sqlite3.Connection:
    """Create the private store if needed and return a live connection.

    The schema is ``project`` and ``evidence_cache``. The caller owns and
    closes the returned connection (use ``contextlib.closing``).
    """
    database = Path(database)
    _safe_directory(database.parent, True)
    _safe_database(database)

    fd = os.open(database, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.fstat(fd).st_nlink != 1:
            raise RuntimeError("Hardlinked index database refused.")
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)

    db = sqlite3.connect(database)
    db.isolation_level = None
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY CHECK(id=1), folder TEXT NOT NULL)")
            db.execute("INSERT OR IGNORE INTO project(id, folder) VALUES (1, ?)", (folder,))
            _verify_folder(db, folder)
            db.execute("CREATE TABLE IF NOT EXISTS evidence_cache "
                       "(key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        return db
    except BaseException:
        db.close()
        raise
