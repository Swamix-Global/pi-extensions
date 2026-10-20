# pi-evidence-engine

Fanout evidence compiler for the Pi coding agent: one question becomes a
source-verified evidence packet, produced by a local model running on SGLang.

## Why

A strong parent model reasons; it should not burn its context reading whole
repositories to find the six decisive lines. This engine fans one question out
across deterministically selected 125-line code windows, lets a small local
model cite what matters, and validates every citation against the files on
disk. The parent receives compact, line-cited evidence — never repository-wide
summaries, never unverified prose.

## Pipeline

1. **Scan** — absolute-path source scanner reads eligible UTF-8 files with
   SHA-256 hashes (source/build files plus selected project Markdown; no
   data/config formats).
2. **Select** — question terms (including joined identifier forms like
   `formattedmarkdown`) score every 125-line chapter by rare-term IDF
   coverage; coverage-greedy selection diversifies windows so common terms
   cannot crowd out the chapter holding the rare identifier.
3. **Fan out** — bounded parallel extraction requests against the local SGLang
   server (`FANOUT_URL`, default `http://127.0.0.1:30000/v1`; model auto-
   detected or `FANOUT_MODEL`). Each window gets the knowledge-enhanced
   extraction prompt: the model cites 1-based line ranges and states one
   claim per finding — it never retypes code.
4. **Validate** — citations map to absolute lines through the window offset,
   are clamped to the window, capped at twelve lines; quotes are rebuilt from
   the file itself, so they are verbatim by construction. Reversed ranges,
   empty/absence claims and over-length text are rejected and counted.
5. **Assemble** — findings merge into spans (gap ≤ 3 lines), quotes truncate
   with an explicit marker, unknowns deduplicate, and the packet reports
   exactly which windows were searched plus usage and failure statistics.

Window results are cached in a private per-folder SQLite store keyed by
question, model, path, content hash and range; editing a file invalidates its
own evidence. One failed window never sinks a query; degenerate generations
(token ceiling) retry as two half windows.

## Asking well

The engine rewards narrow, symbol-bearing questions with one intent:

| Scenario | Style | Example |
|---|---|---|
| Curiosity | name the mechanism | `how does text_delta update the visible report panel` |
| Refactor impact | name the symbol, ask for blast radius | `if the formattedMarkdown signature changed which render call paths would be affected` |
| Failure behavior | name the event, ask for the fallback | `what happens when no formatter listener replies to the sgai format markdown event` |

Avoid multi-part questions: they dilute window selection. When a packet's
`unknowns` say the answer lives elsewhere, re-ask with narrower terms instead
of repeating the question.

## CLI

```sh
python3 -B cli.py --folder /abs/repo --list                 # enumerate eligible files, no model calls
python3 -B cli.py --folder /abs/repo --question "..."       # YAML evidence packet
python3 -B cli.py --folder /abs/repo --question "..." --json --windows 16 --concurrency 16
```

JSON output embeds a pre-rendered `yaml` field for tool rendering.
`PI_QUERY_STORE_DIR` overrides the cache location.

## Pi extension

`src/index.ts` (built to `build/tool-query.js`) registers the `evidence` and `query` tools: parameters
`folder`, `question`, optional `listFiles`, `windows` (2–24, default 12) and
`concurrency` (2–32, default 12). Results render as fenced YAML, and the renderer asks the
formatter through the synchronous `sgai:format-markdown` event so the packet is boxed and
token-colored at layout width; without a formatter listener the native Markdown code block
remains. `usage` reports local tokens at zero cost. Install the package:

```sh
python3 reinstall.py   # pi install + absolute-path registration
```

## Guarantees and limits

- Every quote in a packet is copied from disk at cited lines; the model never
  supplies quote text.
- Claims are model readings, not runtime proof; read the cited spans before
  editing.
- `searchedWindows` makes coverage auditable; `stats` counts rejections.
- Extraction needs the local SGLang server; enumeration and validation are
  offline-safe. Tests: `python3 -B tests/fanout_unit.py`.
