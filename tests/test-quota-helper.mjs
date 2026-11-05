import test from "node:test";
import assert from "node:assert/strict";

// Hermetic: no auth store, so any credential lookup fails instead of hitting the network.
process.env.PI_QUOTA_HELPER_AUTH = "/nonexistent-quota-helper-test-auth.json";

const mod = await import("../quota-helper/build/quota-helper.js");
const {
	parseCodexUsage,
	parseZaiUsage,
	adapterForProvider,
	readConfig,
	backoffMs,
	formatDuration,
	formatSnapshot,
	visibleWidth,
	rightJustify,
	detailReport,
	QuotaPoller,
} = mod;
assert.ok(parseCodexUsage && parseZaiUsage && QuotaPoller, "bundle exports its pure helpers");

const CODEX_SPEC = adapterForProvider("openai-codex");
const ZAI_SPEC = adapterForProvider("zai-coding-cn");

// ---------------------------------------------------------------------------
// codex wham/usage parsing
// ---------------------------------------------------------------------------

test("parseCodexUsage maps primary/secondary windows, plan, and credits", () => {
	const snap = parseCodexUsage(
		{
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 6, limit_window_seconds: 18000, reset_at: 1738300000 },
				secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: 1738900000 },
			},
			credits: { has_credits: true, unlimited: false, balance: 820.69 },
		},
		123,
	);
	assert.equal(snap.kind, "codex");
	assert.equal(snap.plan, "pro");
	assert.equal(snap.primary.pct, 6);
	assert.equal(snap.primary.windowSeconds, 18000);
	assert.equal(snap.primary.resetsAtMs, 1738300000 * 1000);
	assert.equal(snap.secondary.pct, 24);
	assert.equal(snap.secondary.windowSeconds, 604800);
	assert.equal(snap.credits, "$32.82 · 820 credits");
	assert.equal(snap.fetchedAtMs, 123);
});

test("parseCodexUsage tolerates partial payloads and rejects empty ones", () => {
	const partial = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 42 } } });
	assert.equal(partial.primary.pct, 42);
	assert.equal(partial.secondary, undefined);
	assert.equal(partial.plan, undefined);
	assert.equal(parseCodexUsage({}), null);
	assert.equal(parseCodexUsage({ rate_limit: {} }), null);
	assert.equal(parseCodexUsage(null), null);
	assert.equal(parseCodexUsage("nope"), null);
});

test("parseCodexUsage drops credits when unlimited or absent", () => {
	const unl = parseCodexUsage({
		rate_limit: { primary_window: { used_percent: 1 } },
		credits: { has_credits: true, unlimited: true, balance: 10 },
	});
	assert.equal(unl.credits, undefined);
	const none = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1 } } });
	assert.equal(none.credits, undefined);
});

// ---------------------------------------------------------------------------
// zai quota/limit parsing
// ---------------------------------------------------------------------------

test("parseZaiUsage maps unit 3 -> 5h and unit 6 -> weekly with exact ratio", () => {
	// Live GLM Coding Plan (pro) shape: 1438/12000 = 11.98% reported by server as 11.
	const snap = parseZaiUsage(
		{
			code: 200,
			data: {
				limits: [
					{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 1438, remaining: 10561, percentage: 11, nextResetTime: 1787804173065 },
					{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 2254, remaining: 57745, percentage: 3, nextResetTime: 1788223121997 },
				],
				level: "pro",
			},
		},
		7,
	);
	assert.equal(snap.kind, "zai");
	assert.equal(snap.plan, "pro");
	assert.equal(snap.primary.pct, 12); // rounded 1 decimal of 11.98 -> 12.0
	assert.equal(snap.primary.used, 1438);
	assert.equal(snap.primary.total, 12000);
	assert.equal(snap.primary.resetsAtMs, 1787804173065);
	assert.equal(snap.secondary.pct, 3.8); // 2254/60000
});

test("parseZaiUsage falls back to server percentage when totals are missing", () => {
	const snap = parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 17 }] } });
	assert.equal(snap.primary.pct, 17);
	assert.equal(snap.primary.used, undefined);
});

test("parseZaiUsage ignores unrelated units and rejects empty payloads", () => {
	const snap = parseZaiUsage({ data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 12 }] } });
	assert.equal(snap, null);
	assert.equal(parseZaiUsage({ data: { limits: [] } }), null);
	assert.equal(parseZaiUsage({}), null);
	assert.equal(parseZaiUsage(null), null);
});

// ---------------------------------------------------------------------------
// provider mapping + config + backoff
// ---------------------------------------------------------------------------

test("adapterForProvider maps codex, openai oauth, zai regions; rejects others", () => {
	assert.equal(CODEX_SPEC.kind, "codex");
	assert.equal(CODEX_SPEC.authProvider, "openai-codex");
	assert.equal(adapterForProvider("openai").authProvider, "openai");
	assert.equal(ZAI_SPEC.kind, "zai");
	assert.equal(ZAI_SPEC.host, "https://open.bigmodel.cn");
	assert.equal(adapterForProvider("zai").host, "https://api.z.ai");
	assert.equal(adapterForProvider("zai-coding").host, "https://api.z.ai");
	assert.equal(adapterForProvider("sglang"), undefined);
	assert.equal(adapterForProvider("openrouter"), undefined);
	assert.equal(adapterForProvider("deepseek"), undefined);
});

test("readConfig applies defaults and clamps", () => {
	const d = readConfig({});
	assert.equal(d.enabled, true);
	assert.equal(d.intervalMs, 30000);
	assert.equal(d.showResets, true);
	const c = readConfig({ enabled: false, intervalMs: 500, showResets: false });
	assert.equal(c.enabled, false);
	assert.equal(c.intervalMs, 5000);
	assert.equal(c.showResets, false);
	assert.equal(readConfig({ intervalMs: 9_999_999 }).intervalMs, 600000);
});

test("backoffMs doubles per failure and caps at 5 minutes", () => {
	assert.equal(backoffMs(30000, 1), 30000);
	assert.equal(backoffMs(30000, 2), 60000);
	assert.equal(backoffMs(30000, 3), 120000);
	assert.equal(backoffMs(30000, 4), 240000);
	assert.equal(backoffMs(30000, 5), 300000);
	assert.equal(backoffMs(30000, 99), 300000);
	assert.equal(backoffMs(30000, 0), 30000);
});

// ---------------------------------------------------------------------------
// formatting + right justification
// ---------------------------------------------------------------------------

test("formatDuration is compact and monotonic", () => {
	assert.equal(formatDuration(45000), "45s");
	assert.equal(formatDuration(700000), "11m");
	assert.equal(formatDuration(4523_000), "1h15m");
	assert.equal(formatDuration(3 * 86400_000 + 4 * 3600_000), "3d4h");
	assert.equal(formatDuration(0), "");
	assert.equal(formatDuration(-5), "");
});

const FUTURE = Date.now() + 3600_000;

test("formatSnapshot renders model label, both windows, resets; colors by threshold", () => {
	const snap = {
		kind: "codex",
		plan: "pro",
		primary: { pct: 42, resetsAtMs: FUTURE },
		secondary: { pct: 12, resetsAtMs: Date.now() + 3 * 86400_000 },
		fetchedAtMs: 1,
	};
	const text = formatSnapshot(CODEX_SPEC, "gpt-6-luna", snap);
	const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /^codex gpt-6-luna pro │ 5h 42% ↻1h0m │ wk 12% ↻3d0h$/);
	assert.ok(text.includes("\u001b[38;2;110;200;130m"), "healthy window is green");
	assert.ok(!text.includes("\u001b[38;2;255;90;90m"), "nothing red at 42%");
});

test("formatSnapshot escalates color at 70 and 90 percent", () => {
	const mk = (pct) => ({ kind: "zai", primary: { pct }, fetchedAtMs: 1 });
	assert.ok(formatSnapshot(ZAI_SPEC, "glm-5.3", mk(69)).includes("\u001b[38;2;110;200;130m"));
	assert.ok(formatSnapshot(ZAI_SPEC, "glm-5.3", mk(72)).includes("\u001b[38;2;255;170;60m"));
	assert.ok(formatSnapshot(ZAI_SPEC, "glm-5.3", mk(95)).includes("\u001b[38;2;255;90;90m"));
});

test("formatSnapshot placeholder, reset suppression, and org-stripped labels", () => {
	const pending = formatSnapshot(CODEX_SPEC, "gpt-6-luna", undefined);
	assert.match(pending.replace(/\u001b\[[0-9;]*m/g, ""), /^codex quota ⟳$/);
	const snap = { kind: "codex", primary: { pct: 42, resetsAtMs: FUTURE }, fetchedAtMs: 1 };
	const bare = formatSnapshot(ZAI_SPEC, "z-ai/glm-5.3-flash", snap, false);
	assert.equal(bare.replace(/\u001b\[[0-9;]*m/g, ""), "glm glm-5.3-flash │ 5h 42%");
});

test("rightJustify pads with NBSP that survives footer sanitization", () => {
	const text = "codex │ 5h 42%";
	const padded = rightJustify(text, 80);
	assert.equal(padded.length - text.length, 80 - text.length);
	assert.ok(padded.startsWith("\u00a0".repeat(80 - text.length)));
	// pi footer sanitize: strip \r\n\t, collapse ASCII-space runs, trim — NBSP survives.
	const sanitized = padded.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	assert.equal(sanitized, padded);
	assert.equal(rightJustify("x".repeat(90), 80), "x".repeat(90));
	assert.equal(visibleWidth(padded), 80);
});

test("detailReport lists units, windows, resets, credits", () => {
	const lines = detailReport(
		CODEX_SPEC,
		"gpt-6-luna",
		{
			kind: "codex",
			plan: "pro",
			primary: { pct: 42, used: undefined, total: undefined, resetsAtMs: FUTURE, windowSeconds: 18000 },
			secondary: { pct: 12, resetsAtMs: FUTURE, windowSeconds: 604800 },
			credits: "$32.82 · 820 credits",
		},
	).split("\n");
	assert.match(lines[0], /^codex · gpt-6-luna · plan pro$/);
	assert.match(lines[1], /^5h window: 42% used · 5h window · resets in /);
	assert.match(lines[2], /^weekly: 12% used · 168h window · resets in /);
	assert.match(lines[3], /^credits: \$32\.82/);
	assert.match(detailReport(ZAI_SPEC, "glm-5.3", undefined), /no quota data yet/);
});

// ---------------------------------------------------------------------------
// poller state machine (credential file missing -> auth-hidden, no network)
// ---------------------------------------------------------------------------

test("QuotaPoller: unsupported provider clears status; report undefined", () => {
	const p = new QuotaPoller(readConfig({}));
	let last = "sentinel";
	p.retarget({ id: "deepseek-chat", provider: "deepseek" }, (t) => (last = t));
	assert.equal(last, undefined);
	assert.equal(p.report(), undefined);
});

test("QuotaPoller: header harvest updates codex windows instantly", () => {
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }));
	let last = "sentinel";
	p.retarget({ id: "gpt-6-luna", provider: "openai-codex" }, (t) => (last = t));
	// Synchronous harvest before the (failing) auth refresh settles.
	p.harvestHeaders({ "x-codex-primary-used-percent": "58", "x-codex-secondary-used-percent": "21" });
	const plain = last.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /5h 58%/);
	assert.match(plain, /wk 21%/);
	assert.match(plain, /codex gpt-6-luna/);
});

test("QuotaPoller: missing credential hides status and stops polling", async () => {
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }));
	let last = "sentinel";
	p.retarget({ id: "glm-5.3", provider: "zai-coding-cn" }, (t) => (last = t));
	await p.refresh(); // PI_QUOTA_HELPER_AUTH points nowhere -> AuthUnavailableError
	assert.equal(last, undefined, "auth failure clears the status");
	p.tick(); // must be a no-op while hidden (no throw, no fetch)
	const harvested = (() => {
		p.harvestHeaders({ "x-codex-primary-used-percent": "9" });
		return last;
	})();
	assert.equal(harvested, undefined, "hidden poller ignores header harvest");
});

test("QuotaPoller: start/stop lifecycle renders then clears", async () => {
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }));
	const seen = [];
	p.retarget({ id: "gpt-6-luna", provider: "openai-codex" }, (t) => seen.push(t));
	p.start((t) => seen.push(t));
	await p.refresh();
	p.stop();
	assert.equal(seen.at(-1), undefined, "stop clears the status");
});

// Reference unused export guard (keeps import list honest if bundle changes).
test("bundle keeps ANSI styling only (no width-widening glyphs in status)", () => {
	const snap = { kind: "codex", primary: { pct: 42, resetsAtMs: FUTURE }, secondary: { pct: 12 }, fetchedAtMs: 1 };
	const text = formatSnapshot(CODEX_SPEC, "gpt-6-luna", snap);
	for (const ch of text.replace(/\u001b\[[0-9;]*m/g, "")) {
		const cp = ch.codePointAt(0);
		assert.ok(cp < 0x1100 || cp === 0xa0, `unexpected wide glyph: U+${cp.toString(16)}`);
	}
});
