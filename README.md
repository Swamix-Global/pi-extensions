# Pi extensions

One npm folder per extension. Each package builds to a single-file ESM bundle in
`<package>/build/`, declared by its own `pi.extensions` manifest, and the installer deploys
that folder into `$PI_CODING_AGENT_DIR/extensions/<name>/`. `~/.pi/agent` is a deploy
target, never the source of truth.

## Install

```sh
bash install.sh                 # build every package, deploy the five light extensions
bash subagentx/install.sh       # build + register SubagentX as a pi package
python3 query-engine/reinstall.py   # register the evidence engine package
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
| `smartbash/` | Bash override: named commands, timeouts, pid/poll/kill handoff, full logs under `<cwd>/.pi/smartbash/`, head/tail preview. `/settings:smartbash` |
| `sgai-formatter/` | Width-aware assistant/tool Markdown rendering, including boxed YAML; answers the synchronous `sgai:format-markdown` event for SubagentX. |
| `openai-settings/` | Default OpenAI `serviceTier` (priority) applied per request; `/settings:openai [priority\|default\|auto\|flex]`. |
| `fallback-compaction/` | Triggers native `ctx.compact()` when estimated context crosses the threshold (default 50k); `/settings:fallback-compaction [on\|off\|<tokens>]`. |
| `search-tools/` | `web_search` / `web_fetch` across deepseek, brave, perplexity, searxng and antigravity, with per-call provider selection and automatic failover. |
| `query-engine/` | Evidence engine package (`pi-evidence-engine`): `evidence` tool, Python CLI, tests and `reinstall.py`. Self-registers. |
| `subagentx/` | SubagentX package: `src/sgai-subagentx.ts`, minified `build/sgai-subagentx.js`, `install.sh` / `uninstall.sh`. Self-registers. |
| `scripts/` | `build-extension.sh <package>` reads `pi.extensions[0]` and bundles `src/index.ts`; `build-all.sh` builds every package. |
| `package.json` | Private workspace root: package list, `build` and `install:pi` scripts. |

Each extension folder contains `package.json`, `src/index.ts` and (after a build) `build/`.
Build output is gitignored; `install.sh` always rebuilds before deploying. Shared helpers
(`extension-settings.ts`, `output-budget.ts`) are copied into each package's `src/` and
inlined by the bundler, so no package imports outside its own folder.

## Build

```sh
npm run build                          # or: bash scripts/build-all.sh
npm --prefix smartbash run build       # or: bash scripts/build-extension.sh smartbash
```

Bundling rules: Node builtins and host packages (`@earendil-works/pi-*`, `typebox`) stay
external; everything inside the package, including the helper modules, is inlined.
SubagentX keeps its own `build.sh` because it also inlines third-party dependencies
(`execa`, `yaml`, `lodash-es`, `tree-kill`) and minifies. SubagentX still loads a few
agent-owned runtime libraries (`local-ai.mjs`, `deepseek-ai.mjs`, `subagentx-retry.mjs`,
`nest-result.mjs`) from `$PI_CODING_AGENT_DIR/lib` — those belong to the agent deployment,
not this tree.

## Adding an extension

1. Create `<name>/src/index.ts` exporting a default `(pi: ExtensionAPI) => void`
   (copy `src/extension-settings.ts` from a sibling if it reads settings).
2. Add `<name>/package.json` with `name`, `pi.extensions: ["build/<name>.js"]`,
   `scripts.build: "bash ../../scripts/build-extension.sh <name>"`, and its peer dependencies.
3. Append `<name>` to the root `workspaces` array, `scripts/build-all.sh`, and the
   `packages` array in `install.sh` when it should deploy flat.

## Tests

```sh
cd query-engine && python3 -B tests/fanout_unit.py     # offline evidence-engine validation
node --test ../tests/test-subagent-rendering.mjs       # umbrella repo; real Pi TUI, run install.sh first
```

Suites drive installed or built copies, so build before testing.

Not in this tree: `zai-pack` ships its own MCP extensions as a separate package.
