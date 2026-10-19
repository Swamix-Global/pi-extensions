/* Merged extension settings + behavior checks: `bun ~/.pi/agent/tests/test_extension_settings.mjs`
   -> `extension-settings ok`.
   Retains the nontrivial regressions from test_sgai_settings.mjs and test_fallback_compaction.mjs:
   subagent model-pool drift, one atomic settings round-trip with a seeded custom setting preserved,
   settled-only compaction hooks, and the compaction threshold/lock/disabled checks.
   Dropped: Bash policy/pi-job coverage (machinery removed), formatter registration/toggle checks,
   command registration and menu rendering assertions, routine defaults, duplicate rounds, and the
   retired local-summary engine checks. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.join(os.homedir(), ".pi", "agent");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extension-settings-"));
// One shared settings file: pi's own settings.json, extensionSettings.<name> blocks.
const SETTINGS_PATH = path.join(tmp, "settings.json");
process.env.PI_EXTENSION_SETTINGS_PATH = SETTINGS_PATH;
fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
	extensionSettings: { subagentx: {}, fallbackCompaction: {} },
	customTopLevel: "keep-me",
}));

const subagentxFile = path.join(root, "extensions", "sgai-subagentx.ts");
// SubagentX ships as its own package (subagent-pack); its flat extension only exists
// when it was installed the old way. Its pool checks are skipped otherwise.
const subagentx = fs.existsSync(subagentxFile) ? await import(subagentxFile) : null;
const compaction = await import(path.join(root, "extensions", "fallback-compaction.ts"));

const silentCtx = { ui: { notify: () => {} } };
const commandSpecs = {};
const captureCommand = (name, spec) => { commandSpecs[name] = spec; };
const assertCommandDescription = (name, key) => {
	const spec = commandSpecs[`settings:${name}`];
	assert.ok(spec, `settings:${name} is registered against the shared settings.json`);
	assert.ok(
		spec.description.startsWith(`[u] (settings.json:extensionSettings.${key})`),
		`settings:${name} description tags the shared settings.json source`,
	);
};

try {
	// --- subagent model pool: the settings default must match the execution default ---
	if (subagentx) {
		const defaults = subagentx.readSettings();
		const executionSource = fs.readFileSync(subagentxFile, "utf8");
		const declared = executionSource.match(/const DEFAULT_SUBAGENT_MODELS = (\[[^;]+\]);/);
		assert.ok(declared, "execution default pool is declared");
		assert.deepEqual(JSON.parse(declared[1]), defaults.subagentModels, "settings and execution default pools agree");
		const previousSettingsPath = process.env.PI_EXTENSION_SETTINGS_PATH;
		const emptySettings = path.join(tmp, "empty-settings.json");
		fs.writeFileSync(emptySettings, JSON.stringify({ extensionSettings: { subagentx: { subagentModels: [] } } }));
		process.env.PI_EXTENSION_SETTINGS_PATH = emptySettings;
		assert.deepEqual(subagentx.readSettings().subagentModels, defaults.subagentModels, "an empty pool falls back to the default pool");
		process.env.PI_EXTENSION_SETTINGS_PATH = previousSettingsPath;

		// --- one atomic round-trip: a seeded custom setting survives, no temp file is left behind ---
		subagentx.writeSettings({ localModel: "custom/local-model" });
		subagentx.writeSettings({ compressionSuffix: "be terse", subagentModels: ["deepseek/deepseek-flash"] });
		const written = subagentx.readSettings();
		assert.equal(written.compressionSuffix, "be terse", "suffix persists");
		assert.deepEqual(written.subagentModels, ["deepseek/deepseek-flash"], "pool persists");
		assert.equal(written.localModel, "custom/local-model", "the seeded localModel survives a later merged write");
		assert.equal(JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).customTopLevel, "keep-me", "unrelated top-level settings survive an extension write");
		assert.equal(fs.readdirSync(tmp).filter((f) => f.includes(".tmp.")).length, 0, "atomic write leaves no temp file");

		// command registration survives disabled settings and tags the shared settings.json source
		subagentx.writeSettings({ enabled: false });
		subagentx.default({ on: () => {}, registerCommand: captureCommand });
		subagentx.writeSettings({ enabled: true });
		assertCommandDescription("subagentx", "subagentx");
	} else {
		console.log("subagentx not installed as a flat extension; skipping its pool checks");
	}

	// --- fallback compaction: only agent_settled is hooked (turn_end/agent_end abort live runs) ---
	const hooks = {};
	let compactionHandler;
	compaction.default({
		on: (event, handler) => (hooks[event] = handler),
		registerCommand: (name, spec) => { captureCommand(name, spec); compactionHandler = spec.handler; },
	});
	assertCommandDescription("fallback-compaction", "fallbackCompaction");
	assert.equal(typeof hooks.agent_settled, "function", "agent_settled hook is registered");
	assert.equal(hooks.turn_end, undefined, "turn_end must not be registered");
	assert.equal(hooks.agent_end, undefined, "agent_end must not be registered");

	compaction.writeSettings({ enabled: true, thresholdTokens: 100000 });
	let settledCalls = 0;
	await hooks.agent_settled({}, {
		getContextUsage: () => ({ tokens: 105000, contextWindow: 200000, percent: 52.5 }),
		compact: () => { settledCalls++; },
		ui: { notify: () => {} },
	});
	assert.equal(settledCalls, 1, "the settled hook compacts at 105k");

	// --- threshold and lock: fires once at >= threshold, then holds until completion ---
	const checker = compaction.createCompactionChecker();
	let compactCalls = 0;
	let lastOptions = null;
	const mockCtx = (tokens) => ({
		getContextUsage: () => ({ tokens, contextWindow: 200000, percent: tokens / 2000 }),
		compact: (options) => { compactCalls++; lastOptions = options; },
		ui: { notify: () => {} },
	});

	assert.equal(checker.checkAndCompact(mockCtx(95000)), false, "95000 does not trigger");
	assert.equal(compactCalls, 0, "compact() not called below threshold");
	assert.equal(checker.checkAndCompact(mockCtx(105000)), true, "105k triggers at the threshold");
	assert.equal(compactCalls, 1, "compact() called once");
	assert.equal(checker.isCompacting, true, "the lock is active while compacting");
	assert.equal(checker.checkAndCompact(mockCtx(105000)), false, "no re-trigger while compacting");
	assert.equal(compactCalls, 1, "compact() not called again");
	lastOptions.onComplete({ tokensBefore: 105000, estimatedTokensAfter: 15000 });
	assert.equal(checker.isCompacting, false, "the lock is released on complete");

	// --- disabled settings win over a high threshold ---
	compaction.writeSettings({ enabled: false, thresholdTokens: 100000 });
	assert.equal(checker.checkAndCompact(mockCtx(120000)), false, "disabled does not compact");
	assert.equal(compactCalls, 1, "compact() count unchanged when disabled");

	// --- threshold command: k-notation and digit forms persist ---
	await compactionHandler("150k", silentCtx);
	assert.equal(compaction.readSettings().thresholdTokens, 150000, "150k sets the threshold");
	await compactionHandler("100000", silentCtx);
	assert.equal(compaction.readSettings().thresholdTokens, 100000, "digits set the threshold");

	console.log("extension-settings ok");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
