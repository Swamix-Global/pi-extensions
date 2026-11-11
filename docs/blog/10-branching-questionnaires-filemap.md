# Better Agent Decisions: Conditional Questionnaires and Filemap

*By Swamix Global AI Solutions*

An AI coding agent can make two costly mistakes before it writes a line of code: it can misunderstand the request, or misunderstand the repository. Better prompting helps, but neither problem should depend on a model guessing correctly.

At **Swamix Global AI Solutions**, we are exploring a more explicit workflow. A conditional questionnaire turns ambiguous requirements into decisions. Filemap gives the agent a compact, navigable view of the relevant code. Together, they help an engineer inspect the problem before committing to a solution.

This article explains how both tools work, why their boundaries matter, and how to use them on a realistic Filemap improvement request. The branching questionnaire is implemented and tested in a development working tree; it is not yet published on the repository's main branch. Filemap is available in the [pi-extensions repository](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-filemap). Check the branch you install for the exact features it contains.

## Contents

- [Why agents need explicit decisions](#why-agents-need-explicit-decisions)
- [Conditional questionnaires: the contract](#conditional-questionnaires-the-contract)
- [A realistic Filemap decision tree](#a-realistic-filemap-decision-tree)
- [Validation and state management](#validation-and-state-management)
- [Filemap architecture and output budgets](#filemap-architecture-and-output-budgets)
- [A practical engineering workflow](#a-practical-engineering-workflow)
- [Tradeoffs, privacy and limitations](#tradeoffs-privacy-and-limitations)
- [Frequently asked questions](#frequently-asked-questions)
- [Explore the project](#explore-the-project)

## Why agents need explicit decisions

Consider the request, “Improve Filemap.” An engineer could interpret that as better symbol detection, faster traversal, smaller output, clearer truncation notices, or a combination of those. Each implies a different implementation and a different definition of success.

An unstructured follow-up can resolve the ambiguity, but a long fixed list asks everyone the same questions. A decision tree is more considerate: ask about Rust declarations only when the user chooses symbol accuracy, and ask about benchmark targets only when performance is the priority.

A map addresses the other half of the problem. It does not decide what the user wants. It helps an agent locate the files and declarations relevant to that decision. The distinction is important: **intent is supplied by people; repository evidence comes from inspection.**

## Conditional questionnaires: the contract

The questionnaire tool presents one question at a time in a terminal, supports single and multiple selection, and offers a review step. The branching implementation adds an optional condition to a question:

```json
{
  "questionId": "goal",
  "equals": "accuracy",
  "otherwise": false
}
```

The question is active only when the earlier question `goal` is active and answered, and its answer contains the exact value `accuracy`. Set `otherwise` to `true` to activate the opposite arm. If the parent is unanswered or inactive, neither arm appears.

Matching is case-sensitive and exact. For a multi-select answer, selecting the tested value is enough to activate the matching arm. Typed custom answers are also considered; they are not a fuzzy match. Explicit option values make conditions more stable than relying on display labels.

A conditional question may itself be a parent. The root is depth zero, and the implementation allows up to three conditional levels beneath it. That means four questions can appear along one dependency chain. The depth limit is a product constraint, not a claim that deeper decision trees are impossible.

## A realistic Filemap decision tree

Imagine that the user wants to improve Filemap. This abbreviated call distinguishes accuracy from the alternative and asks a deeper question only when it is relevant:

```json
{
  "intro": "Choose the Filemap outcome to prioritize.",
  "questions": [
    {
      "id": "goal",
      "prompt": "What should we improve?",
      "options": [
        { "label": "Mapping accuracy", "value": "accuracy" },
        { "label": "Performance", "value": "performance" }
      ]
    },
    {
      "id": "accuracy_area",
      "prompt": "Which accuracy issue matters most?",
      "options": [
        { "label": "Missing symbols", "value": "symbols" },
        { "label": "Incorrect locations", "value": "locations" }
      ],
      "when": { "questionId": "goal", "equals": "accuracy" }
    },
    {
      "id": "language",
      "prompt": "Which language has missing symbols?",
      "options": [
        { "label": "Rust", "value": "rust" },
        { "label": "TypeScript", "value": "typescript" }
      ],
      "when": { "questionId": "accuracy_area", "equals": "symbols" }
    },
    {
      "id": "rust_scope",
      "prompt": "Which Rust declarations need attention?",
      "options": [
        { "label": "Methods and trait implementations", "value": "methods" },
        { "label": "Structs, enums and types", "value": "types" }
      ],
      "when": { "questionId": "language", "equals": "rust" }
    },
    {
      "id": "performance_goal",
      "prompt": "Which performance outcome matters most?",
      "options": [
        { "label": "Faster scans", "value": "speed" },
        { "label": "Lower memory use", "value": "memory" }
      ],
      "when": { "questionId": "goal", "equals": "accuracy", "otherwise": true }
    }
  ]
}
```

A user choosing performance sees the performance question, not the Rust branch. Someone choosing accuracy, missing symbols, and Rust reaches the third conditional level. In a production questionnaire, include a clear acceptance criterion as well: for example, a reproducible missed declaration, a regression test, or a benchmark with a defined workload.

## Validation and state management

A useful interface must also behave predictably when a user changes their mind. The implementation validates question IDs and dependencies before opening the UI. Duplicate IDs, references to missing or later questions, malformed conditions, and dependency depth greater than three return errors rather than leaving the user in a broken flow.

After an answer changes, the active set is recomputed in declaration order. Questions that become inactive lose their stored answers, multi-select state and custom drafts, including descendants. Navigation, review and submitted answers use the active set.

This is a deliberate tradeoff. Clearing a hidden branch avoids returning contradictory answers, but switching back means the user must re-enter discarded details. Preserving drafts would be friendlier in some workflows, but it would need a separate, explicit policy to prevent inactive answers from leaking into the result.

The current tool limits a call to ten questions and each question to sixty options. Non-interactive sessions return a clear error rather than pretending to collect input. These constraints make the tool suitable for a focused clarification, not an unrestricted survey engine.

## Filemap architecture and output budgets

[Filemap](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-filemap) separates its interface from its work. A TypeScript extension registers the tool and invokes a native Rust binary. The binary walks the requested path and emits a compact tree, with symbol rows for supported source files. A row can include a declaration name, its line number and a short summary derived from nearby documentation.

The tool is designed for navigation, not semantic proof. A symbol row is a pointer to the code an engineer should inspect. It is not a substitute for reading the implementation, understanding callers or running tests.

The current source supports Python, JavaScript and TypeScript, Rust, Svelte and HTML symbol extraction. In Git repositories, symbol extraction is limited to tracked, non-library source files. An untracked source file may appear in the tree without symbol rows. Staging a new file makes it tracked for Git's listing, but teams should follow their own staging policy rather than staging solely to satisfy a map.

Output is bounded. The current tool schema defaults to a 100 KiB byte budget, accepts an explicit budget, and has a maximum depth setting. The map dynamically allocates space across directories. When space is tight, it trims lower-priority symbol detail and reports limits or trimming instead of quietly presenting a partial map as complete. The exact output and defaults are version-specific, so consult the [Filemap source](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-filemap) for the version you run.

A truncated result is a cue to map a narrower path or adjust the budget. It is not evidence that omitted files or symbols do not exist.

## A practical engineering workflow

Here is how the two tools can work together without turning a small task into a ceremony:

1. **Clarify the outcome.** Ask whether the issue is accuracy, performance or presentation. Follow the selected branch to a concrete example and an acceptance criterion.
2. **Map the narrowest useful scope.** For a Rust symbol issue, start with Filemap's native parser directory rather than the whole repository. Check the output for trim or limit notices.
3. **Read the implementation and tests.** Use the map's paths and line numbers as entry points. Verify the report against real code and a minimal reproduction.
4. **Choose and implement a fix.** Preserve existing contracts, cover the reported case and check adjacent failure modes.
5. **Report evidence.** Distinguish an automated test, a local benchmark and a live deployment. A passing test does not establish a performance improvement, and a benchmark without a workload is difficult to reproduce.

For the budget and truncation example, a meaningful benchmark should define the repository or fixture, byte budget, output completeness criteria, machine and measurement method. Compare the same workload before and after the change. The desired result might be lower latency at a fixed budget, more useful retained structure at a fixed budget, or better notices. Those are different objectives and should not be conflated.

## Tradeoffs, privacy and limitations

- **The questionnaire needs a person.** It blocks while waiting for interactive input. Use defaults or plain conversation where an interactive terminal is unavailable.
- **Conditions are exact.** A changed value, capitalization or whitespace can change the selected branch. Multi-select conditions test membership, not equality of the whole set.
- **Hidden work is discarded.** This keeps answers consistent but may surprise users who revisit a branch.
- **Maps have blind spots.** Symbol extraction is heuristic and filtered. Generated code, tests, untracked files and unusual syntax require particular care; inspect the relevant version and repository directly.
- **Local processing is not the same as private output.** A map can reveal paths, identifiers and documentation. Questionnaire answers and tool results may enter a session transcript and, depending on the setup, a model provider's context. Do not put secrets in prompts or custom answers.
- **Neither tool replaces review.** An explicit choice can still be a poor choice, and a concise map can still omit the fact that changes the design.

## Frequently asked questions

### How deep can questionnaire branches go?

The development implementation permits three conditional dependencies below an unconditional root. A fourth conditional level is rejected. This is separate from Filemap's directory-depth setting.

### Can an answer activate more than one follow-up?

Yes. More than one question can depend on an earlier answer. With multi-select, separate questions can match different selected values.

### Does Filemap index every file in a repository?

No. Tree inclusion and symbol extraction follow different rules. In Git repositories, untracked files do not contribute symbol rows, and library or test-related paths can be filtered. Budgets can also truncate output. Read the tool's notices and inspect the source when completeness matters.

### Is the branching questionnaire already released?

The implementation and automated tests discussed here were verified in a development working tree. At publication time, the branching changes had not been committed to the public main branch. Check the repository and installed version before relying on the interface.

## Explore the project

- Browse [Swamix Global AI Solutions](https://swamix.com/) and the [engineering blog](https://swamix.com/blog/).
- Explore the [Pi extensions repository](https://github.com/Swamix-Global/pi-extensions), [Filemap source](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-filemap), and [questionnaire documentation](https://github.com/Swamix-Global/pi-extensions/tree/main/util-questionnaire).
- Continue with [Filemap on the Swamix blog](https://swamix.com/blog/filemap/) and the repository's [engineering article collection](https://github.com/Swamix-Global/pi-extensions/tree/main/docs/blog).

*Written by Swamix Global AI Solutions. Examples describe the implementation and limitations observed during development; verify behavior against your installed version.*
