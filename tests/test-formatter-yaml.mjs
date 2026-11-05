import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const formatterSource = join(repo, "sgai-formatter", "build", "sgai-formatter.js");
assert.ok(existsSync(formatterSource), `build first: ${formatterSource}`);

const piRoot = [join(agentDir, "node_modules/@earendil-works/pi-coding-agent"), "/usr/lib/node_modules/@earendil-works/pi-coding-agent"]
	.filter((candidate) => existsSync(candidate))
	.map((candidate) => realpathSync(candidate))[0];
assert.ok(piRoot, "pi-coding-agent install not found");
const piDeps = join(piRoot, "node_modules/@earendil-works");
const jiti = createJiti(join(piRoot, "package.json"), {
	alias: {
		"@earendil-works/pi-ai": join(piDeps, "pi-ai"),
		"@earendil-works/pi-coding-agent": piRoot,
		"@earendil-works/pi-tui": join(piDeps, "pi-tui"),
	},
});
const { formatMarkdown } = await jiti.import(formatterSource);
const { visibleWidth } = await jiti.import(join(piDeps, "pi-tui"));
const { initTheme } = await jiti.import(join(piRoot, "dist/modes/interactive/theme/theme.js"));
initTheme("dark");

test("formatMarkdown renders headings, lists, and boxed code blocks", () => {
	const sample = `# Heading 1\n## Heading 2\n### Heading 3\n- List item\n\`\`\`js\nconst x = 42;\n\`\`\``;
	const rendered = formatMarkdown(sample, { messageType: "assistant", availableWidth: 80 });
	const plain = stripVTControlCharacters(rendered);
	assert.ok(plain.includes("HEADING 1"), "H1 rendered");
	assert.ok(plain.includes("Heading 2"), "H2 rendered");
	assert.ok(plain.includes("Heading 3"), "H3 rendered");
	assert.ok(plain.includes("const x = 42;"), "code block preserved");
	assert.ok(rendered.includes("╭─"), "code block boxed");
});

test("formatMarkdown applies 50% fade (dim) during streaming and settles at full opacity", () => {
	const text = "First line settled.\nSecond line is currently streaming.";
	// 1. Streaming: last active line has dim (\x1b[2m)
	const streamingOutput = formatMarkdown(text, { messageType: "assistant", isStreaming: true });
	assert.ok(streamingOutput.includes("\x1b[2mSecond line"), "streaming active line is dimmed to 50% fade");

	// 2. Settled: full opacity, no dim wrapper on settled text
	const settledOutput = formatMarkdown(text, { messageType: "assistant", isStreaming: false });
	assert.ok(!settledOutput.includes("\x1b[2mSecond line"), "settled output has full opacity without dim on active line");
});
