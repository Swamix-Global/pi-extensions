/**
 * quota-helper — provider quota (5h + weekly windows) in Pi's footer status bar.
 *
 * Tracks the currently selected model's provider and smart-polls only that
 * provider's usage endpoint every 30s (configurable), rendering a dense,
 * right-justified, quota-only readout:  `● 5h 42% left 🕐1h12m │ 7d 12% left 🕐3d4h`
 * (the model name is redundant — the footer already shows it on the left).
 *
 * Adapters:
 *   - codex  (providers `openai-codex`, `openai` oauth): GET
 *     https://chatgpt.com/backend-api/wham/usage — primary (5h) + secondary (7d)
 *     windows, plan tier and credit balance. Tokens come from
 *     ~/.pi/agent/auth.json (`access` + `accountId`), the same store ctx-engine
 *     uses. Credentials are tried as a ranked candidate list: tokens carrying a
 *     ChatGPT account (`accountId` entry field or `chatgpt_account_id` JWT
 *     claim) go first, because the `openai` provider's own credential (scopes
 *     `chatgpt.tokens.use.direct`, no account claim) is rejected by the usage
 *     endpoint with 401 `no_matching_rule` — the shared `openai-codex`
 *     subscription token serves the readout instead. A missing accountId is
 *     derived from the bearer's JWT claims; HTTP 401/403 falls through to the
 *     next candidate, and the poller hides only when every candidate fails.
 *   - zai    (providers matching *zai*): GET {host}/api/monitor/usage/quota/limit —
 *     unit 3 rows are the 5h window, unit 6 rows the weekly window; plan from
 *     data.level. Host: open.bigmodel.cn for *cn* or bigmodel ids, else api.z.ai.
 *
 * Visual language (one right-justified quota group + one quiet left meter):
 *
 *   ⚡ 15.9M │ 360r          ● 5h █▎░░░░░░ 12% used 🕐3h20m │ 7d ██▎░░░░░ 30% used 🕐6d22h
 *
 * Three ink levels only: chrome (tag, separator, the metric word, the reset
 * clock) in dim slate, the gauge and the percent in the window's fuel tint, and
 * bold reserved as an escalation channel once quota left falls below 51%. Gauges use eighth
 * blocks (▏▎▍▌▋▊▉) so a 13% window draws `▊` instead of overstating itself as a
 * whole cell, over a slate `░` track — the hatch reads as a tank whose level
 * has dropped, never as fuel, and it never borrows the segment's hot tint.
 * Numbers are column-padded to three cells so a 100→99→8 drain does not shuffle
 * the group, and the left meter reuses the same `│` divider the windows use, so
 * both halves of the row speak one visual language.
 *
 * The two windows share one gauge cell count at every width: the meters are
 * normalized so the 5h and weekly gauges always appear and thin together, never
 * one-sided (a lone meter reads as if the other window had no bar at all).
 * Tinting encodes LEVEL, never alarm — a comfortable 84% left still looks
 * comfortable.
 *
 * Status line ownership: quota-helper composes the whole extension status row —
 * the persistent subagentx local-usage meter on the LEFT (`⚡ 15.9M │ 360r`, read
 * live from ~/.pi/agent/subagentx-local-usage.json) and the dense quota readout
 * flush RIGHT. pi joins extension statuses alphabetically by key and
 * truncates the tail at terminal width, so this padded line (key `quota-helper`
 * sorts first) absorbs subagentx's own plain-text meter twin invisibly; if
 * quota-helper ever hides (auth rejected / unsupported provider), the twin
 * resurfaces untouched and the meter never disappears. A graded density
 * ladder picks the widest variant that fits the remaining width: both gauges
 * at 8→6→5→4→3→2 cells with clock resets, then every gauge drops while the
 * clocks stay, then the clocks (`● 5h 88% used │ 7d 13% used`); percents and
 * the metric word survive every rung, and the meter is sacrificed before the
 * reading itself. Multi-factor
 * analysis layers three signals over the raw percents: the thirty-two-band
 * fuel-gauge ramp (bar length, tint and `% left` all derive from quota
 * REMAINING, running green → lime → amber → orange → pure red as the level
 * drops, bold from 74% left, recessed into a blood-red block below 62, and
 * inverted to black ink on a lit red plate below 44 — the plate, never the ink,
 * carries the last of the alarm), BURN-RATE PREDICTION — a
 * rolling least-squares
 * velocity over the sample history projects time-to-cap per window; when the
 * cap lands BEFORE the reset, the clock segment becomes a red `⚠1h05m` badge
 * and the LED escalates, because a calm-looking 40% at high burn is the trap
 * this catches. The badge is a separate channel on purpose: repainting the
 * percent red would mean the ramp no longer answers "how much is left", and a
 * healthy 84% burning hot would read like an almost-spent window — and
 * STALENESS — samples older than 3 poll intervals render a hollow LED (`○`) so
 * the readout never pretends to be fresher than it is.
 *
 * Rendering uses non-breaking-space padding: pi's footer sanitizes statuses by
 * collapsing ASCII runs, so NBSP is the only padding that survives and still
 * occupies one terminal cell — the line lands flush right and is recomputed on
 * resize. Width accounting is grapheme-aware and matches pi-tui exactly for the
 * emitted glyph vocabulary: 🕐/⚡ are 2 cells (RGI emoji), █ ░ │ · ⋯ ● are 1.
 *
 * Smart polling: one provider at a time, in-flight guard, exponential backoff on
 * failures (30s → 5min cap, reset on success), silent hide on auth rejection,
 * opportunistic refresh from x-codex-* response headers, immediate refresh on
 * model switch, full cleanup on session_shutdown.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// settings (inlined helper; mirrors extension-settings.ts in sibling packages)
// ---------------------------------------------------------------------------

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readExtensionSettings(name: string): Record<string, unknown> {
	const file =
		process.env.PI_EXTENSION_SETTINGS_PATH || path.join(agentDir(), "settings.json");
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const section = raw?.extensionSettings;
		const block = section?.[name];
		return block && typeof block === "object" && !Array.isArray(block) ? block : {};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type Metric = "used" | "left";

/** Quota metric percent for a window, 0–100. `used` is the wire value; `left` is
 * its complement. Every visual derives from ONE metric so the gauge, the number
 * and the trailing word can never disagree. */
export function metricPercent(usedPct: number, metric: Metric): number {
	const used = Number.isFinite(usedPct) ? Math.min(100, Math.max(0, usedPct)) : 0;
	return metric === "left" ? 100 - used : used;
}

export interface QuotaWindow {
	/** Used percentage, 0–100 (exact ratio when the provider reports it). */
	pct: number;
	/** Consumed units (credits/tokens), provider-specific — display only. */
	used?: number;
	/** Total window units. */
	total?: number;
	/** Epoch ms when the window resets. */
	resetsAtMs?: number;
	/** Window length in seconds (18000 = 5h, 604800 = 7d). */
	windowSeconds?: number;
}

export interface QuotaSnapshot {
	kind: "codex" | "zai";
	plan?: string;
	/** auth.json key the winning credential came from (set by fetchQuota). */
	source?: string;
	primary?: QuotaWindow;
	secondary?: QuotaWindow;
	credits?: string;
	fetchedAtMs: number;
}

export interface AdapterSpec {
	kind: "codex" | "zai";
	/** Provider id the credential is stored under in auth.json. */
	authProvider: string;
	host: string;
	label: string;
}

export class AuthUnavailableError extends Error {
	constructor(provider: string) {
		super(`no stored credential for ${provider}`);
	}
}
export class AuthRejectedError extends Error {
	constructor(provider: string, status: number) {
		super(`${provider} rejected the credential (HTTP ${status})`);
	}
}

// ---------------------------------------------------------------------------
// provider mapping
// ---------------------------------------------------------------------------

/** Which quota adapter serves a provider id, if any. Pure; unit-tested. */
export function adapterForProvider(providerId: string): AdapterSpec | undefined {
	if (providerId === "openai-codex") {
		return { kind: "codex", authProvider: "openai-codex", host: "https://chatgpt.com", label: "codex" };
	}
	if (providerId === "openai") {
		// OpenAI oauth (subscription auth) draws from the same ChatGPT windows.
		return { kind: "codex", authProvider: "openai", host: "https://chatgpt.com", label: "openai" };
	}
	if (/zai|z\.ai|bigmodel|glm|zhipu/i.test(providerId)) {
		const domestic = /cn|bigmodel|zhipu/i.test(providerId);
		return {
			kind: "zai",
			authProvider: providerId,
			host: domestic ? "https://open.bigmodel.cn" : "https://api.z.ai",
			label: "glm",
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// credential access (auth.json, re-read per fetch so oauth refreshes are seen)
// ---------------------------------------------------------------------------

interface Credential {
	bearer: string;
	accountId?: string;
}

/** Decode JWT payload claims (base64url, no signature check — read-only use). */
export function decodeJwtClaims(bearer: string): Record<string, unknown> | undefined {
	const parts = bearer.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const claims: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
		return claims && typeof claims === "object" && !Array.isArray(claims)
			? (claims as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function authFilePath(): string {
	const block = readExtensionSettings("quotaHelper");
	if (typeof block.authFile === "string" && block.authFile.trim()) return path.resolve(block.authFile.trim());
	return (
		process.env.PI_QUOTA_HELPER_AUTH ||
		process.env.PI_ROUTER_AUTH ||
		path.join(agentDir(), "auth.json")
	);
}

function readCredential(authProvider: string): Credential | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
		const entry = raw?.[authProvider];
		if (!entry || typeof entry !== "object") return undefined;
		const bearer = entry.access ?? entry.key ?? entry.apiKey;
		if (typeof bearer !== "string" || bearer.length === 0) return undefined;
		const accountId = typeof entry.accountId === "string" && entry.accountId
			? entry.accountId
			: ((): string | undefined => {
					const v = decodeJwtClaims(bearer)?.chatgpt_account_id;
					return typeof v === "string" ? v : undefined;
				})();
		return { bearer, accountId };
	} catch {
		return undefined;
	}
}

/** Ordered auth.json keys to try for a spec: the mapped authProvider plus the
 * shared `openai-codex` store for codex providers. Candidates carrying a
 * ChatGPT account (explicit `accountId` or a `chatgpt_account_id` JWT claim)
 * rank first — the `openai` direct-token-use credential lacks any account
 * binding and is rejected by the usage endpoint, so the shared codex token
 * must be tried before it. Stable sort keeps the mapped provider first on
 * ties. Pure; unit-tested. */
export function credentialCandidates(spec: AdapterSpec): string[] {
	const ids = [spec.authProvider];
	if (spec.kind === "codex" && spec.authProvider !== "openai-codex") ids.push("openai-codex");
	const rank = (id: string): number => (readCredential(id)?.accountId ? 0 : 1);
	return [...ids].sort((a, b) => rank(a) - rank(b));
}

/** First resolvable credential across the candidate list (see
 * credentialCandidates); throws when the store has none of them. */
export function resolveCredential(spec: AdapterSpec): Credential & { source: string } {
	for (const id of credentialCandidates(spec)) {
		const cred = readCredential(id);
		if (cred) return { ...cred, source: id };
	}
	throw new AuthUnavailableError(spec.authProvider);
}

// ---------------------------------------------------------------------------
// payload parsers (pure; unit-tested)
// ---------------------------------------------------------------------------

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** codex: GET /backend-api/wham/usage */
export function parseCodexUsage(payload: unknown, nowMs = 0): QuotaSnapshot | null {
	if (!payload || typeof payload !== "object") return null;
	const body = payload as Record<string, unknown>;
	const rl = body.rate_limit as Record<string, unknown> | undefined;
	const win = (w: unknown): QuotaWindow | undefined => {
		if (!w || typeof w !== "object") return undefined;
		const row = w as Record<string, unknown>;
		if (typeof row.used_percent !== "number") return undefined;
		return {
			pct: row.used_percent,
			resetsAtMs: typeof row.reset_at === "number" ? row.reset_at * 1000 : undefined,
			windowSeconds: typeof row.limit_window_seconds === "number" ? row.limit_window_seconds : undefined,
		};
	};
	const primary = win(rl?.primary_window);
	const secondary = win(rl?.secondary_window);
	if (!primary && !secondary) return null;
	let credits: string | undefined;
	const cred = body.credits as Record<string, unknown> | undefined;
	if (cred?.has_credits === true && typeof cred.balance === "number" && cred.unlimited !== true) {
		// Floor at 2 decimals: never overstate the remaining dollar balance.
		const dollars = Math.floor(cred.balance * 0.04 * 100) / 100;
		credits = `$${dollars.toFixed(2)} · ${Math.floor(cred.balance)} credits`;
	}
	return {
		kind: "codex",
		plan: typeof body.plan_type === "string" ? body.plan_type : undefined,
		primary,
		secondary,
		credits,
		fetchedAtMs: nowMs,
	};
}

/** zai: GET /api/monitor/usage/quota/limit — unit 3 = 5h window, unit 6 = weekly. */
export function parseZaiUsage(payload: unknown, nowMs = 0): QuotaSnapshot | null {
	if (!payload || typeof payload !== "object") return null;
	const data = (payload as Record<string, unknown>).data as Record<string, unknown> | undefined;
	const limits = data?.limits;
	if (!Array.isArray(limits) || limits.length === 0) return null;
	let primary: QuotaWindow | undefined;
	let secondary: QuotaWindow | undefined;
	for (const row of limits) {
		if (!row || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		if (r.unit !== 3 && r.unit !== 6) continue;
		const used = typeof r.currentValue === "number" ? r.currentValue : undefined;
		const total = typeof r.usage === "number" ? r.usage : undefined;
		let pct: number | undefined;
		if (used !== undefined && total !== undefined && total > 0) {
			pct = round1((used / total) * 100); // exact ratio beats server-rounded `percentage`
		} else if (typeof r.percentage === "number") {
			pct = r.percentage;
		}
		if (pct === undefined) continue;
		const window: QuotaWindow = {
			pct,
			used,
			total,
			resetsAtMs: typeof r.nextResetTime === "number" ? r.nextResetTime : undefined,
		};
		if (r.unit === 3) primary = primary ?? window;
		else secondary = secondary ?? window;
	}
	if (!primary && !secondary) return null;
	return {
		kind: "zai",
		plan: typeof data?.level === "string" ? data.level : undefined,
		primary,
		secondary,
		fetchedAtMs: nowMs,
	};
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<unknown> {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	if (res.status === 401 || res.status === 403) {
		throw new AuthRejectedError(url, res.status);
	}
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}
	return res.json();
}

/** Fetch quota trying every candidate credential in order. HTTP 401/403 falls
 * through to the next candidate — the poller hides only when every candidate
 * is absent or rejected — while network/5xx errors surface immediately
 * (triggering backoff). Exported for tests and live verification. */
export async function fetchQuota(spec: AdapterSpec): Promise<QuotaSnapshot> {
	let lastAuthError: AuthRejectedError | undefined;
	for (const id of credentialCandidates(spec)) {
		const cred = readCredential(id);
		if (!cred) continue;
		try {
			const snap =
				spec.kind === "codex" ? await fetchCodexUsage(spec, cred) : await fetchZaiUsage(spec, cred);
			return { ...snap, source: id };
		} catch (err) {
			if (err instanceof AuthRejectedError) {
				lastAuthError = err;
				continue;
			}
			throw err;
		}
	}
	if (lastAuthError) throw lastAuthError;
	throw new AuthUnavailableError(spec.authProvider);
}

async function fetchCodexUsage(spec: AdapterSpec, cred: Credential): Promise<QuotaSnapshot> {
	const payload = await fetchJson(`${spec.host}/backend-api/wham/usage`, {
		Authorization: `Bearer ${cred.bearer}`,
		Accept: "application/json",
		"User-Agent": "pi-quota-helper/1.0",
		...(cred.accountId ? { "ChatGPT-Account-Id": cred.accountId } : {}),
	});
	const snap = parseCodexUsage(payload, Date.now());
	if (!snap) throw new Error("wham/usage payload carried no rate-limit windows");
	return snap;
}

async function fetchZaiUsage(spec: AdapterSpec, cred: Credential): Promise<QuotaSnapshot> {
	const payload = await fetchJson(`${spec.host}/api/monitor/usage/quota/limit`, {
		Authorization: `Bearer ${cred.bearer}`,
		Accept: "application/json",
		"User-Agent": "pi-quota-helper/1.0",
	});
	const snap = parseZaiUsage(payload, Date.now());
	if (!snap) throw new Error("quota/limit payload carried no usable limit rows");
	return snap;
}

// ---------------------------------------------------------------------------
// formatting (pure; unit-tested)
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;

/** Wide-glyph ranges in the emoji vocabulary this extension emits, matching
 * pi-tui: RGI emoji (emoji-presentation) are 2 cells — 🕐/⚡ — while bare ⚠
 * (U+26A0, text-presentation by default) is 1, exactly as pi-tui and common
 * terminals render it. █ ░ │ · ⋯ ● ○ deliberately do not fall in any range. */
const WIDE_RANGES: Array<[number, number]> = [
	[0x26a1, 0x27bf], // ⚡ and friends (emoji-presentation; ⚠ excluded — narrow)
	[0x1f1e6, 0x1f1ff], // regional indicators
	[0x1f300, 0x1faff], // 🕐 and the pictographic blocks
];

function glyphWidth(cp: number): number {
	return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
}

/** Terminal-cell width of `text` after stripping SGR escapes. Iterates code
 * points (not UTF-16 units) and applies the wide-range table, matching pi-tui's
 * grapheme measurement for every glyph this extension emits. */
export function visibleWidth(text: string): number {
	let w = 0;
	for (const ch of text.replace(ANSI, "")) w += glyphWidth(ch.codePointAt(0)!);
	return w;
}

const GRAY = "\u001b[38;2;130;140;150m";
/** Chrome tint: window tags, separators, the metric word. Deliberately dull so
 * the grade-tinted percent stays the one thing the eye locks onto. */
const SLATE = "\u001b[38;2;112;122;140m";
const DIM = "\u001b[2m";
/** Dimmed slate — secondary-but-quieter than a tag, for clock resets. */
const QUIET = `${DIM}${SLATE}`;
/** NBSP filler that holds a field's geometry when its content collapses (the
 * threat badge inheriting the clock's cell count). pi's footer collapses ASCII
 * runs but never NBSP, so it costs one cell and survives sanitization. */
const BADGE_PAD = "\u00a0";
const ACCENT = "\u001b[38;2;96;190;255m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const rgb = (r: number, g: number, b: number): string => `\u001b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `\u001b[48;2;${r};${g};${b}m`;
/** Burn-threat badge tint: the one red that is NOT part of the fuel ramp. */
const ALARM = `${BOLD}${rgb(255, 96, 80)}`;

/** Scale a 24-bit `rgb()` ink toward the background. The gauge is the *object*,
 * the number is the *reading* of it: printing both in one exact ink fuses the
 * bar into its label and spends a whole step of hierarchy. 0.84 keeps the bar in
 * the band's hue family — still far above AA on the dark plate — while the
 * percent stays the brightest run on the row. */
function shade(ink: string, k: number): string {
	const m = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(ink);
	if (!m) return ink;
	const [r, g, b] = [m[1], m[2], m[3]].map(v => Math.round(Number(v) * k));
	return rgb(r, g, b);
}

/** How far the fuel gauge sits below the percent's ink. */
const GAUGE_SHADE = 0.84;

export interface Grade {
	/** Lower bound of the REMAINING percent band this grade covers. */
	from: number;
	/** Text ink: the percent, and — on a lit band — the chrome beside it. */
	color: string;
	/** Gauge ink. Only set once the number inverts, because a bar printed in the
	 * text ink would then be BLACK, and a black bar reads as an empty one. */
	fill?: string;
	bold: string;
	/** Plate behind the trailing payload (percent, word, clock). The gauge is
	 * never drawn on it: the wash begins after the last gauge cell. */
	wash?: string;
	/** True when `wash` is LIT rather than a recess — chrome then flips to
	 * `color`, so a slate tag cannot sink into a bright block. A recess keeps
	 * chrome on slate, which still contrasts and keeps the row quiet. */
	lit?: boolean;
	name: string;
}

/** Thirty-six-step fuel-gauge ramp, cool → hot as quota drains. Every input to
 * this table is the REMAINING percent — the same number the segment prints, the
 * gauge fills and the LED tints — so a long green bar always means plenty and
 * nothing has to be read inside-out.
 *
 * THE TWO LAWS.
 *
 * 1. Alarm may never fall as quota falls. An earlier table broke it three times.
 *    It bought late-ramp contrast by WHITENING the text ink (255,22,20 →
 *    255,228,226), then by LIGHTING a plate behind the whole segment
 *    (238,86,72 → 255,132,108): both made the emptiest window the palest,
 *    quietest row while a comfortable window in red was the loudest thing drawn.
 *    The third break was the worst, and is what this table exists to kill:
 *    `barFor` painted the gauge in the band's TEXT ink, so from 44% left down the
 *    fuel itself was drawn BLACK on the lit plate while the empty trough was
 *    drawn on that same plate — a sinking window rendered as a bar FILLING with
 *    red, and colour read exactly backwards at the moment it mattered most.
 *
 * 2. The gauge is always light-on-dark, and the plate never reaches it. The fill
 *    carries its own ink, the trough keeps slate, and the wash begins only after
 *    the last gauge cell — so the bar can brighten monotonically to the end
 *    without ever fighting the block behind the number.
 *
 * The ramp is therefore FOUR eras, each strictly louder than the one before:
 *
 *   1. INK, 100 → 79% left. Saturated single-hue inks on the default
 *      background: spring green drains to lime, and a zero channel keeps every
 *      band out of pastel.
 *   2. WEIGHT, 76 → 56% left. Bold joins at the lime/yellow line and the hue
 *      walks yellow → amber → orange → hot orange-red.
 *   3. RECESS, 54 → 46% left. The ink has reached pure red (255,0,0) and cannot
 *      get hotter, so the escalator moves to the plate: a blood-red block lights
 *      up behind the number, r 40 → 48. It stays near-black because bright red
 *      ink only clears WCAG AA on a dark plate.
 *   4. INCANDESCENT, 44 → 0% left. The number flips to black bold on a LIT
 *      saturated red plate (232,30,26 → 255,60,45: contrast 4.6 → 5.9, so the
 *      loudest rows are also the most legible) while the FUEL climbs an
 *      afterburner ramp, (255,52,30) → (255,158,76): the bar gets BRIGHTER as it
 *      empties instead of going black. That second channel is the fix — the
 *      plate says "alarm", the bar still says "fuel", and neither inverts.
 *
 * Purity caps are enforced by the ramp tests: fill luminance never collapses
 * toward black, every bar clears AA against the background, every black number
 * clears AA on its lit plate, and plate luminance never falls. Escalation starts
 * EARLY on purpose: spring green is gone by 97% left, yellow by 72, orange by
 * 62, bold at 76, the recess at 54, the lit plate at 44 — a half-spent window is
 * an event, not a footnote. */
const GRADES: readonly Grade[] = [
	{ from: 100, color: rgb(0, 201, 118), bold: "", name: "pristine" },
	{ from: 97, color: rgb(0, 209, 100), bold: "", name: "ample" },
	{ from: 94, color: rgb(0, 216, 82), bold: "", name: "lush" },
	{ from: 91, color: rgb(0, 223, 62), bold: "", name: "bountiful" },
	{ from: 88, color: rgb(0, 230, 42), bold: "", name: "verdant" },
	{ from: 85, color: rgb(0, 237, 22), bold: "", name: "lime" },
	{ from: 82, color: rgb(24, 243, 4), bold: "", name: "chartreuse" },
	{ from: 79, color: rgb(80, 247, 0), bold: "", name: "fresh" },
	{ from: 76, color: rgb(138, 251, 0), bold: BOLD, name: "watch" },
	{ from: 74, color: rgb(184, 254, 0), bold: BOLD, name: "brisk" },
	{ from: 72, color: rgb(220, 255, 0), bold: BOLD, name: "caution" },
	{ from: 70, color: rgb(248, 246, 0), bold: BOLD, name: "gilt" },
	{ from: 68, color: rgb(252, 224, 0), bold: BOLD, name: "amber" },
	{ from: 66, color: rgb(253, 200, 0), bold: BOLD, name: "tight" },
	{ from: 64, color: rgb(254, 174, 0), bold: BOLD, name: "steep" },
	{ from: 62, color: rgb(255, 148, 0), bold: BOLD, name: "flare" },
	{ from: 60, color: rgb(255, 122, 0), bold: BOLD, name: "hot" },
	{ from: 58, color: rgb(255, 96, 0), bold: BOLD, name: "blaze" },
	{ from: 56, color: rgb(255, 70, 0), bold: BOLD, name: "scorch" },
	{ from: 54, color: rgb(255, 44, 0), bold: BOLD, wash: bg(40, 2, 6), name: "hazard" },
	{ from: 52, color: rgb(255, 20, 0), bold: BOLD, wash: bg(43, 2, 7), name: "red" },
	{ from: 50, color: rgb(255, 0, 0), bold: BOLD, wash: bg(45, 3, 8), name: "ember" },
	{ from: 48, color: rgb(255, 0, 0), bold: BOLD, wash: bg(47, 3, 8), name: "alert" },
	{ from: 46, color: rgb(255, 0, 0), bold: BOLD, wash: bg(48, 4, 9), name: "scarlet" },
	{ from: 44, color: rgb(0, 0, 0), fill: rgb(255, 52, 30), bold: BOLD, wash: bg(232, 30, 26), lit: true, name: "critical" },
	{ from: 40, color: rgb(0, 0, 0), fill: rgb(255, 62, 34), bold: BOLD, wash: bg(234, 33, 29), lit: true, name: "grave" },
	{ from: 36, color: rgb(0, 0, 0), fill: rgb(255, 72, 38), bold: BOLD, wash: bg(237, 36, 31), lit: true, name: "burning" },
	{ from: 32, color: rgb(0, 0, 0), fill: rgb(255, 82, 42), bold: BOLD, wash: bg(240, 39, 34), lit: true, name: "severe" },
	{ from: 28, color: rgb(0, 0, 0), fill: rgb(255, 92, 46), bold: BOLD, wash: bg(243, 42, 36), lit: true, name: "inferno" },
	{ from: 24, color: rgb(0, 0, 0), fill: rgb(255, 102, 50), bold: BOLD, wash: bg(246, 45, 39), lit: true, name: "terminal" },
	{ from: 20, color: rgb(0, 0, 0), fill: rgb(255, 112, 54), bold: BOLD, wash: bg(248, 48, 41), lit: true, name: "molten" },
	{ from: 16, color: rgb(0, 0, 0), fill: rgb(255, 122, 58), bold: BOLD, wash: bg(250, 51, 42), lit: true, name: "searing" },
	{ from: 12, color: rgb(0, 0, 0), fill: rgb(255, 131, 62), bold: BOLD, wash: bg(252, 53, 43), lit: true, name: "plasma" },
	{ from: 8, color: rgb(0, 0, 0), fill: rgb(255, 140, 66), bold: BOLD, wash: bg(253, 56, 44), lit: true, name: "core" },
	{ from: 4, color: rgb(0, 0, 0), fill: rgb(255, 149, 70), bold: BOLD, wash: bg(254, 58, 44), lit: true, name: "detonate" },
	{ from: 0, color: rgb(0, 0, 0), fill: rgb(255, 158, 76), bold: BOLD, wash: bg(255, 60, 45), lit: true, name: "nova" },
];

/** Ramp index where the bold ("weight") era begins. From here up the band is
 * loud enough that the window tag may carry its ink too. */
const HOT_TAG_INDEX = GRADES.findIndex(g => g.bold !== "");

/** Empty-gauge tint: slate, deliberately outside the fuel ramp — colder and
 * quieter than every band, so density and hue agree with `% left`. */
const TROUGH = rgb(88, 96, 112);
/** Unfilled-cell texture: `█████▊░░` reads as a tank whose level has dropped.
 * Deliberately NOT a background reset — inside a washed (critical) band the
 * block's own wash stays behind the trough, so the empty half reads as a recess
 * cut into the lit block instead of a default-background hole punched through
 * it, and the tint stays slate either way. */
const TRACK = "\u2591";

/** Quota LEFT percent, 0–100 — the single value every visual derives from the
 * provider's used percent. Overruns clamp at 0 (nothing left); garbage
 * collapses to 100 (assume plenty) so a bad row never fakes an alarm. */
export function leftPercent(usedPct: number): number {
	const used = Number.isFinite(usedPct) ? usedPct : 0;
	return Math.min(100, Math.max(0, 100 - used));
}

/** Grade a REMAINING percent (0–100). Shared by every window segment and the
 * line LED: 100 is calmest, 0 is the bold critical pulse. */
export function quotaGrade(leftPct: number): Grade {
	const left = Number.isFinite(leftPct) ? Math.max(0, leftPct) : 100;
	return GRADES.find(g => left >= g.from) ?? GRADES[GRADES.length - 1];
}


/** Burn-threat grade, layered over the fuel ramp: a window projected to hit its
 * cap before reset escalates to the `critical` band, and to the bold critical
 * band once the cap is under 30 minutes away. The table runs cool → hot, so the
 * hottest grade is the LAST element. */
function threatGrade(f: WindowForecast | undefined): Grade | undefined {
	if (!f?.threatensReset || f.etaMs === undefined) return undefined;
	if (f.etaMs < THREAT_RED_MS) return GRADES[GRADES.length - 1];
	// burn velocity is itself an alarm: floor the tint at `low` so a
	// comfortable-looking window that will not survive the reset still warns.
	return quotaGrade(THREAT_FLOOR_LEFT);
}

/** Multi-factor tone: the hotter of the remaining-quota grade and the
 * burn-threat grade — velocity can escalate a calm-looking window. Both inputs
 * come from the GRADES table, which runs cool → hot, so the higher index wins. */
function hotterGrade(a: Grade, b: Grade | undefined): Grade {
	if (!b) return a;
	return GRADES.indexOf(b) > GRADES.indexOf(a) ? b : a;
}

/** Line LED summarizing both windows at a glance: tinted by the WORST window
 * (LOWEST quota left) and escalated by any burn threat; hollow (`○`) when the
 * data is stale. Rendered as a 2-cell prefix. */
function healthDot(snap: QuotaSnapshot | undefined, style?: SnapshotStyle): string {
	const lefts = [snap?.primary?.pct, snap?.secondary?.pct]
		.filter((p): p is number => typeof p === "number")
		.map(leftPercent);
	if (lefts.length === 0) return "";
	const tone = hotterGrade(
		quotaGrade(Math.min(...lefts)),
		threatGrade(style?.primary) ?? threatGrade(style?.secondary),
	);
	const glyph = style?.fresh === false ? "○" : "●";
	return `${tone.bold}${tone.fill ?? tone.color}${glyph}${RESET} `;
}

/** Compact relative duration: "45s", "12m", "1h12m", "3d4h". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${m % 60}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24}h`;
}

/** Freshness floor for the hollow-LED decision; the poller widens this to
 * 3× its poll interval so a single missed beat never reads as stale. */
const STALE_MIN_MS = 90_000;

// ---------------------------------------------------------------------------
// trend analysis — burn-rate prediction (multi-factor; pure; unit-tested)
// ---------------------------------------------------------------------------

export interface TrendSample {
	/** Epoch ms of the observation. */
	t: number;
	/** Primary (5h) used percent. */
	primary: number;
	/** Secondary (weekly) used percent, when reported. */
	secondary?: number;
}

export interface WindowForecast {
	/** Least-squares usage velocity, percent per hour (negative = recovering). */
	ratePerHour: number;
	/** Projected ms until the window hits 100% at that rate (rising only). */
	etaMs?: number;
	/** True when the projected cap lands before the window resets. */
	threatensReset: boolean;
}

/** Compact time-to-cap for the ⚠ segment: sub-minute reads "now", short
 * horizons keep minute precision, long ones collapse to hours (⚠42h). */
function etaText(ms: number): string {
	if (ms < 60_000) return "now";
	return ms >= 10 * 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : formatDuration(ms);
}

export interface TrendAnalysis {
	primary?: WindowForecast;
	secondary?: WindowForecast;
	/** False when the newest sample outlives the staleness budget. */
	fresh: boolean;
}

const TREND_MAX_SAMPLES = 24;
const TREND_MAX_SPAN_MS = 3 * 3_600_000;
const TREND_MIN_GAP_MS = 20_000; // bursty header harvests collapse into one sample
const TREND_MIN_POINTS_MS = 5 * 60_000; // shortest history regression trusts
const TREND_FLAT_RATE_PER_HOUR = 0.5; // below this the window is effectively idle
const THREAT_GRACE_MS = 60_000; // cap landing within a minute of the reset is no threat
const THREAT_RED_MS = 30 * 60_000; // cap closer than this burns bold red
/** Remaining-percent floor a projected overrun escalates the line LED to: the
 * `low` band, so burn velocity alone lights a comfortable window up without
 * pretending the window is nearly spent. */
const THREAT_FLOOR_LEFT = 16;

/** Record one observation into the rolling history: within the min gap the
 * newest sample is overwritten (header harvests are bursty), beyond the sample
 * cap or the span budget the oldest drop off. Mutates `history`. */
export function pushTrendSample(
	history: TrendSample[],
	snap: QuotaSnapshot | undefined,
	nowMs: number,
): void {
	const pct = snap?.primary?.pct;
	if (typeof pct !== "number") return;
	const t = snap.fetchedAtMs || nowMs;
	const secondary = snap?.secondary?.pct;
	const sample: TrendSample = { t, primary: pct, ...(typeof secondary === "number" ? { secondary } : {}) };
	const last = history[history.length - 1];
	if (last && t - last.t < TREND_MIN_GAP_MS) history[history.length - 1] = sample;
	else history.push(sample);
	while (
		history.length > TREND_MAX_SAMPLES ||
		(history.length > 1 && history[history.length - 1].t - history[0].t > TREND_MAX_SPAN_MS)
	) {
		history.shift();
	}
}

/** Least-squares slope of pct over t in percent/hour; undefined until the
 * history spans TREND_MIN_POINTS_MS with ≥ 2 distinct samples. */
export function slopePerHour(points: Array<{ t: number; pct: number }>): number | undefined {
	if (points.length < 2) return undefined;
	const t0 = points[0].t;
	const tN = points[points.length - 1].t;
	if (tN - t0 < TREND_MIN_POINTS_MS) return undefined;
	const n = points.length;
	let sx = 0, sy = 0, sxx = 0, sxy = 0;
	for (const p of points) {
		const x = (p.t - t0) / 3_600_000; // hours since the first sample
		sx += x; sy += p.pct; sxx += x * x; sxy += x * p.pct;
	}
	const denom = n * sxx - sx * sx;
	if (denom === 0) return undefined;
	return (n * sxy - sx * sy) / denom;
}

function seriesFor(history: TrendSample[], key: "primary" | "secondary"): Array<{ t: number; pct: number }> {
	return history
		.map(s => ({ t: s.t, pct: s[key] }))
		.filter((p): p is { t: number; pct: number } => typeof p.pct === "number")
		.sort((a, b) => a.t - b.t); // regression is order-independent; history should be, too
}

/** Project one window: velocity from the sample history, time-to-cap from the
 * remaining percent, threat when the cap lands before the reset does. */
export function forecastWindow(
	points: Array<{ t: number; pct: number }>,
	w: QuotaWindow | undefined,
	nowMs: number,
): WindowForecast | undefined {
	if (!w) return undefined;
	const rate = slopePerHour(points);
	if (rate === undefined) return undefined;
	const etaMs = rate > TREND_FLAT_RATE_PER_HOUR ? ((100 - w.pct) / rate) * 3_600_000 : undefined;
	const resetsIn = w.resetsAtMs !== undefined ? w.resetsAtMs - nowMs : undefined;
	const threatensReset = etaMs !== undefined && resetsIn !== undefined && etaMs < resetsIn - THREAT_GRACE_MS;
	return { ratePerHour: rate, etaMs, threatensReset };
}

/** Analyze the rolling history against the newest snapshot; `staleAfterMs`
 * bounds freshness (3× the poll interval is the sane budget). */
export function analyzeTrend(
	history: TrendSample[],
	snap: QuotaSnapshot | undefined,
	nowMs: number,
	staleAfterMs: number,
): TrendAnalysis {
	if (!snap) return { fresh: false };
	return {
		primary: forecastWindow(seriesFor(history, "primary"), snap.primary, nowMs),
		secondary: forecastWindow(seriesFor(history, "secondary"), snap.secondary, nowMs),
		fresh: nowMs - snap.fetchedAtMs <= staleAfterMs,
	};
}

/** Eighth-block fill glyphs: the gauge resolves 1/8 of a cell instead of
 * rounding to whole cells, so a 13% window draws `▊` and a 84% window draws
 * `█████▏` — the bar never claims more quota than there is. */
const PARTIAL: readonly string[] = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Fuel gauge at `cells` columns: solid fill over a slate `░` track, proportional
 * to the REMAINING pct — the bar drains as quota burns, so its length, its tint
 * and the `% left` beside it all tell the same story. The trough is painted
 * slate (TROUGH), never the segment's hot grade, so a nearly-empty window cannot
 * masquerade as a full red bar. Cell count comes from the density ladder; the
 * fractional cell is an eighth-block.
 *
 * The gauge never touches the band's plate: the filled run resets to the default
 * background, so the bar is always ink-on-dark no matter how loud the row is.
 * Painting it the band's TEXT ink instead — the previous design — drew the fuel
 * BLACK from 44% left down, on a lit red plate, while the empty trough sat on
 * that same plate: the sink read as a bar filling with red, i.e. a reversed
 * gauge exactly where a reversal is least affordable. `fill` exists so the last
 * era can go incandescent (brightening as quota drains) while the number, which
 * needs AA contrast, stays black. */
function barFor(leftPct: number, cells: number, tone: Grade): string {
	// Fuel ink, never the text ink: on a lit band `color` is black.
	const paint = tone.fill ?? shade(tone.color, GAUGE_SHADE);
	const left = Number.isFinite(leftPct) ? Math.min(100, Math.max(0, leftPct)) : 100;
	const exact = (left / 100) * cells;
	let full = Math.floor(exact);
	let eighths = Math.round((exact - full) * 8);
	if (eighths === 8) {
		full += 1;
		eighths = 0;
	}
	let partial = PARTIAL[eighths];
	// any quota at all keeps one sliver, so the hot grade still shows instead of
	// collapsing into an all-trough bar (which reads as "empty").
	if (left > 0 && full === 0 && !partial) partial = PARTIAL[1];
	full = Math.min(full, cells);
	const empty = Math.max(0, cells - full - (partial ? 1 : 0));
	const filled = `\u001b[49m${paint}${"█".repeat(full)}${partial ?? ""}`;
	const drawn = empty > 0 ? `${filled}\u001b[49m${TROUGH}${TRACK.repeat(empty)}` : filled;
	// hand the run back to the segment's own grade (and wash) for the percent
	return `${drawn}${RESET}${tone.bold}${tone.color}${tone.wash ?? ""}`;
}

/** Quota-left label with sub-1% precision: providers that report exact ratios
 * (zai) can leave a real 0.4% sliver, and rounding it to a flat `0%` would claim
 * the window is spent while it still has tokens. Whole numbers everywhere else,
 * so the common case stays one glyph-run wide. */
export function formatLeftPercent(leftPct: number): string {
	const left = Number.isFinite(leftPct) ? Math.max(0, leftPct) : 100;
	if (left === 0 || left >= 1) return `${Math.round(left)}%`;
	return `${left.toFixed(1)}%`;
}

/** Column-stable percent field: a window draining 100 → 99 → 8 must not
 * shuffle the whole group sideways on every poll, so short values are padded to
 * three cells (` 8%`). The pad is NBSP, not a space, because pi's footer
 * sanitizer collapses runs of ASCII spaces — padding with `" "` next to the
 * separator space would silently shave a cell off the row and unseat the
 * flush-right alignment. Sub-1% waits (0.4%) already fill four cells. */
function padPercent(leftPct: number): string {
	const text = formatLeftPercent(leftPct);
	return text.length >= 3 ? text : "\u00a0".repeat(3 - text.length) + text;
}

export interface WindowStyle {
	/** Metric the number and the gauge fill report. */
	metric: Metric;
	/** Gauge cells (0 = no gauge). */
	bars: number;
	/** Print the reset clock — and the ⚠ cap badge in its place when threatened. */
	resets: boolean;
	/** Print BOTH the ⚠ cap badge and the clock when a window is threatened. */
	threatClock?: boolean;
	/** Print the metric word after the percent. */
	word?: boolean;
	/** Burn-rate projection for this window. */
	forecast?: WindowForecast;
}

/** One window segment: quiet tag · fuel gauge · BOLD percent · chrome clock.
 *
 *   5h █████▊▁▁ 84% left 🕐3h48m
 *
 * The number and the gauge fill follow the selected metric; the tint, the LED and
 * the alarm channels stay keyed to the remaining percent, so severity can never
 * invert with the metric. A window projected to cap before its reset swaps the clock
 * for a red `⚠16m` badge — an added channel rather than a repaint, because the
 * tint's contract is "how much is left" and a healthy 84% burning hot must
 * still look healthy while its badge shouts.
 */
function windowText(tag: string, w: QuotaWindow, style: WindowStyle): string {
	const left = leftPercent(w.pct);
	// The band, the LED and the alarm channels stay keyed to quota LEFT —
	// `left` answers "how much is left to burn", which is what tint escalates
	// on. The printed number and the gauge fill follow the selected metric.
	const shownPct = metricPercent(w.pct, style.metric);
	const tone = quotaGrade(left);
	const lit = tone.lit === true;
	const on = `${tone.bold}${tone.color}${tone.wash ?? ""}`;
	// Chrome ink follows the band. On a lit plate slate — and worse, dim slate —
	// sinks into the red, so washed bands redraw every chrome run in the same
	// black the numbers use, re-asserting the plate after each RESET. Nothing is
	// printed between a RESET and the re-assertion, so the block stays continuous
	// from the gauge through the clock instead of breaking off after the percent.
	const quiet = lit ? `${RESET}${tone.wash}${tone.color}` : `${RESET}${QUIET}`;
	// Heat telegraph: once the band enters its bold era the window tag takes the
	// band's own ink, so a hot segment announces itself at its LEFT edge — the eye
	// catches the red `5h` before it has read a single digit. Cool bands keep the
	// quiet slate tag: escalation must stay monotone and slate is the floor.
	const hot = GRADES.indexOf(tone) >= HOT_TAG_INDEX;
	const tagInk = lit || hot ? `${tone.color}` : SLATE;
	// A spent window is a special case of ``chrome follows the band``: with 0%
	// left the reset is the only actionable fact on the row, so the clock is
	// promoted to the segment's own bold ink instead of staying quiet chrome.
	const spent = left < 0.5;
	const clockInk = spent ? `${RESET}${tone.wash ?? ""}${BOLD}${tone.color}` : quiet;
	const alarmInk = lit ? `${RESET}${tone.wash}${BOLD}${tone.color}` : ALARM;
	// The clock field is computed even when the threat badge replaces it, so the
	// badge inherits the clock's EXACT geometry: a firing prediction swaps five
	// cells of text for five cells of text instead of shortening the segment and
	// sliding the whole right-justified group three cells sideways mid-poll.
	const clockBody = style.resets && w.resetsAtMs ? formatDuration(w.resetsAtMs - Date.now()) : "";
	let text = `${tagInk}${tag}${RESET} `;
	text += style.bars > 0
		? `${barFor(shownPct, style.bars, tone)} ${padPercent(shownPct)}`
		: `${tone.wash ?? ""}${on}${padPercent(shownPct)}`;
	if (style.word) text += `${quiet} ${style.metric}`;
	if (style.forecast?.threatensReset && style.forecast.etaMs !== undefined) {
		// cap projected BEFORE the reset: the actionable number is time-to-cap
		const badge = `⚠${etaText(style.forecast.etaMs)}`;
		if (style.threatClock && clockBody) {
			// widest rung: velocity AND recovery on one row — how long you have, and
			// how long until it comes back, without opening the detail view.
			text += `${alarmInk} ${badge}${quiet} 🕐${clockBody}`;
		} else {
			// floor rung: the badge INHERITS the clock's exact geometry, and pads on the
			// LEFT so the segment still ends on a visible glyph — padding on the right
			// leaves the flush-right group short of the margin by exactly the width
			// difference, a ragged edge that appears only while under threat.
			const field = clockBody ? visibleWidth(`🕐${clockBody}`) : 0;
			text += `${alarmInk} ${BADGE_PAD.repeat(Math.max(0, field - visibleWidth(badge)))}${badge}`;
		}
	} else if (clockBody) {
		text += `${clockInk} 🕐${clockBody}`;
	}
	return `${text}${RESET}`;
}

/** Responsive density ladder, widest first, degrading MONOTONICALLY in every
 * dimension: both gauges thin 8→6→5→4→3→2 TOGETHER, then every gauge goes while
 * the reset clocks stay, then the clocks. Percents and the metric word survive
 * every rung — they are the payload, not decoration. The meters are normalized
 * to one cell count so a narrowing terminal never leaves the 5h bar standing
 * alone; gauges are still the first casualty because `% used` already implies
 * fill, while the reset stamp carries information the percentage cannot. A mark
 * that disappears at some width never returns at a narrower one, so resizing
 * can never flicker the footer between layouts. */
export interface DensityConfig {
	/** Metric to print and fill. Defaults to `used`. */
	metric?: Metric;
	/** Gauge cells — shared by the 5h and 7d meters. */
	bars: number;
	/** Clock resets (also gates the ⚠ cap badge). */
	resets: boolean;
	/** Print the metric word (`used`/`left`) after the percent; defaults to true. */
	word?: boolean;
	/** Print the ⚠ cap badge AND the reset clock side by side when threatened. */
	threatClock?: boolean;
}

const DENSITY_LADDER: readonly DensityConfig[] = [
	{ bars: 8, resets: true, word: true, threatClock: true },
	{ bars: 8, resets: true, word: true },
	{ bars: 6, resets: true, word: true },
	{ bars: 5, resets: true, word: true },
	{ bars: 4, resets: true, word: true },
	{ bars: 3, resets: true, word: true },
	{ bars: 2, resets: true, word: true },
	{ bars: 0, resets: true, word: true },
	{ bars: 0, resets: false, word: true },
];

/** One-line quota readout for the footer: dense quota-only, health LED, clock
 * resets. Number, word and gauge fill all report the selected metric
 * (`used` by default); tint stays keyed to quota left. Both gauges always share
 * one cell count, so the 5h and weekly meters appear and thin together.
 * `● 5h ██▎░░░░░ 12% used 🕐3h20m │ 7d ██▎░░░░░ 30% used 🕐6d22h` at full
 * density, down to `● 5h 12% used │ 7d 30% used` (percents-only); a threatened
 * window swaps its clock for `⚠1h05m`. Labels stay parallel (`5h` / `7d`, both
 * durations); the model name is deliberately omitted — the footer's left side
 * already shows it. */
export interface SnapshotStyle {
	/** False renders the hollow stale LED. */
	fresh?: boolean;
	primary?: WindowForecast;
	secondary?: WindowForecast;
}

export function formatSnapshot(snap: QuotaSnapshot | undefined, density: DensityConfig = { bars: 0, resets: true }, style?: SnapshotStyle): string {
	if (!snap) return `${GRAY}quota ⋯${RESET}`;
	const metric: Metric = density.metric ?? "used";
	const sep = `${GRAY} │ ${RESET}`;
	const word = density.word !== false;
	// Both windows draw the same gauge: normalized meters, never one-sided.
	const bars = density.bars;
	const parts: string[] = [];
	if (snap.primary) {
		parts.push(windowText("5h", snap.primary, { metric, bars, resets: density.resets, word, threatClock: density.threatClock, forecast: style?.primary }));
	}
	if (snap.secondary) {
		parts.push(windowText("7d", snap.secondary, { metric, bars, resets: density.resets, word, threatClock: density.threatClock, forecast: style?.secondary }));
	}
	const body = parts.length > 0 ? parts.join(sep) : `${GRAY}quota ⋯${RESET}`;
	return healthDot(snap, style) + body;
}

/** Right-justify by padding with NBSP. pi's footer runs trim() on every status
 * and trim() strips NBSP too (it is Unicode whitespace), so the padding run is
 * prefixed with a reset escape: ANSI codes are not whitespace, the interior
 * NBSPs survive sanitization at 1 cell each, and the line lands flush right. */
export function rightJustify(text: string, columns: number): string {
	const pad = columns - visibleWidth(text);
	return pad > 0 ? RESET + "\u00a0".repeat(pad) + text : text;
}

// ---------------------------------------------------------------------------
// local usage meter (left pill) — persistent subagentx global counter
// ---------------------------------------------------------------------------

export interface LocalUsage {
	totalTokens: number;
	totalRuns: number;
}

/** Read the persistent subagentx local-usage counter; tolerant of missing or
 * corrupt files — the pill is decoration and must never break the status. */
export function readLocalUsage(file: string): LocalUsage | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LocalUsage> | null;
		const tokens = Number(raw?.totalTokens);
		const runs = Number(raw?.totalRuns);
		if (!Number.isFinite(tokens) || !Number.isFinite(runs) || tokens <= 0 || runs < 0) return undefined;
		return { totalTokens: tokens, totalRuns: Math.round(runs) };
	} catch {
		return undefined;
	}
}

/** 15851571 → "15.9M", 812345 → "812k", 999 → "999". */
export function formatTokensCompact(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 100_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export type PillVariant = "full" | "compact";

/** Left meter, richest first: `⚡ 15.9M │ 360r` (full) or `⚡15.9M` (compact) —
 * lifetime local-model usage. Bracketless on purpose: it reuses the same `│`
 * divider as the quota windows, so both halves of the row speak one visual
 * language and the footer keeps a single rhythm. The run count is the first
 * thing to go — it is a curiosity, the token total is the meter. All glyphs
 * width-accounted (⚡ is 2 cells, exactly as pi-tui measures it). */
export function formatLocalPill(u: LocalUsage, variant: PillVariant = "full"): string {
	if (variant === "compact") return `${ACCENT}⚡${RESET}${BOLD}${formatTokensCompact(u.totalTokens)}${RESET}`;
	return `${ACCENT}⚡${RESET} ${BOLD}${formatTokensCompact(u.totalTokens)}${RESET}${SLATE} │ ${u.totalRuns}r${RESET}`;
}

// ---------------------------------------------------------------------------
// status line composition (pill left · NBSP gap · quota flush right)
// ---------------------------------------------------------------------------

/** Pill variants, richest → sparsest. Fixed, so a narrowing terminal walks
 * forward through the (density, pill) preference order and never back. */
const PILL_ORDER: readonly PillVariant[] = ["full", "compact"];

/** Meter-only line for the states where the quota itself has nothing to say:
 * the active provider exposes no quota adapter, or its credential is rejected.
 * The lifetime local-model counter is independent furniture, so it parks at the
 * left margin (status rows begin at column 0) instead of vanishing along with
 * the quota — and it still owns the shared status row, so a sibling meter twin
 * cannot append and push the footer into truncation. Degrades full → compact →
 * nothing as the viewport narrows. */
export function composeMeterOnly(meter: LocalUsage | undefined, columns: number): string | undefined {
	if (!meter) return undefined;
	for (const variant of PILL_ORDER) {
		const candidate = formatLocalPill(meter, variant);
		if (visibleWidth(candidate) <= columns) return candidate;
	}
	return undefined;
}

/** Compose the full status row: meter pill on the LEFT, quota flush RIGHT,
 * NBSP-padded to exactly `columns` cells. The pill walks full → compact → gone
 * and, at each pill size, the density ladder walks widest → narrowest — both
 * fixed orders, so a narrowing terminal only ever sheds detail: gauges thin,
 * then clocks drop, then the run count goes, then the meter itself, and no mark
 * ever returns at a smaller width. Composition is width-exact at every step
 * (never wraps, never truncates). */
export function composeStatusLine(
	snap: QuotaSnapshot | undefined,
	meter: LocalUsage | undefined,
	columns: number,
	showResets = true,
	trend?: TrendAnalysis,
	metric: Metric = "used",
): string {
	const pill = meter ? formatLocalPill(meter) : "";
	const pillW = pill ? visibleWidth(pill) : 0;
	const style: SnapshotStyle | undefined = trend
		? { fresh: trend.fresh, primary: trend.primary, secondary: trend.secondary }
		: undefined;
	const ladder = (showResets ? DENSITY_LADDER : DENSITY_LADDER.map(d => ({ ...d, resets: false, threatClock: false }))).map(d =>
		formatSnapshot(snap, { ...d, metric }, style),
	);
	if (pill) {
		// Pill-major: hold the meter at full fidelity while any rung still fits
		for (const variant of PILL_ORDER) {
			const candidate = formatLocalPill(meter, variant);
			const candidateW = visibleWidth(candidate);
			for (const quota of ladder) {
				const quotaW = visibleWidth(quota);
				if (candidateW + 2 + quotaW <= columns) {
					return candidate + RESET + "\u00a0".repeat(columns - candidateW - quotaW) + quota;
				}
			}
		}
		// Not even the compact pill fits beside the narrowest rung: sacrifice it
		// and let the bare quota re-walk the ladder from the top — a clean dense
		// percentage line beats a squashed meter with nothing to meter.
		const bare = ladder.find(q => visibleWidth(q) <= columns);
		return rightJustify(bare ?? `${GRAY}quota ⋯${RESET}`, columns);
	}
	const bare = ladder.find(q => visibleWidth(q) <= columns) ?? `${GRAY}quota ⋯${RESET}`;
	return rightJustify(bare, columns);
}

/** Multi-line detail report for /quota. The optional trend/history arguments
 * carry the multi-factor analysis: per-window burn velocity, projected
 * time-to-cap vs. reset, and sample telemetry. */
export function detailReport(
	spec: AdapterSpec,
	modelId: string,
	snap: QuotaSnapshot | undefined,
	meter?: LocalUsage,
	trend?: TrendAnalysis,
	history?: TrendSample[],
	nowMs: number = Date.now(),
): string {
	const head = `${spec.label} · ${modelId}${snap?.plan ? ` · plan ${snap.plan}` : ""}${snap?.source ? ` · via ${snap.source}` : ""}`;
	if (!snap) return `${head}\nno quota data yet`;
	const lines = [head];
	const row = (name: string, w?: QuotaWindow) => {
		if (!w) return;
		const pct = Math.round(w.pct);
		const leftPct = leftPercent(w.pct);
		const units = w.total !== undefined && w.used !== undefined ? ` · ${Math.round(w.used)}/${Math.round(w.total)} units` : "";
		const reset = w.resetsAtMs ? ` · resets in ${formatDuration(w.resetsAtMs - nowMs)}` : "";
		const window = w.windowSeconds ? ` · ${(w.windowSeconds / 3600).toFixed(0)}h window` : "";
		lines.push(`${name}: ${formatLeftPercent(leftPct)} left · ${pct}% used${units}${window}${reset}`);
	};
	row("5h window", snap.primary);
	row("weekly", snap.secondary);
	const trendLine = (name: string, w: QuotaWindow | undefined, f?: WindowForecast) => {
		if (!w || !f) return;
		const pace = `${f.ratePerHour >= 0 ? "+" : ""}${f.ratePerHour.toFixed(1)}%/h`;
		if (f.etaMs === undefined) lines.push(`trend (${name}): ${pace} · idle — no cap risk`);
		else if (f.threatensReset) {
			const resetsIn = w.resetsAtMs !== undefined ? formatDuration(w.resetsAtMs - nowMs) : "?";
			lines.push(`trend (${name}): ${pace} · cap in ~${formatDuration(f.etaMs)} · BEFORE reset (${resetsIn} away)`);
		} else lines.push(`trend (${name}): ${pace} · cap in ~${formatDuration(f.etaMs)} · after reset — safe`);
	};
	trendLine("5h", snap.primary, trend?.primary);
	trendLine("weekly", snap.secondary, trend?.secondary);
	if (snap.credits) lines.push(`credits: ${snap.credits}`);
	if (meter) lines.push(`local meter: ${formatTokensCompact(meter.totalTokens)} tokens · ${meter.totalRuns} runs (persistent)`);
	if (history && history.length > 0) {
		const age = formatDuration(nowMs - history[history.length - 1].t);
		lines.push(`samples: ${history.length} · newest ${age ? `${age} ago` : "just now"}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// polling state machine
// ---------------------------------------------------------------------------

type StatusSink = (text: string | undefined) => void;

export interface QuotaConfig {
	enabled: boolean;
	intervalMs: number;
	showResets: boolean;
	/** Which quota metric the footer reports; `used` is the default. */
	metric: Metric;
	/** Burn-rate prediction layer (multi-factor trend analysis). */
	predictions: boolean;
}

export function readConfig(block: Record<string, unknown>): QuotaConfig {
	const interval = typeof block.intervalMs === "number" ? block.intervalMs : 30_000;
	return {
		enabled: block.enabled !== false,
		intervalMs: Math.min(Math.max(interval, 5_000), 600_000),
		showResets: block.showResets !== false,
		metric: block.metric === "left" ? "left" : "used",
		predictions: block.predictions !== false,
	};
}

/** Exponential backoff after consecutive failures: interval * 2^(n-1) — the
 * first failure waits one interval, then doubles — capped at 5 minutes. */
export function backoffMs(intervalMs: number, consecutiveFailures: number): number {
	const cap = 5 * 60_000;
	const factor = Math.min(Math.max(consecutiveFailures - 1, 0), 5);
	return Math.min(intervalMs * 2 ** factor, cap);
}

export class QuotaPoller {
	private readonly localUsageFile: string;
	private spec: AdapterSpec | undefined;
	private family = ""; // kind:host — stable across openai↔openai-codex model switches
	private modelId = "";
	private snapshot: QuotaSnapshot | undefined;
	private readonly trend: TrendSample[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight = false;
	private fails = 0;
	private nextAttemptAt = 0;
	private hidden = false; // auth rejected/absent: poll nothing, render nothing
	private sink: StatusSink | undefined;
	private onResize = () => this.render();

	constructor(private readonly cfg: QuotaConfig, localUsageFile?: string) {
		this.localUsageFile = localUsageFile ?? path.join(agentDir(), "subagentx-local-usage.json");
	}

	/** Re-target the active provider/model; refreshes immediately when the quota
	 * family (adapter kind + host) changed — openai↔openai-codex share windows. */
	retarget(model: { id: string; provider: string } | undefined, sink?: StatusSink): void {
		if (sink) this.sink = sink;
		const spec = model ? adapterForProvider(model.provider) : undefined;
		const family = spec ? `${spec.kind}:${spec.host}` : "";
		const familyChanged = family !== "" && family !== this.family;
		this.spec = spec;
		this.family = family;
		this.modelId = model?.id ?? "";
		if (familyChanged) {
			this.snapshot = undefined;
			this.trend.length = 0; // windows differ: history is void
			this.fails = 0;
			this.nextAttemptAt = 0;
			this.hidden = false;
		}
		this.render();
		if (familyChanged) void this.refresh();
	}

	start(sink: StatusSink): void {
		this.sink = sink;
		this.stopTimer();
		this.timer = setInterval(() => this.tick(), this.cfg.intervalMs);
		this.timer.unref?.();
		process.stdout.on("resize", this.onResize);
		void this.refresh();
	}

	stop(): void {
		this.stopTimer();
		process.stdout.removeListener("resize", this.onResize);
		this.sink?.(undefined);
		this.sink = undefined;
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One smart tick: skips when idle, backed-off, in-flight, or hidden. */
	tick(): void {
		if (!this.spec || this.hidden || this.inFlight) return;
		if (Date.now() < this.nextAttemptAt) return;
		void this.refresh();
	}

	/** Force an immediate fetch (skips backoff); resolves when settled. */
	async refresh(): Promise<void> {
		if (!this.spec || this.inFlight) return;
		this.inFlight = true;
		try {
			const snap = await fetchQuota(this.spec);
			this.snapshot = snap;
			pushTrendSample(this.trend, snap, Date.now());
			this.fails = 0;
			this.nextAttemptAt = 0;
			if (this.hidden) this.hidden = false;
		} catch (err) {
			if (err instanceof AuthUnavailableError || err instanceof AuthRejectedError) {
				this.hidden = true; // credential gone/rejected: hide silently, stop polling
				this.snapshot = undefined;
			} else {
				this.fails += 1;
				this.nextAttemptAt = Date.now() + backoffMs(this.cfg.intervalMs, this.fails);
			}
		} finally {
			this.inFlight = false;
			this.render();
		}
	}

	/** Free mid-run refresh from x-codex-* rate-limit headers, when the proxy forwards them. */
	harvestHeaders(headers: Record<string, unknown>): void {
		if (!this.spec || this.spec.kind !== "codex" || this.hidden) return;
		const get = (name: string): string | undefined => {
			const key = Object.keys(headers).find(k => k.toLowerCase() === name);
			const v = key === undefined ? undefined : headers[key];
			return typeof v === "string" ? v : undefined;
		};
		const pct = get("x-codex-primary-used-percent");
		const wk = get("x-codex-secondary-used-percent");
		if (pct === undefined && wk === undefined) return;
		const prev = this.snapshot;
		this.snapshot = {
			kind: "codex",
			plan: prev?.plan,
			credits: prev?.credits,
			primary: pct !== undefined && Number.isFinite(Number(pct))
				? { ...(prev?.primary ?? {}), pct: Number(pct) }
				: prev?.primary,
			secondary: wk !== undefined && Number.isFinite(Number(wk))
				? { ...(prev?.secondary ?? {}), pct: Number(wk) }
				: prev?.secondary,
			fetchedAtMs: Date.now(),
		};
		pushTrendSample(this.trend, this.snapshot, Date.now());
		this.render();
	}

	render(): void {
		if (!this.sink) return;
		const cols = process.stdout.columns ?? 80;
		const meter = readLocalUsage(this.localUsageFile);
		if (!this.spec || this.hidden) {
			// No quota to report, but the local meter is not quota furniture: keep it
			// anchored at the left margin rather than letting the whole row vanish.
			this.sink(composeMeterOnly(meter, cols));
			return;
		}
		const staleAfter = Math.max(STALE_MIN_MS, 3 * this.cfg.intervalMs);
		const trend = analyzeTrend(this.trend, this.snapshot, Date.now(), staleAfter);
		this.sink(
			composeStatusLine(
				this.snapshot,
				meter,
				cols,
				this.cfg.showResets,
				this.cfg.predictions ? trend : { fresh: trend.fresh },
				this.cfg.metric,
			),
		);
	}

	report(): string | undefined {
		if (!this.spec) return undefined;
		const staleAfter = Math.max(STALE_MIN_MS, 3 * this.cfg.intervalMs);
		const trend = analyzeTrend(this.trend, this.snapshot, Date.now(), staleAfter);
		return detailReport(this.spec, this.modelId, this.snapshot, readLocalUsage(this.localUsageFile), trend, this.trend);
	}
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

const STATUS_KEY = "quota-helper";

const SENTINEL_FILE = () => path.join(agentDir(), ".quota-status-live");

/** Claim the shared footer status row for the next ~2 min: sibling subagentx
 * checks this sentinel's freshness and withholds its plain-text meter twin,
 * which would otherwise append after the padded line and put the footer's
 * truncate ellipsis over the flush-right quota tail. Refreshed on every render
 * (30s poll cadence), removed when the status clears — after a crash without
 * session_shutdown the twin resurfaces within 2 minutes. */
function claimStatusLine(active: boolean): void {
	try {
		if (active) fs.writeFileSync(SENTINEL_FILE(), String(process.pid));
		else fs.unlinkSync(SENTINEL_FILE());
	} catch {
		/* decoration only — never break the status */
	}
}

export default function quotaHelper(pi: ExtensionAPI): void {
	const cfg = readConfig(readExtensionSettings("quotaHelper"));
	if (!cfg.enabled) return;

	const poller = new QuotaPoller(cfg);
	let sink: StatusSink | undefined;

	const bind = (ctx: ExtensionContext): StatusSink | undefined => {
		if (typeof ctx.ui?.setStatus !== "function") return undefined;
		return (text) => {
			claimStatusLine(text !== undefined);
			ctx.ui.setStatus!(STATUS_KEY, text);
		};
	};

	pi.on("session_start", (_event, ctx) => {
		sink = bind(ctx);
		poller.retarget(ctx.model, sink);
		if (sink) poller.start(sink);
	});
	pi.on("model_select", (event, ctx) => {
		poller.retarget(event.model, sink ?? bind(ctx));
	});
	pi.on("session_shutdown", () => {
		poller.stop();
		sink = undefined;
	});
	pi.on("after_provider_response", (event) => {
		if (event.headers) poller.harvestHeaders(event.headers as Record<string, unknown>);
	});

	pi.registerCommand("quota", {
		description: "Refresh and show quota details (5h + weekly windows) for the active provider",
		handler: async (_args, ctx) => {
			sink = sink ?? bind(ctx);
			poller.retarget(ctx.model, sink);
			const report0 = poller.report();
			if (report0 === undefined) {
				ctx.ui.notify(
					`quota-helper: provider \`${ctx.model?.provider ?? "none"}\` has no quota adapter (codex/zai only)`,
					"warning",
				);
				return;
			}
			await poller.refresh();
			ctx.ui.notify(poller.report() ?? report0, "info");
		},
	});

	// Config surfaces in the unified /settings UI (util-settings) via the shared schema bus.
	pi.events?.on?.("settings:schemas", (sink: unknown[]) => {
		sink.push({
			name: "quotaHelper",
			title: "Quota helper",
			fields: [
				{ key: "metric", label: "Metric", type: "choice", values: ["used", "left"], desc: "Quota figure and gauge fill. `used` (default) counts up as the window burns; `left` counts down. Both meters are always shown." },
				{ key: "authFile", label: "Auth file", type: "path", desc: "Router auth.json path; empty = PI_QUOTA_HELPER_AUTH / PI_ROUTER_AUTH env, then <agentDir>/auth.json.", validate: (value: unknown) => {
					const file = String(value);
					if (!file || /[\0\r\n]/.test(file)) throw new Error("authFile must be a non-empty single-line path.");
					return path.resolve(file);
				} },
			],
		});
	});
}
