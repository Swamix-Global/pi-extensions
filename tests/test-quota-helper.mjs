import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

// Hermetic: no auth store, so any credential lookup fails instead of hitting the network.
process.env.PI_QUOTA_HELPER_AUTH = "/nonexistent-quota-helper-test-auth.json";

const mod = await import("../util-quota-helper/build/util-quota-helper.js");
const {
	parseCodexUsage,
	parseZaiUsage,
	adapterForProvider,
	readConfig,
	backoffMs,
	formatDuration,
	formatSnapshot,
	quotaGrade,
	composeStatusLine,
	composeMeterOnly,
	readLocalUsage,
	formatLocalPill,
	formatTokensCompact,
	visibleWidth,
	rightJustify,
	detailReport,
	QuotaPoller,
	resolveCredential,
	credentialCandidates,
	fetchQuota,
	decodeJwtClaims,
	AuthUnavailableError,
	AuthRejectedError,
	pushTrendSample,
	slopePerHour,
	forecastWindow,
	analyzeTrend,
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
	assert.equal(d.metric, "used", "`used` is the default metric");
	assert.equal(readConfig({ metric: "left" }).metric, "left");
	assert.equal(readConfig({ metric: "bogus" }).metric, "used", "unknown metric falls back to used");
});

/** The footer reports ONE metric end to end: the number, the gauge fill and the
 * trailing word all move together, and the inversion between the wire value and
 * the printed value can never resurface. Both meters (5h + 7d) always print. */
test("metric is normalized end-to-end: used counts up, left counts down", () => {
	const snap = { kind: "codex", primary: { pct: 12 }, secondary: { pct: 30 }, fetchedAtMs: 1 };
	const strip = (t) => t.replace(/\u001b\[[0-9;]*m/g, "");
	const solid = (t, tag) => {
		const seg = t.slice(t.indexOf(tag), t.indexOf("%"));
		return (seg.match(/█/g) ?? []).length;
	};

	// default: used — a burning window draws a FULLING gauge and a rising number
	const used = formatSnapshot(snap, { bars: 4, resets: false });
	assert.equal(strip(used), "● 5h ▌░░░ 12% used │ 7d █▎░░ 30% used");
	assert.equal(solid(used, "5h"), 0, "12% used fills well under one of four cells");
	assert.ok(strip(used).includes("▌") && strip(used).includes("█▎"), "eighth-blocks resolve sub-cell fills");

	// the two metrics are exact complements at every point of the ramp, and the
	// gauges move in opposite directions because they report the same window
	for (const pct of [0, 12, 50, 88, 100]) {
		const u = strip(formatSnapshot({ kind: "zai", primary: { pct } }, { bars: 6, resets: false }));
		const l = strip(formatSnapshot({ kind: "zai", primary: { pct } }, { metric: "left", bars: 6, resets: false }));
		const un = Number(u.match(/([\d.]+)% used/)[1]);
		const ln = Number(l.match(/([\d.]+)% left/)[1]);
		assert.equal(un + ln, 100, `used ${un} + left ${ln} = 100 at wire ${pct}`);
		assert.ok(un <= 100 && ln >= 0, `both metrics clamp at wire ${pct}`);
	}

	// escalation stays keyed to quota LEFT in both modes: a nearly-spent window
	// is the bold red one whichever metric the footer prints
	for (const metric of ["used", "left"]) {
		const hot = formatSnapshot({ kind: "zai", primary: { pct: 97 } }, { metric, bars: 4, resets: false });
		const calm = formatSnapshot({ kind: "zai", primary: { pct: 3 } }, { metric, bars: 4, resets: false });
		assert.ok(hot.includes("\u001b[48;2;"), `${metric}: 3% left washes the number`);
		assert.ok(!calm.includes("\u001b[48;2;"), `${metric}: 97% left stays unwashed`);
	}
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

test("formatSnapshot is dense quota-only: LED, windows, clock resets, urgency colors", () => {
	const snap = {
		kind: "codex",
		plan: "pro",
		primary: { pct: 30, resetsAtMs: FUTURE },
		secondary: { pct: 42, resetsAtMs: Date.now() + 3 * 86400_000 },
		fetchedAtMs: 1,
	};
	const text = formatSnapshot(snap, { metric: "left", bars: 0, resets: true });
	const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /^● 5h 70% left 🕐1h0m │ 7d 58% left 🕐3d0h$/);
	assert.ok(!plain.includes("codex") && !plain.includes("luna"), "model/label stays out of the status");
	assert.ok(text.includes("\u001b[38;2;248;246;0m"), "70% left grades gilt (bold yellow)");
	assert.ok(text.includes("\u001b[38;2;255;96;0m"), "58% left grades blaze (hot orange-red)");
	assert.ok(text.includes("\u001b[1m"), "both windows are bold by 70/58 left");
});

test("formatSnapshot grades quota left in thirty-six bands, cool → hot, never pale", () => {
	const tint = (pct) =>
		(formatSnapshot({ kind: "zai", primary: { pct }, fetchedAtMs: 1 }).match(/\u001b\[38;2;(\d+;\d+;\d+)m/) ?? [])[1];
	// band floor (remaining %) -> name -> emitted tint (the LED paints fill ?? color)
	const BANDS = [
		[100, "pristine", "0;201;118"],
		[97, "ample", "0;209;100"],
		[94, "lush", "0;216;82"],
		[91, "bountiful", "0;223;62"],
		[88, "verdant", "0;230;42"],
		[85, "lime", "0;237;22"],
		[82, "chartreuse", "24;243;4"],
		[79, "fresh", "80;247;0"],
		[76, "watch", "138;251;0"],
		[74, "brisk", "184;254;0"],
		[72, "caution", "220;255;0"],
		[70, "gilt", "248;246;0"],
		[68, "amber", "252;224;0"],
		[66, "tight", "253;200;0"],
		[64, "steep", "254;174;0"],
		[62, "flare", "255;148;0"],
		[60, "hot", "255;122;0"],
		[58, "blaze", "255;96;0"],
		[56, "scorch", "255;70;0"],
		[54, "hazard", "255;44;0"],
		[52, "red", "255;20;0"],
		[50, "ember", "255;0;0"],
		[48, "alert", "255;0;0"],
		[46, "scarlet", "255;0;0"],
		[44, "critical", "255;52;30"],
		[40, "grave", "255;62;34"],
		[36, "burning", "255;72;38"],
		[32, "severe", "255;82;42"],
		[28, "inferno", "255;92;46"],
		[24, "terminal", "255;102;50"],
		[20, "molten", "255;112;54"],
		[16, "searing", "255;122;58"],
		[12, "plasma", "255;131;62"],
		[8, "core", "255;140;66"],
		[4, "detonate", "255;149;70"],
		[0, "nova", "255;158;76"],
	];
	for (const [from, name, color] of BANDS) {
		assert.equal(quotaGrade(from).name, name, `${from}% left is the ${name} band (floor inclusive)`);
		assert.equal(tint(100 - from), color, `${from}% left renders ${name}`);
		const idx = BANDS.findIndex(b => b[0] === from);
		if (idx < BANDS.length - 1 && from - BANDS[idx + 1][0] > 1)
			assert.equal(quotaGrade(from - 1).name, BANDS[idx + 1][1], `${from - 1}% left steps down exactly one band`);
	}
	assert.equal(tint(-5), "0;201;118", "nothing burned is pristine (100 left)");
	assert.equal(tint(100), "255;158;76", "exhausted burns white-hot (nova), never black");
	assert.equal(tint(Number.NaN), "0;201;118", "garbage collapses to pristine, never a false alarm");
	// Aggression guard — the ramp must close on the operator early: spring green
	// gone by 97% left, bold at 76, yellow by 72, orange by 62, the recess at 54,
	// the lit plate at 44.
	assert.notEqual(quotaGrade(98).name, "pristine", "98% left already off the top band");
	assert.equal(quotaGrade(72).name, "caution", "72% left is already pure yellow");
	assert.equal(quotaGrade(62).name, "flare", "62% left is already orange");
	assert.equal(quotaGrade(79).bold, "", "79% left is still regular weight");
	assert.equal(quotaGrade(76).bold, "\u001b[1m", "76% left turns bold");
	assert.ok(!quotaGrade(56).wash, "56% left is still on the default background");
	assert.ok(quotaGrade(54).wash && !quotaGrade(54).lit, "54% left recesses the number, unlit");
	assert.equal(quotaGrade(44).lit, true, "44% left lights the plate");
	assert.ok(BANDS.length >= 36, "at least thirty-six grades");
	assert.equal(new Set(BANDS.map(b => b[1])).size, BANDS.length, "every grade name is unique");
});

/** sRGB → CIE-Lab, for the perceived-contrast guard below. */
function lab(rgb) {
	const lin = (u) => {
		const v = u / 255;
		return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
	};
	const [r, g, b] = rgb.map(lin);
	const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
	const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
	const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
	const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
	const [fx, fy, fz] = [f(X / 0.95047), f(Y), f(Z / 1.08883)];
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const inkOf = (left) => quotaGrade(left).color.match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
const washOf = (left) => { const w = quotaGrade(left).wash; return w ? w.match(/48;2;(\d+);(\d+);(\d+)/).slice(1).map(Number) : null; };
const rgbLum = (c) => 0.2126 * ((c[0] / 255) > 0.04045 ? ((c[0] / 255 + 0.055) / 1.055) ** 2.4 : c[0] / 255 / 12.92)
	+ 0.7152 * ((c[1] / 255) > 0.04045 ? ((c[1] / 255 + 0.055) / 1.055) ** 2.4 : c[1] / 255 / 12.92)
	+ 0.0722 * ((c[2] / 255) > 0.04045 ? ((c[2] / 255 + 0.055) / 1.055) ** 2.4 : c[2] / 255 / 12.92);
const ratio = (a, b) => { const [hi, lo] = [rgbLum(a), rgbLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** The regression this test exists for: the OLD ramp bought late-ramp contrast by
 * WHITENING the ink (255,22,20 → 255,228,226), so the emptiest window rendered as
 * the palest, least-alarming row on screen — colouring read backwards exactly
 * where the operator needed it loudest. Whitening is now banned outright. */
/** The regression this test exists for, in three parts. (a) the OLD ramp whitened
 * the ink until the emptiest row was the palest, quietest thing on screen;
 * (b) the newer ramp lit a plate behind the whole segment and flipped the ink to
 * black; (c) `barFor` then painted the gauge in that same text ink, so from 44%
 * left down the FUEL itself was black on a red plate while the empty trough sat
 * on that plate — a sinking window drew as a bar FILLING with red. Each law below
 * is the direct negation of one of those failures. */
test("ramp laws: the fuel is never dark, the plate never reaches it, alarm only rises", () => {
	const steps = [100, 97, 94, 91, 88, 85, 82, 79, 76, 74, 72, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52, 50, 48, 46, 44, 40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 0];
	const inkOfStep = (left) => quotaGrade(left).color.match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
	const fillOf = (left) => (quotaGrade(left).fill ?? quotaGrade(left).color).match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
	assert.deepEqual(steps.map(s => quotaGrade(s).from), steps, "every floor is a grade, strictly descending");

	// LAW 1 — the fuel is never dark. No band may tint the bar with anything that
	// reads as empty: a black bar (the old era-D fill) keeps no contrast at all.
	for (const left of steps) {
		const f = fillOf(left);
		assert.ok(rgbLum(f) >= 0.2, `${left}% left: fuel luminance ${rgbLum(f).toFixed(2)} must never collapse`);
		assert.ok(ratio(f, [0, 0, 0]) >= 4.5, `${left}% left: fuel must clear AA on a dark terminal (${ratio(f, [0, 0, 0]).toFixed(2)})`);
	}

	// LAW 2 — light-on-dark, everywhere. The gauge resets its background and never
	// borrows the band's plate, so no cell can sit on a lit block where its ink
	// would have to invert. The plate starts after the last gauge cell.
	const gauge = (used) => {
		const text = formatSnapshot({ kind: "codex", primary: { pct: used }, fetchedAtMs: 1 }, { metric: "left", bars: 6, resets: false });
		return text.slice(text.indexOf("5h"), text.indexOf("% left"));
	};
	for (const left of [100, 88, 76, 64, 54, 44, 26, 7]) {
		const seg = gauge(100 - left);
		const lastCell = Math.max(...[..."█▏▎▍▌▋▊▉░"].map(g => seg.lastIndexOf(g)));
		const plateAt = seg.lastIndexOf("\u001b[48;2;");
		if (plateAt >= 0) assert.ok(plateAt > lastCell, `${left}% left: the plate starts after the last gauge cell`);
		assert.ok(!/\u001b\[38;2;0;0;0m[█▏▎▍▌▋▊▉]/.test(seg), `${left}% left: the fuel is never black`);
	}
	assert.match(gauge(56), /\u001b\[38;2;255;52;30m█/, "44% left draws its fuel in the incandescent ink");
	assert.match(gauge(99), /\u001b\[38;2;255;158;76m▏/, "1% left keeps one white-hot sliver");

	// LAW 3 — bar and number never disagree: the gauge never grows as quota burns,
	// at every cell count the density ladder can pick.
	for (const bars of [8, 6, 4, 2]) {
		const filled = (used) => (formatSnapshot({ kind: "zai", primary: { pct: used } }, { metric: "left", bars, resets: false }).match(/[█▏▎▍▌▋▊▉]/g) ?? []).length;
		for (let used = 0; used <= 95; used += 5) assert.ok(filled(used) >= filled(used + 5), `bars=${bars}: used=${used} never draws less than used=${used + 5}`);
	}

	// LAW 4 — escalation never recedes. Ink travels green → red and never rotates
	// back; the recess and the lit plate both brighten monotonically; the fuel
	// brightens too, so the bar is hottest exactly when it is emptiest.
	const hues = steps.slice(0, 22).map((s) => { const L = lab(inkOfStep(s)); return Math.atan2(L[2], L[1]); });
	for (let i = 1; i < hues.length; i++) assert.ok(hues[i] <= hues[i - 1] + 1e-9, `band ${steps[i]} never rotates back toward orange`);
	for (let i = 1; i <= 20; i++) {
		const dE = Math.hypot(...lab(inkOfStep(steps[i])).map((v, j) => v - lab(inkOfStep(steps[i - 1]))[j]));
		assert.ok(dE >= 4, `band ${steps[i]} vs ${steps[i - 1]}: ΔE ${dE.toFixed(1)} must be ≥ 4`);
	}
	const recessSteps = [54, 52, 50, 48, 46];
	const recess = recessSteps.map((s) => washOf(s));
	for (let i = 1; i < recess.length; i++) assert.ok(rgbLum(recess[i]) >= rgbLum(recess[i - 1]), `recess brightens (${recessSteps[i]}% left)`);
	assert.ok(recess.every(w => w[0] <= 48), "the recess stays near-black so red ink keeps AA");
	for (const s of recessSteps) assert.ok(ratio(inkOfStep(s), washOf(s)) >= 4.5, `${s}% left red ink clears AA on its recess`);
	const litSteps = [44, 40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 0];
	const lit = litSteps.map((s) => washOf(s));
	for (let i = 1; i < lit.length; i++) assert.ok(rgbLum(lit[i]) > rgbLum(lit[i - 1]), `lit plate brightens (${litSteps[i]}% left)`);
	for (let i = 0; i < lit.length; i++) assert.ok(ratio([0, 0, 0], lit[i]) >= 4.5, `${litSteps[i]}% left black-on-plate clears AA`);
	assert.ok(ratio([0, 0, 0], lit[lit.length - 1]) > ratio([0, 0, 0], lit[0]), "contrast rises as the plate lights up");
	for (let i = 1; i < litSteps.length; i++) assert.ok(rgbLum(fillOf(litSteps[i])) > rgbLum(fillOf(litSteps[i - 1])), `fuel brightens (${litSteps[i]}% left)`);
	const flip = Math.hypot(...lab(inkOfStep(44)).map((v, j) => v - lab(inkOfStep(46))[j]));
	assert.ok(flip >= 40, `strobe flip ΔE ${flip.toFixed(1)} must be a hard cut`);
	// bold is a real notch: absent at the top of the ramp, universal below 80
	for (const left of [100, 94, 85, 82, 79]) assert.equal(quotaGrade(left).bold, "", `${left}% left is not bold yet`);
	for (const left of [76, 62, 54, 44, 12, 0]) assert.equal(quotaGrade(left).bold, "\u001b[1m", `${left}% left is bold`);
});

/** Direction guard: bar length, tint and printed number all track quota LEFT. */
test("gauge direction is unambiguous: a fuller bar is always the healthier window", () => {
	const cells = (used) => ((formatSnapshot({ kind: "zai", primary: { pct: used } }, { metric: "left", bars: 6, resets: false }).match(/█/g) ?? []).length);
	assert.equal(cells(0), 6, "untouched window draws a full gauge");
	assert.equal(cells(50), 3, "half burned, half drawn");
	assert.equal(cells(100), 0, "exhausted draws nothing");
	assert.ok(cells(5) > cells(95), "less used always draws more fill");
	const plain = (used) => formatSnapshot({ kind: "zai", primary: { pct: used } }, { metric: "left" }).replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain(5), /5h 95% left$/, "numbers read as quota left, matching the bar");
	assert.match(plain(95), /5h \u00a05% left$/, "low numbers are warnings, not comfort (percent column-padded)");
});

/** Line LED tint = grade of the WORST window = the LOWEST quota left. */
test("empty gauge cells stay dim, never the segment's hot tint (no inverted weight)", () => {
	const seg = (used) => {
		const text = formatSnapshot({ kind: "zai", primary: { pct: used }, fetchedAtMs: 1 }, { metric: "left", bars: 6, resets: false });
		return text.slice(text.indexOf("5h"), text.indexOf("% left"));
	};
	assert.ok(!seg(0).includes("░"), "a full gauge draws no trough at all");
	assert.match(seg(100), /\u001b\[38;2;88;96;112m░{6}/, "an exhausted gauge paints its whole trough slate");
	for (const used of [20, 100]) {
		const tint = seg(used).match(/\u001b\[38;2;(\d+;\d+;\d+)m░/)?.[1];
		assert.equal(tint, "88;96;112", `used=${used}: trough never borrows a fuel-ramp colour`);
	}
	assert.equal(seg(100).match(/\u001b\[38;2;(\d+;\d+;\d+)m█/), null, "exhausted gauge has no solid cells to mistake for fuel");
	const solid = seg(100).match(/\u001b\[38;2;(\d+;\d+;\d+)m█/);
	assert.equal(solid, null, "exhausted gauge has no solid cells to mistake for fuel");
});

/** Line LED tint = grade of the WORST window = the LOWEST quota left. */
test("health LED tint tracks the worst window (lowest remaining)", () => {
	const dot = (a, b) =>
		(formatSnapshot({ kind: "codex", primary: { pct: a }, secondary: { pct: b }, fetchedAtMs: 1 }).match(
			/^\u001b\[(?:1m\u001b\[)?38;2;(\d+;\d+;\d+)m/,
		) ?? [])[1];
	assert.equal(dot(0, 0), "0;201;118", "both windows full");
	assert.equal(dot(20, 30), "248;246;0", "LED follows the LOWEST remaining (70 left = gilt), not the 80-left window");
	assert.equal(dot(36, 20), "254;174;0", "one scarce window heats the LED (64 left = steep)");
	assert.equal(dot(96, 12), "255;149;70", "one nearly-exhausted window flips the LED to the incandescent fuel ink");
	assert.ok(!formatSnapshot({ kind: "codex", fetchedAtMs: 1 }).includes("●"), "no windows, no LED");
});

test("formatSnapshot renders parallel 5h/7d labels with draining fuel gauges", () => {
	const snap = { kind: "codex", primary: { pct: 95 }, secondary: { pct: 15 }, fetchedAtMs: 1 };
	const text = formatSnapshot(snap, { metric: "left", bars: 5, resets: false });
	const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /^● 5h ▎░░░░ \u00a05% left │ 7d ████▎ 85% left$/, "an eighth-block floor keeps a hot sliver at 5% left");
	assert.ok(!plain.includes("wk"), "weekly label is 7d (parallel durations)");
	assert.ok(plain.includes("████▎"), "85% left nearly fills the gauge");
	assert.ok(plain.includes("▎░░░░"), "5% left drains to one fractional cell, never a whole one");
});

test("both meters are normalized: identical gauge cell counts at every rung", () => {
	const snap = { kind: "codex", primary: { pct: 88 }, secondary: { pct: 13 }, fetchedAtMs: 1 };
	for (const bars of [8, 6, 5, 4, 3, 2]) {
		const plain = formatSnapshot(snap, { bars, resets: false }).replace(/\u001b\[[0-9;]*m/g, "");
		const [fiveHour, weekly] = plain.split(" │ ");
		const cells = (seg) => (seg.match(/[█▏▎▍▌▋▊▉░]/g) ?? []).length;
		assert.equal(cells(fiveHour), bars, `5h gauge has ${bars} cells`);
		assert.equal(cells(weekly), bars, `7d gauge matches the 5h gauge at ${bars} cells`);
	}
	const bare = formatSnapshot(snap, { bars: 0, resets: false }).replace(/\u001b\[[0-9;]*m/g, "");
	assert.ok(!bare.includes("█") && !bare.includes("░"), "both gauges drop together");
});

test("density ladder is graded: bar cells step 6→5→4→3→0 before clocks drop", () => {
	const snap = { kind: "codex", primary: { pct: 5, resetsAtMs: FUTURE }, fetchedAtMs: 1 };
	const cells = (d) => (formatSnapshot(snap, d).match(/[█▏▎▍▌▋▊▉░]/g) ?? []).length; // gauge cells, eighth-blocks included
	assert.equal(cells({ metric: "left", bars: 6, resets: true }), 6);
	assert.equal(cells({ metric: "left", bars: 5, resets: true }), 5);
	assert.equal(cells({ metric: "left", bars: 4, resets: true }), 4);
	assert.equal(cells({ metric: "left", bars: 3, resets: true }), 3);
	const bare = formatSnapshot(snap, { metric: "left", bars: 0, resets: true }).replace(/\u001b\[[0-9;]*m/g, "");
	assert.ok(bare.includes("🕐") && !bare.includes("█"), "clocks outlast bars");
	const noClocks = formatSnapshot(snap, { metric: "left", bars: 3, resets: false }).replace(/\u001b\[[0-9;]*m/g, "");
	assert.ok(noClocks.includes("█") && !noClocks.includes("🕐"), "bar+reset mix rung exists");
});

test("alarm ladder: bold at 76% left, recess at 54, lit plate at 44, fuel never dark", () => {
	const mk = (pct) => ({ kind: "codex", primary: { pct }, fetchedAtMs: 1 });
	const calm = formatSnapshot(mk(21)); // 79 left
	assert.ok(calm.includes("\u001b[38;2;80;247;0m"), "79% left is fresh lime-green");
	assert.ok(!calm.includes("\u001b[1m"), "79% left never bold");
	assert.ok(!calm.includes("\u001b[48;2;"), "79% left carries no wash");
	assert.ok(formatSnapshot(mk(24)).includes("\u001b[1m"), "76% left turns bold while still unwashed");
	assert.ok(!formatSnapshot(mk(44)).includes("\u001b[48;2;"), "56% left is still unwashed");
	// the recess lands at 54: near-black block, red ink, chrome left on slate
	const recess = formatSnapshot(mk(46)); // 54 left
	assert.ok(recess.includes("\u001b[48;2;40;2;6m"), "54% left recesses the number");
	assert.ok(recess.includes("\u001b[38;2;255;44;0m"), "54% left is hot orange-red ink");
	assert.ok(recess.includes("\u001b[38;2;112;122;140m"), "a recess leaves chrome on slate");
	// the strobe: the NUMBER inverts, the FUEL does not
	const lit = formatSnapshot(mk(56)); // 44 left
	assert.ok(lit.includes("\u001b[48;2;232;30;26m"), "44% left sits on the lit plate");
	assert.ok(lit.includes("\u001b[38;2;0;0;0m"), "44% left inverts the number to black");
	assert.ok(!lit.includes("\u001b[38;2;112;122;140m"), "no slate chrome inside a lit band");
	const gauge = (used) => {
		const t = formatSnapshot({ kind: "codex", primary: { pct: used }, fetchedAtMs: 1 }, { metric: "left", bars: 4, resets: false });
		return t.slice(t.indexOf("5h"), t.indexOf("% left"));
	};
	assert.ok(!/\u001b\[38;2;0;0;0m[█▏▎▍▌▋▊▉]/.test(gauge(56)), "44% left never paints the fuel black");
	const lastCell = Math.max(..."█▏▎▍▌▋▊▉░".split("").map((g) => gauge(56).lastIndexOf(g)));
	assert.ok(gauge(56).indexOf("\u001b[48;2;") > lastCell, "the plate begins after the last gauge cell");
	assert.match(gauge(56), /\u001b\[38;2;255;52;30m█/i, "44% left draws its fuel in the incandescent ink");
	// no band anywhere may pale out toward white: every text ink is either an
	// inverted black or a fully saturated hue
	for (const left of [74, 64, 54, 46, 44, 26, 13, 0]) {
		const ink = quotaGrade(left).color.match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
		assert.ok((Math.max(...ink) === 0) || (Math.min(...ink) === 0), `${left}% left ink is saturated or inverted, never washed out`);
	}
});

test("formatSnapshot placeholder, reset suppression, dense quota-only", () => {
	const pending = formatSnapshot(undefined);
	assert.match(pending.replace(/\u001b\[[0-9;]*m/g, ""), /^quota ⋯$/);
	const snap = { kind: "codex", primary: { pct: 42, resetsAtMs: FUTURE }, fetchedAtMs: 1 };
	const bare = formatSnapshot(snap, { metric: "left", bars: 0, resets: false });
	assert.equal(bare.replace(/\u001b\[[0-9;]*m/g, ""), "● 5h 58% left");
});

test("rightJustify pads with NBSP that survives footer sanitization", () => {
	const text = "5h 42% │ 7d 12%";
	const padded = rightJustify(text, 80);
	const plain = padded.replace(/\u001b\[[0-9;]*m/g, "");
	assert.equal(plain.length - text.length, 80 - text.length);
	assert.ok(plain.startsWith("\u00a0".repeat(80 - text.length)), "pads with NBSP");
	assert.ok(padded.startsWith("\u001b[0m"), "padding run is ANSI-prefixed so trim() cannot strip it");
	// pi footer sanitize (verbatim): strip \r\n\t, collapse ASCII-space runs, trim.
	const sanitized = padded.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	assert.equal(sanitized, padded, "padding survives the real footer sanitization");
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
	assert.match(lines[1], /^5h window: 58% left · 42% used · 5h window · resets in /);
	assert.match(lines[2], /^weekly: 88% left · 12% used · 168h window · resets in /);
	assert.match(lines[3], /^credits: \$32\.82/);
	assert.match(detailReport(ZAI_SPEC, "glm-5.3", undefined), /no quota data yet/);
});

// ---------------------------------------------------------------------------
// poller state machine (credential file missing -> auth-hidden, no network)
// ---------------------------------------------------------------------------

test("QuotaPoller: unsupported provider clears status; report undefined", () => {
	const p = new QuotaPoller(readConfig({}), NO_LOCAL);
	let last = "sentinel";
	p.retarget({ id: "deepseek-chat", provider: "deepseek" }, (t) => (last = t));
	assert.equal(last, undefined);
	assert.equal(p.report(), undefined);
});

test("QuotaPoller: local meter survives quota-less and auth-less providers", async () => {
	const file = `${process.env.TMPDIR ?? "/tmp"}/quota-helper-meter-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
	fs.writeFileSync(file, JSON.stringify(METER));
	try {
		const noQuota = new QuotaPoller(readConfig({}), file);
		let last;
		noQuota.retarget({ id: "glm-5.3-flash", provider: "deepseek" }, (t) => (last = t));
		assert.equal(
			last.replace(/\u001b\[[0-9;]*m/g, ""),
			"⚡ 15.9M │ 303r",
			"no adapter: pill stays, quota stays silent, line stays at the left margin",
		);

		const rejected = new QuotaPoller(readConfig({}), file);
		let seen;
		rejected.retarget({ id: "glm-5.3", provider: "zai-coding-cn" }, (t) => (seen = t));
		await rejected.refresh(); // auth store missing -> AuthUnavailableError
		assert.equal(seen.replace(/\u001b\[[0-9;]*m/g, ""), "⚡ 15.9M │ 303r", "auth failure hides the quota, not the meter");
	} finally {
		fs.unlinkSync(file);
	}
});

test("QuotaPoller: header harvest updates codex windows instantly", () => {
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }), NO_LOCAL);
	let last = "sentinel";
	p.retarget({ id: "gpt-6-luna", provider: "openai-codex" }, (t) => (last = t));
	// Synchronous harvest before the (failing) auth refresh settles.
	p.harvestHeaders({ "x-codex-primary-used-percent": "58", "x-codex-secondary-used-percent": "21" });
	const plain = last.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /5h .*58% used/);
	assert.match(plain, /7d .*21% used/);
	assert.ok(!plain.includes("gpt-6-luna"), "status stays quota-only after header harvest");
});

test("QuotaPoller: missing credential hides status and stops polling", async () => {
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }), NO_LOCAL);
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
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }), NO_LOCAL);
	const seen = [];
	p.retarget({ id: "gpt-6-luna", provider: "openai-codex" }, (t) => seen.push(t));
	p.start((t) => seen.push(t));
	await p.refresh();
	p.stop();
	assert.equal(seen.at(-1), undefined, "stop clears the status");
});

// Reference unused export guard (keeps import list honest if bundle changes).
test("status glyph vocabulary is width-accounted (🕐/⚡ 2 cells, rest 1)", () => {
	const snap = { kind: "codex", primary: { pct: 42, resetsAtMs: FUTURE }, secondary: { pct: 12 }, fetchedAtMs: 1 };
	const text = formatSnapshot(snap, { metric: "left", bars: 5, resets: true }) + formatLocalPill(METER);
	const widths = { "│": 1, "🕐": 2, "⚡": 2, "·": 1, "⋯": 1, "█": 1, "░": 1, "●": 1, "○": 1, "⚠": 1 };
	for (const ch of "▏▎▍▌▋▊▉") widths[ch] = 1; // eighth-block fill glyphs are narrow
	for (const ch of text.replace(/\u001b\[[0-9;]*m/g, "")) {
		const cp = ch.codePointAt(0);
		if (cp < 0x7f || cp === 0xa0) continue;
		assert.ok(ch in widths, `unexpected glyph: U+${cp.toString(16)}`);
		assert.equal(visibleWidth(ch), widths[ch], `declared width for ${ch}`);
	}
});

// ---------------------------------------------------------------------------
// local usage meter pill + full-line composition (pill left · quota right)
// ---------------------------------------------------------------------------

const NO_LOCAL = "/nonexistent-quota-helper-local-usage.json";
const METER = { totalTokens: 15851571, totalRuns: 303 };
const COMPOSE_SNAP = {
	kind: "codex",
	plan: "plus",
	primary: { pct: 12, resetsAtMs: Date.now() + 3 * 3600_000 + 20 * 60_000 },
	secondary: { pct: 30, resetsAtMs: Date.now() + 6 * 86400_000 + 22 * 3600_000 },
	fetchedAtMs: 1,
};

test("formatTokensCompact renders human magnitudes", () => {
	assert.equal(formatTokensCompact(999), "999");
	assert.equal(formatTokensCompact(1000), "1k");
	assert.equal(formatTokensCompact(812345), "812k");
	assert.equal(formatTokensCompact(15851571), "15.9M");
	assert.equal(formatTokensCompact(99_999_999), "100M");
});

test("readLocalUsage tolerates missing/corrupt/nonsense files", () => {
	const file = `${process.env.TMPDIR ?? "/tmp"}/quota-helper-local-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
	fs.writeFileSync(file, JSON.stringify({ totalTokens: 15851571, totalRuns: 303 }));
	assert.deepEqual(readLocalUsage(file), METER);
	assert.equal(readLocalUsage(NO_LOCAL), undefined);
	fs.writeFileSync(file, "{corrupt");
	assert.equal(readLocalUsage(file), undefined);
	fs.writeFileSync(file, JSON.stringify({ totalTokens: -5, totalRuns: 3 }));
	assert.equal(readLocalUsage(file), undefined);
	fs.writeFileSync(file, JSON.stringify({ totalTokens: 0, totalRuns: 0 }));
	assert.equal(readLocalUsage(file), undefined);
	fs.unlinkSync(file);
});

test("formatLocalPill is the left-side meter pill with exact widths", () => {
	const pill = formatLocalPill(METER);
	const plain = pill.replace(/\u001b\[[0-9;]*m/g, "");
	assert.equal(plain, "⚡ 15.9M │ 303r");
	assert.equal(visibleWidth(pill), 15);
	assert.equal(visibleWidth(formatLocalPill({ totalTokens: 812345, totalRuns: 52 })), 13); // 812k │ 52r
	assert.ok(pill.includes("⚡"));
});

test("composeMeterOnly keeps the meter at the left margin when the quota is silent", () => {
	const plain = (cols) => composeMeterOnly(METER, cols)?.replace(/\u001b\[[0-9;]*m/g, "");
	assert.equal(plain(120), "⚡ 15.9M │ 303r");
	assert.equal(plain(40), "⚡ 15.9M │ 303r");
	assert.equal(plain(30), "⚡ 15.9M │ 303r", "15 cells still fit at 30");
	assert.equal(plain(15), "⚡ 15.9M │ 303r", "the full pill fits exactly at its own width");
	assert.equal(plain(14), "⚡15.9M", "below the full pill: compact glyph, still left-anchored");
	assert.equal(plain(6), undefined, "nothing fits: silence beats a mangled pill");
	assert.equal(composeMeterOnly(undefined, 120), undefined, "no counter file: nothing to show");
	assert.equal(visibleWidth(composeMeterOnly(METER, 120)), 15, "meter-only line has no padding");
});

test("composeStatusLine: flush right at every width, meter pill on the left", () => {
	for (const cols of [70, 85, 120]) {
		const line = composeStatusLine(COMPOSE_SNAP, METER, cols);
		assert.equal(visibleWidth(line), cols, `width ${cols}`);
		const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
		assert.ok(plain.startsWith("⚡ 15.9M │ 303r"), `pill leads at ${cols}`);
		assert.ok(plain.trimEnd().endsWith("🕐6d22h"), `quota lands flush right at ${cols}`);
	}
});

test("composeStatusLine is width-exact across the whole responsive range", () => {
	for (let cols = 24; cols <= 160; cols++) {
		const line = composeStatusLine(COMPOSE_SNAP, METER, cols);
		assert.ok(visibleWidth(line) <= cols, `never exceeds ${cols}`);
		assert.equal(visibleWidth(line), cols, `exact fit at ${cols}`);
	}
});

test("composeStatusLine density ladder degrades monotonically: decoration never returns", () => {
	const plain = (cols) => composeStatusLine(COMPOSE_SNAP, METER, cols).replace(/\u001b\[[0-9;]*m/g, "");
	let barsGone = false;
	let clockGone = false;
	let pillGone = false;
	for (let cols = 120; cols >= 30; cols--) {
		const line = plain(cols);
		const pill = line.includes("⚡");
		if (!pill) pillGone = true;
		else assert.ok(!pillGone, `pill reappeared at ${cols} cols after being sacrificed`);
		const bars = line.includes("█");
		const clock = line.includes("🕐");
		if (!bars) barsGone = true;
		else assert.ok(!barsGone, `gauges reappeared at ${cols} cols after dropping out`);
		// clocks never come back once dropped, at any width below that rung
		if (!clock) clockGone = true;
		else assert.ok(!clockGone, `clocks reappeared at ${cols} cols after dropping out`);
		assert.ok(line.includes("12% used"), `percents are never sacrificed (${cols} cols)`);
		assert.ok(visibleWidth(composeStatusLine(COMPOSE_SNAP, METER, cols)) <= Math.max(cols, 30), `fits ${cols}`);
	}
	assert.ok(plain(120).includes("█") && plain(120).includes("🕐"), "wide viewport: gauges + clocks");
	assert.ok(plain(85).includes("█") && plain(85).includes("🕐"), "85 cols keeps gauges + clocks");
	assert.ok(plain(85).includes("█") && plain(85).includes("🕐"), "85 cols keeps the gauge beside a compact pill");
	assert.ok(plain(70).includes("█") && plain(70).includes("🕐") && plain(70).includes("⚡"), "70 cols keeps both meters, thinned, beside the reset clocks");
	assert.ok(!plain(60).includes("█") && plain(60).includes("🕐") && plain(60).includes("⚡"), "60 cols trades the gauges for the reset clock (the % implies fill, the clock does not)");
	assert.ok(!plain(45).includes("█") && !plain(45).includes("🕐") && plain(45).includes("⚡"), "45 cols: percents + a clockless pill");
	assert.ok(!plain(30).includes("█") && !plain(30).includes("🕐"), "narrow viewport: percents only");
	assert.ok(!plain(30).includes("⚡"), "pill sacrificed only when nothing fits beside it");
});

test("composeStatusLine width matches pi-tui's own measurement exactly", async () => {
	const { visibleWidth: piWidth } = await import("/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js");
	for (const cols of [70, 85, 120]) {
		const line = composeStatusLine(COMPOSE_SNAP, METER, cols);
		assert.equal(piWidth(line), cols, `pi-tui width at ${cols}`);
		assert.equal(visibleWidth(line), piWidth(line), "our width table agrees with pi-tui");
	}
});

// ---------------------------------------------------------------------------
// credential resolution: openai->openai-codex fallback + JWT accountId claims
// ---------------------------------------------------------------------------

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeJwt = (claims) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;

function withAuthFile(entries, fn) {
	const file = `${process.env.TMPDIR ?? "/tmp"}/quota-helper-auth-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
	fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
	const prev = process.env.PI_QUOTA_HELPER_AUTH;
	process.env.PI_QUOTA_HELPER_AUTH = file;
	try {
		return fn();
	} finally {
		process.env.PI_QUOTA_HELPER_AUTH = prev;
		fs.unlinkSync(file);
	}
}

test("decodeJwtClaims extracts chatgpt_account_id from a bearer JWT", () => {
	assert.equal(decodeJwtClaims(fakeJwt({ chatgpt_account_id: "acct-42" })).chatgpt_account_id, "acct-42");
	assert.equal(decodeJwtClaims("sk-plain-api-key"), undefined);
	assert.equal(decodeJwtClaims("a.b."), undefined); // broken payload
	assert.equal(decodeJwtClaims("a.not-json!.c"), undefined);
});

test("resolveCredential: openai falls back to openai-codex and derives accountId from JWT", () => {
	const spec = adapterForProvider("openai");
	withAuthFile({ "openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct-shared" }) } }, () => {
		const cred = resolveCredential(spec);
		assert.equal(cred.source, "openai-codex", "falls back to the shared codex credential");
		assert.equal(cred.accountId, "acct-shared", "accountId derived from JWT claims");
	});
});

test("resolveCredential: explicit accountId wins; zai keys stay undecorated; missing auth throws", () => {
	const openaiSpec = adapterForProvider("openai");
	withAuthFile({
		openai: { access: fakeJwt({ chatgpt_account_id: "from-jwt" }), accountId: "acct-explicit" },
	}, () => {
		const cred = resolveCredential(openaiSpec);
		assert.equal(cred.source, "openai");
		assert.equal(cred.accountId, "acct-explicit");
	});
	withAuthFile({ "zai-coding-cn": { key: "sk-zai-plain" } }, () => {
		const cred = resolveCredential(ZAI_SPEC);
		assert.equal(cred.source, "zai-coding-cn");
		assert.equal(cred.accountId, undefined);
	});
	assert.throws(() => resolveCredential(openaiSpec), AuthUnavailableError);
});

// ---------------------------------------------------------------------------
// candidate ranking + auth-rejection fall-through
// (the `openai` direct-token credential gets 401 no_matching_rule from
//  chatgpt.com/backend-api/wham/usage — the shared openai-codex token must win)
// ---------------------------------------------------------------------------

const whamPayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 95, limit_window_seconds: 18000, reset_at: 1793921485 },
		secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 1794508285 },
	},
	credits: { has_credits: false, unlimited: false, balance: "0" },
};

const unauthorized = {
	error: { message: "Unauthorized", type: "rejected_by_access_enforcement", code: "no_matching_rule", param: null },
	status: 401,
};

const jsonResponse = (status, body) => ({
	status,
	ok: status >= 200 && status < 300,
	json: async () => body,
});

/** withAuthFile for async bodies: env must stay swapped until the promise
 * settles, so the test traffic never touches the real credential store. */
function withAuthFileAsync(entries, fn) {
	const file = `${process.env.TMPDIR ?? "/tmp"}/quota-helper-auth-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
	fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
	const prev = process.env.PI_QUOTA_HELPER_AUTH;
	process.env.PI_QUOTA_HELPER_AUTH = file;
	return fn().finally(() => {
		process.env.PI_QUOTA_HELPER_AUTH = prev;
		fs.unlinkSync(file);
	});
}

test("credentialCandidates ranks chatgpt-backend tokens first; zai stays single", () => {
	const spec = adapterForProvider("openai");
	withAuthFile({
		openai: { access: fakeJwt({ sub: "direct-token-use" }) }, // no account binding
		"openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct-shared" }), accountId: "acct-shared" },
	}, () => {
		assert.deepEqual(credentialCandidates(spec), ["openai-codex", "openai"]);
	});
	withAuthFile({
		openai: { access: fakeJwt({ chatgpt_account_id: "acct" }), accountId: "acct" },
		"openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct-shared" }) },
	}, () => {
		assert.deepEqual(credentialCandidates(spec), ["openai", "openai-codex"]);
	});
	withAuthFile({}, () => {
		assert.deepEqual(credentialCandidates(adapterForProvider("openai-codex")), ["openai-codex"]);
		assert.deepEqual(credentialCandidates(ZAI_SPEC), ["zai-coding-cn"]);
	});
});

test("fetchQuota falls through a 401 candidate and reports the working source", async () => {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), bearer: String(init.headers.Authorization).slice(0, 12) });
		return calls.length === 1 ? jsonResponse(401, unauthorized) : jsonResponse(200, whamPayload);
	};
	try {
		await withAuthFileAsync({
			openai: { access: fakeJwt({ chatgpt_account_id: "ranked-first" }), accountId: "ranked-first" },
			"openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct-shared" }), accountId: "acct-shared" },
		}, () => fetchQuota(adapterForProvider("openai"))).then((snap) => {
			assert.equal(snap.source, "openai-codex");
			assert.equal(snap.primary.pct, 95);
			assert.equal(snap.secondary.pct, 15);
		});
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(calls.length, 2, "both candidates were tried");
	assert.match(calls[0].url, /chatgpt\.com\/backend-api\/wham\/usage$/);
});

test("fetchQuota: all candidates rejected -> AuthRejectedError; none present -> AuthUnavailable", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse(401, unauthorized);
	try {
		await withAuthFileAsync({
			openai: { access: fakeJwt({ chatgpt_account_id: "a" }) },
			"openai-codex": { access: fakeJwt({ chatgpt_account_id: "b" }) },
		}, () => assert.rejects(() => fetchQuota(adapterForProvider("openai")), AuthRejectedError));
		await withAuthFileAsync(
			{ openai: { access: fakeJwt({ chatgpt_account_id: "a" }) } },
			() => assert.rejects(() => fetchQuota(adapterForProvider("openai")), AuthRejectedError),
		);
	} finally {
		globalThis.fetch = realFetch;
	}
	await withAuthFileAsync({}, () => assert.rejects(() => fetchQuota(adapterForProvider("openai")), AuthUnavailableError));
});

test("QuotaPoller: openai model renders via openai-codex fall-through (gpt-6.1-terra regression)", async () => {
	const realFetch = globalThis.fetch;
	let n = 0;
	globalThis.fetch = async () => (++n === 1 ? jsonResponse(401, unauthorized) : jsonResponse(200, whamPayload));
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }), NO_LOCAL);
	let last = "sentinel";
	p.retarget({ id: "gpt-6.1-terra", provider: "openai" }, (t) => (last = t));
	await new Promise((r) => setTimeout(r, 10)); // drain retarget's own (unawaited, pre-swap) refresh
	try {
		await withAuthFileAsync({
			openai: { access: fakeJwt({ sub: "direct-token-use" }) }, // 401s on wham/usage, like the real store
			"openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct" }), accountId: "acct" },
		}, () => p.refresh());
	} finally {
		globalThis.fetch = realFetch;
	}
	const plain = last.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /5h .*95% used/);
	assert.match(plain, /7d .*15% used/);
	assert.equal(n, 2, "both candidates were exercised");
	p.stop();
});

// ---------------------------------------------------------------------------
// multi-factor trend analysis (burn-rate prediction · staleness)
// ---------------------------------------------------------------------------

const mkSnap = (pct, opts = {}) => ({
	kind: "codex",
	primary: { pct, resetsAtMs: opts.resetsAtMs, windowSeconds: 18000 },
	secondary: opts.secondaryPct !== undefined ? { pct: opts.secondaryPct, resetsAtMs: opts.resetsAtMs } : undefined,
	fetchedAtMs: opts.at ?? 0,
});

test("pushTrendSample: burst collapse, sample cap, and span pruning", () => {
	const h = [];
	pushTrendSample(h, mkSnap(10, { at: 0 }), 0);
	pushTrendSample(h, mkSnap(11, { at: 5_000 }), 5_000); // within gap -> overwrite
	assert.equal(h.length, 1);
	assert.equal(h[0].primary, 11);
	pushTrendSample(h, mkSnap(12, { at: 30_000 }), 30_000); // beyond gap -> append
	assert.equal(h.length, 2);
	for (let i = 0; i < 40; i++) pushTrendSample(h, mkSnap(20 + i, { at: 60_000 + i * 60_000 }), 0);
	assert.equal(h.length <= 24, true, "sample cap enforced");
	pushTrendSample(h, mkSnap(99, { at: 5 * 3_600_000 + 60_000 }), 0); // far future: old span drops
	assert.equal(h[0].t > 0, true);
	assert.equal(h[h.length - 1].primary, 99);
	pushTrendSample(h, mkSnap(undefined, { at: 1 }), 1); // no pct -> no-op
	assert.equal(h[h.length - 1].primary, 99);
});

test("slopePerHour: least-squares velocity, span and count gates", () => {
	assert.equal(slopePerHour([]), undefined);
	assert.equal(slopePerHour([{ t: 0, pct: 5 }]), undefined);
	assert.equal(slopePerHour([{ t: 0, pct: 5 }, { t: 60_000, pct: 6 }]), undefined, "span < 5min rejected");
	// +10%/h exact: 5% at t=0 -> 10% at t=30min
	const rate = slopePerHour([{ t: 0, pct: 5 }, { t: 1_800_000, pct: 10 }]);
	assert.equal(Math.round(rate * 100) / 100, 10);
	// noisy rising series stays positive and near the true slope (2%/5min = 24%/h)
	const noisy = Array.from({ length: 8 }, (_, i) => ({ t: i * 300_000, pct: 20 + i * 2 + (i % 2 ? 0.4 : -0.4) }));
	assert.ok(Math.abs(slopePerHour(noisy) - 24) < 0.6, `noisy slope ~24%/h, got ${slopePerHour(noisy)}`);
});

test("forecastWindow: threat requires rising rate AND cap before reset", () => {
	const now = 10 * 3_600_000;
	const resetFar = now + 3 * 3_600_000; // 3h to reset
	const resetSoon = now + 20 * 60_000; // 20m to reset
	const fast = [{ t: now - 1_800_000, pct: 50 }, { t: now, pct: 60 }]; // +20%/h
	const slow = [{ t: now - 1_800_000, pct: 50 }, { t: now, pct: 50.05 }]; // +0.1%/h (flat)
	const w = { pct: 60, resetsAtMs: resetFar };

	const burning = forecastWindow(fast, w, now);
	assert.equal(burning.ratePerHour > 15, true);
	assert.equal(burning.etaMs !== undefined && Math.round(burning.etaMs / 60_000), 120, "2h to cap");
	assert.equal(burning.threatensReset, true, "cap 2h < reset 3h");

	assert.equal(forecastWindow(fast, { pct: 60, resetsAtMs: resetSoon }, now).threatensReset, false, "reset first");
	const flat = forecastWindow(slow, w, now);
	assert.equal(flat.etaMs, undefined, "flat rate -> no eta");
	assert.equal(flat.threatensReset, false);
	assert.equal(forecastWindow(fast, { pct: 60 }, now).threatensReset, false, "no reset time -> no threat claim");
	assert.equal(forecastWindow(fast, undefined, now), undefined);
});

test("analyzeTrend: per-window forecasts and freshness budget", () => {
	const now = 5 * 3_600_000;
	const hist = [{ t: now - 1_800_000, primary: 40, secondary: 10 }, { t: now, primary: 50, secondary: 11 }];
	const snap = mkSnap(50, { at: now, resetsAtMs: now + 3_600_000, secondaryPct: 11 });
	const trend = analyzeTrend(hist, snap, now, 90_000);
	assert.equal(trend.fresh, true);
	assert.equal(trend.primary.ratePerHour > 15, true);
	assert.equal(trend.secondary.ratePerHour > 0 && trend.secondary.ratePerHour < 5, true);
	assert.equal(analyzeTrend(hist, snap, now + 120_000, 90_000).fresh, false, "stale beyond budget");
	assert.equal(analyzeTrend([], undefined, now, 90_000).fresh, false);
});

test("formatSnapshot: threatened window flips clock to ⚠eta and LED escalates bold red", () => {
	const now = Date.now();
	const snap = mkSnap(84, { at: now, resetsAtMs: now + 3 * 3_600_000, secondaryPct: 16 }); // calm 84% used, warm band
	const style = {
		fresh: true,
		primary: { ratePerHour: 60, etaMs: 16 * 60_000, threatensReset: true }, // cap in 16m -> bold red band
	};
	const text = formatSnapshot(snap, { metric: "left", bars: 6, resets: true }, style);
	const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
	// the badge keeps the clock's field, right-aligned: pad on the LEFT so the row
	// still ends on a visible glyph instead of trailing blanks
	assert.match(plain, /5h █░░░░░ 16% left \u00a0{2}⚠16m/, "clock replaced by time-to-cap, right-aligned in its field");
	assert.doesNotMatch(plain, /\u00a0$/, "no trailing pad: the segment ends flush");
	assert.equal(visibleWidth("⚠"), 1, "bare ⚠ is narrow, matching pi-tui's measurement");
	assert.match(plain, /7d .*84% left.*🕐/, "other window keeps its clock");
	assert.ok(!/16% left[^│]*🕐/.test(plain), "threatened 5h segment carries no reset clock");
	assert.ok(text.includes("\u001b[1m\u001b[38;2;255;158;76m"), "LED escalated to the incandescent fuel ink");
	const w = visibleWidth(text);
	assert.equal(Number.isInteger(w) && w > 0, true, "width integral (⚠ measured 2 cells)");
});

test("formatSnapshot: widest rung prints the ⚠ time-to-cap AND the reset clock", () => {
	const now = Date.now();
	const snap = mkSnap(84, { at: now, resetsAtMs: now + 3 * 3_600_000, secondaryPct: 16 });
	const style = {
		fresh: true,
		primary: { ratePerHour: 60, etaMs: 16 * 60_000, threatensReset: true },
	};
	const plain = (d) => formatSnapshot(snap, d, style).replace(/\u001b\[[0-9;]*m/g, "");
	const both = plain({ metric: "left", bars: 6, resets: true, threatClock: true });
	assert.match(both, /16% left ⚠16m 🕐3h0m/, "velocity and recovery side by side");
	assert.doesNotMatch(both, /\u00a0/, "no padding once both fields are printed");
	// a calm window ignores the flag entirely
	const calm = formatSnapshot(snap, { metric: "left", bars: 6, resets: true, threatClock: true }, { fresh: true }).replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(calm, /🕐3h0m/);
	assert.doesNotMatch(calm, /⚠/, "no badge without a threat");
});

test("formatSnapshot: stale data renders hollow LED, non-threat keeps 🕐 and ramp", () => {
	const now = Date.now();
	const snap = mkSnap(84, { at: now, resetsAtMs: now + 3 * 3_600_000, secondaryPct: 16 });
	const stale = formatSnapshot(snap, { metric: "left", bars: 6, resets: true }, { fresh: false });
	assert.ok(stale.includes("○"), "hollow stale LED");
	const fresh = formatSnapshot(snap, { metric: "left", bars: 6, resets: true }, { fresh: true });
	const plain = fresh.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /● 5h/);
	assert.match(plain, /🕐/, "unthreatened windows keep reset clocks");
});

test("window text: washed bands redraw chrome in the plate ink, not sunk slate", () => {
	const now = Date.now();
	const snap = mkSnap(96, { at: now, resetsAtMs: now + 3_600_000 }); // 4% left -> lit plate
	const line = formatSnapshot(snap, { metric: "left", bars: 4, resets: true });
	const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /5h ▏░░░/);
	assert.match(plain, /4% left 🕐1h0m/);
	assert.ok(!line.includes("\u001b[38;2;112;122;140m"), "no slate chrome inside a washed band");
	assert.ok(line.split("\u001b[38;2;0;0;0m").length - 1 >= 3, "tag, word and clock all use the plate ink");
	assert.ok(line.includes("\u001b[48;2;254;58;44m"), "plate still lit");
});

test("window text: a spent window promotes its reset clock to the segment ink", () => {
	const now = Date.now();
	const line = formatSnapshot(mkSnap(100, { at: now, resetsAtMs: now + 1_800_000 }), { metric: "left", bars: 4, resets: true });
	assert.ok(line.includes("\u001b[1m\u001b[38;2;0;0;0m 🕐"), "clock carries the bold segment ink");
});

test("window text: a firing threat badge inherits the clock's geometry", () => {
	const now = Date.now();
	const snap = mkSnap(16, { at: now, resetsAtMs: now + 3 * 3_600_000 });
	const calm = formatSnapshot(snap, { metric: "left", bars: 6, resets: true }, {
		fresh: true,
		primary: { ratePerHour: 0.2, etaMs: undefined, threatensReset: false },
	});
	const hot = formatSnapshot(snap, { metric: "left", bars: 6, resets: true }, {
		fresh: true,
		primary: { ratePerHour: 20, etaMs: 16 * 60_000, threatensReset: true },
	});
	assert.equal(visibleWidth(hot), visibleWidth(calm), "badge occupies exactly the clock's cells");
	assert.match(hot.replace(/\u001b\[[0-9;]*m/g, ""), /⚠16m/);
});

test("composeStatusLine: trend-aware composition stays width-exact at real widths", () => {
	const now = 10 * 3_600_000;
	const snap = mkSnap(84, { at: now, resetsAtMs: now + 3 * 3_600_000, secondaryPct: 16 });
	const meter = { totalTokens: 15_851_571, totalRuns: 360 };
	const trend = {
		fresh: true,
		primary: { ratePerHour: 60, etaMs: 16 * 60_000, threatensReset: true },
		secondary: { ratePerHour: 0.4, etaMs: undefined, threatensReset: false },
	};
	for (const cols of [70, 85, 100, 120]) {
		const line = composeStatusLine(snap, meter, cols, true, trend);
		assert.equal(visibleWidth(line), cols, `exact width at ${cols}`);
		const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
		assert.ok(plain.includes("⚠16m"), `threat visible at ${cols}`);
		assert.ok(plain.includes("⚡ 15.9M │ 360r"), `pill kept at ${cols}`);
	}
});

test("detailReport: trend lines, threat verdict, and sample telemetry", () => {
	const now = Date.now();
	const spec = adapterForProvider("openai-codex");
	const snap = mkSnap(60, { at: now, resetsAtMs: now + 3_600_000 });
	const trend = { fresh: true, primary: { ratePerHour: 20, etaMs: 2 * 3_600_000, threatensReset: true } };
	const report = detailReport(spec, "gpt-6.1-terra", snap, undefined, trend, [{ t: now - 60_000, primary: 59 }, { t: now, primary: 60 }], now);
	assert.match(report, /trend \(5h\): \+20\.0%\/h · cap in ~2h0m · BEFORE reset \(1h0m away\)/);
	assert.match(report, /samples: 2 · newest just now/);
	const calm = detailReport(spec, "m", mkSnap(60, { at: now, resetsAtMs: now + 3_600_000 }), undefined, {
		fresh: true,
		primary: { ratePerHour: 0.2, etaMs: undefined, threatensReset: false },
	}, undefined, now);
	assert.match(calm, /idle — no cap risk/);
});

test("QuotaPoller: trend history feeds the prediction layer end-to-end", async () => {
	const realFetch = globalThis.fetch;
	const now = Date.now();
	const payload = { ...whamPayload };
	payload.rate_limit = { ...whamPayload.rate_limit };
	payload.rate_limit.primary_window = { ...whamPayload.rate_limit.primary_window, used_percent: 84, reset_at: (now + 3 * 3_600_000) / 1000 };
	globalThis.fetch = async () => jsonResponse(200, payload);
	const p = new QuotaPoller(readConfig({ intervalMs: 60000 }), NO_LOCAL);
	let last = "";
	p.retarget({ id: "gpt-5.3-codex", provider: "openai-codex" }, (t) => (last = t));
	await new Promise((r) => setTimeout(r, 10)); // drain retarget's unawaited refresh (auth store absent -> hidden)
	try {
		await withAuthFileAsync({ "openai-codex": { access: fakeJwt({ chatgpt_account_id: "acct" }), accountId: "acct" } }, async () => {
			await p.refresh();
			// simulate a rising history (older samples planted directly)
			p.trend.push({ t: now - 1_800_000, primary: 74, secondary: 15 });
			p.trend.push({ t: now - 900_000, primary: 79, secondary: 15.5 });
			p.render();
		});
	} finally {
		globalThis.fetch = realFetch;
	}
	const plain = last.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(plain, /⚠/, "rising 84% with 3h reset predicts cap-before-reset");
	const rep = p.report();
	assert.match(rep, /trend \(5h\): \+/);
	assert.match(rep, /samples: 3/);
	p.stop();
});
