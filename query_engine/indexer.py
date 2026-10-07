"""Folder discovery and batch indexing through the canonical hash-only engine."""
import os
from pathlib import Path

from .engine import IGNORED_DIRECTORIES, canonical, query_project


def find_agent_folders(search_roots):
    """Discover AGENTS.md folders only within explicit absolute search roots."""
    discovered = set()
    for root in search_roots:
        root = canonical(str(root))
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if name not in IGNORED_DIRECTORIES
                       and not name.startswith(".") and not Path(directory, name).is_symlink()]
            if any(name.lower() == "agents.md" and not Path(directory, name).is_symlink() for name in files):
                discovered.add(Path(directory))
    return sorted(discovered)


def index_folder(folder, progress=lambda text: None, store_dir=None, reindex=False):
    """Index a folder using the same absolute-path scanner and hash-only database as query."""
    return query_project(str(folder), index_only=True, progress=progress, store_dir=store_dir, reindex=reindex)


def auto_index_all_agent_folders(search_roots=None, progress=lambda text: None, store_dir=None, reindex=False):
    """Index discovered folders and report failures without claiming batch success."""
    roots = search_roots if search_roots is not None else ["/home/ubuntu/src"]
    results = []
    for folder in find_agent_folders(roots):
        try:
            results.append(index_folder(folder, progress=progress, store_dir=store_dir, reindex=reindex))
        except Exception as error:
            results.append({"folder": str(folder), "error": str(error)})
    return results
