# Query Engine for Pi

`query` discovers relevant code and files using a complete, alphabetically sorted
map of source summaries, answered by local SGLang running Nemotron-3-Nano-4B-FP8.
**Pass `folder` explicitly.** Indexes live under Pi, not in the source tree.
Preview indexing with an offline, read-only dry run before a large first query.

Summaries are discovery context, **not exact source evidence**. Read the recommended
files before editing or making exact claims. Model relevance is not guaranteed.

## Requirements and installation

- Node.js **22.19+** (`node:sqlite`).
- Pi for the extension; the standalone CLI does not need a running Pi session.
- Normal queries: `~/.pi/agent/lib/local-ai.mjs`, local model settings in
  `~/.pi/agent/settings-subagentx.json`, and healthy SGLang serving exactly
  `nemotron-3-nano-4b-fp8` at the loopback endpoint (`http://127.0.0.1:30000/v1`).
  No remote inference fallback.
- Dry runs: filesystem access and Node only; no model, configuration or network
  connection is required.

```sh
pi install /home/ubuntu/src/sgai-pi/query-engine
```

Then run `/reload` in Pi. The package registers `query` through supported Pi
extension APIs; no installed Pi/provider patches.

## Pi tool

Normal query:

```json
{
  "folder": "/home/ubuntu/src/sglang-server",
  "question": "Where is model inventory configured and which files document the selected SGLang model?"
}
```

Preview:

```json
{ "folder": "/home/ubuntu/src/sglang-server", "dryRun": true }
```

| Argument | Requirement | Meaning |
| --- | --- | --- |
| `folder` | Always required; nonblank string | Absolute path or relative to the Pi session cwd. No implicit cwd default. |
| `question` | Required for normal queries; nonblank string | Project-level question or code/files to locate. Ignored in dry runs. |
| `dryRun` | Optional boolean; default `false` | Plan indexing without applying it or answering a question. |

The selected folder resolves to its canonical realpath. Symlink aliases and
normalized paths share the same index; different folders, including a parent and
its subfolder, have independent indexes. Returned source paths are relative to
that canonical folder. A missing path or a non-directory fails explicitly.

## CLI and help

From this package directory:

```sh
node cli.mjs --help
node cli.mjs --folder /home/ubuntu/src/sglang-server --dry-run
node cli.mjs --folder /home/ubuntu/src/sglang-server --dry-run --json
node cli.mjs --folder ./src --question "Where is authentication checked?"
```

Equivalent npm entry point: `npm run query -- --folder ./src --dry-run`.
CLI-relative folders resolve from the shell cwd. Values containing spaces need
shell quotes. `--folder=PATH` and `--question=QUESTION` are also supported.
Unknown/duplicate options and missing/blank required values fail; no arguments
prints usage. Exit codes: **0** success/help, **1** execution failure, **2** invalid
arguments. With `--json`, stdout is one JSON document on success or an execution
failure (`{"error":"..."}`); progress/errors go to stderr. Argument errors emit
usage to stderr and no stdout document. `--help` / `-h` describes all flags.

## Global index store

Default location:

```text
~/.pi/agent/query-engine/<SHA-256 of canonical absolute folder>.db
```

`PI_CODING_AGENT_DIR` changes the agent-directory portion. `PI_QUERY_STORE_DIR`
overrides the whole store directory (relative values resolve from the process
cwd; use an absolute path for predictable results). Both Pi and CLI use the same
store. There is no cross-folder summary reuse and no default tenant/owner.

```sh
PI_QUERY_STORE_DIR=/tmp/query-indexes node cli.mjs --folder ./src --dry-run
```

Each database records its canonical folder identity and refuses a mismatch. The
`files` table has exactly one row per eligible source, with `path`, `summary`,
`content_hash` (SHA-256 of bytes) and `index_time`. Normal queries create the store
with mode **0700** and databases with **0600**. Symlinked store ancestors,
symlink/hardlinked databases and unsafe SQLite sidecars are refused. The store is
a private local cache, not a sandbox against other processes under the same OS
account. Summaries can contain sensitive source information.

**Legacy caches:** project-local `query-engine.db` files are not read, migrated,
overwritten or deleted. The first normal query rebuilds its new global index
from sources. Delete an old local cache manually only if you no longer need it.
To rebuild a global cache, remove the exact returned `database` file while no
queries are running; the next normal query recreates it. No automatic pruning.

## Dry-run result

```json
{
  "dryRun": true,
  "folder": "/canonical/project",
  "database": "/home/user/.pi/agent/query-engine/<hash>.db",
  "indexed": 3,
  "eligible": 3,
  "pending": {
    "added": ["new.py"],
    "changed": ["handler.ts"],
    "deleted": ["removed.md"],
    "unchanged": ["start.sh"]
  },
  "sync": { "updated": 2, "deleted": 1, "unchanged": 1 }
}
```

- `indexed` is the cached row count **before** a sync; `eligible` is the current
  source count. `database` is the intended path even if it does not exist.
- All four path arrays are alphabetical, complete and relative to `folder`.
  `changed` is based on bytes, not modification times. Renames appear as
  added/deleted. Newly excluded files appear as deleted if previously cached.
- `sync` is **planned work**: `updated = added + changed`, not performed writes.
- No directory/schema creation, migration, journal/accounting writes, inference,
  backend imports or network calls. Existing indexes open read-only. Indexes use
  SQLite rollback journals so read-only inspection does not create WAL/SHM files;
  a manually converted WAL index is refused by dry runs.
- Planning uses the same scanner/hashes as actual indexing, including tokenizer
  filtering, symlink refusal and UTF-8 validation. It reads full eligible files;
  a large tree can still take time. It is a point-in-time plan, not a reservation;
  normal queries rescan and validate independently.
- No answer/recommendations or usage billing information is returned. Invalid or
  corrupt stores fail explicitly rather than reporting an empty cache.

## Normal query and indexing guarantees

Before answering, the engine syncs added/changed/deleted sources atomically.
Unchanged files reuse their summaries. It sends **every** cached row in binary
alphabetical path order, with path, summary and index time, to local SGLang.
There is no top-k retrieval, query-map clipping, stale-map fallback or source edit.

A normal result includes `dryRun:false`, `folder`, `database`, `indexed` (after
sync), `sync` (performed counts), `answer`, ordered `files` with `path`, `reason`
and cached `summary`, and `limitations`. Model usage is available separately in
the library result/Pi tool accounting. Answers use SGLang constrained JSON;
recommended paths must actually exist in the indexed map.

Each summary targets about **200 words** as a sizing hint, not a hard limit.
Sources are consumed completely. Large UTF-8 files split losslessly into ordered
chunks; every chunk is summarized, then reduced into one file summary. All
indexing work shares at most **four** concurrent inference calls. Progress reports
completed files and chunks, then answering. UTF-8 characters are never split.

Sources are checked again before committing and before returning an answer.
Summarization/cancellation/race failures cannot commit a partial source map.
Same-folder operations serialize within one process; SQLite commits are
transactional, but cross-process calls can duplicate inference work. Inference
outages, invalid model responses and full-map context-capacity failures are
reported; no silently stale answer. A source change during answering rejects the
answer, although the already-completed index sync remains committed.

## Eligibility and exclusions

Eligible extensions (case-insensitive):

```text
.py .js .mjs .cjs .ts .tsx .jsx .md .html .css .svelte .txt
.sh .bash .yaml .yml .toml
```

Skipped directory names:

```text
.git .hg .svn node_modules __pycache__ .venv venv env .env
site-packages vendor dist build out target coverage .next .nuxt
.svelte-kit .cache .tmp hf-cache
```

Also skipped: `query-engine.db` and its sidecars, `.min.js`/`.min.css`, lock files,
source/directory symlinks, and anything outside the selected folder. No `.gitignore`
filtering: eligible hidden or ignored files may be indexed. NUL/binary or invalid
UTF-8 content in an otherwise eligible file fails explicitly; it is never
silently omitted.

`merges.txt` / `vocab.txt` are excluded **only** beside a regular
`tokenizer_config.json` or `tokenizer.json`. These are tokenizer data, not source.
Model READMEs, custom code and ordinary `src/models/` sources remain eligible;
there is no blanket model-directory exclusion. A symlinked tokenizer marker does
not authorize the exclusion.

## Library and modules

```js
import { planProject, queryProject } from "./lib/query-engine.mjs";

const plan = await planProject({ folder: "/project", signal });
const result = await queryProject({ folder: "/project", question: "Find routes", signal, onProgress });
// queryProject({ folder, dryRun: true }) is equivalent to planProject.
```

- `lib/query-engine.mjs`: scanner, lossless chunking, concurrency, summarization,
  source verification and orchestration.
- `lib/index-store.mjs`: canonical-folder key location, private SQLite store,
  read-only cache snapshots, identity checks and hash-based planning categories.
- `lib/format-result.mjs`: shared text output for Pi and CLI.
- `extensions/sgai-query.ts`: required parameters, output schema, progress and
  Pi accounting adapter.
- `cli.mjs`: strict argument parsing, help, output and exit-code adapter.

Optional library dependencies `complete`, `check` and `storeDir` support isolated
checks. Dry runs never invoke `check` or `complete`.

## Validation

```sh
npm test                  # unit, planning, CLI and Pi extension integration
npm run test:extension    # Pi SDK loader + mock local HTTP server
npm run test:live         # real local SGLang; fails if unavailable
```

Tests isolate stores and cover canonical alias reuse/folder isolation, required
arguments, offline/nonmutating dry runs, legacy caches, identity/link safety,
incremental sync, rollback, source races, full Unicode consumption, tokenizer
exclusions, four-call concurrency, CLI help/JSON and extension usage accounting.
Live checks index a disposable project, preview before/after, query real SGLang,
and verify incremental sync. Live inference speed/relevance is not established
by offline checks.
