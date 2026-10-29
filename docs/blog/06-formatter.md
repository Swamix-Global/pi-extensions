> **Published article:** [Read this guide on swamix.com](https://swamix.com/blog/pi-agent-markdown-formatter/).

![A calm, organized developer workspace](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-script.jpg)

# Readability is a feature of an agent system

### Making terminal output easier to scan with `sgai-formatter`

An agent can produce a correct answer and still make it difficult to use. Tool output, structured evidence, and progress messages all compete for space in a terminal. `sgai-formatter` is a presentation extension intended to make that information easier to scan without changing the underlying facts.

## What it does

The formatter integrates with Pi's Markdown rendering and offers a synchronous formatting event that cooperating extensions can use. It supports width-aware presentation for Markdown and structured output such as YAML. SubagentX can request formatted output through that event; if the formatter is disabled, SubagentX falls back to native Markdown.

This is a **presentation layer**. It does not verify a claim, make external content safe, or replace source review. The goal is to help a developer notice the useful information that is already present.

## Try it

The formatter is included in the shared [Pi extensions installer](https://github.com/Swamix-Global/pi-extensions#install):

```sh
bash install.sh
```

Run this from the extensions repository root and reload an existing Pi session. Then use a cooperating tool that produces Markdown or structured output. The repository contains the implementation at [`sgai-formatter/src/index.ts`](https://github.com/Swamix-Global/pi-extensions/blob/main/sgai-formatter/src/index.ts).

## What to check in your environment

Terminal width, Unicode support, theme, and other registered renderers can affect the final result. In particular, the formatter and scripting extension both have Bash-related rendering hooks; their interaction and historical-call presentation deserve an interactive TUI check. Do not assume every narrow layout is perfect or that a prettier output is more accurate.

A good operational workflow still lets you inspect raw output and original files. Presentation should complement that evidence—not hide it.

---

**Need clearer developer-facing AI workflows?** Swamix Global AI Solutions can tailor presentation, integration, and support to your environment. [Contact Nikhil](mailto:nikhil@swamix.com?subject=AI%20developer%20experience%20and%20support) · [swamix.com](https://swamix.com)
