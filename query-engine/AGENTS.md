# pi-evidence-engine — Agent Guide

Fanout evidence compiler backing pi's `evidence` tool: deterministic 125-line
window selection by rare-term IDF coverage, parallel local-model extraction,
line-range citations validated against disk, quotes rebuilt from files.

## Layout
- `cli.py` — entry point (`--folder`, `--question`, `--list`, `--windows`, `--concurrency`, `--json`)
- `query_engine/` — `engine.py` (scanner/enumeration), `fanout.py` (selection,
  extraction, validation, assembly, cache), `store.py` (private SQLite cache),
  `__main__.py` (CLI)
- `src/index.ts` + `build/sgai-evidence.js` — pi tool wiring; `package.json` manifest
- `tests/fanout_unit.py` — offline validation suite (no network/inference)
- `reinstall.py` — `pi install` + absolute-path package registration

## Extraction facts
- Endpoint `FANOUT_URL` (default `http://127.0.0.1:30000/v1`); model from
  `FANOUT_MODEL` or first `/v1/models` entry.
- Greedy `temperature 0`, `enable_thinking: false`, `response_format`
  json_schema; `max_tokens 2048`; token-ceiling failures retry as half windows.
- The model cites line ranges only; quotes are always rebuilt from disk.
- Cache keyed by question+model+path+content hash+range in per-folder store;
  `PI_QUERY_STORE_DIR` overrides. Changed files self-invalidate.
- Ask narrow symbol-bearing questions; joined identifier terms
  (e.g. `formattedmarkdown`) drive selection. Re-ask narrower on thin packets
  instead of repeating.
