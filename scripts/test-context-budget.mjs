// Offline regression for the 2026-10-20 3.96M-character retained tool result.
// Run through the repository pre-commit hook; no provider calls or session edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdkRoot = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(`${sdkRoot}/package.json`);
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": `${sdkRoot}/dist/index.js`,
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  typebox: require.resolve("typebox"),
} });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "context-budget-"));
process.env.PI_EXTENSION_SETTINGS_PATH = path.join(temp, "settings.json");
fs.writeFileSync(process.env.PI_EXTENSION_SETTINGS_PATH, JSON.stringify({ extensionSettings: { fallbackCompaction: { enabled: false } } }));
const { SessionManager, buildSessionContext, estimateTokens } = await import(`${sdkRoot}/dist/index.js`);
const bash = await jiti.import(`${root}/smartbash/src/index.ts`);
const fallback = await jiti.import(`${root}/fallback-compaction/src/index.ts`);
const budget = await jiti.import(`${root}/smartbash/src/output-budget.ts`);
const hooks = {};
fallback.default({ on: (name, fn) => { hooks[name] = fn; }, registerCommand() {} });
let aborts = 0;
let compactions = 0;
const notices = [];
const ctx = {
  cwd: temp, model: { contextWindow: 200000 },
  ui: { notify: (...args) => notices.push(args) },
  abort: () => { aborts++; }, compact: () => { compactions++; },
};
const text = (value) => [{ type: "text", text: value }];
const result = (id, value) => ({ role: "toolResult", toolCallId: id, toolName: "test", content: text(value), isError: false, timestamp: Date.now() });
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
try {
  check("inlined package budget copies cannot drift silently", () => {
    assert.equal(fs.readFileSync(`${root}/smartbash/src/output-budget.ts`, "utf8"), fs.readFileSync(`${root}/fallback-compaction/src/output-budget.ts`, "utf8"));
  });
  check("UTF-8 cap, both ends, marker included, exact boundaries", () => {
    for (const limit of [0, 1, 63, 1024, 65536]) {
      for (const value of ["x".repeat(4000000), "🙂汉字".repeat(300000), "a\n".repeat(100000)]) {
        const clipped = budget.boundText(value, limit);
        assert.ok(Buffer.byteLength(clipped) <= limit);
        assert.ok(!clipped.includes("�"));
      }
    }
    assert.equal(budget.boundText("abc", 3), "abc");
    assert.ok(budget.boundText(`HEAD${"x".repeat(1000)}TAIL`, 100).startsWith("HEAD"));
    assert.ok(budget.boundText(`HEAD${"x".repeat(1000)}TAIL`, 100).endsWith("TAIL"));
  });
  check("smartbash caps giant lines, short files and ordinary 5000-line output", () => {
    for (const [name, value, count] of [
      ["one", `HEAD${"x".repeat(4000000)}TAIL`, 1],
      ["fifty", Array(50).fill("x".repeat(80000)).join("\n"), 50],
      ["unicode", "🙂汉字".repeat(300000), 1],
      ["lines", Array.from({ length: 5000 }, (_, i) => String(i + 1)).join("\n") + "\n", 5000],
      ["empty", "", 0], ["small", "hello\n", 1],
    ]) {
      const file = path.join(temp, name);
      fs.writeFileSync(file, value);
      const out = bash.elideLog(file);
      assert.ok(Buffer.byteLength(out.text) <= budget.TOOL_OUTPUT_BYTES);
      assert.equal(out.totalLines, count);
      assert.equal(fs.readFileSync(file, "utf8"), value);
      if (Buffer.byteLength(value) > budget.TOOL_OUTPUT_BYTES) {
        assert.equal(out.elided, true);
        assert.ok(out.text.includes(file));
      }
      assert.ok(!out.text.match(/-\d+ of \d+ lines/));
    }
  });
  check("decoded binary output cannot expand beyond the byte cap", () => {
    const file = path.join(temp, "invalid-utf8");
    fs.writeFileSync(file, Buffer.alloc(60000, 0xff));
    const out = bash.elideLog(file);
    assert.ok(Buffer.byteLength(out.text) <= budget.TOOL_OUTPUT_BYTES);
    assert.equal(out.elided, true);
    assert.ok(out.text.includes(file));
  });
  check("all text blocks share a single cap; images survive unchanged", () => {
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const out = budget.boundContent([...text("x".repeat(100000)), image, ...text("y".repeat(100000)), ...text("")], 8192);
    assert.ok(budget.textBytes(out) <= 8192);
    assert.equal(out[1], image);
  });
  check("global tool hook archives full output even with proactive compaction off", () => {
    const content = text("x".repeat(3957391));
    const out = hooks.tool_result({ content, details: { original: true } }, ctx);
    assert.ok(budget.textBytes(out.content) <= budget.TOOL_OUTPUT_BYTES);
    const file = out.content.map((b) => b.text).join("").match(/full result: (.+?\.json)/)[1];
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).content, content);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(compactions, 0);
  });
  check("oversized structured payload cannot bypass the nested-tool cap", () => {
    const out = hooks.tool_result({ content: text("small"), structuredContent: { data: "x".repeat(100000) } }, ctx);
    assert.ok(out.content[0].text.includes("small"));
    assert.ok(out.content.some((b) => b.text.includes("full result:")));
    assert.equal(out.structuredContent, undefined);
    assert.equal(hooks.tool_result({ content: text("small"), structuredContent: { a: 1 } }, ctx), undefined);
  });
  check("nested programmatic results retain their schema until outer output", () => {
    const event = { parentToolCallId: "outer", content: text("small"), structuredContent: { data: "x".repeat(1000000) } };
    assert.equal(hooks.tool_result(event, ctx), undefined);
    assert.equal(event.structuredContent.data.length, 1000000);
  });
  check("disk failure stays bounded and preserves original in session details", () => {
    const saved = process.env.PI_EXTENSION_SETTINGS_PATH;
    const file = path.join(temp, "not-a-directory");
    fs.writeFileSync(file, "x");
    process.env.PI_EXTENSION_SETTINGS_PATH = path.join(file, "settings.json");
    try {
      const content = text("x".repeat(100000));
      const out = hooks.tool_result({ content, details: { keep: true } }, ctx);
      assert.ok(budget.textBytes(out.content) <= budget.TOOL_OUTPUT_BYTES);
      assert.deepEqual(out.details.contextBudgetOriginal.content, content);
    } finally { process.env.PI_EXTENSION_SETTINGS_PATH = saved; }
  });
  check("aggregate parallel outputs persist as context edits, not aborted runs", () => {
    const manager = SessionManager.inMemory(temp);
    for (let i = 0; i < 12; i++) manager.appendMessage(result(`t${i}`, "x".repeat(65536)));
    const projection = manager.buildSessionProjection();
    const earlier = { type: "custom", customType: "earlier-handler", data: { keep: true } };
    const out = hooks.turn_end({ entries: [earlier], context: { contextEntries: projection.entries } }, ctx);
    assert.equal(out.entries[0], earlier);
    assert.equal(out.entries.length, 13);
    for (const edit of out.entries.filter((entry) => entry.type === "context_edit")) manager.appendContextEdit(edit.targetId, edit.replacement);
    assert.ok(manager.buildSessionProjection().messages.reduce((n, m) => n + budget.textBytes(m.content), 0) <= budget.REQUEST_TOOL_OUTPUT_BYTES);
    assert.equal(aborts, 0);
    assert.equal(compactions, 0);
  });
  check("within-budget historical results stay unchanged for prefix caching", () => {
    const messages = [result("large", "x".repeat(60000)), ...Array.from({ length: 64 }, (_, i) => result(String(i), "small"))];
    const out = hooks.context_with_system({ messages }, ctx);
    for (let i = 0; i < messages.length; i++) assert.equal(out.messages[i], messages[i]);
  });
  check("legacy compaction retains giant pair; request repair preserves IDs and system", () => {
    const manager = SessionManager.inMemory(temp);
    manager.appendMessage({ role: "user", content: "inspect risk", timestamp: 1 });
    const callId = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "grep" } }], timestamp: 2 });
    manager.appendMessage(result("call", "x".repeat(3957391)));
    manager.appendCompaction("existing summary", callId, 1013764);
    const history = manager.buildSessionProjection().messages;
    assert.ok(history.reduce((sum, m) => sum + estimateTokens(m), 0) > 900000);
    const system = { role: "system", content: "system unchanged", timestamp: 0 };
    const out = hooks.context_with_system({ messages: [system, ...history] }, ctx);
    assert.equal(out.messages[0], system);
    assert.equal(out.messages.at(-1).toolCallId, "call");
    assert.ok(budget.textBytes(out.messages.at(-1).content) <= budget.TOOL_OUTPUT_BYTES);
    assert.ok(history.at(-1).content[0].text.length > 3900000);
    assert.equal(aborts, 0);
  });
  check("oversized user input requests abort, without silently deleting instructions", () => {
    const message = { role: "user", content: "x".repeat(1000000), timestamp: 1 };
    const out = hooks.context_with_system({ messages: [message] }, ctx);
    assert.equal(aborts, 1);
    assert.equal(out.messages[0], message);
    assert.ok(notices.at(-1)[0].includes("retry alone will not help"));
    aborts = 0;
  });
  check("small-context models get a smaller aggregate output budget", () => {
    const out = hooks.context_with_system({ messages: [result("a", "x".repeat(100000)), result("b", "y".repeat(100000))] }, { ...ctx, model: { contextWindow: 32768 } });
    assert.ok(out.messages.reduce((sum, m) => sum + budget.textBytes(m.content), 0) <= 65536);
    assert.equal(aborts, 0);
  });

  // Replay the exact screenshot context when its local fixture is present, read-only.
  const fixture = path.join(os.homedir(), ".pi/agent/sessions/--home-ubuntu-src-GigaTrader-v2--/2026-10-20T05-58-08-834Z_01a157e3-7cbb-7547-b592-b576bea297b4.jsonl");
  if (fs.existsSync(fixture)) {
    const entries = fs.readFileSync(fixture, "utf8").trim().split("\n").map(JSON.parse);
    const index = entries.findIndex((e) => e.type === "compaction" && e.tokensBefore === 1013764);
    if (index >= 0) check("exact screenshot session replay, no mutation or provider call", () => {
      const context = buildSessionContext(entries.slice(0, index + 1));
      const before = context.messages.reduce((n, m) => n + estimateTokens(m), 0);
      const out = hooks.context_with_system({ messages: context.messages }, ctx);
      const after = out.messages.reduce((n, m) => n + estimateTokens(m), 0);
      assert.ok(before > 900000);
      assert.ok(after < 30000);
      assert.equal(aborts, 0);
      console.log(JSON.stringify({ screenshotReplay: { estimatedBefore: before, estimatedAfter: after } }));
    });
  }
  let tool;
  bash.default({ registerTool: (value) => { tool = value; }, registerCommand() {} });
  const live = await tool.execute("large-real-process", {
    name: "reproduce giant single line", command: "python3 -c \"print('HEAD' + 'x' * 4000000 + 'TAIL')\"", directory: temp,
  }, undefined, undefined, ctx);
  check("real bash process returns bounded output and leaves full 4MB log", () => {
    assert.ok(budget.textBytes(live.content) <= budget.TOOL_OUTPUT_BYTES);
    assert.ok(fs.statSync(live.details.log).size > 4000000);
    assert.ok(live.content[0].text.includes("HEAD"));
    assert.ok(live.content[0].text.includes("TAIL"));
    assert.equal(live.details.elided, true);
    console.log(JSON.stringify({ realProcess: { returnedBytes: budget.textBytes(live.content), logBytes: fs.statSync(live.details.log).size } }));
  });
  const largeName = await tool.execute("large-name", { name: "name".repeat(100000), command: "echo small", directory: temp }, undefined, undefined, ctx);
  check("complete result cap includes oversized status and metadata text", () => {
    assert.ok(budget.textBytes(largeName.content) <= budget.TOOL_OUTPUT_BYTES);
    assert.ok(largeName.content[0].text.includes("full log:"));
  });

  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500); res.end("unexpected request"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    hooks.context_with_system({ messages: [{ role: "user", content: "x".repeat(1000000), timestamp: 1 }] }, { ...ctx, abort: () => controller.abort() });
    const { completeSimple } = await import(`${sdkRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`);
    const response = await completeSimple({
      id: "budget-test", name: "budget-test", api: "openai-completions", provider: "budget-test",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 100,
    }, { messages: [{ role: "user", content: "should not be transmitted", timestamp: 1 }] }, { apiKey: "local-test-only", signal: controller.signal });
    check("actual provider adapter sends no HTTP request after safety abort", () => {
      assert.equal(requests, 0);
      assert.equal(response.stopReason, "aborted");
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log(`${checks} context-budget regression groups passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
