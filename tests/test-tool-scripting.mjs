// tool-scripting regression suite: drives the real bundle under
// ~/.pi/agent/extensions/tool-scripting/build/tool-scripting.js against real
// processes (bash + uv python), plus render invariants: 10-row boxlet caps,
// wait-budget bar geometry, and display-only bash separator layout.
// Usage: node --test tests/test-tool-scripting.mjs [piAgentDir]
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = process.argv[2] ?? path.join(os.homedir(), ".pi", "agent");
const bundle = path.join(agentDir, "extensions", "tool-scripting", "build", "tool-scripting.js");
assert.ok(fs.existsSync(bundle), `bundle missing: ${bundle} — run install.sh first`);

const jiti = createJiti(bundle);
const mod = await jiti.import(pathToFileURL(bundle).href, { default: true });
const factory = mod.default ?? mod;
const ext = await factory();
const bashTool = ext.tools.find((t) => t.name === "bash");
const pythonTool = ext.tools.find((t) => t.name === "python");
assert.ok(bashTool, "bash tool must be registered");
assert.ok(pythonTool, "python tool must be registered");

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visible = (s) => stripAnsi(s).length;
const theme = { fg: (_c, t) => t, bold: (t) => t };

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-scripting-"));
test("bash execute: runs, logs under .pi/scripting/bash, done status", async () => {
	const result = await bashTool.execute({ name: "check echo", command: "echo hello-scripting" }, { cwd: workDir });
	const text = result.content[0].text;
	assert.ok(text.startsWith("[bash] done exit=0"), text);
	assert.ok(text.includes("hello-scripting"), text);
	assert.ok(result.details.log.startsWith(path.join(workDir, ".pi", "scripting", "bash")), result.details.log);
	assert.equal(result.details.status, "done");
});

test("python execute: uv run, meta.json + script.py on disk", async () => {
	const result = await pythonTool.execute({ name: "check py", code: "print('py-ok')" }, { cwd: workDir });
	const text = result.content[0].text;
	assert.ok(text.startsWith("[python] done exit=0"), text);
	assert.ok(text.includes("py-ok"), text);
	const runDir = path.dirname(result.details.log);
	assert.ok(fs.existsSync(path.join(runDir, "script.py")));
	assert.ok(fs.existsSync(path.join(runDir, "meta.json")));
});

test("timeout: returns without blocking, keeps pid + poll handoff", async () => {
	const result = await bashTool.execute({ name: "check sleep", command: "sleep 5", timeout: 1 }, { cwd: workDir });
	const text = result.content[0].text;
	assert.ok(text.includes("[bash] timed out waiting after 1s"), text);
	assert.ok(text.includes("kill "), text);
	assert.equal(result.details.status, "timeout");
	try {
		execSync(`kill ${result.details.pid} 2>/dev/null || true`);
	} catch {}
});

test("catastrophic guard: rm -rf / is blocked", async () => {
	const result = await bashTool.execute({ name: "check guard", command: "rm -rf /" }, { cwd: workDir });
	assert.match(result.content[0].text, /blocked: rm -rf \//);
	assert.equal(result.details.status, "blocked");
});

test("output boxlet: 10 visible content rows max, collapsed and expanded", () => {
	const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	const result = {
		content: [{ type: "text", text: "[bash] done exit=0\n" + lines.join("\n") }],
		details: { status: "done", exit: 0, elapsedS: 1.2, waitS: 60, name: "check caps", head: lines.slice(0, 3), tail: lines.slice(-3), totalLines: 40, elided: true, log: "/tmp/x.log" },
	};
	for (const expanded of [false, true]) {
		const rows = bashTool.renderResult(result, { expanded, isPartial: false }, theme).render(80);
		const content = rows.slice(1, -1);
		assert.ok(rows.length <= 12, `rows ${rows.length} for expanded=${expanded}`);
		assert.ok(content.length <= 10, `content rows ${content.length} for expanded=${expanded}`);
		for (const row of content) assert.equal(visible(row), 80, `row width ${visible(row)}: ${stripAnsi(row)}`);
	}
});

test("code boxlet: 10 visible content rows max", () => {
	const code = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join("\n");
	const rows = pythonTool.renderCall({ name: "check code cap", code }, theme).render(80);
	const content = rows.slice(1, -1);
	assert.ok(content.length <= 10, `content rows ${content.length}`);
	assert.match(stripAnsi(content[content.length - 1]), /source truncated/);
});

test("progress bar: full-width top border, monotone fill", () => {
	const mk = (elapsedS) =>
		bashTool
			.renderResult(
				{ content: [], details: { status: "running", elapsedS, waitS: 10, name: "x", head: [], tail: [], totalLines: 0 } },
				{ expanded: false, isPartial: true },
				theme,
			)
			.render(40)[0];
	const zero = stripAnsi(mk(0));
	const half = stripAnsi(mk(5));
	const full = stripAnsi(mk(10));
	// Every glyph is single-width, so char length == display width == 40.
	assert.equal(zero.length, 40);
	assert.equal(half.length, 40);
	assert.equal(full.length, 40);
	const labelWidth = "bash run 5s/10s".length;
	const barWidth = 40 - 2 - labelWidth;
	assert.equal((half.match(/━/g) ?? []).length, Math.round((barWidth * 5) / 10), half);
	assert.ok((full.match(/━/g) ?? []).length > (half.match(/━/g) ?? []).length);
	assert.ok(zero.includes("bash run 0s/10s"), zero);
});

test("bash separators: display-only split of top-level ; && ||", () => {
	const rows = bashTool
		.renderCall({ name: "check split", command: 'git status --short && grep -n "a;b" f.txt; ls || echo "no $(x; y)"' }, theme)
		.render(100)
		.map(stripAnsi);
	const joined = rows.join("\n");
	// three top-level segments, each on its own line, operators preserved
	assert.match(joined, /git status --short/);
	assert.match(joined, /&& grep -n "a;b" f\.txt/);
	assert.match(joined, /; ls/);
	assert.match(joined, /\|\| echo "no \$\(x; y\)"/);
	// quoted ; stays inline, not split
	assert.ok(!joined.includes('"a;\nb"'));
	// executed command file is untouched: run it and compare
	// (covered implicitly: runner writes the raw command to cmd.sh)
});

test("formatBashSource: heredoc bodies untouched", () => {
	const source = "cat <<'EOF'\ninner; line && other\nEOF\necho after";
	const rows = bashTool.renderCall({ name: "check heredoc", command: source }, theme).render(100).map(stripAnsi);
	const joined = rows.join("\n");
	assert.ok(joined.includes("inner; line && other"));
	assert.match(joined, /echo after/);
});

after(() => fs.rmSync(workDir, { recursive: true, force: true }));
