# Pi Script Tool

Run Bash commands and uv-backed Python scripts through one Pi tool, with a shared execution lifecycle, persistent logs, and language-aware terminal views.

The extension registers **`script`** using Pi's supported extension API. It does not patch Pi, replace the built-in `bash` executor, or rewrite session history.

## Requirements

- Pi with `registerTool`, `registerToolRenderer`, and self-rendered tool view support.
- [Bun](https://bun.sh/) to build the extension.
- Bash for shell execution; [uv](https://docs.astral.sh/uv/) for Python execution.
- The host-provided peer dependencies listed in `package.json`.

This package is currently marked `private: true`. The instructions below install from a source checkout, not from npm.

## Install from source

From the root of a `pi-extensions` checkout, build and register this package:

```sh
bash scripts/build-extension.sh tool-scripting
pi install ./tool-scripting
```

Alternatively, use the repository-wide deployment script:

```sh
bash install.sh
```

**Choose one installation method.** Registering the source package while also deploying a copy under the agent's `extensions/` directory can produce a duplicate `script` registration and prevent Pi from loading the extension. Remove the duplicate registration or deployment before restarting.

Run `/reload` in existing interactive sessions after installing or rebuilding. Rebuilding a source checkout does not update a separately deployed copy; rerun the deployment script when using that installation method.

## Tool API

The following JSON objects are tool-call arguments, not shell commands.

### Bash

```json
{
  "mode": "bash",
  "title": "inspect working tree",
  "script": "git status --short",
  "dir": ".",
  "timeout": 10
}
```

### Python

```json
{
  "mode": "python",
  "title": "summarize values",
  "script": "import statistics\nvalues = [12, 18, 24]\nprint(statistics.mean(values))",
  "timeout": 30
}
```

Use raw Python source rather than shell heredocs or `python -c`. Declare ephemeral dependencies through `deps`; the runner passes them to uv rather than running a separate pip installation.

```json
{
  "mode": "python",
  "title": "render JSON",
  "script": "import sys\nfrom rich import print_json\nprint_json(sys.stdin.read())",
  "deps": ["rich>=13"],
  "stdin": "{\"status\": \"ok\"}",
  "timeout": 60
}
```

| Argument | Required | Meaning |
| --- | --- | --- |
| `mode` | Yes | `bash` or `python`. |
| `script` | Yes | Complete shell commands or raw Python source. |
| `title` | Yes | Short, human-readable purpose for the run. |
| `dir` | No | Working directory; defaults to the session directory. Relative paths resolve against the session directory, not a previous call's directory. |
| `timeout` | No | Wait budget in seconds, default 60; maximum 60 for Bash and 120 for Python. **Not a process lifetime limit.** |
| `deps` | No | Python-only dependency specifications passed through uv's `--with` option. Dependency resolution may require network access. |
| `python` | No | Python-only interpreter version passed to uv, for example `3.12`. |
| `stdin` | No | Python-only standard input text. |

Each call starts a separate process. Do not assume shell variables, imports, or a changed working directory persist into later calls. Use files for durable state and `dir` for each call's working directory.

## Execution and output

- **Wait budget:** at approximately `timeout` (the runner normally hands off slightly early), the tool returns a PID and log path while the process continues. Poll the log or stop the process explicitly using the returned guidance. Do not blindly retry a timed-out command: the first run may still be making changes.
- **Abort:** the runner attempts process-group termination, escalating from TERM to KILL. Timeout handoff and abort are different operations.
- **Logs:** normally started runs write execution artifacts under `<working-directory>/.pi/scripting/<language>/<run-id>/`, including `cmd.sh` or `script.py`, `out.log`, and `meta.json`. Preparation failures, such as a blocked command or missing uv, may not create all of these files.
- **Model-visible output:** returned text is bounded to 64 KiB, including status and retrieval metadata. Full captured output remains in the log; inspect bounded ranges rather than returning the entire log to the model.
- **Terminal output:** code and results have separate boxes. The output's top border shows elapsed time against the wait budget; it is not a percentage-complete estimate.

Scripts execute with the permissions and environment of the Pi process. The Bash catastrophic-command guard is **not a sandbox**. Source files and output logs may contain sensitive data; review them before sharing and exclude `.pi/` artifacts from version control. Log retention and cleanup are the operator's responsibility.

## Settings

```text
/settings:tool-scripting
/settings:tool-scripting on
/settings:tool-scripting off
/settings:tool-scripting bash off
/settings:tool-scripting python on
```

Settings are stored in `extensionSettings.toolScripting`. Disabling a mode rejects execution through `script`; it does not disable Pi's built-in Bash tool or other extensions.

## Harness integration

`src/index.ts` exports Pi's default extension factory and registers:

1. `script`, including its schema, execution callback, model guidance, and call/result renderers.
2. A tool-renderer resolver for historical `bash` and `python` calls, using their saved arguments and results at draw time.
3. The `/settings:tool-scripting` command.

The native `bash` tool remains available. Prompt guidance recommends `script`, but does not enforce routing. Historical rendering changes presentation only; it does not change how a recorded command executed.

## Source map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Public schema, argument normalization, tool registration, legacy renderer registration, and settings command. |
| `src/languages.ts` | Bash/Python preparation, language-specific options, and source presentation. |
| `src/runner.ts` | Working directory, process lifecycle, wait budget, abort handling, logs, and returned results. |
| `src/render.ts` | Width-aware code/result components and progress presentation. |
| `src/box.ts` | Box borders and progress-bar drawing. |
| `src/output-budget.ts` | Bounded model-visible text. |
| `src/extension-settings.ts` | Package-local settings access. |

## Known limitations

- The display budget is currently **10 content rows per box**, not 10 rows for the complete call; borders add more rows. Expanding a result does not remove this display cap.
- Long code-box titles or directory labels can overflow because the title row is not yet wrapped.
- Below 16 terminal columns, the result fallback omits output text.
- Legacy results without scripting metadata can display placeholder timing, line counts, or empty log paths. Old calls do not necessarily have scripting log artifacts.
- The repository's formatter also registers a Bash call renderer. Resolver ordering can affect which call view is used; coexistence and historical rendering still need interactive TUI verification.

These are presentation limitations, not a claim that the underlying execution failed. Current smoke checks cover fresh Pi loading, Bash execution, Python execution, and timeout handoff. They do not establish complete visual compatibility or comprehensive regression coverage.
