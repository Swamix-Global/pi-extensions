"""Index store for the query engine, ported from lib/index-store.mjs.

Pure Python stdlib. Callers must supply a canonical folder; identical realpaths
share one index. ``open_index`` returns a live connection that the caller closes
(e.g. with ``contextlib.closing``); ``read_index`` opens and closes its own
read-only connection and never writes.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
from contextlib import closing
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote

__all__ = [
    "location",
    "read_index",
    "open_index",
    "read_rows",
    "pending_files",
]

_SCHEMA = """\
PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  folder TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  index_time TEXT NOT NULL
);
"""


def _default_store_dir() -> str:
    override = os.environ.get("PI_QUERY_STORE_DIR")
    if override:
        return override
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".pi", "agent"
    )
    return os.path.join(agent_dir, "query-engine")


def location(folder: str, store_dir: Any = None) -> Path:
    """Return the canonical per-folder database path ``<sha256(folder)>.db``.

    ``store_dir`` overrides ``PI_QUERY_STORE_DIR``; otherwise the store lives
    under ``PI_CODING_AGENT_DIR`` (or ``~/.pi/agent``) in ``query-engine``.
    ``os.path.abspath`` normalizes without dereferencing symlinks, matching
    ``path.resolve`` in the original.
    """
    raw = store_dir if store_dir is not None else _default_store_dir()
    directory = os.path.abspath(os.fspath(raw))
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
    """Validate ancestors, then optionally create and chmod the store dir.

    Existing ancestors are lstat'd first so a missing child is never created
    through a symlinked parent. This is a private per-user cache, not a sandbox
    against another process under the same OS account swapping paths mid-call.
    """
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
    """Refuse symlinked/hardlinked databases and SQLite sidecars.

    SQLite may use ``-journal``, ``-wal`` and ``-shm`` sidecars; their links are
    refused even when the database itself is absent.
    """
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
            "Index folder identity mismatch; refusing another folder's summaries."
        )


def read_rows(db: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    """Return ``{path: rowdict}`` ordered by binary path."""
    return {
        row["path"]: dict(row)
        for row in db.execute("SELECT * FROM files ORDER BY path COLLATE BINARY")
    }


def read_index(folder: str, database: Path) -> dict[str, dict[str, Any]]:
    """Read a cache snapshot without writing anything.

    Read-only rollback-journal databases do not create WAL/SHM sidecars. Missing
    stores stay missing; dry runs never create directories, schema or journals.
    A WAL-mode database is refused from its on-disk header before any connection
    is constructed, because a read-only WAL open can still create sidecars.
    """
    database = Path(database)
    if not _safe_directory(database.parent, False):
        return {}
    _safe_database(database)

    try:
        fd = os.open(database, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return {}
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        header = os.read(fd, 20)
    finally:
        os.close(fd)

    if len(header) == 20 and (header[18] == 2 or header[19] == 2):
        raise RuntimeError(
            "Dry run requires a rollback-journal index; refusing WAL sidecar writes."
        )

    uri = f"file:{quote(str(database))}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        journal_mode = db.execute("PRAGMA journal_mode").fetchone()[0]
        if journal_mode == "wal":
            raise RuntimeError(
                "Dry run requires a rollback-journal index; refusing WAL sidecar writes."
            )
        _verify_folder(db, folder)
        return read_rows(db)


def open_index(folder: str, database: Path) -> sqlite3.Connection:
    """Create the private store if needed and return a live connection.

    The schema is exactly ``project`` and ``files``. The caller owns and closes
    the returned connection (use ``contextlib.closing``).
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
    # Match DatabaseSync's autocommit behaviour.
    db.isolation_level = None
    db.row_factory = sqlite3.Row
    try:
        db.executescript(_SCHEMA)
        db.execute("INSERT OR IGNORE INTO project(id, folder) VALUES (1, ?)", (folder,))
        _verify_folder(db, folder)
        return db
    except BaseException:
        db.close()
        raise


def _content_hash(entry: Any) -> Any:
    if isinstance(entry, Mapping):
        return entry["content_hash"]
    return entry.content_hash


def pending_files(
    files: Mapping[str, Any], old: Mapping[str, Any]
) -> dict[str, list[str]]:
    """Categorize current ``files`` against cached ``old`` rows by content hash."""
    pending: dict[str, list[str]] = {
        "added": [],
        "changed": [],
        "deleted": [],
        "unchanged": [],
    }
    for name, entry in files.items():
        if name not in old:
            pending["added"].append(name)
        elif _content_hash(old[name]) != _content_hash(entry):
            pending["changed"].append(name)
        else:
            pending["unchanged"].append(name)
    for name in old:
        if name not in files:
            pending["deleted"].append(name)
    return pending
