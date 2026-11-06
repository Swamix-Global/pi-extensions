import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../util-frankenstein/build/util-frankenstein.js");

/** Minimal ExtensionAPI stub: capture the virtual model and command handlers. */
function harness() {
	const virtuals = [];
	const commands = new Map();
	const listeners = new Map();
	const pi = {
		registerVirtualModel: (def) => virtuals.push(def),
		registerCommand: (name, def) => commands.set(name, def),
		on: (name, fn) => {
			listeners.set(name, [...(listeners.get(name) ?? []), fn]);
		},
		events: { on: () => {} },
	};
	mod.default(pi);
	return { virtuals, commands, listeners };
}

/** Registry stub: only the two physical codex models and the virtual one exist. */
function ctx() {
	const models = new Map([
		["openai-codex/gpt-6-astra", { provider: "openai-codex", id: "gpt-6-astra" }],
		["openai-codex/gpt-6-luna", { provider: "openai-codex", id: "gpt-6-luna" }],
	]);
	const registry = { find: (provider, id) => models.get(`${provider}/${id}`) };
	return { modelRegistry: registry, model: undefined, thinkingLevel: "high", notify: [] };
}

const DISPATCH = { slot: 0 };

test("virtual model is registered under the physical provider (startup-resolvable)", () => {
	const { virtuals } = harness();
	assert.equal(virtuals.length, 1);
	const def = virtuals[0];
	// Pi's startup resolver only honours defaultProvider when that provider has
	// auth; a credential-less provider id silently loses the rotation on launch.
	assert.equal(def.provider, "openai-codex", "must inherit the codex credential");
	assert.equal(def.id, "auto");
	assert.match(def.name, /A1:L2/);
});

test("cycle is Astra 1 : Luna 2, advancing on every routed request", () => {
	const { virtuals } = harness();
	const def = virtuals[0];
	const c = ctx();
	const route = (slot, reason = "user") =>
		def.route({ reason, state: slot === 0 ? undefined : { slot }, thinkingLevel: "high" }, c);

	// A fresh session starts on slot 0 = Astra/high.
	const first = route(0);
	assert.equal(first.model.id, "gpt-6-astra");
	assert.equal(first.thinkingLevel, "high");
	assert.deepEqual(first.state, { slot: 1 });

	// Then two Luna/max slots, then back to Astra — the A1:L2 ratio.
	const picks = [];
	for (let slot = 1; slot <= 6; slot++) {
		const r = route(slot);
		picks.push(`${r.model.id}@${r.thinkingLevel}`);
	}
	assert.deepEqual(picks, [
		"gpt-6-luna@max",
		"gpt-6-luna@max",
		"gpt-6-astra@high",
		"gpt-6-luna@max",
		"gpt-6-luna@max",
		"gpt-6-astra@high",
	]);
});

test("continuations advance the cycle; retries and direct calls do not", () => {
	const { virtuals } = harness();
	const def = virtuals[0];

	const cont = def.route({ reason: "continuation", state: { slot: 1 }, thinkingLevel: "high" }, ctx());
	assert.deepEqual(cont.state, { slot: 2 }, "tool follow-ups keep steering the rotation");

	const failed = def.route(
		{
			reason: "retry",
			failed: { model: { provider: "openai-codex", id: "gpt-6-luna" }, thinkingLevel: "max" },
			state: { slot: 1 },
			thinkingLevel: "high",
		},
		ctx(),
	);
	assert.equal(failed.model.id, "gpt-6-luna", "a retry stays on the model that failed");
	assert.equal(failed.state, undefined, "a retry keeps prompt caches valid — no slot advance");

	const direct = def.route({ reason: "direct", state: { slot: 0 }, thinkingLevel: "high" }, ctx());
	assert.equal(direct.model.id, "gpt-6-luna", "out-of-loop calls get the cheaper/faster slot");
	assert.equal(direct.state, undefined);
});

test("/frankenstein on activates the virtual model and /off restores the previous one", async () => {
	const { commands } = harness();
	const on = commands.get("frankenstein");
	assert.ok(on && typeof on.handler === "function");

	const physical = { provider: "openai-codex", id: "gpt-6-astra" };
	const virtual = { provider: "openai-codex", id: "auto" };
	const c = ctx();
	c.model = physical;
	c.modelRegistry.find = (provider, id) => (id === "auto" ? virtual : physical);
	c.setModel = async (m) => {
		c.model = m;
		return true;
	};
	c.setThinkingLevel = (l) => {
		c.thinkingLevel = l;
	};
	c.ui = { notify: (m) => c.notify.push(m) };
	c.getThinkingLevel = () => c.thinkingLevel;

	await on.handler("on", c);
	assert.equal(c.model.id, "auto", "on switches to the virtual model");
	assert.match(c.notify.at(-1), /on — cycle: gpt-6-astra\/high → gpt-6-luna\/max ×2/);

	await on.handler("off", c);
	assert.equal(c.model.id, "gpt-6-astra", "off restores the saved physical model");
	assert.equal(c.thinkingLevel, "high");
});
