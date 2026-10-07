"""Deterministic stdlib-only lexical retrieval: corpus BM25 plus sublinear TF-IDF fused by reciprocal rank fusion."""
import math
import os
import re
from collections import Counter

_K1 = 1.2
_B = 0.75
_RRF_K = 60
_PATH_BOOST = 3.0
_MAX_EXCERPT = 1200

STOPWORDS = frozenset(
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its "
    "me my no not of on or our out should so than that the their them then there these they this to was "
    "we were what when where which who why will with would you your".split()
)

_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CAMEL = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")


def tokenize(text, drop_stopwords=False):
    """Emit lowercased identifier tokens and their snake/camel components without duplicate plain tokens."""
    out = []
    for raw in _WORD.findall(text):
        parts = []
        for chunk in raw.split("_"):
            if chunk:
                parts.extend(_CAMEL.findall(chunk) or [chunk])
        seen = set()
        for token in [raw.lower()] + [p.lower() for p in parts]:
            if token and token not in seen:
                seen.add(token)
                if not (drop_stopwords and token in STOPWORDS):
                    out.append(token)
    return out


def _root(paths):
    """Common directory of file paths for internal relative-path weighting."""
    dirs = [os.path.dirname(p) for p in paths]
    return os.path.commonpath(dirs) if dirs else ""


def _window(lines, best, limit=_MAX_EXCERPT):
    """Return the largest verbatim contiguous line window around best within limit."""
    start = end = best
    total = len(lines[best])
    while True:
        grew = False
        if start > 0 and total + 1 + len(lines[start - 1]) <= limit:
            start -= 1
            total += 1 + len(lines[start])
            grew = True
        if end + 1 < len(lines) and total + 1 + len(lines[end + 1]) <= limit:
            end += 1
            total += 1 + len(lines[end])
            grew = True
        if not grew:
            return "\n".join(lines[start:end + 1])


def _locate(content, terms, idf):
    """Return the 1-based line with the strongest weighted term density and its bounded window."""
    lines = content.split("\n")
    best, best_score = 0, 0.0
    for i, line in enumerate(lines):
        if not line:
            continue
        counts = Counter(tokenize(line))
        score = 0.0
        for term in terms:
            count = counts.get(term, 0)
            if count:
                score += idf.get(term, 0.0) * (1 + math.log(count))
        if score > best_score:
            best, best_score = i, score
    if len(lines[best]) > _MAX_EXCERPT:
        match = next((m.start() for m in _WORD.finditer(lines[best]) if set(tokenize(m.group())) & set(terms)), 0)
        start = max(0, min(match - _MAX_EXCERPT // 2, len(lines[best]) - _MAX_EXCERPT))
        return best + 1, lines[best][start:start + _MAX_EXCERPT]
    return best + 1, _window(lines, best)


def rank_sources(files, question, limit=10):
    """Fuse corpus BM25 and sublinear TF-IDF rankings over content and boosted relative paths."""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("limit must be a positive integer")
    if not isinstance(files, dict) or not files:
        return []
    q_tokens = tokenize(question if isinstance(question, str) else "", drop_stopwords=True)
    if not q_tokens:
        return []
    terms = sorted(set(q_tokens))

    entries = []
    for key, raw in files.items():
        path = raw["path"]
        if not os.path.isabs(key) or not os.path.isabs(path) or key != path:
            raise ValueError("Source paths must be matching absolute paths")
        entries.append((path, raw["content"]))
    if not entries:
        return []
    root = _root([path for path, _ in entries])

    docs, df, total_dl = [], Counter(), 0.0
    for path, content in entries:
        rel = os.path.relpath(path, root) if root else os.path.basename(path)
        content_tokens = tokenize(content)
        path_tokens = tokenize(rel)
        tf = Counter(content_tokens)
        for token in path_tokens:
            tf[token] += _PATH_BOOST
        dl = len(content_tokens) + _PATH_BOOST * len(path_tokens)
        for token in tf:
            df[token] += 1
        total_dl += dl
        docs.append({"path": path, "content": content, "tf": tf, "dl": dl,
                     "path_terms": set(path_tokens)})
    n = len(docs)
    avgdl = total_dl / n
    if avgdl <= 0:
        return []

    idf_bm25 = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
    idf_tfidf = {t: math.log((n + 1) / (d + 1)) + 1 for t, d in df.items()}
    qtf = Counter(q_tokens)
    q_weight = {t: (1 + math.log(qtf[t])) * idf_tfidf.get(t, 0.0) for t in qtf}
    q_norm = math.sqrt(sum(w * w for w in q_weight.values()))
    if q_norm == 0:
        return []

    scored = []
    for doc in docs:
        tf = doc["tf"]
        matched = [t for t in terms if tf.get(t)]
        if not matched:
            continue
        length_norm = _K1 * (1 - _B + _B * (doc["dl"] / avgdl))
        doc["bm25"] = sum(idf_bm25[t] * (tf[t] * (_K1 + 1)) / (tf[t] + length_norm) for t in matched)
        d_weight = {t: (1 + math.log(f)) * idf_tfidf.get(t, 0.0) for t, f in tf.items()}
        d_norm = math.sqrt(sum(w * w for w in d_weight.values()))
        dot = sum(q_weight[t] * d_weight.get(t, 0.0) for t in matched)
        doc["tfidf"] = dot / (q_norm * d_norm) if d_norm else 0.0
        doc["matched"] = matched
        scored.append(doc)

    bm25_ranked = sorted((d for d in scored if d["bm25"] > 0), key=lambda d: (-d["bm25"], d["path"]))
    tfidf_ranked = sorted((d for d in scored if d["tfidf"] > 0), key=lambda d: (-d["tfidf"], d["path"]))
    rrf = {}
    for ranking in (bm25_ranked, tfidf_ranked):
        for rank, doc in enumerate(ranking, 1):
            rrf[doc["path"]] = rrf.get(doc["path"], 0.0) + 1.0 / (_RRF_K + rank)

    by_path = {d["path"]: d for d in scored}
    order = sorted((p for p, s in rrf.items() if s > 0), key=lambda p: (-rrf[p], p))

    results = []
    for path in order[:limit]:
        doc = by_path[path]
        matched = sorted(doc["matched"], key=lambda t: (-idf_bm25.get(t, 0.0), t))
        line, excerpt = _locate(doc["content"], terms, idf_bm25)
        reason = f"lexical: {len(matched)}/{len(terms)} query terms"
        if matched[:3]:
            reason += " (" + ", ".join(matched[:3]) + ")"
        if any(t in doc["path_terms"] for t in matched):
            reason += "; path term boost"
        reason += f"; best line {line}"
        results.append({"path": path, "score": rrf[path], "bm25": doc["bm25"], "tfidf": doc["tfidf"],
                        "reason": reason, "excerpt": excerpt, "line": line})
    return results
