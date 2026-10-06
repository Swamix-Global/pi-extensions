"""Scan → atomic sync → hierarchical map → typed decisions. No hidden agent loop."""
import hashlib
import json
import os
import stat
import subprocess
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .store import location, open_index, pending_files, read_index, read_rows
from .models import (SUMMARY_SYSTEM, HIERARCHY_SYSTEM, QUERY_SYSTEM, budget,
                     decision_client, encode, local_client, tokens)
from . import qdrant

SOURCE_EXTENSIONS = set(".py .js .jsx .mjs .cjs .md .ts .tsx .html .css .svelte .txt .sh .bash .yaml .yml .toml".split())
IGNORED_DIRECTORIES = set("node_modules .venv venv .git __pycache__ .pytest_cache .mypy_cache .ruff_cache .cache .svelte-kit .next dist build coverage hf-cache .tmp".split())


def canonical(folder):
    if not isinstance(folder, str) or not folder.strip():
        raise ValueError("An explicit non-empty folder is required")
    root = Path(folder).resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"Not a folder: {root}")
    return str(root)


def is_git_repo(root: Path) -> bool:
    try:
        res = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, timeout=2.0
        )
        return res.returncode == 0 and res.stdout.strip() == "true"
    except Exception:
        return False


def filter_git_ignored_dirs(root: Path, dir_names: list[str], parent_rel: str = "") -> set[str]:
    if not dir_names:
        return set()
    queries = [f"{parent_rel}/{d}/" if parent_rel else f"{d}/" for d in dir_names]
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "--stdin"],
            input="\n".join(queries),
            capture_output=True, text=True, timeout=2.0
        )
        ignored_lines = set(proc.stdout.splitlines())
        ignored_names = set()
        for q, d in zip(queries, dir_names):
            if q in ignored_lines or q.rstrip("/") in ignored_lines:
                ignored_names.add(d)
        return ignored_names
    except Exception:
        return set()


def scan_sources(root, respect_gitignore: bool = True):
    root_path = Path(root).resolve(strict=True)
    in_git = is_git_repo(root_path) if respect_gitignore else False
    files = {}

    def walk(directory):
        entries = sorted(os.scandir(directory), key=lambda e: e.name)
        tokenizer = any(e.name in ("tokenizer.json", "tokenizer_config.json")
                        and e.is_file(follow_symlinks=False) for e in entries)

        subdirs = []
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name not in IGNORED_DIRECTORIES:
                    subdirs.append(entry.name)

        if in_git and subdirs:
            parent_rel = Path(directory).relative_to(root_path).as_posix()
            if parent_rel == ".":
                parent_rel = ""
            ignored_subdirs = filter_git_ignored_dirs(root_path, subdirs, parent_rel)
            subdirs = [d for d in subdirs if d not in ignored_subdirs]

        for d_name in subdirs:
            walk(os.path.join(directory, d_name))

        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in SOURCE_EXTENSIONS:
                if tokenizer and entry.name in ("merges.txt", "vocab.txt"):
                    continue
                path = Path(entry.path)
                if path.resolve() != path:
                    raise RuntimeError(f"Source path changed: {path}")
                rel_name = path.relative_to(root_path).as_posix()
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as handle:
                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                        raise RuntimeError(f"Source is not a regular file: {path}")
                    raw = handle.read()
                content = raw.decode("utf-8")
                if "\0" in content:
                    raise ValueError(f"Source contains binary data: {path}")
                files[rel_name] = {
                    "path": rel_name,
                    "content": content,
                    "content_hash": hashlib.sha256(raw).hexdigest()
                }

    walk(root_path)

    if in_git and files:
        candidate_paths = list(files.keys())
        try:
            proc = subprocess.run(
                ["git", "-C", str(root_path), "check-ignore", "--stdin"],
                input="\n".join(candidate_paths),
                capture_output=True, text=True, timeout=5.0
            )
            ignored_files = set(proc.stdout.splitlines())
            for ign in ignored_files:
                files.pop(ign, None)
        except Exception:
            pass

    return dict(sorted(files.items()))


def same_sources(a, b):
    return {k: v["content_hash"] for k, v in a.items()} == {k: v["content_hash"] for k, v in b.items()}


def source_chunks(content, max_bytes=16000):
    chunks, chars, size = [], [], 0
    for char in content:
        length = len(char.encode())
        if chars and size + length > max_bytes:
            chunks.append("".join(chars))
            chars, size = [], 0
        chars.append(char)
        size += length
    if chars or not chunks:
        chunks.append("".join(chars))
    return chunks


def pack(items, make_state, client, system, output=None):
    """Greedy bounded packing of whole items; no dropped tails or oversized singleton."""
    limit = budget(client.context, system, output or client.output)
    groups, group = [], []
    for item in items:
        if tokens(encode(make_state([item]))) > limit:
            raise RuntimeError("One state item exceeds context capacity; use a larger context window")
        if group and tokens(encode(make_state(group + [item]))) > limit:
            groups.append(group)
            group = []
        group.append(item)
    if group:
        groups.append(group)
    return groups


def summarize(file, local):
    # Preserve the existing 16k-byte lossless source chunks; shrink for small windows.
    chunk_size = min(16000, max(1, int(budget(local.context, SUMMARY_SYSTEM, local.output) * 3.5) - len(encode({"path": file["path"]})) - 128))
    chunks = source_chunks(file["content"], chunk_size)
    notes = [local.complete({"path": file["path"], "part": f"{i + 1}/{len(chunks)}", "content": text}, SUMMARY_SYSTEM)
             for i, text in enumerate(chunks)]
    while len(notes) > 1:
        state = lambda group: {"path": file["path"], "chunk_summaries": group}
        groups = pack(notes, state, local, SUMMARY_SYSTEM)
        if len(groups) >= len(notes):
            raise RuntimeError("Chunk summaries cannot be reduced within context; no clipping performed")
        notes = [local.complete(state(group), SUMMARY_SYSTEM) if len(group) > 1 else group[0] for group in groups]
    return {"path": file["path"], "summary": notes[0], "content_hash": file["content_hash"],
            "index_time": datetime.now(timezone.utc).isoformat()}


def plan_project(folder, store_dir=None, **_):
    root = canonical(folder)
    database = location(root, store_dir)
    files, old = scan_sources(root), read_index(root, database)
    pending = pending_files(files, old)
    return {"dryRun": True, "folder": root, "database": str(database), "indexed": len(old),
            "eligible": len(files), "pending": pending,
            "sync": {"updated": len(pending["added"]) + len(pending["changed"]),
                     "deleted": len(pending["deleted"]), "unchanged": len(pending["unchanged"])}}


def sync_index(root, database, local, progress):
    files = scan_sources(root)
    with closing(open_index(root, database)) as db:
        old = read_rows(db)
        pending = pending_files(files, old)
        changed = sorted(pending["added"] + pending["changed"])
        progress(f"Sync: {len(files)} files; {len(changed)} added/changed; {len(pending['deleted'])} deleted")
        def work(name):
            row = summarize(files[name], local)
            progress(f"Indexed: {name}")
            return row
        # Client semaphore is shared across every file/chunk/hierarchy inference.
        with ThreadPoolExecutor(max_workers=4) as pool:
            summaries = list(pool.map(work, changed))
        if not same_sources(files, scan_sources(root)):
            raise RuntimeError("Sources changed during indexing; no partial sync committed")
        db.execute("BEGIN IMMEDIATE")
        try:
            for row in summaries:
                db.execute("""INSERT INTO files(path,summary,content_hash,index_time) VALUES (:path,:summary,:content_hash,:index_time)
                    ON CONFLICT(path) DO UPDATE SET summary=excluded.summary,
                    content_hash=excluded.content_hash,index_time=excluded.index_time
                    WHERE files.content_hash != excluded.content_hash""", row)
            for name in read_rows(db):
                if name not in files:
                    db.execute("DELETE FROM files WHERE path=?", (name,))
            rows = read_rows(db)
            if not same_sources(files, rows):
                raise RuntimeError("Concurrent index changed; rerun query")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
    # 4. Synchronize with Qdrant Hybrid vector store if available
    try:
        if qdrant.is_qdrant_alive():
            col_name = qdrant.collection_name_for_folder(root)
            qdrant.ensure_collection(col_name)
            qdrant_points = qdrant.get_indexed_points(col_name)

            points_to_update = [
                row for row in rows.values()
                if row["path"] not in qdrant_points or qdrant_points[row["path"]].get("content_hash") != row["content_hash"]
            ]
            points_to_delete = [
                pt["id"] for p, pt in qdrant_points.items()
                if p not in rows and pt.get("id")
            ]

            if points_to_delete:
                qdrant.delete_points(col_name, points_to_delete)

            if points_to_update:
                upsert_batch = []
                for row in points_to_update:
                    rel_p = row["path"]
                    file_info = files.get(rel_p, {})
                    content = file_info.get("content", "")
                    code_meta = qdrant.extract_code_metadata(rel_p, content)
                    d_vec, s_vec = qdrant.build_doc_tokens(rel_p, row["summary"], code_meta["symbols"])
                    pt_id = qdrant.uuid_for_path(root, rel_p)
                    upsert_batch.append({
                        "id": pt_id,
                        "vector": {"dense": d_vec, "sparse": s_vec},
                        "payload": {
                            "folder": root,
                            "path": rel_p,
                            "summary": row["summary"],
                            "content_hash": row["content_hash"],
                            "index_time": row["index_time"],
                            "language": code_meta["language"],
                            "lines": code_meta["lines"],
                            "bytes": code_meta["bytes"],
                            "symbols": code_meta["symbols"],
                            "imports": code_meta["imports"]
                        }
                    })
                qdrant.upsert_points(col_name, upsert_batch)
    except Exception as e:
        progress(f"Qdrant sync skipped or failed non-fatally: {e}")

    return files, list(rows.values()), {"updated": len(changed), "deleted": len(pending["deleted"]), "unchanged": len(pending["unchanged"])}


def hierarchy(rows, local, progress):
    """Generalizable H1/H2 parts. Cache keyed by entire map plus model/budget."""
    state = lambda group: {"file_summaries": group}
    fragments = []
    limit = budget(local.context, HIERARCHY_SYSTEM, local.output)
    for row in rows:
        clean = {"path": row["path"], "summary": row["summary"]}
        if tokens(encode(state([clean]))) <= limit:
            fragments.append(clean)
            continue
        overhead = tokens(encode(state([{ "path": row["path"], "summary": "", "fragment": "999999999/999999999" }])))
        chars = int((limit - overhead - 16) * 3.5)
        if chars <= 0:
            raise RuntimeError("File path alone exceeds hierarchy context budget")
        text = row["summary"]
        chunks = [text[i:i + chars] for i in range(0, len(text), chars)]
        fragments.extend({"path": row["path"], "summary": text,
                          "fragment": f"{i + 1}/{len(chunks)}"} for i, text in enumerate(chunks))
    groups = pack(fragments, state, local, HIERARCHY_SYSTEM)
    parts = []
    for i, group in enumerate(groups):
        marker = f"{i + 1}/{len(groups)}"
        progress(f"Preparing map {marker}")
        text = local.complete(state(group), HIERARCHY_SYSTEM)
        parts.append({"part": marker, "overview": f"# Project map {marker}\n\n## Summary\n{text}",
                      "paths": [r["path"] for r in group]})
    return parts


def parse_decision(raw, allowed):
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1])
    value = json.loads(raw)
    if (not isinstance(value, dict) or not isinstance(value.get("answer"), str)
            or not value["answer"].strip() or not isinstance(value.get("files"), list)
            or not isinstance(value.get("limitations"), list)
            or any(not isinstance(x, str) for x in value["limitations"])):
        raise ValueError("Decision returned an invalid state")
    seen = set()
    for item in value["files"]:
        if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                or item["path"] not in allowed or not isinstance(item.get("reason"), str)
                or item["path"] in seen):
            raise ValueError("Decision returned an invalid, duplicate or unindexed path")
        seen.add(item["path"])
    return value


def decide(question, rows, parts, remote):
    make = lambda group: {"question": question, "parts": group,
                          "part": f"{len(parts)}/{len(parts)}"}
    groups = pack(parts, make, remote, QUERY_SYSTEM)
    if not groups:
        groups = [[]]
    results = []
    for i, group in enumerate(groups):
        allowed = {path for part in group for path in part["paths"]}
        state = make(group)
        state["part"] = f"{i + 1}/{len(groups)}"
        results.append(parse_decision(remote.complete(state, QUERY_SYSTEM, structured=True), allowed))
    while len(results) > 1:
        state = lambda group: {"question": question, "decisions": group}
        batches = pack(results, state, remote, QUERY_SYSTEM)
        if len(batches) >= len(results):
            raise RuntimeError("Decision states cannot reduce within context; no partial answer returned")
        next_results = []
        for group in batches:
            allowed = {f["path"] for result in group for f in result["files"]}
            next_results.append(parse_decision(remote.complete(state(group), QUERY_SYSTEM, structured=True), allowed))
        results = next_results
    return results[0]


def query_project(folder, question=None, dry_run=False, index_only=False,
                  store_dir=None, local=None, remote=None, progress=lambda text: None):
    if not isinstance(dry_run, bool) or not isinstance(index_only, bool):
        raise ValueError("dry_run and index_only must be booleans")
    if dry_run:
        return plan_project(folder, store_dir)
    if not index_only and (not isinstance(question, str) or not question.strip()):
        raise ValueError("A non-empty question is required")
    root = canonical(folder)
    database = location(root, store_dir)
    local = local or local_client()
    if not index_only:
        remote = remote or decision_client()
        remote.check()
    local.check()
    files, rows, sync = sync_index(root, database, local, progress)
    result = {"dryRun": False, "folder": root, "database": str(database), "indexed": len(rows), "sync": sync}
    map_parts = [{"part": "1/1", "overview": "# Project map 1/1\n\n## File summaries",
                  "files": [{"path": r["path"], "summary": r["summary"]} for r in rows],
                  "paths": [r["path"] for r in rows]}]
    target = remote if remote is not None else local
    limit = budget(target.context, QUERY_SYSTEM, target.output)
    oversized = tokens(encode({"question": question or "", "parts": map_parts, "part": "1/1"})) > limit
    if oversized:
        signature = hashlib.sha256(encode({"rows": rows, "model": local.model, "context": local.context}).encode()).hexdigest()
        with closing(open_index(root, database)) as db:
            db.execute("CREATE TABLE IF NOT EXISTS map_cache (signature TEXT PRIMARY KEY, parts TEXT NOT NULL)")
            cached = db.execute("SELECT parts FROM map_cache WHERE signature=?", (signature,)).fetchone()
            map_parts = json.loads(cached[0]) if cached else hierarchy(rows, local, progress)
            if not cached:
                db.execute("BEGIN IMMEDIATE")
                try:
                    db.execute("DELETE FROM map_cache")
                    db.execute("INSERT INTO map_cache VALUES (?,?)", (signature, encode(map_parts)))
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
    if index_only:
        result.update({"indexOnly": True, "parts": map_parts})
    else:
        answer = decide(question, rows, map_parts, remote)
        by_path = {r["path"]: r for r in rows}
        result.update(answer)
        result["files"] = [{**f, "summary": by_path[f["path"]]["summary"]} for f in answer["files"]]
        if oversized:
            result["limitations"].append("Oversized map uses hierarchical ~400-word part overviews; exact source verification required.")
    if not same_sources(files, scan_sources(root)):
        raise RuntimeError("Sources changed while answering; rerun for fresh context")
    usage = dict(local.usage)
    usage["cost"] = dict(local.usage["cost"])
    if remote:
        for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens"):
            usage[key] += remote.usage[key]
        usage["cost"]["total"] += remote.usage["cost"]["total"]
    result["usage"] = usage
    return result
