# Hash-only Query Engine for Pi

Local source discovery using **BM25 + sublinear TF-IDF cosine**, combined with
reciprocal rank fusion (RRF). Python 3.10+ standard library implements scanning,
sync, retrieval, CLI and reinstall; a thin TypeScript adapter registers the tool
through Pi's supported API. Ranking stays lexical and deterministic. The Pi
adapter additionally summarizes retrieved source chapters with the configured
LocalAI backend; it requires no API key, embeddings or external vector database.
Full source is read locally; only file hashes persist in the query index.

## Run and reinstall

Use absolute source and store paths; relative paths are rejected. Folder aliases
resolve to a canonical absolute identity. No pip dependencies are required.

```sh
python3 -B /home/ubuntu/src/sgai-pi/query-engine/cli.py --folder /project --dry-run --json
python3 -B /home/ubuntu/src/sgai-pi/query-engine/cli.py --folder /project --question 'Find authentication routes'
python3 -B /home/ubuntu/src/sgai-pi/query-engine/cli.py --folder /project/.pi/subagents/contracts --question 'prior launch contract'
python3 -B /home/ubuntu/src/sgai-pi/query-engine/cli.py --folder /project --index-only --reindex
python3 -B /home/ubuntu/src/sgai-pi/query-engine/reinstall.py
```

The Python reinstall command invokes `pi install` with the absolute package path,
then atomically normalizes this package's settings declaration to an absolute
path, preserving unrelated settings and resource filters. Run **`/reload`** to
load the updated extension and instructions in an existing Pi session. Local
packages load from their original directory; no build or source copying occurs.
Pi's adapter requires the normal Node runtime and host-supplied SDK packages.

The registered `query` tool accepts:

```json
{"folder":"/project","question":"Find the API routes"}
```

```json
{"folder":"/project","dryRun":true}
```

Normal queries return at most ten retrieval candidates with absolute `path`,
`line`, `reason`, fused `score` and raw `bm25`/`tfidf` scores plus a compact
whole-file `sections` map (`mapKind`: `structural` or `fallback`). Python
ranking, result schema, `structuredContent.files` paths and order, and native
tool `details` remain lexical and unchanged. JSON sections have
`{line, endLine, name, purpose}` with 1-based inclusive ranges covering every
physical line contiguously. These are navigation partitions, not semantic
scopes; maps are still available to programmatic callers and the CLI.

The Pi adapter's normal text uses each ranked absolute path followed by
zero-based, half-open 100-line chapters (`0-100`, `100-200`, and so on), each
summarized in plain prose with a meaningful sizing hint of about 100 words.
The final chapter may be shorter. It reads each source without following
symlinks, hashes the bytes, and compares that SHA-256 with the existing SQLite
row through a read-only connection before generation. Stale snapshots, symlink
sources, missing LocalAI responses, and responses without final token usage fail
explicitly; summaries are never presented for bytes other than the indexed
snapshot. The adapter dynamically imports
`$PI_CODING_AGENT_DIR/lib/local-ai.mjs` (default `~/.pi/agent/lib/local-ai.mjs`)
and calls it with thinking enabled, low reasoning, streaming, at most four
concurrent calls, and a 2048-token cap. Progress labels per-call stream rates as
provisional; final throughput uses server-reported output tokens including
reasoning, divided by generation wall time. The Python CLI does not generate summaries.

Dry runs remain write-free and skip inference. Canonical `.pi/subagents/contracts`
queries remain deterministic: the adapter returns ranked paths without model
generation, while the structured result retains every ranked file and section.
Read complete recommended files before editing; lexical results are not
semantic answers. No matching query terms returns an empty match list, not
invented recommendations.

`--json` emits one document on stdout; progress goes to stderr. Runtime failures
exit 1 (with `{"error":"..."}` in JSON mode); invalid CLI arguments exit 2.
`--question` is required unless `--dry-run` or `--index-only` is selected.
`--reindex` deletes all cached file rows and inserts current hashes, including
unchanged files; it cannot be combined with `--dry-run`.
`--auto-all` indexes AGENTS.md folders under `/home/ubuntu/src`, reporting per-folder
errors and exiting nonzero on failure; it cannot be combined with folder,
question or dry-run arguments.

## Minimal store and freshness

Each canonical folder owns an independent database:

```text
/home/ubuntu/.pi/agent/query-engine/<sha256(canonical absolute folder)>.db
```

| Variable | Meaning |
| --- | --- |
| `PI_QUERY_STORE_DIR` | Absolute store-directory override |
| `PI_CODING_AGENT_DIR` | Absolute agent-directory override; default `~/.pi/agent` |

The schema contains only:

```sql
CREATE TABLE project (id INTEGER PRIMARY KEY CHECK(id=1), folder TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL);
```

`project` prevents accidental cross-folder reuse. `files` contains canonical
absolute paths and SHA-256 byte hashes, never source text, summaries, timestamps,
sizes, vectors or model state. Legacy summary schemas are rebuilt on writable
sync; `map_cache` is removed. Dry-run previews legacy rows as requiring reindex,
without migrating or modifying the old database.

1. Scan eligible sources and hash their complete bytes, regardless of mtime/size.
2. Delete rows for missing or hash-mismatched files **before** inserting replacements.
3. Insert added/changed hashes (all hashes with `--reindex`) in one transaction.
4. Re-read indexed rows, verify they match the scanned path/hash map, then COMMIT.
5. Rank the already-scanned in-memory sources; no post-query disk rescan occurs.

Invalidation remains SHA-256-based, not diff-based; clarify whether any request
for “different invalidation” means diff-based invalidation before changing it.

Sync failures, including scan errors and detected source races, roll back the
transaction and preserve previously valid cached rows, then fail explicitly;
stale rows never serve as fallback evidence. SQLite uses rollback
journals, a five-second busy timeout and serialized write transactions. The store
is private (0700 directory, 0600 database). Folder identity mismatch, linked
store ancestors, linked databases and unsafe sidecars are refused. This is not a
sandbox against another process with the same OS account swapping paths mid-call.

Dry runs use the same scanner and hashes, return absolute pending paths and sync
counts, and never create a store, migrate schema or write journals. Existing
indexes open read-only; WAL-mode indexes are refused to prevent sidecar writes.

## Retrieval and eligibility

Ranking uses corpus document frequencies and average document length, BM25
`k1=1.2`, `b=0.75`, sublinear TF-IDF cosine, path term boost `3.0`, and RRF `k=60`.
Only positive matches participate; ties resolve deterministically by absolute
path. Identifier tokens include full names and snake/camel components. Common
question stopwords are removed. Relative path terms are computed internally only
for path boosting; source/store paths in inputs, outputs and SQLite are absolute.
No source tail is discarded before scoring.

Eligible files are the curated source and build sets in `query_engine/engine.py`:
C/C++/systems and compiled languages; interpreted, functional and concurrent
languages; shells, batch and PowerShell; frontend sources and stylesheets; SQL
and build files; named `Makefile`/`Dockerfile`/`Jenkinsfile`; executable `#!`
scripts; and the curated Markdown names `README.md`, `AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md` and `ARCHITECTURE.md`. Data/config formats (`.txt`, `.html`,
`.json`, `.yaml`, `.toml`) and unlisted Markdown are not indexed, so use explicit
file reads for them.

Git ignore rules are respected before reading ignored files, except in contract
scope below. Excluded directory names:

```text
node_modules .venv venv .git __pycache__ .pytest_cache .mypy_cache
.ruff_cache .cache .svelte-kit .next dist build coverage hf-cache .tmp
```

File/directory symlinks are skipped; the selected folder boundary is never
crossed. Invalid UTF-8 or NUL-containing eligible files fail explicitly.

### Contract scope

A query whose canonical root is exactly `.pi/subagents/contracts` is bounded for
prior-contract discovery: every Markdown file there is eligible and Git ignore
checks are skipped, so contract fixtures stay retrievable in projects whose
`.gitignore` hides that directory. Directories matching `*.claim/` are never
scanned, keeping active-claim `owner.md` sidecars out of the index. Contract
queries return up to ten retrieval candidates, deterministically ranked by
fused score with absolute-path tie-breaking. That bound covers retrieval
candidates only: launch filtering selects at most five completed contract
outputs. Read the complete contract files before launching derived work or
editing. `question` is forwarded to the Python engine unchanged (trimmed only
for the non-empty check, so whitespace, Unicode and line endings survive), and
the original query belongs in the child task while completed contract outputs
enter system context. Outside this scope the original query requirements are
untouched: ordinary source queries keep their eligibility, Git ignore rules
and ten-candidate bound.

## Library and checks

```python
from query_engine import plan_project, query_project

plan = plan_project('/project')
result = query_project('/project', 'Find routes')
index = query_project('/project', index_only=True, reindex=True)
```

- `query_engine/engine.py`: absolute-path scanning, hash synchronization and freshness.
- `query_engine/store.py`: minimal SQLite schema, identity and read-only planning.
- `query_engine/retrieval.py`: deterministic BM25, TF-IDF, RRF and structural map assembly.
- `query_engine/structure.py`: whole-file section discovery and adaptive purpose sizing.
- `query_engine/indexer.py`: bounded AGENTS.md discovery and batch hash indexing.
- `query_engine/__main__.py` / `cli.py`: CLI and presentation.
- `extensions/sgai-query.ts`: Pi schemas, Python subprocess adapter, verified source snapshots and LocalAI chapter summaries.
- `reinstall.py`: supported package installation and absolute declaration.

From `/home/ubuntu/src/sgai-pi/query-engine`:

```sh
npm test             # Three real CLI scenarios and one real Pi extension scenario
```

Functional tests cover retrieval/read-only preview, hash-sync/reindex,
migration/failure recovery, and the real Pi adapter. The extension test uses a
loopback streaming server to verify LocalAI request options, four-call
concurrency, chapter coverage and order, usage, stale/symlink refusals, explicit
inference failures, and write-free dry runs. It uses disposable folders and a
read-only SQLite index; no external vector database or credentials are needed.

To run a bounded live generation against GigaTrader with the configured LocalAI
backend, use:

```sh
PI_QUERY_CHAPTER_LIVE=1 \
PI_QUERY_CHAPTER_FOLDER=/home/ubuntu/src/GigaTrader-v2 \
PI_QUERY_CHAPTER_QUESTION='GigaTrader architecture ranking workers predictors analytics frontend backend' \
node tests/extension.test.mjs
```

The opt-in runner saves the generated text and a JSON throughput report under
`/tmp/query-chapter-live-*.txt` and `*.json`, and prints both paths. The report
contains selected ranked paths, chapter count, generation and query wall times,
per-call final token totals, aggregate server-token throughput and progress updates. Use
`/reload` after changing the extension in an existing Pi session.
