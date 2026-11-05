/**
 * quota-helper — provider quota (5h + weekly windows) in Pi's footer status bar.
 *
 * Tracks the currently selected model's provider and smart-polls only that
 * provider's usage endpoint every 30s (configurable), rendering a dense,
 * right-justified, quota-only readout:  `● 5h 42% 🕐1h12m │ 7d 12% 🕐3d4h`
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
 * Status line ownership: quota-helper composes the whole extension status row —
 * the persistent subagentx local-usage pill on the LEFT (`[ ⚡ 15.9M · 303r ]`,
 * read live from ~/.pi/agent/subagentx-local-usage.json) and the dense quota
 * readout flush RIGHT. pi joins extension statuses alphabetically by key and
 * truncates the tail at terminal width, so this padded line (key `quota-helper`
 * sorts first) absorbs subagentx's own plain-text meter twin invisibly; if
 * quota-helper ever hides (auth rejected / unsupported provider), the twin
 * resurfaces untouched and the meter never disappears. A graded density
 * ladder picks the widest variant that fits the remaining width: fuel-gauge
 * bars at 6/5/4/3 cells with clock resets
 * (`● 5h ██████ 95% 🕐3h20m │ 7d █░░░░░ 15% 🕐6d22h`), then resets-only,
 * then bar+reset mixes, then percents-only; the meter pill is sacrificed
 * first. Multi-factor health is summarized by a line LED (`●`, tinted by the
 * WORST window) plus per-window urgency grading on remaining percent:
 * green ≥ 40%, amber 15–39%, red < 15% — below 8% the whole segment goes
 * bold red (the terminal-safe critical pulse).
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

/** Wide-glyph ranges in the emoji vocabulary this extension emits. Only RGI
 * emoji (2 cells in pi-tui) fall inside; █ ░ │ · ⋯ deliberately do not. */
const WIDE_RANGES: Array<[number, number]> = [
	[0x26a0, 0x27bf], // ⚡ and friends (emoji-presentation)
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
const GREEN = "\u001b[38;2;110;200;130m";
const ORANGE = "\u001b[38;2;255;170;60m";
const RED = "\u001b[38;2;255;90;90m";
const ACCENT = "\u001b[38;2;96;190;255m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

/** Urgency grading on REMAINING percent, shared by each window segment and
 * the line LED: calm ≥ 40%, tight 15–39%, scarce < 15%; below 8% the tone
 * runs bold (the terminal-safe critical pulse). */
function urgencyTone(pct: number): { color: string; bold: string } {
	if (pct < 15) return { color: RED, bold: pct < 8 ? BOLD : "" };
	if (pct < 40) return { color: ORANGE, bold: "" };
	return { color: GREEN, bold: "" };
}

/** Line LED summarizing both windows at a glance: tinted by the WORST
 * remaining percent. Rendered as a 2-cell `● ` prefix on the quota run. */
function healthDot(snap: QuotaSnapshot | undefined): string {
	const pcts = [snap?.primary?.pct, snap?.secondary?.pct].filter(
		(p): p is number => typeof p === "number",
	);
	if (pcts.length === 0) return "";
	const tone = urgencyTone(Math.min(...pcts));
	return `${tone.bold}${tone.color}●${RESET} `;
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

/** Fuel gauge at `cells` columns: █ filled / ░ empty, proportional to
 * REMAINING pct — the bar drains as quota is consumed, exactly like the
 * number beside it. Cell count comes from the density ladder. */
function barFor(pct: number, cells: number): string {
	const filled = Math.min(cells, Math.max(0, Math.round((pct / 100) * cells)));
	return "█".repeat(filled) + "░".repeat(cells - filled);
}

function windowText(tag: string, w: QuotaWindow, bars: number, resets: boolean): string {
	const pct = Math.round(w.pct);
	// one cohesive color run: label + gauge + percent share the urgency tone;
	// below 8% remaining the whole segment goes bold (critical pulse).
	const tone = urgencyTone(w.pct);
	let text = `${tone.bold}${tone.color}${tag} `;
	if (bars > 0) text += `${barFor(w.pct, bars)} `;
	text += `${pct}%${RESET}`;
	if (resets && w.resetsAtMs) {
		const left = formatDuration(w.resetsAtMs - Date.now());
		if (left) text += `${GRAY} 🕐${left}${RESET}`;
	}
	return text;
}

/** Responsive density ladder, widest first. Clocks are the non-redundant
 * info (the % already implies fill) so bars thin out 6→5→4→3 and drop
 * entirely before the clock resets do; percents-only is the final rung. */
export interface DensityConfig {
	bars: number;
	resets: boolean;
}

const DENSITY_LADDER: readonly DensityConfig[] = [
	{ bars: 6, resets: true },
	{ bars: 5, resets: true },
	{ bars: 4, resets: true },
	{ bars: 3, resets: true },
	{ bars: 0, resets: true },
	{ bars: 3, resets: false },
	{ bars: 0, resets: false },
];

/** One-line quota readout for the footer: dense quota-only, health LED, clock
 * resets. `● 5h ██████ 95% 🕐3h20m │ 7d █░░░░░ 15% 🕐6d22h` (full density) down
 * to `5h 95% │ 7d 15%` (percents-only). Labels stay parallel (`5h` / `7d`,
 * both durations); the model name is deliberately omitted — the footer's left
 * side already shows it. */
export function formatSnapshot(snap: QuotaSnapshot | undefined, density: DensityConfig = { bars: 0, resets: true }): string {
	if (!snap) return `${GRAY}quota ⋯${RESET}`;
	const sep = `${GRAY} │ ${RESET}`;
	const parts: string[] = [];
	if (snap.primary) parts.push(windowText("5h", snap.primary, density.bars, density.resets));
	if (snap.secondary) parts.push(windowText("7d", snap.secondary, density.bars, density.resets));
	const body = parts.length > 0 ? parts.join(sep) : `${GRAY}quota ⋯${RESET}`;
	return healthDot(snap) + body;
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

/** Left pill: `[ ⚡ 15.9M · 303r ]` — lifetime local-model usage, exactly 19
 * cells for typical values. All glyphs width-accounted: ⚡ is 2 cells. */
export function formatLocalPill(u: LocalUsage): string {
	return `${GRAY}[${RESET} ${ACCENT}⚡${RESET} ${BOLD}${formatTokensCompact(u.totalTokens)}${RESET} ${GRAY}· ${u.totalRuns}r${RESET} ${GRAY}]${RESET}`;
}

// ---------------------------------------------------------------------------
// status line composition (pill left · NBSP gap · quota flush right)
// ---------------------------------------------------------------------------

/** Compose the full status row: meter pill on the LEFT, quota flush RIGHT,
 * NBSP-padded to exactly `columns` cells. The density ladder walks widest →
 * narrowest; the widest variant that still fits after the pill wins, the pill
 * is dropped only when nothing fits beside it, and the composition is
 * width-exact at every step (never wraps, never truncates in real terms). */
export function composeStatusLine(
	snap: QuotaSnapshot | undefined,
	meter: LocalUsage | undefined,
	columns: number,
	showResets = true,
): string {
	const pill = meter ? formatLocalPill(meter) : "";
	const pillW = pill ? visibleWidth(pill) : 0;
	const ladder = (showResets ? DENSITY_LADDER : DENSITY_LADDER.map(d => ({ ...d, resets: false }))).map(d =>
		formatSnapshot(snap, d),
	);
	if (pill) {
		const beside = ladder.find(q => pillW + 2 + visibleWidth(q) <= columns);
		if (beside !== undefined) {
			const pad = columns - pillW - visibleWidth(beside);
			return pill + RESET + "\u00a0".repeat(pad) + beside;
		}
	}
	const bare = ladder.find(q => visibleWidth(q) <= columns) ?? `${GRAY}quota ⋯${RESET}`;
	return rightJustify(bare, columns);
}

/** Multi-line detail report for /quota. */
export function detailReport(spec: AdapterSpec, modelId: string, snap: QuotaSnapshot | undefined, meter?: LocalUsage): string {
	const head = `${spec.label} · ${modelId}${snap?.plan ? ` · plan ${snap.plan}` : ""}${snap?.source ? ` · via ${snap.source}` : ""}`;
	if (!snap) return `${head}\nno quota data yet`;
	const lines = [head];
	const row = (name: string, w?: QuotaWindow) => {
		if (!w) return;
		const pct = Math.round(w.pct);
		const units = w.total !== undefined && w.used !== undefined ? ` · ${Math.round(w.used)}/${Math.round(w.total)} units` : "";
		const reset = w.resetsAtMs ? ` · resets in ${formatDuration(w.resetsAtMs - Date.now())}` : "";
		const window = w.windowSeconds ? ` · ${(w.windowSeconds / 3600).toFixed(0)}h window` : "";
		lines.push(`${name}: ${pct}% used${units}${window}${reset}`);
	};
	row("5h window", snap.primary);
	row("weekly", snap.secondary);
	if (snap.credits) lines.push(`credits: ${snap.credits}`);
	if (meter) lines.push(`local meter: ${formatTokensCompact(meter.totalTokens)} tokens · ${meter.totalRuns} runs (persistent)`);
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
}

export function readConfig(block: Record<string, unknown>): QuotaConfig {
	const interval = typeof block.intervalMs === "number" ? block.intervalMs : 30_000;
	return {
		enabled: block.enabled !== false,
		intervalMs: Math.min(Math.max(interval, 5_000), 600_000),
		showResets: block.showResets !== false,
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
		this.render();
	}

	render(): void {
		if (!this.sink) return;
		if (!this.spec || this.hidden) {
			this.sink(undefined);
			return;
		}
		const cols = process.stdout.columns ?? 80;
		this.sink(composeStatusLine(this.snapshot, readLocalUsage(this.localUsageFile), cols, this.cfg.showResets));
	}

	report(): string | undefined {
		if (!this.spec) return undefined;
		return detailReport(this.spec, this.modelId, this.snapshot, readLocalUsage(this.localUsageFile));
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
}
