/**
 * search-tools — pluggable multi-provider web search for Pi.
 *
 * One canonical `web_search` tool aggregating: deepseek (Search API),
 * brave (Search API), perplexity (sonar), searxng (open-source metasearch,
 * keyless), and antigravity (delegates to the registered google_search
 * tool). Plus `web_fetch` (DeepSeek Fetch API — markdown page reader).
 *
 * Provider selection per call, in order: explicit `provider` argument →
 * settings `extensionSettings.searchTools.provider` → default "random"
 * (uniform shuffle of available providers). Whatever is chosen, the rest
 * of the available chain acts as automatic failover; `details.chain`
 * records who served and who failed.
 *
 * Keys resolve per call: env (DEEPSEEK_API_KEY / BRAVE_API_KEY /
 * PERPLEXITY_API_KEY) → settings `.providers.<name>.apiKey` → auth.json
 * entry matching the provider name. SearXNG is keyless (instance URL via
 * settings `.searxngUrl`, default https://searx.be). Antigravity needs the
 * google_search tool registered.
 *
 * Collapsed results are one line; ctrl+o/click expands the full result
 * list (renderers honor `expanded`). Calls bounded to 30s, abort-aware.
 * Tests: `tests/test-search-tools.mjs` (hermetic offline; --live for API smoke).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CALL_TIMEOUT_MS = 30_000;
const MAX_FETCH_LINES = 200;
const MAX_FETCH_BYTES = 65_536;
const ELIDE_SIDE_LINES = 100;
const MAX_RESULTS_TEXT = 20;
const DEFAULT_SEARXNG_URL = "https://searx.be";

// --- settings & keys ---------------------------------------------------------

export interface SearchToolsSettings {
	provider?: string;
	searxngUrl?: string;
	providers?: Record<string, { apiKey?: string }>;
}

export function readSearchToolsSettings(home = os.homedir()): SearchToolsSettings {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
		return settings?.extensionSettings?.searchTools ?? {};
	} catch {
		return {};
	}
}

const ENV_KEYS: Record<string, string[]> = {
	deepseek: ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"],
	brave: ["BRAVE_API_KEY"],
	perplexity: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
};

export function resolveProviderKey(provider: string, settings: SearchToolsSettings = {}, home = os.homedir()): { key: string; source: string } {
	for (const envName of ENV_KEYS[provider] ?? []) {
		const v = process.env[envName];
		if (v && v.trim()) return { key: v.trim(), source: `env:${envName}` };
	}
	const fromSettings = settings.providers?.[provider]?.apiKey;
	if (fromSettings && fromSettings.trim()) return { key: fromSettings.trim(), source: "settings" };
	try {
		const auth = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "auth.json"), "utf8"));
		for (const [k, v] of Object.entries(auth)) {
			if (!new RegExp(provider, "i").test(k)) continue;
			const key =
				typeof v === "string" ? v :
				typeof (v as any)?.apiKey === "string" ? (v as any).apiKey :
				typeof (v as any)?.key === "string" ? (v as any).key : "";
			if (key.trim()) return { key: key.trim(), source: `auth.json:${k}` };
		}
	} catch {
		// missing/unreadable auth.json — fall through
	}
	throw new Error(`No API key for search provider "${provider}". Set ${ENV_KEYS[provider]?.[0] ?? "the provider env var"}, settings extensionSettings.searchTools.providers.${provider}.apiKey, or an auth.json entry.`);
}

// --- provider plumbing --------------------------------------------------------

export interface SearchHit {
	title?: string;
	url?: string;
	summary?: string;
	score?: number;
}

interface ProviderCallCtx {
	toolNames: string[];
	executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
}

interface SearchProvider {
	name: string;
	needsKey: boolean;
	available(ctx: ProviderCallCtx): boolean;
	search(query: string, count: number, signal: AbortSignal | undefined, ctx: ProviderCallCtx): Promise<SearchHit[]>;
}

async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
	const signals = [signal, AbortSignal.timeout(CALL_TIMEOUT_MS)].filter(Boolean) as AbortSignal[];
	const res = await fetch(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
	const text = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300) || "(empty body)"}`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`non-JSON response: ${text.slice(0, 300)}`);
	}
}

const PROVIDERS: SearchProvider[] = [
	{
		name: "deepseek",
		needsKey: true,
		available: () => true,
		async search(query, count, signal, ctx) {
			const { key } = resolveProviderKey("deepseek", ctx.settings);
			const json = await request("https://api.deepseek.com/v1/tools/search", {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ query, count, need_content: false }),
			}, signal);
			return (Array.isArray(json?.results) ? json.results : []).map((r: any) => ({
				title: r.title, url: r.url, summary: r.summary || r.snippet, score: typeof r.rerank_score === "number" ? r.rerank_score : undefined,
			}));
		},
	},
	{
		name: "brave",
		needsKey: true,
		available: () => true,
		async search(query, count, signal, ctx) {
			const { key } = resolveProviderKey("brave", ctx.settings);
			const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
			const json = await request(url, {
				headers: { Accept: "application/json", "X-Subscription-Token": key },
			}, signal);
			return (Array.isArray(json?.web?.results) ? json.web.results : []).map((r: any) => ({
				title: r.title, url: r.url, summary: r.description, score: typeof r.meta?.authority === "number" ? r.meta.authority : undefined,
			}));
		},
	},
	{
		name: "perplexity",
		needsKey: true,
		available: () => true,
		async search(query, _count, signal, ctx) {
			const { key } = resolveProviderKey("perplexity", ctx.settings);
			const json = await request("https://api.perplexity.ai/chat/completions", {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }] }),
			}, signal);
			const content = typeof json?.choices?.[0]?.message?.content === "string" ? json.choices[0].message.content : "";
			const citations: string[] = Array.isArray(json?.citations) ? json.citations : [];
			const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
			return [
				...(content ? [{ title: "Perplexity answer", url: citations[0] ?? "", summary: content.slice(0, 800) }] : []),
				...citations.map((u) => ({ title: host(u), url: u, summary: undefined, score: undefined })),
			];
		},
	},
	{
		name: "searxng",
		needsKey: false,
		available: () => true,
		async search(query, count, signal, ctx) {
			const base = (ctx.settings.searxngUrl || DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
			const json = await request(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
				headers: { Accept: "application/json" },
			}, signal);
			return (Array.isArray(json?.results) ? json.results : []).slice(0, count).map((r: any) => ({
				title: r.title, url: r.url, summary: r.content, score: typeof r.score === "number" ? r.score : undefined,
			}));
		},
	},
	{
		name: "antigravity",
		needsKey: false,
		available: (ctx) => ctx.toolNames.includes("google_search") && typeof ctx.executeTool === "function",
		async search(query, count, signal, ctx) {
			const outcome = await ctx.executeTool!("google_search", { query }, { signal });
			if (outcome?.isError) throw new Error("google_search failed");
			const content = outcome?.result?.content;
			const text = Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n") : "";
			const hits: SearchHit[] = [];
			const seen = new Set<string>();
			for (const m of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]{1,2000})\)/g)) {
				if (seen.has(m[2])) continue;
				seen.add(m[2]);
				hits.push({ title: m[1], url: m[2], summary: undefined, score: undefined });
				if (hits.length >= count) break;
			}
			if (hits.length === 0 && text.trim()) hits.push({ title: "Google evidence brief", url: "", summary: text.slice(0, 800) });
			return hits;
		},
	},
];

export const providerNames = PROVIDERS.map((p) => p.name);

function withSettings(ctx: ProviderCallCtx, settings: SearchToolsSettings): ProviderCallCtx & { settings: SearchToolsSettings } {
	return { ...ctx, settings };
}

export function providerChain(settings: SearchToolsSettings, ctx: ProviderCallCtx): SearchProvider[] {
	const full = withSettings(ctx, settings);
	const available = PROVIDERS.filter((p) => {
		if (p.needsKey) {
			try {
				resolveProviderKey(p.name, settings);
			} catch {
				return false;
			}
		}
		return p.available(full);
	});
	const requested = (settings.provider || "random").toLowerCase();
	if (requested !== "random" && requested !== "auto") {
		const first = available.find((p) => p.name === requested);
		return [...(first ? [first] : []), ...available.filter((p) => p !== first)];
	}
	return [...available].sort(() => Math.random() - 0.5);
}

// --- formatting ---------------------------------------------------------------

function scoreLabel(score?: number): string {
	return typeof score === "number" ? score.toFixed(2) : " --";
}

export function formatHits(provider: string, query: string, hits: SearchHit[]): string {
	const shown = hits.slice(0, MAX_RESULTS_TEXT);
	const lines = shown.map((h, i) => {
		const head = `${i + 1}. [${scoreLabel(h.score)}] ${h.title ?? "(untitled)"}`;
		const body = [h.url ?? "", h.summary || ""].filter(Boolean).map((l) => `   ${l}`);
		return [head, ...body].join("\n");
	});
	const note = hits.length > MAX_RESULTS_TEXT ? `\n(${hits.length - MAX_RESULTS_TEXT} more results omitted)` : "";
	return `Web search via ${provider}: "${query}" — ${hits.length} results\n\n${lines.join("\n\n")}${note}`;
}

/** Expanded body: full text, dimmed like built-ins, capped with a "more" marker. */
function expandedText(text: string, theme: any): string {
	const all = text.split("\n");
	const shown = all.slice(0, 200).map((l) => theme.fg("dim", l));
	if (all.length > 200) shown.push(theme.fg("muted", `... ${all.length - 200} more lines (ctrl+o or click to collapse)`));
	return shown.join("\n");
}

function elideText(text: string): { text: string; totalLines: number; elided: boolean } {
	const all = text.split("\n");
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	const bytes = Buffer.byteLength(text);
	if (all.length <= MAX_FETCH_LINES && bytes <= MAX_FETCH_BYTES)
		return { text, totalLines: all.length, elided: false };
	const marker = `... [${all.length - 2 * ELIDE_SIDE_LINES} of ${all.length} lines elided] ...`;
	return {
		text: `${all.slice(0, ELIDE_SIDE_LINES).join("\n")}\n${marker}\n${all.slice(-ELIDE_SIDE_LINES).join("\n")}`,
		totalLines: all.length,
		elided: true,
	};
}

// --- tools ---------------------------------------------------------------------

const searchParameters = Type.Object({
	query: Type.String({ description: "Web search query, 1-128 characters works best. Free text; provider-specific operators may apply." }),
	count: Type.Optional(Type.Number({ description: "Number of results, 1-50 (default 10)." })),
	provider: Type.Optional(
		Type.String({ description: `Force one provider: ${providerNames.join(", ")}. Default: settings provider or random with automatic failover.` }),
	),
});

const fetchParameters = Type.Object({
	url: Type.String({ description: "HTTP/HTTPS URL to fetch; returns title and body as Markdown." }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web through a pluggable provider aggregator (deepseek, brave, perplexity, searxng, antigravity). " +
			"Provider comes from the call, settings, or random with automatic failover. Normalized results: title, url, " +
			"summary, optional provider score. Billed per successful request on paid providers.",
		parameters: searchParameters,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (typeof query !== "string" || !query.trim()) throw new Error("query must be a non-empty string");
			const count = Math.min(Math.max(Math.round(typeof params.count === "number" ? params.count : 10), 1), 50);
			const settings = readSearchToolsSettings();
			if (typeof params.provider === "string" && params.provider.trim()) settings.provider = params.provider.trim();
			const toolNames = (ctx?.tools ?? []).map((t: any) => t?.name).filter(Boolean);
			const callCtx: ProviderCallCtx = {
				toolNames,
				executeTool: (name, args, options) => (ctx as any)?.executeTool?.(name, args, options),
			};
			const chain = providerChain(settings, callCtx);
			if (chain.length === 0) throw new Error("No search provider available (missing API keys and no google_search tool).");
			const attempts: { provider: string; ok: boolean; tookMs?: number; error?: string }[] = [];
			let served: string | undefined;
			let hits: SearchHit[] = [];
			for (const provider of chain) {
				const started = Date.now();
				try {
					hits = await provider.search(query, count, signal, withSettings(callCtx, settings));
					attempts.push({ provider: provider.name, ok: true, tookMs: Date.now() - started });
					served = provider.name;
					break;
				} catch (e) {
					attempts.push({ provider: provider.name, ok: false, tookMs: Date.now() - started, error: String((e as Error)?.message ?? e).slice(0, 200) });
				}
			}
			if (served === undefined) {
				throw new Error(`All search providers failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`);
			}
			const text = formatHits(served, query, hits);
			return {
				content: [{ type: "text" as const, text }],
				details: { provider: served, chain: attempts, resultCount: hits.length, query },
			};
		},
		renderCall(args, theme) {
			const line =
				theme.fg("toolTitle", theme.bold("web_search ")) +
				theme.fg("accent", `"${String(args.query ?? "")}"`) +
				theme.fg("muted", ` · ${typeof args.count === "number" ? args.count : 10} results${args.provider ? ` · ${String(args.provider)}` : ""}`);
			return {
				render(width: number) {
					return [truncateToWidth(line, width)];
				},
				invalidate() {},
			};
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "● searching…"), 0, 0);
			}
			const d = result.details as { provider?: string; resultCount?: number; chain?: { provider: string; ok: boolean }[] } | undefined;
			const served = d?.provider ?? "web";
			const skipped = (d?.chain ?? []).filter((a) => !a.ok).map((a) => a.provider);
			let summary = theme.fg("success", `✔ ${d?.resultCount ?? 0} results · ${served}`) +
				(skipped.length ? theme.fg("warning", ` (fell back from ${skipped.join(", ")})`) : "") +
				theme.fg("dim", " · ctrl+o to expand");
			const content = result.content?.[0] as { type?: string; text?: string } | undefined;
			const text = content?.type === "text" && content.text ? content.text : "";
			if (!expanded || !text) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${expandedText(text, theme)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch one web page and return its title and full body converted to Markdown (DeepSeek Fetch API). " +
			"HTTP/HTTPS URLs only; large pages are elided head+tail. Billed per successful request.",
		parameters: fetchParameters,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const url = typeof params.url === "string" ? params.url.trim() : "";
			if (!/^https?:\/\//.test(url)) throw new Error(`url must start with http:// or https:// — got: ${url.slice(0, 100)}`);
			const { key, source } = resolveProviderKey("deepseek", readSearchToolsSettings());
			const started = Date.now();
			const json = await request("https://api.deepseek.com/v1/tools/fetch", {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ url }),
			}, signal);
			const tookMs = Date.now() - started;
			const title = typeof json?.title === "string" ? json.title : "(untitled)";
			const content = typeof json?.content === "string" ? json.content : "";
			const { text, totalLines, elided } = elideText(content);
			const header = `DeepSeek fetch: ${title}\n${url} · ${content.length} chars · ${totalLines} lines${elided ? " · elided" : ""}\n`;
			return {
				content: [{ type: "text" as const, text: text.trim() ? header + "\n" + text : header }],
				details: { url, title, provider: "deepseek", keySource: source, tookMs, totalChars: content.length, totalLines, elided },
			};
		},
		renderCall(args, theme) {
			const line =
				theme.fg("toolTitle", theme.bold("web_fetch ")) +
				theme.fg("accent", String(args.url ?? ""));
			return {
				render(width: number) {
					return [truncateToWidth(line, width)];
				},
				invalidate() {},
			};
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "● fetching…"), 0, 0);
			}
			const d = result.details as { totalChars?: number; tookMs?: number } | undefined;
			const summary = theme.fg("success", `✔ ${d?.totalChars ?? 0} chars${d?.tookMs !== undefined ? ` · ${d.tookMs}ms` : ""}`) +
				theme.fg("dim", " · ctrl+o to expand");
			const content = result.content?.[0] as { type?: string; text?: string } | undefined;
			const text = content?.type === "text" && content.text ? content.text : "";
			if (!expanded || !text) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${expandedText(text, theme)}`, 0, 0);
		},
	});
}
