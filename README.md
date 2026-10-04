# Pi Query Engine

Folder-scoped codebase discovery with local SGLang inference. Pi's `query` tool syncs a complete source map, answers a project question, and recommends files to read with contextual summaries. It does not edit source files or replace exact source verification.

## Install and use

Requires Pi, Node.js 22.19+ and the existing local inference library at `~/.pi/agent/lib/local-ai.mjs`.

```sh
pi install /home/ubuntu/src/query-engine
```

Run `/reload` in Pi after installation or code changes. The extension registers `query` as an active tool and gives it highest prompt preference for codebase discovery, before exploratory `read`, `find` or `grep`. Explicit file reads still go directly to `read`; read recommended source before editing or making exact claims. Preference is guidance, not a ban on other tools.

Tool arguments:

```json
{
  "question": "Where is authentication checked, and which files should I read before changing it?",
  "folder": "/path/to/project"
}
```

`folder` is optional and defaults to the Pi session's working directory. Relative paths resolve from that directory. Each selected folder owns its own `query-engine.db`; selecting a subfolder creates an independent map there.

The result contains the answer, recommended relative paths in reading order, reasons, approximately 200-word file summaries, source-verification limitations and sync counts. The tool also reports local token usage and indexing progress.

## Source map and sync

Eligible extensions: `py`, `js`, `md`, `ts`, `html`, `css`, `svelte`, `txt`, plus `jsx`, `mjs`, `cjs` and `tsx` (case-insensitive).

Ignored directory names: `node_modules`, `.venv`, `venv`, `.git`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.cache`, `.svelte-kit`, `.next`, `dist`, `build` and `coverage`. Symlinked files and directories are skipped. There is no additional Git-ignore filtering. Non-UTF-8 or binary files with eligible extensions fail explicitly rather than disappearing from the map.

Every tool call:

1. Checks the local endpoint and exact served model.
2. Scans all eligible files recursively and hashes their full contents with SHA-256.
3. Reuses unchanged summaries; summarizes added or changed files with four concurrent workers. Large files are consumed completely in UTF-8-safe chunks, then their notes are recursively merged into one summary. Approximately 200 words is a sizing hint, not a clipping limit.
4. Re-scans for source changes, then commits additions, changes and deletions in one SQLite transaction. Failed syncs preserve the previous complete index but never answer from it.
5. Sends **every** indexed path and summary to SGLang, sorted alphabetically with SQLite binary collation:

   ```text
   "backend/auth.py" : approximately 200-word summary

   "frontend/login.ts" : approximately 200-word summary
   ```

6. Uses SGLang's constrained JSON-schema decoding to require `answer`, `files` and `limitations`, with recommended paths restricted to the indexed files. Validates the result again in the engine. A final source rescan prevents returning an answer when files changed during inference.

Same-folder calls are serialized in-process. SQLite uses WAL, a five-second busy timeout and transaction-time map validation for concurrent processes. Concurrent source changes produce an explicit retry error, not stale context.

## Database

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  index_time TEXT NOT NULL
);
```

`path` is relative to the selected folder, using `/` separators. `index_time` is an ISO UTC timestamp for the last summary generation; unchanged rows retain it. There is one row per eligible source file, not a vector index or top-k retrieval database.

New databases have owner-only permissions. Summaries are sensitive local project data; add these patterns to the project's `.gitignore`:

```gitignore
query-engine.db
query-engine.db-wal
query-engine.db-shm
```

To rebuild the cache, remove those files only when no query is running. The next call indexes the folder again.

## Local inference and limits

Uses the existing `LocalAI` entry point. Settings come from `~/.pi/agent/settings-subagentx.json`, or `SETTINGS_SUBAGENTX_PATH` for tests:

- `localBackendUrl`: defaults to `http://127.0.0.1:30000/v1`; must be loopback.
- `localModel`: must be exactly `granite-4.2-3b-fp8`.
- `localMaxTokens`: existing shared output cap; the engine requests up to 2048 tokens per summary and 4096 per answer.

Thinking is disabled, reasoning effort is low and each inference call has a 60-second timeout. The shared `LocalAI` library must support the optional `responseFormat` argument for constrained query answers (plain-text summary calls are unchanged). Start the configured SGLang server with:

```sh
~/src/sglang-server/launch-sgl.sh
curl -fsS http://127.0.0.1:30000/v1/models
```

The first query indexes the whole folder and can be slow; later calls reuse summaries for unchanged content. There is no silent excerpt, top-k selection, remote-model fallback or stale-map fallback. The complete map must fit the local model's context; if it does not, the tool fails and asks you to select a smaller folder. Summaries can omit details, so they are discovery context, not exact source evidence.

## Verification

```sh
cd /home/ubuntu/src/query-engine
npm test
```

Runs the engine regression suite and a real Pi resource-loader/session integration test backed by a mock SGLang HTTP/SSE server and the real `LocalAI` library. It verifies schema, filtering, alphabetical completeness, incremental sync, rollback, Unicode chunking, source races, invalid recommendations, cancellation, default tool activation and preference in the model's system prompt. The integration test locates the installed Pi SDK locally; no duplicate host packages are bundled.

With real SGLang running, the optional live check indexes a temporary project, answers a question, changes/adds/deletes files and verifies another query:

```sh
npm run test:live
```

The live check fails if inference is unavailable; it never substitutes a mock. Passing mock tests does not establish real-model answer quality or latency.
