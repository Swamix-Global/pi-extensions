// Renderer regressions for the installed smartbash extension. Run through commit hooks.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const source = join(agentDir, "extensions", "smartbash.ts");
const jiti = createJiti(source);
const { default: register } = await jiti.import(source);
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
let tool;
register({ registerCommand() {}, registerTool(value) { tool = value; } });
assert.ok(tool, "smartbash must be enabled in extension settings");

const theme = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const compact = (lines) => stripVTControlCharacters(lines.join("\n")).replace(/\s/g, "");
const checkWidth = (lines, width) => {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
};
const marker = `metric{model="granite-4.2-3b-awq",rank="0",value="${"x".repeat(200)}"}END`;
const result = {
  content: [{ type: "text", text: `[smartbash] done exit=0\nfirst\nMIDDLE_OUTPUT\n${marker}\nlast` }],
  details: { status: "done", exit: 0, head: ["first", marker], tail: ["last"], totalLines: 4 },
};

for (const width of [12, 40, 80]) {
  test(`call wraps long lines and keeps commands after line 12 at width ${width}`, () => {
    const command = `${marker}\n${Array.from({ length: 15 }, (_, i) => `echo command_${i}`).join("\n")}`;
    const component = tool.renderCall({ name: "long command", command }, theme);
    const lines = component.render(width);
    checkWidth(lines, width);
    assert.ok(compact(lines).includes(marker));
    assert.ok(compact(lines).includes("echocommand_14"));
  });

  for (const options of [{ expanded: false, isPartial: false }, { expanded: false, isPartial: true }, { expanded: true, isPartial: false }]) {
    test(`output wraps intact at width ${width}: ${JSON.stringify(options)}`, () => {
      const component = tool.renderResult(result, options, theme);
      const lines = component.render(width);
      checkWidth(lines, width);
      assert.ok(compact(lines).includes(marker));
      if (options.expanded) assert.ok(compact(lines).includes("MIDDLE_OUTPUT"));
    });
  }
}

test("Unicode and ANSI remain width-safe after resize and invalidation", () => {
  const text = "\x1b[31m指标界面😀".repeat(12) + "UNICODE_END\x1b[0m";
  const component = tool.renderCall({ name: "Unicode", command: text }, theme);
  for (const width of [40, 12, 80]) {
    component.invalidate();
    const lines = component.render(width);
    checkWidth(lines, width);
    assert.ok(compact(lines).includes(stripVTControlCharacters(text)));
  }
});

test("expanded results retain the existing large-output elision notice and log path", () => {
  const log = "/tmp/full-smartbash-output.log";
  const output = {
    content: [{ type: "text", text: `[smartbash] done exit=0\nfirst\n... [800 lines elided; full log: ${log}] ...\nlast` }],
    details: { ...result.details, elided: true, log, totalLines: 1000 },
  };
  const lines = tool.renderResult(output, { expanded: true, isPartial: false }, theme).render(24);
  checkWidth(lines, 24);
  assert.ok(compact(lines).includes("800lineselided"));
  assert.ok(compact(lines).includes(log));
});
