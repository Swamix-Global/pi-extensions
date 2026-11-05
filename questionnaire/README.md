# questionnaire

Paginated multiple-choice clarification tool for the Pi coding agent. The agent
calls `questionnaire` before starting ambiguous work; the user answers with a
keyboard-driven TUI and the structured answers flow straight back into the
model's context.

## Tool

- **name**: `questionnaire`
- **parameters**:
  - `intro` (optional) — one line of context shown above the questions
  - `questions` (1–10), each with:
    - `prompt` — full question text
    - `options` (1–60) — `{ label, value?, description? }`; long lists paginate
    - `multi` (optional) — allow multiple selections with checkboxes
    - `allowOther` (optional, default true) — adds a free-text "Type something…" option
    - `label` / `id` (optional) — short tab label and stable answer identifier

## UI

One question per screen; options paginated 9 per page.

| Key | Action |
| --- | --- |
| `↑ ↓` | move selection |
| `1–9` | quick-pick visible option (toggle in multi mode) |
| `Space` | toggle option (multi mode) |
| `← →` / `PgUp PgDn` | page through long option lists |
| `Tab` / `Shift+Tab` | next / previous question or review page |
| `Enter` | select, confirm multi-selection, open free-text, or submit |
| `Esc` | cancel (back one level inside the free-text editor) |

A tab bar tracks answered (`■`) vs. unanswered (`□`) questions; the final
**Review & submit** page lists every answer, allows jumping back to change any
question, and submits once everything is answered. Non-TUI sessions return a
clear error so the model falls back to asking in prose.

## Build & deploy

```bash
bash scripts/build-extension.sh questionnaire   # from extensions/
# or, repo-wide:
bash install.sh
```

Deployed to `$PI_CODING_AGENT_DIR/extensions/questionnaire/build/questionnaire.js`.
Run `/reload` in existing Pi sessions to activate.

## Tests

```bash
node --test tests/test-questionnaire.mjs
```
