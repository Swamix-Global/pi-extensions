"""Per-folder indexer with Qdrant service integration and SGLang.

Features:
- Discovers folders containing AGENTS.md (case-insensitive).
- Filters out gitignored directories and files using native git integration.
- Incremental indexing: SHA-256 byte hashing guarantees only added/modified files are processed.
- Qdrant service integration: stores vectors in per-folder collections (folder_<hash>).
- Progress reporting and atomic persistence to SQLite + Qdrant.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from .engine import canonical, scan_sources, summarize, same_sources, is_git_repo
from .models import local_client
from .store import location, open_index, read_rows, pending_files
from . import qdrant


def find_agent_folders(search_roots: list[str | Path]) -> list[Path]:
    """Find all top-level project folders containing an AGENTS.md or agents.md file."""
    discovered: set[Path] = set()
    for root in search_roots:
        root_path = Path(root).resolve()
        if not root_path.exists():
            continue
        for candidate in ("AGENTS.md", "agents.md", "AGENTS.MD"):
            if (root_path / candidate).is_file():
                discovered.add(root_path)

        try:
            for dirpath, dirnames, filenames in os.walk(root_path):
                # Filter out standard ignored and deep sub-worktrees
                dirnames[:] = [d for d in dirnames if d not in (
                    "node_modules", ".git", "venv", ".venv", "__pycache__", ".tmp",
                    "hf-cache", ".cache", "logs", ".kilo", "dist", "build"
                )]
                p = Path(dirpath)
                for candidate in ("AGENTS.md", "agents.md", "AGENTS.MD"):
                    if candidate in filenames and (p / candidate).is_file():
                        # Exclude internal hidden dirs or logs
                        if not any(part.startswith(".") for part in p.relative_to(root_path).parts):
                            discovered.add(p)
        except Exception:
            continue
    return sorted(discovered)


def index_folder(
    folder: str | Path,
    local=None,
    progress: Callable[[str], None] = lambda text: None,
    use_qdrant: bool = True
) -> dict[str, Any]:
    """Index an individual folder into SQLite store and Qdrant collection.

    Only processes what is required (incremental sync based on SHA-256 hashes).
    Respects gitignore.
    """
    root = canonical(str(folder))
    progress(f"[*] Starting index for folder: {root}")

    local = local or local_client()
    local.check()

    database = location(root)
    col_name = qdrant.collection_name_for_folder(root)

    # 1. Scan sources (respecting gitignore and source extensions)
    files = scan_sources(root)
    progress(f"[*] Scanned {len(files)} eligible (non-ignored) source files in {root}")

    # 2. Check existing state in SQLite
    with open_index(root, database) as db:
        old_rows = read_rows(db)
        pending = pending_files(files, old_rows)
        changed = sorted(pending["added"] + pending["changed"])

        progress(f"[*] Sync state: {len(changed)} changed/new, {len(pending['deleted'])} deleted, {len(pending['unchanged'])} unchanged")

        if changed:
            progress(f"[*] Generating summaries with SGLang for {len(changed)} files...")
            for idx, name in enumerate(changed, 1):
                t0 = time.perf_counter()
                row = summarize(files[name], local)
                dur = time.perf_counter() - t0
                progress(f"[{idx}/{len(changed)}] Summarized: {name} in {dur:.2f}s")

                # Incremental commit per file to avoid losing work
                db.execute("BEGIN IMMEDIATE")
                try:
                    db.execute("""INSERT INTO files(path,summary,content_hash,index_time)
                        VALUES (:path,:summary,:content_hash,:index_time)
                        ON CONFLICT(path) DO UPDATE SET summary=excluded.summary,
                        content_hash=excluded.content_hash,index_time=excluded.index_time
                        WHERE files.content_hash != excluded.content_hash""", row)
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise

        if pending["deleted"]:
            db.execute("BEGIN IMMEDIATE")
            try:
                for name in pending["deleted"]:
                    db.execute("DELETE FROM files WHERE path=?", (name,))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

        current_rows = read_rows(db)

    # 3. Synchronize with Qdrant vector database
    qdrant_synced = False
    if use_qdrant and qdrant.is_qdrant_alive():
        progress(f"[*] Syncing vector index to Qdrant collection '{col_name}'...")
        qdrant.ensure_collection(col_name)
        qdrant_points = qdrant.get_indexed_points(col_name)

        # Find points needing embedding update
        points_to_update = []
        texts_to_embed = []
        for path_key, row in current_rows.items():
            cached_pt = qdrant_points.get(path_key)
            if not cached_pt or cached_pt.get("content_hash") != row["content_hash"]:
                points_to_update.append(row)
                texts_to_embed.append(f"{row['path']}: {row['summary']}")

        # Points to delete from Qdrant
        points_to_delete = [
            cached_pt["id"] for path_key, cached_pt in qdrant_points.items()
            if path_key not in current_rows and cached_pt.get("id")
        ]

        if points_to_delete:
            progress(f"[*] Deleting {len(points_to_delete)} stale points from Qdrant...")
            qdrant.delete_points(col_name, points_to_delete)

        if points_to_update:
            progress(f"[*] Computing embeddings for {len(points_to_update)} updated files...")
            embs = qdrant.get_embeddings(texts_to_embed)
            upsert_batch = []
            for row, emb in zip(points_to_update, embs):
                pt_id = qdrant.uuid_for_path(root, row["path"])
                upsert_batch.append({
                    "id": pt_id,
                    "vector": emb,
                    "payload": {
                        "folder": root,
                        "path": row["path"],
                        "summary": row["summary"],
                        "content_hash": row["content_hash"],
                        "index_time": row["index_time"]
                    }
                })
            qdrant.upsert_points(col_name, upsert_batch)
            progress(f"[*] Upserted {len(upsert_batch)} vectors into Qdrant collection '{col_name}'.")
        else:
            progress(f"[*] All {len(current_rows)} points in Qdrant already up to date.")

        qdrant_synced = True

    return {
        "folder": root,
        "database": str(database),
        "qdrant_collection": col_name,
        "qdrant_synced": qdrant_synced,
        "total_files": len(current_rows),
        "updated": len(changed),
        "deleted": len(pending["deleted"]),
        "unchanged": len(pending["unchanged"])
    }


def auto_index_all_agent_folders(
    search_roots: list[str | Path] | None = None,
    progress: Callable[[str], None] = lambda text: None
) -> list[dict[str, Any]]:
    """Scan search roots for folders with AGENTS.md and auto-index all of them."""
    if search_roots is None:
        search_roots = ["/home/ubuntu/src"]

    folders = find_agent_folders(search_roots)
    progress(f"[*] Auto-indexer discovered {len(folders)} folders containing AGENTS.md:")
    for f in folders:
        progress(f"    - {f}")

    results = []
    for f in folders:
        try:
            res = index_folder(f, progress=progress)
            results.append(res)
        except Exception as e:
            progress(f"[!] Error indexing {f}: {e}")
            results.append({"folder": str(f), "error": str(e)})

    return results
