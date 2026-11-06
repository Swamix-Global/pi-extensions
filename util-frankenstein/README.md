# util-frankenstein

Virtual model **`openai-codex/auto`** that interleaves two physical OpenAI Codex
models in one conversation with a fixed sequential slot ratio:

    slot 0 → openai-codex/gpt-6-astra  at reasoning "high"
    slot 1 → openai-codex/gpt-6-luna   at reasoning "max"
    slot 2 → openai-codex/gpt-6-luna   at reasoning "max"
    (repeats: A1:L2)

## Semantics

- **Strict sequential cycle over provider calls.** The cycle advances on every agent-loop
  request — the first request after a user message (`user`) *and* every tool-result
  follow-up (`continuation`) — and keeps advancing across user turns. The ratio holds over
  the whole call sequence; it does not reset per turn.
- **Cycle position is router state** stored by Pi on the session branch: it follows forks
  and `/tree` navigation and survives compaction and session resume. A fresh session
  starts at slot 0 (Astra).
- **Retries** stay on the failed model/level without advancing the cycle (keeps prompt
  caches and thinking signatures valid for the retry).
- **Direct out-of-loop requests** (compaction summaries, etc.) go to Luna/max without
  advancing.
- **Native signature handling.** The extension only selects the dispatch pair; Pi's own
  per-request transformation replays each model's reasoning signatures and drops the other
  model's. No history is rewritten. Verified safe for this pair in
  `.pi/experiments/astra-luna/REPORT.md`.
- Limits shown before the first response: 272k context / 128k output (both physical models).

## Commands

```bash
/frankenstein on      # switch session to openai-codex/auto, saving current model+level
/frankenstein off     # restore saved model+level (fallback: astra/high)
/frankenstein status  # cycle position, recent dispatch log, restore point
/model openai-codex/auto   # activate directly (also enables); switching away clears state
```

Selecting `openai-codex/auto` via `/model` saves the previously selected model as the
restore point (its thinking level is unknown to the event, so restore defaults to `high`).
Manually switching away from frankenstein deactivates it and drops the restore point.

## Making the rotation the default

The virtual model is registered **under the physical provider** (`openai-codex/auto`, not a
standalone `frankenstein` provider). Pi's startup resolver honours a saved `defaultProvider`
only when *that* provider has configured auth; a credential-less virtual provider id was
silently skipped and every launch fell through to the first available model. It also means
`/model`, scoped models and `enabledModels` treat it like any other codex model.

To rotate on every session, both settings must agree — scoped models outrank the saved
default at startup:

```jsonc
{
  "enabledModels": ["openai-codex/auto", /* …other models… */],
  "defaultProvider": "openai-codex",
  "defaultModel": "auto"
}
```

A session that still names the retired `frankenstein/auto` provider is migrated back onto
the virtual model on `session_start`.

## Verification (live, 2026-11-06)

Startup dispatch in a fresh session: `gpt-6-astra@high → gpt-6-luna@max → gpt-6-luna@max`
over three provider calls (two tool continuations) — the A1:L2 cycle, intact from launch
without any `/frankenstein on`. Earlier RPC run: 7 provider calls across 5 turns (2 with tool continuations): every call matched the
A1:L2 slot sequence exactly (`astra/high → luna/max → luna/max → …`), ledger markers and
cross-model arithmetic recalled correctly, and errored calls (usage-limit) never derailed
the cycle. Details and drivers: `.pi/experiments/frankenstein-a1l2/`.

## Build / Install

```sh
bash ../install.sh   # from repo root: builds all extensions incl. util-frankenstein
npm run build        # or: bash scripts/build-extension.sh util-frankenstein
```

Run `/reload` in existing Pi sessions after install.
