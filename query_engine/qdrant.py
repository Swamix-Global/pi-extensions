"""Minimal Qdrant REST client and vector indexer for folder-based code discovery.

Pure Python standard library (urllib.request). Zero external dependencies.
Manages per-folder collections, hash-based incremental syncing, and vector searches.
Uses fast deterministic dense hashing (dim=384) for sub-millisecond embedding and instant sync.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import urllib.error
import urllib.request
from typing import Any, Mapping

QDRANT_DEFAULT_URL = "http://127.0.0.1:6333"
VECTOR_DIMENSION = 384


def get_qdrant_url() -> str:
    return os.environ.get("QDRANT_URL", QDRANT_DEFAULT_URL).rstrip("/")


def collection_name_for_folder(folder_path: str) -> str:
    """Generate a clean, deterministic collection name for a folder path."""
    canonical_folder = os.path.realpath(os.path.abspath(folder_path))
    h = hashlib.sha256(canonical_folder.encode("utf-8")).hexdigest()[:16]
    return f"folder_{h}"


def qdrant_request(route: str, method: str = "GET", payload: Any = None, timeout: float = 15.0) -> Any:
    base = get_qdrant_url()
    url = f"{base}{route}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Qdrant HTTP {e.code} on {route}: {err_body}") from e
    except Exception as e:
        raise RuntimeError(f"Qdrant connection error on {route}: {e}") from e


def is_qdrant_alive() -> bool:
    try:
        req = urllib.request.Request(f"{get_qdrant_url()}/healthz")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            return resp.status == 200
    except Exception:
        try:
            req = urllib.request.Request(f"{get_qdrant_url()}/readyz")
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                return resp.status == 200
        except Exception:
            return False


def text_to_vector(text: str, dim: int = VECTOR_DIMENSION) -> list[float]:
    """Fast, deterministic unigram+bigram feature hashing with L2 normalization."""
    tokens = re.findall(r"[a-zA-Z0-9_\-\.]+", text.lower())
    vec = [0.0] * dim
    if not tokens:
        return vec

    # Unigrams
    for t in tokens:
        h = int(hashlib.md5(t.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if ((h >> 16) & 1) else -1.0
        vec[idx] += sign

    # Bigrams
    for i in range(len(tokens) - 1):
        bg = f"{tokens[i]}_{tokens[i+1]}"
        h = int(hashlib.md5(bg.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if ((h >> 16) & 1) else -1.0
        vec[idx] += 0.5 * sign

    norm = math.sqrt(sum(x * x for x in vec))
    if norm > 0:
        vec = [x / norm for x in vec]
    return vec


def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Compute dense embeddings for texts instantly in pure python."""
    return [text_to_vector(t) for t in texts]


def ensure_collection(collection_name: str, dim: int = VECTOR_DIMENSION) -> bool:
    """Ensure collection exists in Qdrant with the specified vector dimension and Cosine metric."""
    try:
        res = qdrant_request(f"/collections/{collection_name}", method="GET")
        existing_dim = (
            res.get("result", {})
            .get("config", {})
            .get("params", {})
            .get("vectors", {})
            .get("size")
        )
        if existing_dim is not None and existing_dim != dim:
            # Recreate collection if dimension changed
            qdrant_request(f"/collections/{collection_name}", method="DELETE")
            qdrant_request(
                f"/collections/{collection_name}",
                method="PUT",
                payload={"vectors": {"size": dim, "distance": "Cosine"}},
            )
        return True
    except RuntimeError as e:
        if "404" in str(e):
            qdrant_request(
                f"/collections/{collection_name}",
                method="PUT",
                payload={"vectors": {"size": dim, "distance": "Cosine"}},
            )
            return True
        raise


def get_indexed_points(collection_name: str) -> dict[str, dict[str, Any]]:
    """Scroll and return all indexed points keyed by their relative path.

    Returns: {rel_path: {"id": str, "content_hash": str, "summary": str, "path": str, ...}}
    """
    indexed = {}
    try:
        offset = None
        while True:
            payload: dict[str, Any] = {"limit": 250, "with_payload": True, "with_vector": False}
            if offset is not None:
                payload["offset"] = offset
            res = qdrant_request(f"/collections/{collection_name}/points/scroll", method="POST", payload=payload)
            result = res.get("result", {})
            points = result.get("points", [])
            for p in points:
                p_payload = p.get("payload", {})
                rel_path = p_payload.get("path")
                if rel_path:
                    indexed[rel_path] = {
                        "id": p.get("id"),
                        "path": rel_path,
                        "content_hash": p_payload.get("content_hash", ""),
                        "summary": p_payload.get("summary", ""),
                        "index_time": p_payload.get("index_time", ""),
                    }
            offset = result.get("next_page_offset")
            if not offset or not points:
                break
    except RuntimeError as e:
        if "404" in str(e):
            return {}
        raise
    return indexed


def uuid_for_path(folder_path: str, rel_path: str) -> str:
    """Create a deterministic UUID string from the folder and file relative path."""
    h = hashlib.sha1(f"{folder_path}:{rel_path}".encode("utf-8")).hexdigest()[:32]
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def upsert_points(collection_name: str, points: list[dict[str, Any]]) -> None:
    """Batch upsert points into Qdrant collection."""
    if not points:
        return
    for i in range(0, len(points), 100):
        batch = points[i : i + 100]
        qdrant_request(
            f"/collections/{collection_name}/points",
            method="PUT",
            payload={"points": batch},
        )


def delete_points(collection_name: str, point_ids: list[str]) -> None:
    """Delete points from Qdrant by ID."""
    if not point_ids:
        return
    qdrant_request(
        f"/collections/{collection_name}/points/delete",
        method="POST",
        payload={"points": point_ids},
    )


def search_similar(collection_name: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Search Qdrant collection for top matching points by cosine similarity."""
    query_vector = text_to_vector(query)
    payload = {
        "vector": query_vector,
        "limit": limit,
        "with_payload": True,
    }
    res = qdrant_request(f"/collections/{collection_name}/points/search", method="POST", payload=payload)
    results = []
    for hit in res.get("result", []):
        results.append({
            "id": hit.get("id"),
            "score": hit.get("score"),
            "path": hit.get("payload", {}).get("path"),
            "summary": hit.get("payload", {}).get("summary"),
            "content_hash": hit.get("payload", {}).get("content_hash"),
        })
    return results
