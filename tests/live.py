"""Live CLI scenarios: real ``python3 -B cli.py`` subprocesses over disposable
absolute source/store paths with ``PI_QUERY_STORE_DIR``. No mocks, network,
inference, unittest or query_engine imports; store state is observed with
sqlite3 only. Run: ``python3 -B tests/live.py``."""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli.py"


def _run(store, *args):
    """Run the real CLI with --json and an absolute PI_QUERY_STORE_DIR override."""
    env = {**os.environ, "PI_QUERY_STORE_DIR": os.path.abspath(str(store))}
    return subprocess.run(["python3", "-B", str(CLI), *args, "--json"],
                          env=env, capture_output=True, text=True)


def _load(proc):
    """Parse the single JSON document the CLI prints on stdout."""
    assert proc.stdout.strip(), f"no JSON output; stderr: {proc.stderr}"
    return json.loads(proc.stdout)


def _database(store, root):
    """Return the per-folder database path the CLI derives from a canonical root."""
    key = hashlib.sha256(os.path.realpath(str(root)).encode("utf-8")).hexdigest()
    return Path(store) / (key + ".db")


def _rows(db):
    """Return {absolute path: content_hash} rows from the store database."""
    with sqlite3.connect(db) as conn:
        return dict(conn.execute("SELECT path, content_hash FROM files"))


def _sha(path):
    """Return a file's actual SHA-256 byte digest."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def scenario_dry_run_and_query():
    """Scenario 1: dry-run leaves no store; a real query returns verbatim tail evidence."""
    with tempfile.TemporaryDirectory(prefix="query-live-s1-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"
        lines = [f"filler line {i:04d}" for i in range(1999)]
        lines[1899] = "UNIQUE_TAIL_MARKER = compute()"
        tail = root / "tail.py"
        tail.write_text("\n".join(lines) + "\n", encoding="utf-8")
        other = root / "other.py"
        other.write_text("def unrelated(): return 1\n", encoding="utf-8")

        # Dry-run: same scanner/hashes, absolute pending paths, no store created.
        dry = _run(store, "--folder", str(root), "--dry-run")
        assert dry.returncode == 0, dry.stderr
        plan = _load(dry)
        assert plan["dryRun"] is True
        assert plan["pending"]["added"] == [str(other), str(tail)]
        assert plan["database"] == str(_database(store, root))
        assert Path(plan["database"]).is_absolute()
        assert not store.exists(), "dry-run must not create the store"

        # Real query: absolute path, verbatim bounded tail excerpt, positive fused scores.
        found = _run(store, "--folder", str(root), "--question", "unique_tail_marker")
        assert found.returncode == 0, found.stderr
        result = _load(found)
        top = result["files"][0]
        assert top["path"] == str(tail) and Path(top["path"]).is_absolute()
        assert top["line"] == 1900
        assert top["excerpt"] in tail.read_text(encoding="utf-8"), "excerpt must be verbatim"
        assert len(top["excerpt"]) <= 1200
        assert top["bm25"] > 0 and top["tfidf"] > 0 and top["score"] > 0
        assert result["sync"] == {"updated": 2, "deleted": 0, "unchanged": 0}

        # Minimal schema: exactly project + files(path, content_hash).
        db = _database(store, root)
        assert _rows(db) == {str(other): _sha(other), str(tail): _sha(tail)}
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == ["path", "content_hash"]
            assert {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {"project", "files"}
            assert conn.execute("SELECT folder FROM project WHERE id=1").fetchone()[0] == str(root)

        # No match returns an empty list, not invented evidence.
        none = _load(_run(store, "--folder", str(root), "--question", "absent_symbol_xyz"))
        assert none["files"] == [] and "No lexical matches" in none["answer"]

        # Relative source folder is a runtime failure.
        rel = _run(store, "--folder", "relative", "--dry-run")
        assert rel.returncode == 1 and "absolute" in _load(rel)["error"]


def scenario_hash_lifecycle():
    """Scenario 2: hash-only freshness, read-only dry-run, deletion and forced reindex."""
    with tempfile.TemporaryDirectory(prefix="query-live-s2-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"
        alpha = root / "alpha.py"
        alpha.write_text("def addition(a, b): return a + b\n", encoding="utf-8")
        beta = root / "beta.py"
        beta.write_text("echo add\n", encoding="utf-8")

        first = _load(_run(store, "--folder", str(root), "--index-only"))
        assert first["sync"] == {"updated": 2, "deleted": 0, "unchanged": 0}
        db = _database(store, root)
        assert _rows(db) == {str(alpha): _sha(alpha), str(beta): _sha(beta)}

        # Real trigger records every deleted path, proving stale rows leave before replacements.
        with sqlite3.connect(db) as conn:
            conn.execute("CREATE TABLE deletes(path TEXT)")
            conn.execute("CREATE TRIGGER record_delete AFTER DELETE ON files "
                         "BEGIN INSERT INTO deletes VALUES (OLD.path); END")

        # Equal-length edit with the original mtime restored still reindexes by hash.
        before = alpha.stat()
        alpha.write_text("def addition(a, b): return a - b\n", encoding="utf-8")
        os.utime(alpha, ns=(before.st_atime_ns, before.st_mtime_ns))
        assert alpha.stat().st_size == before.st_size and alpha.stat().st_mtime_ns == before.st_mtime_ns
        changed = _load(_run(store, "--folder", str(root), "--index-only"))
        assert changed["sync"] == {"updated": 1, "deleted": 0, "unchanged": 1}
        assert _rows(db) == {str(alpha): _sha(alpha), str(beta): _sha(beta)}
        with sqlite3.connect(db) as conn:
            assert [r[0] for r in conn.execute("SELECT path FROM deletes")] == [str(alpha)]

        # Dry-run is read-only: database bytes are untouched.
        before_bytes = db.read_bytes()
        dry = _load(_run(store, "--folder", str(root), "--dry-run"))
        assert dry["pending"] == {"added": [], "changed": [], "deleted": [],
                                  "unchanged": [str(alpha), str(beta)]}
        assert db.read_bytes() == before_bytes, "dry-run must not change database bytes"

        # Deletion removes the stale row.
        beta.unlink()
        removed = _load(_run(store, "--folder", str(root), "--index-only"))
        assert removed["sync"] == {"updated": 0, "deleted": 1, "unchanged": 1}
        assert _rows(db) == {str(alpha): _sha(alpha)}

        # Force reindex replaces the unchanged row: trigger proves delete before insert.
        with sqlite3.connect(db) as conn:
            conn.execute("DELETE FROM deletes")
        forced = _load(_run(store, "--folder", str(root), "--index-only", "--reindex"))
        assert forced["sync"] == {"updated": 1, "deleted": 0, "unchanged": 0}
        assert _rows(db) == {str(alpha): _sha(alpha)}
        with sqlite3.connect(db) as conn:
            assert [r[0] for r in conn.execute("SELECT path FROM deletes")] == [str(alpha)]


def scenario_legacy_invalid_and_refusals():
    """Scenario 3: legacy migration, invalid UTF-8 invalidation and store refusals."""
    with tempfile.TemporaryDirectory(prefix="query-live-s3-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"
        store.mkdir()
        source = root / "marker.py"
        source.write_text("def legacy_marker(): return 1\n", encoding="utf-8")
        db = _database(store, root)
        with sqlite3.connect(db) as conn:
            conn.executescript(
                "CREATE TABLE project(id INTEGER PRIMARY KEY, folder TEXT);"
                "CREATE TABLE files(path TEXT PRIMARY KEY, summary TEXT, content_hash TEXT, index_time TEXT);"
                "CREATE TABLE map_cache(signature TEXT PRIMARY KEY, parts TEXT);")
            conn.execute("INSERT INTO project VALUES (1, ?)", (str(root),))
            conn.execute("INSERT INTO files VALUES (?, 'obsolete', ?, 'yesterday')",
                         (str(source), _sha(source)))

        # Legacy dry-run previews the changed row without migrating or writing.
        before = db.read_bytes()
        preview = _load(_run(store, "--folder", str(root), "--dry-run"))
        assert preview["indexed"] == 1
        assert preview["pending"]["changed"] == [str(source)]
        assert db.read_bytes() == before, "dry-run must not migrate the legacy database"
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == \
                ["path", "summary", "content_hash", "index_time"]
            assert conn.execute("SELECT name FROM sqlite_master WHERE name='map_cache'").fetchone()

        # Writable sync rebuilds to the minimal schema and rehashes the source.
        rebuilt = _load(_run(store, "--folder", str(root), "--question", "legacy_marker"))
        assert rebuilt["sync"] == {"updated": 1, "deleted": 0, "unchanged": 0}
        assert rebuilt["files"][0]["path"] == str(source)
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == ["path", "content_hash"]
            assert conn.execute("SELECT name FROM sqlite_master WHERE name='map_cache'").fetchone() is None
        assert _rows(db) == {str(source): _sha(source)}

        # Invalid UTF-8 scan exits nonzero, preserves cached rows; repaired source succeeds.
        bad = root / "bad.py"
        bad.write_bytes(b"legacy_marker \xff")
        failed = _run(store, "--folder", str(root), "--index-only")
        assert failed.returncode == 1 and "utf-8" in _load(failed)["error"].lower()
        assert _rows(db) == {str(source): _sha(source)}, "failed scan must preserve cached rows"
        bad.write_text("def repaired_marker(): return 2\n", encoding="utf-8")
        repaired = _load(_run(store, "--folder", str(root), "--question", "repaired_marker"))
        assert repaired["sync"] == {"updated": 1, "deleted": 0, "unchanged": 1}
        assert repaired["files"][0]["path"] == str(bad)
        assert _rows(db) == {str(source): _sha(source), str(bad): _sha(bad)}

        # Cross-folder identity, hardlinked database and symlinked store are refused.
        other = base / "other"
        other.mkdir()
        shutil.copy2(db, _database(store, other))
        mismatch = _run(store, "--folder", str(other), "--dry-run")
        assert mismatch.returncode == 1 and "identity" in _load(mismatch)["error"]

        linked = store / "linked.db"
        os.link(db, linked)
        unsafe = _run(store, "--folder", str(root), "--dry-run")
        assert unsafe.returncode == 1 and "Unsafe index database" in _load(unsafe)["error"]
        linked.unlink()

        alias = base / "alias"
        alias.symlink_to(root)
        symlinked = _run(alias / "cache", "--folder", str(root), "--dry-run")
        assert symlinked.returncode == 1 and "symlink" in _load(symlinked)["error"]


def main():
    """Run the three real CLI scenarios and print one PASS line per scenario."""
    scenario_dry_run_and_query()
    print("PASS scenario 1: dry-run creates no store; query returns absolute verbatim tail match with "
          "positive BM25/TF-IDF/RRF scores, minimal schema, empty no-match and relative folder error")
    scenario_hash_lifecycle()
    print("PASS scenario 2: mtime-preserving equal-length edit reindexes; dry-run keeps database bytes; "
          "deletion removes rows; forced reindex deletes before insert; stored hashes match SHA-256")
    scenario_legacy_invalid_and_refusals()
    print("PASS scenario 3: legacy summary migration previews read-only then rebuilds; invalid UTF-8 exits "
          "nonzero and preserves cached rows before repair; cross-folder, hardlinked database and symlinked store refused")


if __name__ == "__main__":
    main()
