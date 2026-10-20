/** Enforce tool-output budgets independently of optional proactive compaction. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai/compat";
import { boundContent, textBytes, TOOL_OUTPUT_BYTES, REQUEST_TOOL_OUTPUT_BYTES } from "../../smartbash/src/output-budget.ts";

type Content = (TextContent | ImageContent)[];

function archive(value: unknown, settingsFile: string): string {
  const json = JSON.stringify(value);
  const hash = createHash("sha256").update(json).digest("hex");
  const directory = path.join(path.dirname(settingsFile), "artifacts", "tool-output");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${hash}.json`);
  try {
    fs.writeFileSync(file, json, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return file;
}

function marker(file: string) {
  return `\n… [context-budget: output truncated; full result: ${file}. Read bounded ranges; do not reload the whole artifact.] …\n`;
}

function requestToolBudget(ctx: ExtensionContext) {
  return Math.min(REQUEST_TOOL_OUTPUT_BYTES, Math.floor((ctx.model?.contextWindow ?? 65536) * 1.5));
}

function bounded(content: Content, limit: number, payload: unknown, settingsFile: string): Content {
  if (textBytes(content) <= limit) return content;
  return boundContent(content, limit, marker(archive(payload, settingsFile)));
}

export function registerContextBudget(pi: ExtensionAPI, settingsPath: () => string) {
  // Direct tools, MCP and nested codemode results pass through this hook.
  pi.on("tool_result", (event, ctx) => {
    const content = event.content;
    const structuredBytes = event.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(event.structuredContent));
    const limit = Math.min(TOOL_OUTPUT_BYTES, requestToolBudget(ctx));
    if (textBytes(content) <= limit && structuredBytes <= limit) return;
    try {
      const file = archive({ content, structuredContent: event.structuredContent }, settingsPath());
      const textContent: Content = textBytes(content) > limit ? content : [...content, { type: "text", text: marker(file) }];
      // Replacing content also clears structuredContent under Pi's hook contract,
      // so nested consumers cannot re-inject the original oversized object.
      return { content: boundContent(textContent, limit, marker(file)) };
    } catch (error) {
      // If disk is full, preserve the original in non-model-visible session details.
      ctx.ui.notify(`Output archive failed: ${String(error)}. Full result retained in session tool details.`, "warning");
      return {
        content: boundContent([...content, { type: "text" as const, text: "\n… [output truncated; full result retained in session tool details: contextBudgetOriginal] …\n" }], limit, "\n… [output truncated; full result retained in session tool details: contextBudgetOriginal] …\n"),
        details: { originalDetails: event.details, contextBudgetOriginal: { content, structuredContent: event.structuredContent } },
      };
    }
  });

  // Persist aggregate limits without aborting the live run or deleting raw history.
  pi.on("turn_end", (event, ctx) => {
    const results = event.context.contextEntries.flatMap((entry) => entry.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ id: entry.sourceEntry.id, message })));
    if (!results.length) return;
    const perResult = Math.min(TOOL_OUTPUT_BYTES, Math.floor(requestToolBudget(ctx) / results.length));
    const entries = [];
    for (const { id, message } of results) {
      try {
        const content = bounded(message.content, perResult, message, settingsPath());
        if (content !== message.content) entries.push({ type: "context_edit" as const, targetId: id, replacement: { content } });
      } catch (error) {
        ctx.ui.notify(`Context repair deferred to request guard: ${String(error)}`, "warning");
      }
    }
    return { entries };
  });

  // Repair old/resumed sessions too. Preserve system state and every call/result ID.
  pi.on("context_with_system", (event, ctx) => {
    const results = event.messages.filter((message) => message.role === "toolResult");
    const perResult = Math.min(TOOL_OUTPUT_BYTES, Math.floor(requestToolBudget(ctx) / Math.max(1, results.length)));
    let repaired = 0;
    const messages = event.messages.map((message) => {
      if (message.role !== "toolResult") return message;
      let content: Content;
      try {
        content = bounded(message.content, perResult, message, settingsPath());
      } catch {
        // Legacy output is already durable in the original transcript.
        content = boundContent(message.content, perResult, "\n… [output truncated; original remains in the session transcript] …\n");
      }
      if (content === message.content) return message;
      repaired++;
      return { ...message, content };
    });
    if (repaired) ctx.ui.notify(`Context safety: bounded ${repaired} oversized tool result(s); full output preserved.`, "warning");
    // Estimates are not tokenizer guarantees. Stop oversized non-tool input instead
    // of silently dropping user instructions or invoking a live-run compaction.
    const window = ctx.model?.contextWindow;
    if (window) {
      const estimate = messages.reduce((sum, message) => sum + Math.ceil(estimateTokens(message) * 1.5) + 64, 0);
      const reserve = Math.min(16384, Math.floor(window / 4));
      if (estimate > window - reserve) {
        ctx.ui.notify(`Context safety stopped this request: estimated ${estimate} tokens, safe input budget ${window - reserve}. Run /compact, split large input, or select a larger-context model; retry alone will not help.`, "error");
        ctx.abort();
      }
    }
    return { messages };
  });
}
