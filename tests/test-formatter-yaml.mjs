// Bare-YAML boxing and tool-query renderer regressions. Run through commit hooks.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const formatterSource = join(repo, "sgai-formatter", "build", "sgai-formatter.js");
const querySource = join(repo, "tool-query", "build", "tool-query.js");
for (const source of [formatterSource, querySource]) assert.ok(existsSync(source), `build first: ${source}`);

// The bundles externalize pi packages; alias them to the installed runtime, the way
// Pi's loader resolves them at runtime.
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
const { looksLikeBareYaml, formatMarkdown } = await jiti.import(formatterSource);
const { visibleWidth } = await jiti.import(join(piDeps, "pi-tui"));
// Markdown components read the live theme at render time.
const { initTheme } = await jiti.import(join(piRoot, "dist/modes/interactive/theme/theme.js"));
initTheme("dark");

const PACKET = `folder: /home/ubuntu/src/sgai-pi/extensions/tool-query
question: how does the formatter box bare yaml output
model: minicpm5-2b-fp8
windowsSearched: 2
searchedWindows:
- path: /home/ubuntu/src/sgai-pi/extensions/tool-query/README.md
  lines: 1-86
evidence:
- path: /home/ubuntu/src/sgai-pi/extensions/tool-query/src/index.ts
  spans:
  - lines: 124-125
    quote: "    async execute(_id: string, params: any, signal: any) {"
    claims:
    - The toolQueryExtension function begins executing with the folder parameter.
    truncated: false
stats:
  findingsAccepted: 1
  findingsRejected: 0`;

const CODE_DUMP = `[scripting] done exit=1


def ranks_per_host() -> int:
    """Number of ranks of this job running on the same machine as this one."""
    if not torch.distributed.is_available():
        return 1
    try:
        world_group = get_world_group()
    except AssertionError:
        return 1
    return max(world_group.world_size, 1)`;

const fixtures = [
	["evidence packet", PACKET, true],
	["packet with block scalar", `folder: /repo
question: how does it work
evidence:
- path: /repo/a.ts
  spans:
  - lines: 1-6
    quote: |
      function f() {
        return 1;
      }
    truncated: false`, true],
	["query list output", `folder: /repo
files:
- path: /repo/src/index.ts
  lines: 156
- path: /repo/README.md
  lines: 86`, true],
	["python source dump", CODE_DUMP, false],
	["js source dump", `async function streamAssistantResponse(context, config, signal, emit) {
  let messages = context.messages;
  if (config.transform) {
    messages = config.transform(messages);
  }
  for (const m of messages) {
    await emit(m);
  }
}`, false],
	["prose paragraph", `The router is the component that decides which profile applies. It keeps a soft
budget of 32k tokens and a hard cap of 8192, and it protects the newest two turns.`, false],
	["markdown table", `77:| Add a model-callable operation | pi.registerTool() |
193:| renderCall and renderResult draw calls | pi.registerToolRenderer() |`, false],
	["git status", `On branch main
Changes not staged for commit:
  modified:   src/index.ts
  modified:   build/tool-query.js`, false],
	["git diff", `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -12,3 +12,4 @@
-const a = 1;
+const a = 2;`, false],
	["json document", `{
  "name": "sgai",
  "version": "1.0.0",
  "private": true
}`, false],
	["service yaml", `services:
  web:
    image: nginx:1.25
    ports:
      - "8080:80"`, true],
];

for (const [name, text, want] of fixtures) {
	test(`bare YAML detection: ${name}`, () => {
		assert.equal(looksLikeBareYaml(text), want);
	});
}

test("formatMarkdown boxes bare YAML with the yaml title and token colors", () => {
	const rendered = formatMarkdown(PACKET, { messageType: "toolResult", availableWidth: 72 });
	const plain = stripVTControlCharacters(rendered);
	assert.match(plain, /╭─ yaml /);
	assert.match(plain, /╰─+╯/);
	assert.ok(plain.includes("question: how does the formatter box bare yaml output"));
	assert.ok(rendered.includes("\x1b[38;5;75m"), "keys use the YAML key color");
	for (const line of rendered.split("\n")) assert.ok(visibleWidth(line) <= 72, "box respects width");
});

test("formatMarkdown leaves source dumps unboxed", () => {
	const rendered = formatMarkdown(CODE_DUMP, { messageType: "toolResult", availableWidth: 72 });
	assert.ok(!stripVTControlCharacters(rendered).includes("╭─ yaml"));
	assert.ok(rendered.includes("ranks_per_host"));
});

// End-to-end: the tool-query renderer must ask the formatter, or evidence packets
// render as flat YAML in the transcript even though the formatter knows how to box.
function loadQueryTool(emit) {
	let tool;
	const pi = {
		registerTool(value) {
			tool = value;
		},
		events: { emit, on: () => () => {} },
		exec: async () => ({ code: 1, stdout: "", stderr: "not executed" }),
	};
	return jiti.import(querySource).then((mod) => {
		mod.default(pi);
		return tool;
	});
}
const formatterEvent = (name, data) => {
	if (name !== "sgai:format-markdown") return;
	data.reply(formatMarkdown(data.markdown, { availableWidth: data.availableWidth, messageType: data.messageType }));
};
const packetResult = { content: [{ type: "text", text: PACKET }], details: {} };

for (const emit of [formatterEvent, () => {}]) {
	const active = emit === formatterEvent;
	test(`tool-query renderResult ${active ? "uses the formatter box" : "falls back to native markdown"}`, async () => {
		const tool = await loadQueryTool(emit);
		const component = tool.renderResult(packetResult, { expanded: true, isPartial: false }, { fg: (_c, t) => t });
		const lines = component.render(72);
		const plain = stripVTControlCharacters(lines.join("\n"));
		assert.ok(plain.includes("question: how does the formatter box bare yaml output"), "packet body renders");
		assert.equal(plain.includes("╭─ yaml "), active, "box appears exactly when the formatter answers");
		for (const line of lines) assert.ok(visibleWidth(line) <= 72, "result respects width");
	});
}
