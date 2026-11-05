# quota-helper

Shows the **active model's provider quota** — 5-hour rolling window + weekly window — as
percentages in Pi's footer status bar, **right-justified** to the terminal width.

```
                                                                    gpt-6-luna │ 5h 42% ↻1h12m │ wk 12% ↻3d4h
```

The widget follows model selection (`/model`, `Ctrl+P`): switching providers retargets
it instantly, switching models relabels it. Only the **selected provider** is polled —
one lightweight authenticated GET every 30 seconds while a session is open.

## Data sources

| Provider ids | Endpoint | Windows |
| --- | --- | --- |
| `openai-codex`, `openai` (oauth) | `GET https://chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window` (5h), `secondary_window` (7d), plan, credits |
| `zai`, `zai-coding-cn`, `*zai*`/`*glm*`/`*bigmodel*` | `GET {host}/api/monitor/usage/quota/limit` — `open.bigmodel.cn` for CN ids, else `api.z.ai` | `data.limits[]` rows `unit 3` (5h) and `unit 6` (weekly), plan from `data.level` |

Credentials are read from `~/.pi/agent/auth.json` (`access`/`accountId` for codex oauth,
`key` for zai api keys) — the same store the context router uses — and re-read before
every fetch, so OAuth refreshes are picked up automatically. `PI_QUOTA_HELPER_AUTH` (or
`PI_ROUTER_AUTH`) overrides the path. Codex providers try a ranked candidate list: a
credential ranks first when it carries a ChatGPT account binding (`accountId` field or
`chatgpt_account_id` JWT claim) — the `openai` provider's own token (scopes
`chatgpt.tokens.use.direct`, no account claim) is rejected by the usage endpoint with
401 `no_matching_rule`, so the shared `openai-codex` subscription token serves the
readout (`/quota` shows `via <source>`). Auth rejections fall through
candidate-by-candidate; the status hides only when every candidate fails. Any other
provider renders no status.

## Smart polling

- **30s interval, active provider only** (configurable, see Settings).
- **In-flight guard** — no overlapping requests.
- **Exponential backoff** on fetch errors: 30s → 1m → 2m → 4m → 5m cap, reset on success.
- **Auth-aware hide** — only when *every* candidate credential is missing or rejected
  (HTTP 401/403) does the status hide silently and polling stop; a single rejected
  candidate just falls through to the next one.
- **Free mid-run updates** — `x-codex-primary/secondary-used-percent` response headers are
  harvested opportunistically when the proxy forwards them.
- **Immediate refresh** on `session_start` and on provider switch; full teardown on
  `session_shutdown`.

## Rendering

Percentages are colored by headroom: green < 70 %, orange ≥ 70 %, red ≥ 90 %, with the
reset countdown (`↻1h12m`, `↻3d4h`) in dim gray. Right-justification pads with
non-breaking spaces — Pi's footer sanitizer collapses ASCII space runs, and U+00A0 is the
only blank that survives while still occupying one cell — recomputed on terminal resize.

## Command

`/quota` — force-refresh (skips backoff) and show the full report: plan tier, used/total
units, window lengths, reset times, and credit balance.

## Settings

`~/.pi/agent/settings.json` → `extensionSettings.quotaHelper`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable entirely |
| `intervalMs` | `30000` | Poll interval, clamped to 5000–600000 |
| `showResets` | `true` | Append `↻…` reset countdowns to the status line |

## Build / test / deploy

```bash
npm run build                                    # or: bash scripts/build-extension.sh quota-helper
node --test tests/test-quota-helper.mjs          # from extensions/
bash install.sh                                  # deploy all extensions to ~/.pi/agent
```
