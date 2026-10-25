/** Enforce tool-output budgets independently of optional proactive compaction. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai/compat";
import { boundContent, textBytes, TOOL_OUTPUT_BYTES, REQUEST_TOOL_OUTPUT_BYTES } from "./output-budget.ts";

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

/**
 * A result carrying a budget marker was bounded at the cap in force then. The
 * aggregate cap shrinks as results accumulate, so re-running the repair would
 * shave a little more off the same results every turn/request, rewriting early
 * history each time — invalidating the provider prefix cache from the first
 * edit onward and re-billing the whole prompt every turn. Bounded once means
 * bounded forever: the request guard still protects the context window.
 */
function isBounded(content: Content): boolean {
  return content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      (block.text.includes("[context-budget:") ||
        block.text.includes("output truncated; original remains in the session transcript")),
  );
}

/**
 * Caps are constant per model, never a share of a budget that shrinks as results
 * accumulate. Any cap derived from live accumulation re-derives differently on every
 * turn, so a 40 KiB result that fits one turn falls outside the smaller cap later and
 * gets rewritten deep in history. Each such edit diverges the prompt prefix (re-billing
 * the whole tail) and invalidates Pi's usage-anchored context estimate, which is what
 * made the reported context percentage flicker between the measured value and a
 * char-based fallback. A result is bounded once, at creation or first repair.
 */
function perResultCap(ctx: ExtensionContext) {
  return Math.max(4096, Math.min(TOOL_OUTPUT_BYTES, Math.floor((ctx.model?.contextWindow ?? 65536) / 2)));
}

/** Two full-size results per request before the burst is sliced smaller. */
function requestCap(ctx: ExtensionContext) {
  return Math.min(REQUEST_TOOL_OUTPUT_BYTES, 2 * perResultCap(ctx));
}

function bounded(content: Content, limit: number, payload: unknown, settingsFile: string): Content {
  if (textBytes(content) <= limit) return content;
  return boundContent(content, limit, marker(archive(payload, settingsFile)));
}

/**
 * Over-window last resort: drop the oldest whole tool blocks instead of shaving
 * results already in history. Rewriting a deep result diverges the provider prefix
 * cache and re-bills the whole tail; removing one contiguous old run is a single
 * prefix cut — the same cost the router pays when it trims — and it keeps the run
 * alive instead of aborting it. Only blocks carrying tool results are dropped, so
 * user instructions and the leading system message always survive, and the cut
 * lands at a low watermark (`DROP_FRACTION`) so the frontier holds for many requests
 * rather than advancing a little on each one.
 */
const DROP_FRACTION = 0.6;

function dropOldestBlocks<T extends { role: string }>(messages: T[], limit: number, weigh: (message: T) => number): T[] {
  const groups: T[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    // A result belongs to the assistant call turn that heads the group; orphan
    // results (already-compacted history) are individually droppable.
    if (message.role === "toolResult" && last?.[0]?.role === "assistant") last.push(message);
    else groups.push([message]);
  }
  const total = (list: T[][]) => list.flat().reduce((sum, message) => sum + weigh(message), 0);
  const kept = [...groups];
  const target = Math.floor(limit * DROP_FRACTION);
  for (let index = 1; index < kept.length - 1 && total(kept) > target; ) {
    if (!kept[index].some((message) => message.role === "toolResult")) { index++; continue; }
    kept.splice(index, 1);
  }
  return kept.flat();
}

export function registerContextBudget(pi: ExtensionAPI, settingsPath: () => string) {
  // One request's worth of tool output is spent as the results arrive: a burst of
  // parallel 64 KiB results must not land 768 KiB in the transcript. Charged at
  // creation, so the bound is written once, at the tail, and never revisited.
  let spent = 0;
  const MIN_SLICE = 8 * 1024;

  // Nested results belong to code, not the model. Preserve their schemas so scripts
  // can filter full data; the enclosing model-visible tool result is capped instead.
  pi.on("tool_result", (event, ctx) => {
    if (event.parentToolCallId) return;
    const content = event.content;
    const structuredBytes = event.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(event.structuredContent));
    const limit = Math.min(perResultCap(ctx), Math.max(MIN_SLICE, requestCap(ctx) - spent));
    spent += Math.min(textBytes(content), limit);
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

  // Persist limits on results that are still over the constant per-result cap.
  pi.on("turn_end", (event, ctx) => {
    spent = 0;
    const results = event.context.contextEntries.flatMap((entry) => entry.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ id: entry.sourceEntry.id, message })));
    if (!results.length) return;
    const perResult = perResultCap(ctx);
    const entries = [...event.entries];
    for (const { id, message } of results) {
      if (isBounded(message.content)) continue;
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
    spent = 0;
    const results = event.messages.filter((message) => message.role === "toolResult");
    const perResult = perResultCap(ctx);
    let repaired = 0;
    const messages = event.messages.map((message) => {
      if (message.role !== "toolResult" || isBounded(message.content)) return message;
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
    // Estimates are not tokenizer guarantees. Fit the window by dropping old tool
    // blocks whole; stop the request only if user/tool-free input still cannot fit,
    // rather than silently dropping user instructions or invoking live compaction.
    const window = ctx.model?.contextWindow;
    if (!window) return { messages };
    const weigh = (message: (typeof messages)[number]) => Math.ceil(estimateTokens(message) * 1.5) + 64;
    const reserve = Math.min(16384, Math.floor(window / 4));
    const fitted = dropOldestBlocks(messages, window - reserve, weigh);
    const estimate = fitted.reduce((sum, message) => sum + weigh(message), 0);
    if (estimate > window - reserve) {
      ctx.ui.notify(`Context safety stopped this request: estimated ${estimate} tokens, safe input budget ${window - reserve}. Run /compact, split large input, or select a larger-context model; retry alone will not help.`, "error");
      ctx.abort();
      return { messages: fitted };
    }
    const dropped = messages.length - fitted.length;
    if (dropped) ctx.ui.notify(`Context safety: dropped ${dropped} oldest tool message(s) to fit; full transcript preserved.`, "warning");
    return { messages: fitted };
  });
}
