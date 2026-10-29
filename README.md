# Pi extensions

A collection of source-installable Pi extensions for script execution, tool rendering,
search, evidence retrieval, context management, and delegated work. Each extension uses
Pi's extension APIs; installation does not patch the Pi runtime.

Start with the [Script Tool guide](tool-scripting/README.md) for the unified Bash/Python
API, examples, execution semantics, architecture, and known limitations. For a practical
walkthrough of the tools and modules, see the [Swamix AI engineering field guide](docs/blog/00-collection.md).

**Custom implementation and support:** [nikhil@swamix.com](mailto:nikhil@swamix.com) · [swamix.com](https://swamix.com).

One npm folder per extension. Each package builds to a single-file ESM bundle in
`<package>/build/`, declared by its own `pi.extensions` manifest, and the installer deploys
that folder into `$PI_CODING_AGENT_DIR/extensions/<name>/`. `~/.pi/agent` is a deploy
target, never the source of truth.

## Install

```sh
bash install.sh                     # build packages and deploy the directory-based extensions
bash tool-subagentx/install.sh      # build + register tool-subagentx as a pi package
python3 tool-query/reinstall.py     # register the tool-query evidence engine package
```

Then run `/reload` in open Pi sessions. Do not also register a source package with
`pi install` if the same extension is already deployed under the agent's `extensions/`
directory: duplicate tool registrations can prevent startup. For a scripting-only
installation, follow the [package installation guide](tool-scripting/README.md#install-from-source). Pi discovers one directory level in
`extensions/`: a folder whose `package.json` declares `pi.extensions` is loaded from those
paths, so the deployed folder is `package.json` + `build/<name>.js`.

Requirements: Pi with the `extensionSettings` API; [Bun](https://bun.sh) for builds; Node 22+
for tests. Settings live in `settings.json:extensionSettings.<name>`; each package carries
its own inlined `src/extension-settings.ts` helper (no shared lib import at runtime).

## Layout

| Path | Purpose |
| --- | --- |
| [`tool-scripting/`](tool-scripting/README.md) | One `script` tool with `mode=bash\|python`, raw source, working directory, and wait budget. Python uses uv with optional dependencies. Includes persistent logs, timeout handoff, and boxed terminal views; native Bash remains available. |
| `sgai-formatter/` | Width-aware assistant/tool Markdown rendering, including boxed YAML; answers the synchronous `sgai:format-markdown` event for tool-subagentx. |
| `util-compaction/` | Triggers native `ctx.compact()` when estimated context crosses the threshold (default 100k); `/settings:util-compaction [on\|off\|<tokens>]`. |
| `tool-search/` | `web_search` / `web_fetch` across deepseek, brave, perplexity, searxng and antigravity, with per-call provider selection and automatic failover. |
| `tool-query/` | Evidence query engine package (`@sgai/pi-tool-query`): the `evidence` tool, Python CLI, tests and `reinstall.py`. Self-registers. |
| `tool-subagentx/` | SubagentX package (`@sgai/pi-tool-subagentx`): `src/sgai-subagentx.ts`, minified `build/reloadable/tool-subagentx.js`, `install.sh` / `uninstall.sh`. Self-registers. |
| `scripts/` | `build-extension.sh <package>` reads `pi.extensions[0]` and bundles `src/index.ts`; `build-all.sh` builds every package. |
| `package.json` | Private workspace root: package list, `build` and `install:pi` scripts. |

Each extension folder contains `package.json`, `src/index.ts` and (after a build) `build/`.
Build output is gitignored; `install.sh` always rebuilds before deploying. Shared helpers
(`extension-settings.ts`, `output-budget.ts`) are copied into each package's `src/` and
inlined by the bundler, so no package imports outside its own folder.

## Script execution at a glance

```json
{
  "mode": "python",
  "title": "calculate total",
  "script": "print(sum([10, 20, 30]))",
  "dir": ".",
  "timeout": 30
}
```

Pass this object to the `script` tool. Use `mode: "bash"` for shell commands and
`deps: ["package"]` for ephemeral Python dependencies.

**Timeout returns control; it does not kill the process.** A timed-out run returns a
PID and log path for follow-up. Each call runs in a separate process, and scripts use
Pi's OS permissions—not a sandbox. Captured output is logged under the execution
working directory's `.pi/scripting/` folder; do not commit sensitive execution artifacts.

The renderer currently caps each code/output box separately, not the whole call.
See [known limitations](tool-scripting/README.md#known-limitations) before relying on
historical Bash rendering or narrow-terminal layouts.

## Build

```sh
npm run build                          # or: bash scripts/build-all.sh
npm --prefix tool-scripting run build  # or: bash scripts/build-extension.sh tool-scripting
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
   `scripts.build: "bash ../scripts/build-extension.sh <name>"`, and its peer dependencies.
3. Append `<name>` to the root `workspaces` array, `scripts/build-all.sh`, and the
   `packages` array in `install.sh` when it should deploy flat.

## Context-output safety

tool-scripting enforces a **64 KiB UTF-8 cap on the complete returned text**, including status
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

Install the repository's commit hook with `git config core.hooksPath .githooks`.
Context/cache changes are verified manually through actual Pi RPC turns and provider/router
telemetry; retired context-budget unit checks are not an acceptance gate. For scripting
changes, separately verify execution through Pi and terminal rendering: a successful bundle
or runner-only test does not prove extension discovery or visual behavior.

## Tests

```sh
git -c core.hooksPath=.githooks hook run pre-commit   # repository's configured checks
node --test tests/test-tool-scripting.mjs            # deployed scripting bundle; run install.sh first
cd tool-query && python3 -B tests/fanout_unit.py      # offline evidence-engine validation
node --test ../tests/test-subagent-rendering.mjs      # umbrella repo; real Pi TUI, run install.sh first
```

Suites drive installed or built copies, so build before testing.
