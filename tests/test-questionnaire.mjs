// Questionnaire extension test suite. `node --test tests/test-questionnaire.mjs`
// loads the deployed bundle and drives the custom UI state machine with fake
// key sequences: single/multi question flows, option pagination, multi-select,
// free-text "other" answers, review-page jump-back, cancel, and renderer
// smoke checks at several widths. Hermetic and offline.
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, realpathSync, mkdtempSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
const extFile = path.join(agentDir, "extensions", "util-questionnaire", "build", "util-questionnaire.js");
assert.ok(existsSync(extFile), `bundle missing: ${extFile} — deploy questionnaire first`);

const piRoot = [
	path.join(agentDir, "node_modules/@earendil-works/pi-coding-agent"),
	"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
]
	.filter((candidate) => existsSync(candidate))
	.map((candidate) => realpathSync(candidate))[0];
const piDeps = path.join(piRoot, "node_modules/@earendil-works");
const jiti = createJiti(path.join(piRoot, "package.json"), {
	alias: {
		"@earendil-works/pi-ai": path.join(piDeps, "pi-ai"),
		"@earendil-works/pi-coding-agent": piRoot,
		"@earendil-works/pi-tui": path.join(piDeps, "pi-tui"),
		typebox: path.join(piRoot, "node_modules/typebox"),
	},
});
const mod = await jiti.import(pathToFileURL(extFile).href);
const { visibleWidth } = await jiti.import(path.join(piDeps, "pi-tui"));

const tools = {};
const commands = {};
mod.default({
	registerTool: (t) => (tools[t.name] = t),
	registerCommand: (name, spec) => (commands[name] = spec),
});
const tool = tools.questionnaire;

// Hermetic settings: every test drives config through settings.json (the same
// file pi reads), redirected via PI_EXTENSION_SETTINGS_PATH. Flow tests keep the
// attention sound off; the sound suite rewrites the block per scenario.
const settingsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "q-settings-")), "settings.json");
process.env.PI_EXTENSION_SETTINGS_PATH = settingsFile;
function writeSettings(sound = "off", extra = {}) {
	writeFileSync(
		settingsFile,
		JSON.stringify({ extensionSettings: { utilQuestionnaire: { sound, ...extra } } }, null, 2),
	);
}
writeSettings();

// --- fake theme / keyboard / tui ----------------------------------------------

const ANSI = {
	text: (s) => s,
	accent: (s) => `\x1b[36m${s}\x1b[0m`,
	muted: (s) => `\x1b[90m${s}\x1b[0m`,
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	success: (s) => `\x1b[32m${s}\x1b[0m`,
	warning: (s) => `\x1b[33m${s}\x1b[0m`,
	toolTitle: (s) => `\x1b[34m${s}\x1b[0m`,
};
const fakeTheme = {
	fg: (key, s) => (ANSI[key] ?? ((x) => x))(s),
	bg: (_key, s) => `\x1b[7m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// raw sequences for the keys we drive
const K = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	space: " ",
};

// --- custom-UI capture ---------------------------------------------------------

function makeCustomUI() {
	let current = null;
	return {
		ui: {
			custom(factory) {
				return new Promise((resolve) => {
					const tui = { requestRender() {}, terminal: { rows: 24, cols: 120 } };
					current = {
						comp: factory(tui, fakeTheme, null, (value) => resolve(value)),
					};
				});
			},
		},
		get comp() {
			return current?.comp ?? null;
		},
	};
}

function drive(ui, keys, width = 100) {
	for (const key of keys) {
		assert.ok(ui.comp, "custom UI component not mounted");
		ui.comp.handleInput(key);
		ui.comp.invalidate(); // TUI invalidates between renders (resize/new frame)
		ui.comp.render(width);
	}
}

async function runQuestionnaire(params, keys) {
	const ui = makeCustomUI();
	const ctx = { mode: "tui", ui: ui.ui };
	const pending = tool.execute("call-1", params, undefined, undefined, ctx);
	drive(ui, keys);
	return await pending;
}

// --- fixtures -------------------------------------------------------------------

const singleQ = {
	questions: [
		{
			prompt: "Which database should the migration target?",
			options: [
				{ label: "PostgreSQL", description: "existing cluster" },
				{ label: "SQLite", description: "zero-ops local" },
			],
		},
	],
};

const multiQ = {
	intro: "Refining the deployment task",
	questions: [
		{
			id: "scope",
			label: "Scope",
			prompt: "Which components should the change touch?",
			options: [{ label: "backend only" }, { label: "extensions only" }, { label: "both" }],
		},
		{
			id: "runtime",
			label: "Runtime",
			prompt: "Target runtime?",
			options: [{ label: "node 22" }, { label: "bun" }],
			allowOther: false,
		},
		{
			id: "prio",
			label: "Priority",
			prompt: "Pick all that apply",
			multi: true,
			options: Array.from({ length: 12 }, (_, i) => ({ label: `option ${i + 1}` })),
		},
	],
};

// --- tests ----------------------------------------------------------------------

describe("registration", () => {
	it("registers the questionnaire tool", () => {
		assert.equal(tool.name, "questionnaire");
		assert.ok(tool.parameters);
		assert.equal(typeof tool.execute, "function");
	});
});

describe("non-TUI fallback", () => {
	it("returns a clear error outside the TUI", async () => {
		const res = await tool.execute("c", singleQ, undefined, undefined, { mode: "rpc", ui: {} });
		assert.equal(res.details.cancelled, true);
		assert.match(res.content[0].text, /plain chat/);
	});
});

describe("single question", () => {
	it("quick digit picks the option and submits", async () => {
		const res = await runQuestionnaire(singleQ, ["2"]);
		assert.equal(res.details.cancelled, false);
		const a = res.details.answers[0];
		assert.equal(a.labels[0], "SQLite");
		assert.equal(a.values[0], "SQLite");
		assert.match(res.content[0].text, /1\/1 questions/);
	});

	it("arrow + enter works", async () => {
		const res = await runQuestionnaire(singleQ, [K.down, K.enter]);
		assert.equal(res.details.answers[0].labels[0], "SQLite");
	});

	it("escape cancels", async () => {
		const res = await runQuestionnaire(singleQ, [K.escape]);
		assert.equal(res.details.cancelled, true);
		assert.match(res.content[0].text, /cancelled/i);
	});

	it("free-text answer through the editor", async () => {
		const res = await runQuestionnaire(singleQ, [K.down, K.down, K.enter, ..."mysql".split(""), K.enter]);
		const a = res.details.answers[0];
		assert.equal(a.labels[0], "mysql");
		assert.equal(a.custom[0], "mysql");
	});
});

describe("multi-question flow", () => {
	it("auto-advances through questions and submits from review", async () => {
		// Q1: pick 1 (backend only) -> Q2: pick 2 (bun) -> Q3 (multi, 12 options): 1, page right, 1 (option 10), enter confirm -> review -> enter submit
		const res = await runQuestionnaire(multiQ, ["1", "2", "1", K.right, "1", K.enter, K.enter]);
		assert.equal(res.details.cancelled, false);
		const byId = Object.fromEntries(res.details.answers.map((a) => [a.id, a]));
		assert.equal(byId.scope.labels[0], "backend only");
		assert.equal(byId.runtime.labels[0], "bun");
		assert.deepEqual(
			byId.prio.labels.sort(),
			["option 1", "option 10"].sort(),
		);
		assert.deepEqual(byId.prio.indices.sort((x, y) => x - y), [1, 10]);
	});

	it("review page lists unanswered questions and blocks submit", async () => {
		const ui = makeCustomUI();
		const ctx = { mode: "tui", ui: ui.ui };
		const pending = tool.execute("c1", multiQ, undefined, undefined, ctx);
		// answer only Q1, then tab to review
		// tab once lands on Q2, not review; second tab reaches review
		drive(ui, ["1", K.tab, K.tab]);
		const reviewLines = ui.comp.render(100).join("\n");
		assert.match(reviewLines, /Review & submit/);
		assert.match(reviewLines, /Unanswered: Runtime, Priority/);
		// enter on submit row is a no-op while unanswered
		drive(ui, [K.enter]);
		// jump back to Runtime and answer it, review again, answer Priority, submit
		drive(ui, [K.up, K.up, K.enter, "1", "1", K.enter, K.enter]);
		const res = await pending;
		assert.equal(res.details.cancelled, false);
		assert.equal(res.details.answers.length, 3);
	});

	it("tab navigation skips through and wraps via review", async () => {
		const ui = makeCustomUI();
		const ctx = { mode: "tui", ui: ui.ui };
		const pending = tool.execute("c2", multiQ, undefined, undefined, ctx);
		drive(ui, [K.tab, K.tab, K.tab]); // Q2 -> Q3 -> review
		assert.match(ui.comp.render(100).join("\n"), /Review & submit/);
		drive(ui, [K.tab]); // wraps to Q1
		assert.doesNotMatch(ui.comp.render(100).join("\n"), /Review & submit/);
		drive(ui, [K.escape]);
		const res = await pending;
		assert.equal(res.details.cancelled, true);
	});

	it("shift-tab navigates backwards", async () => {
		const ui = makeCustomUI();
		const ctx = { mode: "tui", ui: ui.ui };
		const pending = tool.execute("c3", multiQ, undefined, undefined, ctx);
		drive(ui, [K.tab, K.shiftTab]);
		const out = ui.comp.render(100).join("\n");
		assert.match(out, /Question 1 of 3/);
		drive(ui, [K.escape]);
		await pending;
	});
});

describe("pagination", () => {
	it("pages with arrow keys and clamps", async () => {
		const ui = makeCustomUI();
		const ctx = { mode: "tui", ui: ui.ui };
		const pending = tool.execute("c4", multiQ, undefined, undefined, ctx);
		drive(ui, [K.tab, K.tab]); // to Q3 with 12 options (12+other = 13 -> 2 pages)
		let out = ui.comp.render(80).join("\n");
		assert.match(out, /page 1\/2/);
		drive(ui, [K.right]);
		out = ui.comp.render(80).join("\n");
		assert.match(out, /page 2\/2/);
		assert.match(out, /Add a custom answer/);
		drive(ui, [K.left]);
		assert.match(ui.comp.render(80).join("\n"), /page 1\/2/);
		drive(ui, [K.escape]);
		await pending;
	});

	it("multi toggle via space and digits", async () => {
		const res = await runQuestionnaire(multiQ, ["1", "1", K.space, "2", K.enter, K.enter]);
		const prio = res.details.answers.find((a) => a.id === "prio");
		assert.deepEqual(prio.labels, ["option 1", "option 2"]);
	});
});

describe("renderers", () => {
	it("renderCall shows question count and labels", () => {
		const comp = tool.renderCall(multiQ, fakeTheme, {});
		const text = stripVTControlCharacters(comp.render(120).join("\n"));
		assert.match(text, /questionnaire 3 questions/);
	});

	it("renderResult shows answers or cancellation", () => {
		const ok = tool.renderResult(
			{
				content: [{ type: "text", text: "x" }],
				details: { cancelled: false, answers: multiQ.questions.map((q, i) => ({
					id: q.id, label: q.label, prompt: q.prompt, multi: false,
					labels: [`choice ${i}`], values: [`choice ${i}`], indices: [1], custom: [],
				})) },
			},
			{},
			fakeTheme,
			{},
		);
		const text = stripVTControlCharacters(ok.render(120).join("\n"));
		assert.match(text, /Scope: 1\. choice 0/);
		const cancelled = tool.renderResult(
			{ content: [{ type: "text", text: "x" }], details: { cancelled: true, answers: [] } },
			{},
			fakeTheme,
			{},
		);
		assert.match(stripVTControlCharacters(cancelled.render(120).join("\n")), /Cancelled/);
	});

	it("renders without overflow at 70/85/120 columns in every state", () => {
		// exercise states directly through a live component
		const ui = makeCustomUI();
		const ctx = { mode: "tui", ui: ui.ui };
		const pending = tool.execute("c5", multiQ, undefined, undefined, ctx);
		const states = [
			[], // Q1 initial
			[K.tab], // Q2
			[K.tab, K.tab], // Q3 paginated multi
			[K.tab, K.tab, K.right], // Q3 page 2
			[K.tab, K.tab, K.right, "4"], // editor open (custom answer on page 2)
			[K.tab, K.tab, K.right, "4", ..."abc".split("")], // editor with text
		];
		for (const keys of states) {
			// fresh component per state for isolation
			const fresh = makeCustomUI();
			const p = tool.execute("c", multiQ, undefined, undefined, { mode: "tui", ui: fresh.ui });
			drive(fresh, keys);
			for (const w of [70, 85, 120]) {
				fresh.comp.invalidate(); // resize semantics: invalidate before re-render
				for (const line of fresh.comp.render(w)) {
					assert.ok(
						visibleWidth(line) <= w,
					`line overflows width ${w} (${visibleWidth(line)}): ${JSON.stringify(line)}`,
					);
				}
			}
			// resolve or cancel each pending promise to avoid dangling handles
			drive(fresh, [K.escape, K.escape]);
			p.catch(() => {});
		}
		drive(ui, [K.escape]);
		pending.catch(() => {});
	});
});

// --- attention sound --------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStubPlayer() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "q-stub-"));
	const bin = path.join(dir, "paplay");
	writeFileSync(bin, `#!/bin/sh\necho "$@" >> "$STUB_LOG"\n`);
	chmodSync(bin, 0o755);
	return dir;
}

function parseWav(file) {
	const buf = readFileSync(file);
	assert.equal(buf.subarray(0, 4).toString(), "RIFF");
	assert.equal(buf.subarray(8, 12).toString(), "WAVE");
	const info = {};
	let off = 12;
	while (off + 8 <= buf.length) {
		const id = buf.subarray(off, off + 4).toString();
		const size = buf.readUInt32LE(off + 4);
		if (id === "fmt ") {
			info.format = buf.readUInt16LE(off + 8);
			info.channels = buf.readUInt16LE(off + 10);
			info.sampleRate = buf.readUInt32LE(off + 12);
			info.bits = buf.readUInt16LE(off + 22);
		} else if (id === "data") {
			info.dataBytes = size;
		}
		off += 8 + size + (size % 2);
	}
	info.seconds = info.dataBytes / (info.sampleRate * info.channels * (info.bits / 8));
	return info;
}

function restoreEnv(saved) {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

const settingsCommand = () => commands["settings:util-questionnaire"];
const silentCtx = { ui: { notify: (msg, level) => notices.push({ msg, level }) } };
const notices = [];

describe("attention sound", () => {
	const soundsDir = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"util-questionnaire",
		"assets",
		"sounds",
	);
	const SOUND_NAMES = ["chirp", "pulse", "orchestral", "glass", "harp"];

	it("ships five valid 48kHz stereo PCM WAV variants in assets/sounds (source and deployed)", () => {
		for (const name of SOUND_NAMES) {
			for (const dir of [soundsDir, path.join(agentDir, "extensions", "util-questionnaire", "assets", "sounds")]) {
				const file = path.join(dir, `${name}.wav`);
				assert.ok(existsSync(file), `missing asset: ${file}`);
				const info = parseWav(file);
				assert.equal(info.format, 1); // PCM
				assert.equal(info.channels, 2);
				assert.equal(info.sampleRate, 48000);
				assert.equal(info.bits, 16);
				assert.ok(info.seconds > 0.5 && info.seconds < 2.0, `${name}: unexpected duration ${info.seconds}`);
			}
		}
		assert.ok(settingsCommand(), "settings:util-questionnaire command is registered");
	});

	it("beeps on trigger, repeats while unfocused, stops on first keypress", async () => {
		const stubDir = makeStubPlayer();
		const stubLog = path.join(stubDir, "plays.log");
		const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
		try {
			process.env.PATH = `${stubDir}:${process.env.PATH}`;
			process.env.STUB_LOG = stubLog;
			writeSettings("chirp", { intervalMs: 60, debug: path.join(stubDir, "debug.log") });
			const plays = () =>
				existsSync(stubLog)
					? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).length
					: 0;

			const ui = makeCustomUI();
			const pending = tool.execute("sound-1", singleQ, undefined, undefined, { mode: "tui", ui: ui.ui });
			await sleep(30);
			const first = plays();
			assert.ok(first >= 1, "no beep on trigger");
			await sleep(100);
			assert.ok(plays() >= first + 1, "no repeat beep while unfocused");

			ui.comp.handleInput("1"); // focus + answer in one key
			const after = plays();
			await sleep(150);
			assert.equal(plays(), after, "kept beeping after focus");

			const res = await pending;
			assert.equal(res.details.cancelled, false);
			assert.match(readFileSync(stubLog, "utf8"), /sounds\/chirp\.wav/, "stub saw wrong asset path");
			assert.match(readFileSync(path.join(stubDir, "debug.log"), "utf8"), /"begin"/, "debug log disabled");
		} finally {
			restoreEnv(saved);
		}
	});

	it("plays the selected variant: /settings:util-questionnaire sound orchestral switches the asset", async () => {
		const stubDir = makeStubPlayer();
		const stubLog = path.join(stubDir, "plays.log");
		const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
		try {
			process.env.PATH = `${stubDir}:${process.env.PATH}`;
			process.env.STUB_LOG = stubLog;
			notices.length = 0;
			await settingsCommand().handler("sound orchestral", silentCtx);
			assert.ok(notices.some((n) => /sound: orchestral/.test(n.msg)), "command did not confirm the switch");

			const ui = makeCustomUI();
			const pending = tool.execute("sound-2", singleQ, undefined, undefined, { mode: "tui", ui: ui.ui });
			await sleep(30);
			ui.comp.handleInput(K.escape);
			await pending;
			assert.match(readFileSync(stubLog, "utf8"), /sounds\/orchestral\.wav/, "stub saw wrong variant");
		} finally {
			restoreEnv(saved);
			writeSettings();
		}
	});

	it("stays silent when settings say sound=off", async () => {
		const stubDir = makeStubPlayer();
		const stubLog = path.join(stubDir, "plays.log");
		const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
		try {
			process.env.PATH = `${stubDir}:${process.env.PATH}`;
			process.env.STUB_LOG = stubLog;
			writeSettings("off");
			const res = await runQuestionnaire(singleQ, [K.escape]);
			assert.equal(res.details.cancelled, true);
			assert.ok(!existsSync(stubLog), "stub player was invoked despite sound=off");
		} finally {
			restoreEnv(saved);
		}
	});

	it("settings command validates, persists, and resets without clobbering unrelated settings", async () => {
		notices.length = 0;
		writeFileSync(
			settingsFile,
			JSON.stringify({ keepTop: 1, extensionSettings: { keepExt: { v: 2 }, utilQuestionnaire: { sound: "glass", keep: true } } }),
		);

		await settingsCommand().handler("sound nope", silentCtx);
		assert.ok(notices.some((n) => n.level === "warning"), "invalid sound accepted");
		await settingsCommand().handler("interval 5", silentCtx);
		assert.ok(notices.some((n) => n.level === "warning"), "interval below 50ms accepted");

		await settingsCommand().handler("sound harp", silentCtx);
		await settingsCommand().handler("interval 2500", silentCtx);
		const raw = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.equal(raw.keepTop, 1);
		assert.deepEqual(raw.extensionSettings.keepExt, { v: 2 });
		assert.deepEqual(raw.extensionSettings.utilQuestionnaire, { sound: "harp", keep: true, intervalMs: 2500 });

		await settingsCommand().handler("sound default", silentCtx);
		assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).extensionSettings.utilQuestionnaire.sound, "chirp");
		await settingsCommand().handler("debug off", silentCtx);
		assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).extensionSettings.utilQuestionnaire.debug, "");

		await settingsCommand().handler("", silentCtx);
		assert.ok(notices.some((n) => /sound=chirp/.test(n.msg)), "show did not report current config");
		writeSettings();
	});
});
