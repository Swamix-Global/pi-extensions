# Pi extensions

Personal extension pack for the [Pi coding agent](https://github.com/nikhil-swamix/pi): one
git tree for every extension, the shared settings helper, and their regression tests. The
tree mirrors the agent's install layout, so deploying is a copy, not a rewrite.

## Install

```sh
bash install.sh                 # -> ~/.pi/agent (or $PI_CODING_AGENT_DIR)
```

Then run `/reload` in open Pi sessions. Files land flat in `$PI_CODING_AGENT_DIR/extensions`
because Pi discovers `*.ts` there; `search-tools/` deploys as a directory with `index.ts`.
`~/.pi/agent` is a deploy target, never the source of truth — edit here and reinstall.

Requirements: Pi with the `extensionSettings` API; Node 22+ for tests; Bun for
`tests/test_extension_settings.mjs`. Extensions read settings from
`settings.json:extensionSettings.<name>` through `lib/extension-settings.mjs`, which this
tree owns and installs.

## Layout

| Path | Purpose |
| --- | --- |
| `smartbash.ts` | Bash override: named commands, timeouts, pid/poll/kill handoff, full logs under `<cwd>/.pi/smartbash/`, head/tail preview. `/settings:smartbash` |
| `sgai-formatter.ts` | Width-aware assistant/tool Markdown rendering, including boxed YAML; answers the synchronous `sgai:format-markdown` event for SubagentX. |
| `openai-settings.ts` | Default OpenAI `serviceTier` (priority) applied per request; `/settings:openai [priority\|default\|auto\|flex]`. |
| `fallback-compaction.ts` | Triggers native `ctx.compact()` when estimated context crosses the threshold (default 100k); `/settings:fallback-compaction [on\|off\|<tokens>]`. |
| `search-tools/index.ts` | `web_search` / `web_fetch` across deepseek, brave, perplexity, searxng and antigravity, with per-call provider selection and automatic failover. |
| `legacy/smart-read.ts.disabled` | Retired reader extension, kept for reference; not installed and not loaded. |
| `query-engine/` | The evidence engine, a self-contained Pi package (`pi-evidence-engine`) with its own `package.json`, CLI, tests and `reinstall.py`. Installed by path, not copied. |
| `lib/extension-settings.mjs` | Shared read/write helper for `extensionSettings`, with `PI_EXTENSION_SETTINGS_PATH` override. |
| `tests/` | Offline regressions; installed alongside the extensions. |

Not in this tree: `sgai-subagentx.ts.disabled` is a generated bundle of
[`subagent-pack`](../subagent-pack) and is rebuilt from that source; `zai-pack` ships its
own MCP extensions as a package.

## Tests

```sh
node tests/test-smartbash-rendering.mjs        # renderer: widths, Unicode, expansion, resize
node tests/test-search-tools.mjs               # hermetic; add --live to smoke real providers
bun  tests/test_extension_settings.mjs         # settings round-trip + compaction hooks
node tests/test-smartbash.mjs "$HOME/.pi/agent" "$(mktemp -d)"   # tool execution + logs
cd query-engine && python3 -B tests/fanout_unit.py               # evidence engine
```

Suites drive the installed copies under `$PI_CODING_AGENT_DIR/extensions`, so run
`bash install.sh` first.

`tests/test_extension_settings.mjs` also checks SubagentX's settings pool, but only when
`sgai-subagentx.ts` exists as a flat extension; SubagentX normally ships as its own package
and owns those checks in `subagent-pack`.
