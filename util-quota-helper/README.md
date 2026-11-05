# util-quota-helper

Shows the **active model's provider quota** — 5-hour rolling window + weekly window — as
percentages in Pi's footer status bar, **right-justified** to the terminal width.

```
⚡ 15.9M │ 360r        ● 5h ██████▊░ 84% left 🕐3h20m │ 7d ▊░░░░░ 13% left 🕐6d20h
```

The widget follows model selection (`/model`, `Ctrl+P`): switching providers retargets
it instantly, switching models relabels it. Only the **selected provider** is polled —
one lightweight authenticated GET every 30 seconds while a session is open.

It owns the whole status row: the persistent local-model meter on the **left**
(`⚡ 15.9M │ 360r`, read live from `~/.pi/agent/subagentx-local-usage.json`) and the quota
readout flush **right**. The meter degrades `⚡ 15.9M │ 360r` → `⚡15.9M` → gone as the
terminal narrows, but it never vanishes together with the quota: when the active provider
has no adapter or every credential is rejected, the meter alone parks at the left margin.

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

Every number, gauge cell and tint speaks **quota left** — the complement of the wire
`used_percent` that the provider sends and `/quota` reports as *used*. A long green bar
therefore always means plenty; nothing has to be read inside-out.

```
● 5h ██████▊░ 84% left 🕐3h20m │ 7d ▊░░░░░ 13% left 🕐6d20h
     └ gauge ┘ └ percent ┘ └ clk ┘   └ gauge ┘ └ percent ┘ └ clk ┘
```

The ramp runs **four eras**, each strictly louder than the one before, so alarm can never
fall as quota falls:

| Era | Left | Grade names | Text ink | Plate | Emphasis |
| --- | --- | --- | --- | --- | --- |
| ink | 79–100 % | pristine, ample, lush, bountiful, verdant, lime, chartreuse, fresh | green `#00c96f` → lime `#50f700` | — | — |
| weight | 56–78 % | watch, brisk, caution, gilt, amber, tight, steep, flare, hot, blaze, scorch | chartreuse `#8afb00` → orange-red `#ff4600` | — | **bold** |
| recess | 46–55 % | hazard, red, ember, alert, scarlet | pure red `#ff2c00` → `#ff0000` | dark-red wash `#280206` → `#300409` | **bold** + wash |
| incandescent | 0–45 % | critical, grave, burning, severe, inferno, terminal, molten, searing, plasma, core, detonate, nova | **black** bold | lit red `#e81e1a` → `#ff3c2d` | **bold** + lit plate |

The gauge keeps its own **fuel** ink, never the text ink: from 45 % left down the number
inverts to black-on-red for contrast while the bar climbs an afterburner ramp
(`#ff341e` → `#ff9e4c`) — it brightens as it empties instead of going black. The plate
starts after the last gauge cell, so the bar is always light-on-dark. Unfilled cells are
slate `░` over a slate trough, so the empty half reads as a recess, not as fuel.

Gauges use eighth blocks (`▏▎▍▌▋▊▉`), so a 13 % window draws `▊` instead of overstating
itself as a whole cell; numbers are padded to three cells (` 8%`, ` 84%`, `100%`) so a
drain never shuffles the group sideways. Below 1 % the field keeps a decimal (`0.4%`) — a
provider that reports exact ratios can leave a real sliver, and rounding it to `0%` would
claim the window is spent while it still has tokens.

### Window segments

The 5h window is the actionable one (it turns over several times a day) and owns the
widest gauge; the weekly window is context and gets a shorter one, then none. A window
tag takes the band's ink once the segment enters its bold era, so a hot window announces
itself at its left edge; a **spent** window promotes its reset clock to the segment's own
bold ink, because recovery time is then the only actionable fact.

### Density ladder

| Rung | 5h gauge | 7d gauge | Clocks | Notes |
| --- | --- | --- | --- | --- |
| 1 | 8 | 6 | 🕐 | ⚠ cap badge and clock side by side |
| 2 | 8 | 6 | 🕐 | |
| 3 | 6 | 5 | 🕐 | |
| 4 | 5 | 4 | 🕐 | |
| 5 | 4 | 3 | 🕐 | |
| 6 | 4 | 0 | 🕐 | weekly gauge dropped |
| 7 | 3 | 0 | 🕐 | |
| 8 | 2 | 0 | 🕐 | |
| 9 | 0 | 0 | 🕐 | `● 5h 88% left 🕐3h20m │ 7d 70% left 🕐6d22h` |
| 10 | 0 | 0 | — | `● 5h 88% left │ 7d 70% left` |

Degradation is monotone in every dimension: gauges thin, then drop, then the clocks go.
Percents and the word `left` survive every rung — they are the payload, not decoration.
The meter is sacrificed before the reading itself. Composition is width-exact at every
step (never wraps, never truncates), reconsidered on terminal resize.

### Multi-factor analysis

The readout layers three signals, because a bare percentage cannot tell 40 % that is safe
from 40 % about to run dry:

| Signal | Meaning | Channel |
| --- | --- | --- |
| remaining quota | how much is left | gauge length, tint, percent |
| burn-rate forecast | rolling least-squares velocity over the sample history; a window projected to hit its cap **before** it resets swaps its clock for a red `⚠1h05m` badge | badge only — the percent keeps answering *how much is left*, so a healthy 84 % burning hot still looks healthy |
| staleness | newest sample older than 3 poll intervals | LED turns hollow `○` |

The LED itself is tinted by the **worst** window (lowest quota left), escalated by any cap
threat, so the footer warns even when the failing window is scrolled off. `/quota` shows
the same analysis in words: pace per hour, projected time-to-cap, and whether that lands
before or after the reset.

Right-justification pads with non-breaking spaces — Pi's footer sanitizer collapses ASCII
space runs and its `trim()` eats none of the padding because the run is prefixed with an
ANSI reset, so U+00A0 remains the only blank that occupies one cell and survives.

## Command

`/quota` — force-refresh (skips backoff) and show the full report: plan tier, source
credential, quota left vs used, used/total units, window lengths, reset times, credit
balance, per-window burn trend (cap before or after reset), sample telemetry, and the
local meter.

## Settings

`~/.pi/agent/settings.json` → `extensionSettings.quotaHelper`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable entirely |
| `intervalMs` | `30000` | Poll interval, clamped to 5000–600000 |
| `showResets` | `true` | Append `🕐…` reset countdowns (and the `⚠` cap badge) to the status line |
| `predictions` | `true` | Burn-rate prediction layer; `false` keeps the same ladder without a performance track record |

## Build / test / deploy

```bash
npm run build                                    # or: bash scripts/build-extension.sh util-quota-helper
node --test tests/test-quota-helper.mjs          # from extensions/
bash install.sh                                  # deploy all extensions to ~/.pi/agent
```
