# Python Query Engine for Pi

A standard-library Python engine and CLI, with a thin TypeScript adapter required
by Pi. SGLang indexes **all eligible files** locally; an OpenRouter **free** model
makes Jev-style structured decisions from a simple JSON state. There is no agent
framework, hidden tool loop, embedding store, top-k map retrieval or stale fallback.

**Data boundary:** raw source text goes only to loopback SGLang. Normal queries
send file paths, summaries and your question to OpenRouter. Summaries may expose
sensitive source information. `--index-only` and `--dry-run` never use OpenRouter.
Summary recommendations are discovery context, not exact source evidence: read
recommended files before editing or making exact claims.

## Run

Python 3.10+ is sufficient for the standalone engine; no pip dependencies. Pi's
adapter also requires its normal Node runtime and supplied SDK packages.

```sh
python3 -B cli.py --folder /project --dry-run --json
python3 -B cli.py --folder /project --index-only
export OPENROUTER_API_KEY='your-key'
python3 -B cli.py --folder /project --question 'Where is authentication checked?'
```

`--index-only` preindexes every eligible file into the durable summary store and
prepares hierarchical map parts when the map exceeds the configured local window.
SGLang processes sources and hierarchy generation; its automatic prefix/KV cache
is evictable and does not survive restart. This is **not** a claim that an entire
project permanently resides in GPU memory. Unchanged file summaries and derived
hierarchy parts are reused from SQLite.

`--json` emits one result document on stdout; progress goes to stderr. Execution
failure emits `{"error":"..."}` with exit 1. Argument errors exit 2. Explicit
nonblank `--folder` is always required; `--question` is required for normal queries.
CLI-relative folders resolve from the shell cwd. CLI dry runs disable bytecode writes.

Install as a personal Pi package:

```sh
pi install /home/ubuntu/src/sgai-pi/query-engine
```

Run `/reload` after installing/updating. The tool interface remains:

```json
{"folder":"/project","question":"Find the API routes"}
```

```json
{"folder":"/project","dryRun":true}
```

The adapter uses the same Python CLI. It has no indexing, inference, storage or
query-decision implementation. Source files are never edited by the query tool.

## Models and configuration

| Variable | Default / meaning |
| --- | --- |
| `OPENROUTER_API_KEY` | Required for remote decisions; process environment first, then installation `.env` |
| `QUERY_DECISION_MODEL` | `openrouter/free`; alternatively an explicit model ending in `:free` |
| `QUERY_DECISION_CONTEXT` | Conservative 32768-token cap, reduced if `/models` advertises a smaller window |
| `QUERY_SGLANG_URL` | Settings `localBackendUrl`, otherwise `http://127.0.0.1:30000/v1`; loopback enforced |
| `QUERY_LOCAL_MODEL` | Settings `localModel`, otherwise `granite-4.2-3b-awq` |
| `QUERY_LOCAL_CONTEXT` | 32768; reduced by advertised model capacity |
| `SETTINGS_SUBAGENTX_PATH` | `~/.pi/agent/settings-subagentx.json` for local model/URL defaults |
| `PI_QUERY_STORE_DIR` | Whole store override, absolute or relative to process cwd |
| `PI_CODING_AGENT_DIR` | Agent directory override; default `~/.pi/agent` |

The engine automatically reads `OPENROUTER_API_KEY` from `.env` beside `cli.py`
when absent from the process environment, including when launched by Pi from
another directory. It never reads credentials from the queried folder or executes
`.env` as shell code. Keep this file private (`chmod 600 .env`); it is Git-ignored.
A copied Pi credential is a snapshot: replace it if revoked or rotated. Pi's
original auth stays intact; the engine does not refresh Pi OAuth credentials.

`openrouter/free` selects among available free models, rather than promising a
specific Jev model. Only free router / `:free` IDs are allowed: no automatic paid
fallback. Choose a pinned free model for predictable model identity. Rate limits
and outages are surfaced as errors. HTTP timeouts are 180 seconds per request;
no hidden retries of billed requests. Provider context compression is explicitly
disabled. The 3.5-character estimate is deliberately approximate; a tokenizer or
provider can still reject a request and such failures are reported, never clipped.

## Index mechanism: unchanged file summaries

Canonical realpaths share an index. Different folders (including parents and
children) have independent SHA-256-keyed databases:

```text
~/.pi/agent/query-engine/<sha256(canonical absolute folder)>.db
```

Existing global indexes are read directly with the same `project` identity and
`files(path, summary, content_hash, index_time)` schema. No rebuild or migration
is required. Old project-local `query-engine.db` files remain untouched.

1. Scan all eligible UTF-8 sources in binary alphabetical path order.
2. Compare SHA-256 byte hashes; reuse unchanged summaries.
3. Summarize added/changed sources with loopback SGLang, targeting **200 words**.
   Large sources split losslessly into ordered 16000-byte chunks (smaller for
   small configured windows). Recursively combine **all** chunk notes into one
   summary; never truncate a source or discard the tail.
4. Rescan sources; abort if anything changed. Atomically upsert all completed
   summaries and remove deleted paths. No SQLite transaction spans inference.
5. Answer only from the freshly synchronized map. Rescan before returning; reject
   a stale answer if sources changed during query processing.

File work and nested inference share one four-request semaphore. SQLite uses
rollback journals and a five-second busy timeout. Cross-process calls may duplicate
inference; commits verify that the complete path/hash map matches the snapshot.
All workers settle on failure; failed syncs preserve the preceding complete map.

The store is private (0700 directory, 0600 DB). Identity mismatch, symlinked store
ancestors, symlink/hardlinked DBs and unsafe sidecars are refused. This is not a
sandbox against another process with the same OS account swapping paths mid-call.

## Simple state and hierarchical context

State is an ordinary JSON object, not a transcript:

```json
{
  "question": "Find authentication",
  "part": "1/3",
  "parts": [{
    "part": "1/3",
    "overview": "# Project map 1/3\n\n## Summary\n...",
    "paths": ["auth.py", "routes.py"]
  }]
}
```

Each request gets a fresh budget:

```text
estimated tokens = ceil(characters / 3.5)
usable input = floor(context window × 0.90)
               − estimated system prompt tokens − output reserve
```

Here “90% buffer” means 90% utilization / **10% headroom**, not reserving 90% unused.
Serialized state, question, paths and markers count too. Default output reserve is
2048 tokens. SGLang uses thinking disabled for predictable indexing output.

Small maps send **all complete file summaries** to the decision model. Oversized
maps are partitioned without dropping rows. SGLang creates an approximately
**400-word** overview per part, presented with **H1 + H2** headings and explicit
`1/n`, `2/n`, … markers. Oversized individual summaries split into path-labelled
fragments. Derived parts are cached separately in `map_cache`, keyed by the full
map, local model and context; the original file-summary rows are unchanged.

Every part retains its exact path catalog. If the complete overview map cannot
fit a remote request, decisions run on every bounded group, then recursively
merge **all** intermediate decisions until one result remains. This architecture
is independent of a particular folder or model. Impossible singleton states or
nonshrinking reductions fail clearly instead of silently clipping context.
Compression can lose detail: it is surfaced in answer limitations.

Model decisions must have `answer`, ordered `files` (`path`, `reason`) and string
`limitations`. Every recommended path is validated against the exact indexed
catalog supplied to that decision. Merge stages cannot invent new candidates;
duplicate/unindexed paths, malformed JSON and truncated completions fail. Final
recommendations include the original cached file summaries for source verification.
Usage from local and remote calls is returned to Pi for accounting.

## Dry run and eligibility

Dry runs use the exact scanner/hashes but never call models, create a store,
migrate schema or write journals. Existing DBs open read-only; WAL-mode indexes
are refused before connecting to avoid SQLite sidecar writes. Result includes
`folder`, `database`, `indexed`, `eligible`, alphabetical `pending` arrays
(`added`, `changed`, `deleted`, `unchanged`) and planned `sync` counts.

Eligible extensions:

```text
.py .js .jsx .mjs .cjs .md .ts .tsx .html .css .svelte .txt
.sh .bash .yaml .yml .toml
```

Skipped directory names (same as the prior implementation):

```text
node_modules .venv venv .git __pycache__ .pytest_cache .mypy_cache
.ruff_cache .cache .svelte-kit .next dist build coverage hf-cache .tmp
```

Skip source/directory symlinks; never cross the selected folder boundary.
`merges.txt` / `vocab.txt` are excluded only beside regular tokenizer JSON markers;
model READMEs and custom code remain eligible. No `.gitignore` filtering: eligible
hidden/ignored files may be indexed. Invalid UTF-8 or NUL content fails explicitly.

## Library, modules and checks

```python
from query_engine import plan_project, query_project

plan = plan_project('/project')
result = query_project('/project', 'Find routes')
index = query_project('/project', index_only=True)
```

- `query_engine/engine.py`: scanning, sync, hierarchy and typed decision pipeline.
- `query_engine/store.py`: compatible SQLite store, identity and dry-run safety.
- `query_engine/models.py`: local/remote HTTP clients, budgets and usage.
- `query_engine/__main__.py` / `cli.py`: Python CLI and text presentation.
- `extensions/sgai-query.ts`: Pi schema and Python process adapter only.

```sh
npm test                       # Python checks plus Pi SDK adapter smoke
npm run test:live               # Real SGLang; OpenRouter when key supplied
```

Unit tests use disposable projects and fake model responses. Live tests use a
fresh temporary store and check actual local summaries, incremental sync and
read-only planning. A skipped OpenRouter stage does **not** establish remote
health, decision accuracy or end-to-end live success.
