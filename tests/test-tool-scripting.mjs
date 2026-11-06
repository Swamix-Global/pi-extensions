// Regression checks for the Pi-native tool-scripting bundle. Deploy first:
//   bash install.sh
//   node --test tests/test-tool-scripting.mjs
// PI_SCRIPTING_BUNDLE can select a different Pi-loadable deployed bundle.
// PI_SCRIPTING_JITI can select Pi's jiti module when automatic discovery fails.
// These direct integration checks do not replace an actual Pi/TUI smoke test.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

async function loadJiti() {
 if (process.env.PI_SCRIPTING_JITI) return (await import(pathToFileURL(path.resolve(process.env.PI_SCRIPTING_JITI)).href)).createJiti;
 try { return (await import("jiti")).createJiti; } catch {}
 // Pi carries jiti. Locate its installation from the pi executable, without
 // assuming a particular global npm prefix.
 for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
  const executable = path.join(entry, "pi");
  let directory;
  try { directory = path.dirname(fs.realpathSync(executable)); } catch { continue; }
  while (true) {
   const candidate = path.join(directory, "node_modules/jiti/lib/jiti.mjs");
   if (fs.existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).createJiti;
   const parent = path.dirname(directory);
   if (parent === directory) break;
   directory = parent;
  }
 }
 throw new Error("Cannot find Pi's jiti loader; set PI_SCRIPTING_JITI to its jiti.mjs path");
}
const createJiti = await loadJiti();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
const bundle = process.env.PI_SCRIPTING_BUNDLE ?? path.join(agentDir, "extensions/tool-scripting/build/reloadable/tool-scripting.js");
assert.ok(fs.existsSync(bundle), `bundle missing: ${bundle} — deploy tool-scripting first`);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-scripting-"));
const originalSettingsPath = process.env.PI_EXTENSION_SETTINGS_PATH;
process.env.PI_EXTENSION_SETTINGS_PATH = path.join(workDir, "settings.json");

const jiti = createJiti(bundle);
const mod = await jiti.import(pathToFileURL(bundle).href, { default: true });
const factory = mod.default ?? mod;
const tools = [];
const resolvers = [];
const commands = [];
await factory({
 registerTool: (tool) => tools.push(tool),
 registerToolRenderer: (resolver) => resolvers.push(resolver),
 registerCommand: (name, command) => commands.push({ name, command }),
});
const scriptTool = tools.find((tool) => tool.name === "script");
assert.ok(scriptTool, "script tool must be registered");
const execute = (args) => scriptTool.execute("test-call", args, undefined, undefined, { cwd: workDir });
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visible = (s) => stripAnsi(s).length;
const theme = { fg: (_c, t) => t, bold: (t) => t };

test("registers one script tool, a settings command and legacy renderer", () => {
 assert.deepEqual(tools.map((t) => t.name), ["script"]);
 assert.ok(commands.some((c) => c.name === "settings:tool-scripting"));
 assert.equal(resolvers.length, 1);
 assert.ok(scriptTool.parameters.required.includes("mode"));
 assert.ok(scriptTool.parameters.required.includes("script"));
 assert.ok(scriptTool.parameters.required.includes("title"));
});

test("uvBinary settings win over UV_BIN, reset restores fallback, and config merge preserves unrelated fields", async () => {
 const settingsFile = process.env.PI_EXTENSION_SETTINGS_PATH;
 const original = process.env.UV_BIN;
 const configuredUv = path.join(workDir, "configured-uv");
 const legacyUv = path.join(workDir, "legacy-uv");
 for (const [file, marker] of [[configuredUv, "configured"], [legacyUv, "legacy"]]) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf 'uv-${marker}\n'\n`, { mode: 0o755 });
 }
 fs.writeFileSync(settingsFile, JSON.stringify({ keepRoot: { value: 1 }, extensionSettings: {
  keepExtension: { value: 2 }, toolScripting: { enabled: true, keep: "preserved" },
 } }));
 process.env.UV_BIN = legacyUv;
 const command = commands.find((item) => item.name === "settings:tool-scripting").command;
 const notices = [];
 const ctx = { ui: { notify: (...args) => notices.push(args) } };
 try {
  await command.handler(`set uvBinary "${configuredUv}"`, ctx);
  let raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(raw.extensionSettings.toolScripting.uvBinary, configuredUv);
  assert.deepEqual(raw.keepRoot, { value: 1 });
  assert.deepEqual(raw.extensionSettings.keepExtension, { value: 2 });
  assert.equal(raw.extensionSettings.toolScripting.keep, "preserved");
  let result = await execute({ mode: "python", title: "configured uv", script: "print('unused')" });
  assert.match(result.content[0].text, /uv-configured/);

  await command.handler("set uvBinary /path/that/does/not/exist", ctx);
  raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(raw.extensionSettings.toolScripting.uvBinary, configuredUv, "invalid values must not replace a valid setting");
  assert.ok(notices.some(([, level]) => level === "error"), "invalid path is reported");

  await command.handler("reset uvBinary", ctx);
  raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(Object.hasOwn(raw.extensionSettings.toolScripting, "uvBinary"), false);
  result = await execute({ mode: "python", title: "legacy uv", script: "print('unused')" });
  assert.match(result.content[0].text, /uv-legacy/);
 } finally {
  if (original === undefined) delete process.env.UV_BIN; else process.env.UV_BIN = original;
 }
});

test("bash execute: runs, logs under .pi/scripting/bash, done status", async () => {
 const result = await execute({ mode: "bash", title: "check echo", script: "echo hello-scripting" });
 const text = result.content[0].text;
 assert.ok(text.startsWith("[bash] done exit=0"), text);
 assert.ok(text.includes("hello-scripting"), text);
 assert.ok(result.details.log.startsWith(path.join(workDir, ".pi", "scripting", "bash")), result.details.log);
 assert.equal(result.details.status, "done");
});

test("python execute: uv run, meta.json + script.py on disk", async () => {
 const result = await execute({ mode: "python", title: "check py", script: "print('py-ok')" });
 const text = result.content[0].text;
 assert.ok(text.startsWith("[python] done exit=0"), text);
 assert.ok(text.includes("py-ok"), text);
 const runDir = path.dirname(result.details.log);
 assert.ok(fs.existsSync(path.join(runDir, "script.py")));
 assert.ok(fs.existsSync(path.join(runDir, "meta.json")));
});

test("relative dir resolves against the session working directory", async () => {
 fs.mkdirSync(path.join(workDir, "nested"));
 const result = await execute({ mode: "bash", title: "check dir", script: "pwd", dir: "nested" });
 assert.ok(result.content[0].text.includes(path.join(workDir, "nested")));
});

test("python-only arguments are rejected in bash mode", async () => {
 for (const extra of [{ deps: ["rich"] }, { python: "3.12" }, { stdin: "input" }]) {
  await assert.rejects(execute({ mode: "bash", title: "check args", script: "true", ...extra }), /only in python mode/);
 }
});

test("timeout: returns without blocking and provides pid and poll handoff", async () => {
 const result = await execute({ mode: "bash", title: "check sleep", script: "sleep 5", timeout: 1 });
 try {
  const text = result.content[0].text;
  assert.ok(text.includes("[bash] timed out waiting after 1s"), text);
  assert.ok(text.includes("kill "), text);
  assert.equal(result.details.status, "timeout");
  assert.ok(result.details.pid > 0);
  process.kill(result.details.pid, 0);
 } finally {
  if (result.details.pid) { try { process.kill(-result.details.pid, "SIGTERM"); } catch { try { process.kill(result.details.pid, "SIGTERM"); } catch {} } }
 }
});

test("catastrophic guard: rm -rf / is blocked", async () => {
 const result = await execute({ mode: "bash", title: "check guard", script: "rm -rf /" });
 assert.match(result.content[0].text, /blocked: rm -rf \//);
 assert.equal(result.details.status, "blocked");
});

test("output boxlet: 10 rows collapsed, up to 50 rows expanded", () => {
 const lines40 = Array.from({ length: 40 }, (_, i) => `line-${i}`);
 const result40 = {
  content: [{ type: "text", text: "[bash] done exit=0\n" + lines40.join("\n") }],
  details: { language: "bash", status: "done", exit: 0, elapsedS: 1.2, waitS: 60, name: "check caps", head: lines40.slice(0, 3), tail: lines40.slice(-3), totalLines: 40, elided: true, log: "/tmp/x.log" },
 };
 {
  const rows = scriptTool.renderResult(result40, { expanded: false, isPartial: false }, theme).render(80);
  const content = rows.slice(1, -1);
  assert.ok(rows.length <= 12, `collapsed rows ${rows.length}`);
  assert.ok(content.length <= 10, `collapsed content rows ${content.length}`);
  for (const row of content) assert.equal(visible(row), 80, `row width ${visible(row)}: ${stripAnsi(row)}`);
  assert.match(stripAnsi(content[content.length - 1]), /\d+ more lines? truncated/);
 }
 {
  const rows = scriptTool.renderResult(result40, { expanded: true, isPartial: false }, theme).render(80);
  const content = rows.slice(1, -1);
  assert.equal(content.length, 40, `40 lines fit within 50-row limit without truncation: ${content.length}`);
  assert.ok(!stripAnsi(rows.join("\n")).includes("more lines truncated"), "40 lines should not truncate when expanded");
  for (const row of content) assert.equal(visible(row), 80, `row width ${visible(row)}: ${stripAnsi(row)}`);
 }
 const lines80 = Array.from({ length: 80 }, (_, i) => `line-${i}`);
 const result80 = {
  content: [{ type: "text", text: "[bash] done exit=0\n" + lines80.join("\n") }],
  details: { language: "bash", status: "done", exit: 0, elapsedS: 1.2, waitS: 60, name: "check 80 caps", head: lines80.slice(0, 3), tail: lines80.slice(-3), totalLines: 80, elided: true, log: "/tmp/x80.log" },
 };
 {
  const rows = scriptTool.renderResult(result80, { expanded: true, isPartial: false }, theme).render(80);
  const content = rows.slice(1, -1);
  assert.equal(content.length, 50, `expanded content rows capped at 50: ${content.length}`);
  assert.match(stripAnsi(content[content.length - 1]), /31 more lines truncated/);
 }
});

test("code boxlet: 10 visible content rows max", () => {
 const script = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join("\n");
 const rows = scriptTool.renderCall({ mode: "python", title: "check code cap", script }, theme).render(80);
 const content = rows.slice(1, -1);
 assert.ok(content.length <= 10, `content rows ${content.length}`);
 assert.match(stripAnsi(content[content.length - 1]), /source truncated/);
});

test("code boxlet: expanded renders full text without truncation", () => {
 const script = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join("\n");
 const rows = scriptTool.renderCall({ mode: "python", title: "check code expand", script }, theme, { expanded: true }).render(80);
 const content = rows.slice(1, -1);
 assert.ok(content.length >= 41, `expanded content rows should include title + all code rows: ${content.length}`);
 assert.ok(!stripAnsi(rows.join("\n")).includes("source truncated"), "expanded call must not truncate");
 assert.ok(stripAnsi(content[content.length - 1]).includes("x39 = 39"), "last line must be visible in full text");
});

test("code boxlet: click toggles expansion on tool call", () => {
 const script = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join("\n");
 let invalidated = false;
 const context = { isPartial: true, state: {}, invalidate: () => { invalidated = true; } };
 const box = scriptTool.renderCall({ mode: "python", title: "check click", script }, theme, context);
 const collapsedRows = box.render(80);
 assert.match(stripAnsi(collapsedRows.join("\n")), /source truncated/);
 const clickResult = box.handleMouse({ type: "click", button: "left", x: 5, y: 3 });
 assert.deepEqual(clickResult, { handled: true });
 assert.ok(invalidated, "clicking must invalidate to trigger re-render");
 const expandedRows = box.render(80);
 assert.ok(!stripAnsi(expandedRows.join("\n")).includes("source truncated"), "call must expand to full text");
 assert.ok(expandedRows.length >= 43, `expanded total rows ${expandedRows.length}`);
});

test("progress bar: full-width top border, monotone fill", () => {
 const mk = (elapsedS) => scriptTool.renderResult(
  { content: [], details: { language: "bash", status: "running", elapsedS, waitS: 10, name: "x", head: [], tail: [], totalLines: 0 } },
  { expanded: false, isPartial: true }, theme,
 ).render(40)[0];
 const zero = stripAnsi(mk(0));
 const half = stripAnsi(mk(5));
 const full = stripAnsi(mk(10));
 assert.equal(zero.length, 40);
 assert.equal(half.length, 40);
 assert.equal(full.length, 40);
 const barWidth = 40 - 2 - "bash run 5s/10s".length;
 assert.equal((half.match(/━/g) ?? []).length, Math.round((barWidth * 5) / 10), half);
 assert.ok((full.match(/━/g) ?? []).length > (half.match(/━/g) ?? []).length);
 assert.ok(zero.includes("bash run 0s/10s"), zero);
});

test("bash separators: display-only split of top-level ; && ||", () => {
 const rows = scriptTool.renderCall({ mode: "bash", title: "check split", script: 'git status --short && grep -n "a;b" f.txt; ls || echo "no $(x; y)"' }, theme).render(100).map(stripAnsi);
 const joined = rows.join("\n");
 assert.match(joined, /git status --short/);
 assert.match(joined, /&& grep -n "a;b" f\.txt/);
 assert.match(joined, /; ls/);
 assert.match(joined, /\|\| echo "no \$\(x; y\)"/);
 assert.ok(!joined.includes('"a;\nb"'));
});

test("formatBashSource: heredoc bodies untouched", () => {
 const script = "cat <<'EOF'\ninner; line && other\nEOF\necho after";
 const joined = scriptTool.renderCall({ mode: "bash", title: "check heredoc", script }, theme).render(100).map(stripAnsi).join("\n");
 assert.ok(joined.includes("inner; line && other"));
 assert.match(joined, /echo after/);
});

test("legacy renderer uses saved call and result text", () => {
 for (const [name, args, expected] of [["bash", { command: "echo legacy" }, "echo legacy"], ["python", { code: "print('legacy')" }, "print('legacy')"]]) {
  const renderer = resolvers[0](name, () => undefined);
  assert.ok(renderer);
  assert.ok(renderer.renderCall(args, theme).render(100).map(stripAnsi).join("\n").includes(expected));
  assert.ok(renderer.renderResult({ content: [{ type: "text", text: "legacy-output" }] }, { expanded: false, isPartial: false }, theme).render(100).map(stripAnsi).join("\n").includes("legacy-output"));
 }
});

after(() => {
 if (originalSettingsPath === undefined) delete process.env.PI_EXTENSION_SETTINGS_PATH;
 else process.env.PI_EXTENSION_SETTINGS_PATH = originalSettingsPath;
 fs.rmSync(workDir, { recursive: true, force: true });
});
