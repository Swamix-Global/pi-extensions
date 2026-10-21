# Pi extensions

One npm folder per extension. Each package builds to a single-file ESM bundle in
`<package>/build/`, declared by its own `pi.extensions` manifest, and the installer deploys
that folder into `$PI_CODING_AGENT_DIR/extensions/<name>/`. `~/.pi/agent` is a deploy
target, never the source of truth.

## Install

```sh
bash install.sh                     # build every package, deploy the six light extensions
bash tool-subagentx/install.sh      # build + register tool-subagentx as a pi package
python3 tool-query/reinstall.py     # register the tool-query evidence engine package
```

Then run `/reload` in open Pi sessions. Pi discovers one directory level in
`extensions/`: a folder whose `package.json` declares `pi.extensions` is loaded from those
paths, so the deployed folder is `package.json` + `build/<name>.js`.

Requirements: Pi with the `extensionSettings` API; [Bun](https://bun.sh) for builds; Node 22+
for tests. Settings live in `settings.json:extensionSettings.<name>`; each package carries
its own inlined `src/extension-settings.ts` helper (no shared lib import at runtime).

## Layout

| Path | Purpose |
| --- | --- |
| `tool-bash/` | Bash override: named commands, timeouts, pid/poll/kill handoff, full logs under `<cwd>/.pi/smartbash/`, head/tail preview. `/settings:tool-bash` |
| `tool-python/` | uv-based `python` tool: arbitrary on-the-fly scripts with ephemeral deps, syntax-highlighted call view, per-run `script.py`/`out.log` under `<cwd>/.pi/smartpython/`. `/settings:tool-python` |
| `sgai-formatter/` | Width-aware assistant/tool Markdown rendering, including boxed YAML; answers the synchronous `sgai:format-markdown` event for tool-subagentx. |
| `util-openai/` | Default OpenAI `serviceTier` (priority) applied per request; `/settings:util-openai [priority\|default\|auto\|flex]`. |
| `util-compaction/` | Triggers native `ctx.compact()` when estimated context crosses the threshold (default 100k); `/settings:util-compaction [on\|off\|<tokens>]`. |
| `tool-search/` | `web_search` / `web_fetch` across deepseek, brave, perplexity, searxng and antigravity, with per-call provider selection and automatic failover. |
| `tool-query/` | Evidence query engine package (`@sgai/pi-tool-query`): `evidence` and `query` tools, Python CLI, tests and `reinstall.py`. Self-registers. |
| `tool-subagentx/` | SubagentX package (`@sgai/pi-tool-subagentx`): `src/sgai-subagentx.ts`, minified `build/tool-subagentx.js`, `install.sh` / `uninstall.sh`. Self-registers. |
| `scripts/` | `build-extension.sh <package>` reads `pi.extensions[0]` and bundles `src/index.ts`; `build-all.sh` builds every package. |
| `package.json` | Private workspace root: package list, `build` and `install:pi` scripts. |

Each extension folder contains `package.json`, `src/index.ts` and (after a build) `build/`.
Build output is gitignored; `install.sh` always rebuilds before deploying. Shared helpers
(`extension-settings.ts`, `output-budget.ts`) are copied into each package's `src/` and
inlined by the bundler, so no package imports outside its own folder.

## Build

```sh
npm run build                          # or: bash scripts/build-all.sh
npm --prefix tool-bash run build       # or: bash scripts/build-extension.sh tool-bash
```

Bundling rules: Node builtins and host packages (`@earendil-works/pi-*`, `typebox`) stay
external; everything inside the package, including the helper modules, is inlined.
`tool-subagentx` keeps its own `build.sh` because it also inlines third-party dependencies
(`execa`, `yaml`, `lodash-es`, `tree-kill`) and minifies. `tool-subagentx` still loads a few
agent-owned runtime libraries (`local-ai.mjs`, `deepseek-ai.mjs`, `nest-result.mjs`) from `$PI_CODING_AGENT_DIR/lib` — those belong to the agent deployment,
not this tree.

## Adding an extension

1. Create `<name>/src/index.ts` exporting a default `(pi: ExtensionAPI) => void`
   (copy `src/extension-settings.ts` from a sibling if it reads settings).
2. Add `<name>/package.json` with `name`, `pi.extensions: ["build/<name>.js"]`,
   `scripts.build: "bash ../../scripts/build-extension.sh <name>"`, and its peer dependencies.
3. Append `<name>` to the root `workspaces` array, `scripts/build-all.sh`, and the
   `packages` array in `install.sh` when it should deploy flat.

## Context-output safety

tool-bash enforces a **64 KiB UTF-8 cap on the complete returned text**, including status
and retrieval metadata. Line elision alone is not a size limit: even a one-line log can
be megabytes. Log scanning uses fixed-size buffers; original logs stay untouched.

The util-compaction package also registers output-safety hooks, independently of
its optional settled-only 100k-token proactive compaction:

- Direct model-visible tool text is capped at 64 KiB; full results are archived under
  `<agent-dir>/artifacts/tool-output/<sha256>.json` with mode `0600`.
- Nested tool results keep their programmatic schemas; only the enclosing model-visible
  output is capped. Scripts can therefore filter large datasets before returning them.
- `turn_end` adds reversible `context_edit` replacements when aggregate tool text exceeds
  128 KiB (less for small-context models), preserving earlier handlers' proposals.
- `context_with_system` repairs legacy oversized tool results before a request, preserving
  system state and call/result identity. Within-budget messages are not rewritten.
- Conservative residual-input estimates request an abort when oversized user/system/tool
  declarations remain. This is a safety estimate, not an exact tokenizer or provider-limit
  guarantee. No instructions or conversation history are silently deleted.
- If archiving fails, new direct output remains bounded and its full original is retained
  in non-model-visible tool-result details. Legacy originals remain in session history.

Run `/reload` after deployment. Existing session files are never rewritten. Read artifacts
using bounded slices rather than loading an entire result back into context.

Install the local regression gate once with `git config core.hooksPath .githooks`.
The pre-commit hook builds both affected packages and checks byte limits, Unicode/binary
expansion, parallel aggregates, hook composition, nested schemas, disk failure, legacy
compaction, the real 4 MB bash reproduction, and provider cancellation without network IO.

## Tests

```sh
git -c core.hooksPath=.githooks hook run pre-commit   # context-output safety gate
cd tool-query && python3 -B tests/fanout_unit.py      # offline evidence-engine validation
node --test ../tests/test-subagent-rendering.mjs      # umbrella repo; real Pi TUI, run install.sh first
```

Suites drive installed or built copies, so build before testing.
