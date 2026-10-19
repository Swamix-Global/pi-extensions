// search-tools test suite. `node test-search-tools.mjs` runs the hermetic
// offline suite (no network, no billing). Add --live to also smoke the real
// APIs. agent dir override: first non-flag argument.
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const flags = process.argv.slice(2);
const agentDir = flags.find((a) => !a.startsWith("--")) || process.env.HOME + "/.pi/agent";
const REAL_HOME = process.env.HOME || os.homedir(); // captured before any test swaps HOME
const extFile = path.join(agentDir, "extensions", "search-tools", "index.ts");
const extUrl = pathToFileURL(extFile).href;
const mod = await createJiti(extUrl).import(extUrl);

const tools = {};
mod.default({ registerTool: (t) => (tools[t.name] = t) });
const search = tools.web_search;
const fetchTool = tools.web_fetch;
const baseCtx = { cwd: process.cwd(), tools: [] };

const fakeTheme = { fg: (_k, s) => s, bold: (s) => s };
const renderLines = (component, width = 120) => component.render(width).join("\n");
const fakeResult = (details, text) => ({ details, content: [{ type: "text", text }] });

// fetch mock with per-test registration and reliable teardown
let fetchMocks = [];
function setFetch(fn) {
	fetchMocks.push(mock.method(globalThis, "fetch", fn));
}
function restoreFetch() {
	fetchMocks.forEach((m) => m.mock.restore());
	fetchMocks = [];
}
const urlRouter = (routes) => async (url, init) => {
	for (const [match, respond] of Object.entries(routes)) {
		if (String(url).includes(match)) return respond(url, init);
	}
	throw new Error(`unexpected fetch: ${url}`);
};
const jsonResponse = (body, status = 200) => ({
	ok: status === 200,
	status,
	text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// --- temp home for key/settings isolation -------------------------------------

function makeHome(entries) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "st-"));
	fs.mkdirSync(path.join(tmp, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, ".pi", "agent", "settings.json"),
		JSON.stringify({ extensionSettings: { searchTools: entries.settings ?? {} } }),
	);
	fs.writeFileSync(path.join(tmp, ".pi", "agent", "auth.json"), JSON.stringify(entries.auth ?? {}));
	return tmp;
}

describe("resolveProviderKey chain", () => {
	let tmp;
	before(() => {
		delete process.env.BRAVE_API_KEY;
		tmp = makeHome({
			settings: { providers: { brave: { apiKey: "settings-brave" } } },
			auth: { deepseek: "auth-deepseek" },
		});
	});
	after(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("env wins over settings and auth.json", () => {
		process.env.BRAVE_API_KEY = "env-brave";
		const r = mod.resolveProviderKey("brave", {}, tmp);
		assert.equal(r.key, "env-brave");
		assert.equal(r.source, "env:BRAVE_API_KEY");
	});

	it("settings.providers fallback", () => {
		delete process.env.BRAVE_API_KEY;
		const settings = mod.readSearchToolsSettings(tmp);
		assert.equal(mod.resolveProviderKey("brave", settings, tmp).key, "settings-brave");
	});

	it("auth.json fallback (string form)", () => {
		assert.equal(mod.resolveProviderKey("deepseek", {}, tmp).key, "auth-deepseek");
	});

	it("missing key throws with provider name", () => {
		assert.throws(() => mod.resolveProviderKey("perplexity", {}, tmp), /perplexity/);
	});
});

describe("providerChain selection", () => {
	let emptyHome;
	before(() => {
		emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "st-empty-"));
		process.env.HOME = emptyHome;
	});
	after(() => {
		process.env.HOME = REAL_HOME;
		fs.rmSync(emptyHome, { recursive: true, force: true });
	});

	it("excludes providers without keys", () => {
		delete process.env.DEEPSEEK_API_KEY;
		delete process.env.BRAVE_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;
		const chain = mod.providerChain({}, { toolNames: [] }).map((p) => p.name);
		assert.deepEqual(chain, ["searxng"]);
	});

	it("settings.provider pins a provider first, rest as fallback", () => {
		const settings = { provider: "searxng", providers: { deepseek: { apiKey: "k" } } };
		const chain = mod.providerChain(settings, { toolNames: [] }).map((p) => p.name);
		assert.equal(chain[0], "searxng");
		assert.ok(chain.includes("deepseek"));
	});

	it("random covers all available providers", () => {
		const settings = { providers: { deepseek: { apiKey: "k" }, brave: { apiKey: "k" } } };
		const names = mod.providerChain(settings, { toolNames: [] }).map((p) => p.name);
		assert.equal(names.length, 3);
		assert.ok(names.every((n) => ["deepseek", "brave", "searxng"].includes(n)));
	});
});

describe("provider request shaping (mocked fetch)", () => {
	before(() => {
		process.env.DEEPSEEK_API_KEY = "ds-key";
		process.env.BRAVE_API_KEY = "br-key";
		process.env.PERPLEXITY_API_KEY = "pplx-key";
	});
	after(() => {
		delete process.env.DEEPSEEK_API_KEY;
		delete process.env.BRAVE_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;
	});

	it("deepseek: endpoint, auth, clamped count, abort signal", async () => {
		let captured;
		setFetch(async (url, init) => {
			captured = { url, init };
			return jsonResponse({ results: [{ title: "A", url: "https://a", rerank_score: 2.4, summary: "s" }] });
		});
		const r = await search.execute("t", { query: "q", count: 99, provider: "deepseek" }, undefined, undefined, baseCtx);
		restoreFetch();
		assert.equal(captured.url, "https://api.deepseek.com/v1/tools/search");
		assert.equal(captured.init.headers.Authorization, "Bearer ds-key");
		assert.deepEqual(JSON.parse(captured.init.body), { query: "q", count: 50, need_content: false });
		assert.ok(captured.init.signal instanceof AbortSignal);
		assert.equal(r.details.provider, "deepseek");
		assert.match(r.content[0].text, /\[2\.40\] A/);
	});

	it("brave: GET with subscription token, description → summary", async () => {
		let captured;
		setFetch(async (url, init) => {
			captured = { url, init };
			return jsonResponse({ web: { results: [{ title: "B", url: "https://b", description: "desc" }] } });
		});
		const r = await search.execute("t", { query: "q", provider: "brave" }, undefined, undefined, baseCtx);
		restoreFetch();
		assert.match(captured.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=q&count=10$/);
		assert.equal(captured.init.headers["X-Subscription-Token"], "br-key");
		assert.equal(r.details.provider, "brave");
		assert.match(r.content[0].text, /desc/);
	});

	it("perplexity: sonar model, answer + citations normalized", async () => {
		let captured;
		setFetch(async (url, init) => {
			captured = { url, init };
			return jsonResponse({ choices: [{ message: { content: "The answer." } }], citations: ["https://x.example/1"] });
		});
		const r = await search.execute("t", { query: "q", provider: "perplexity" }, undefined, undefined, baseCtx);
		restoreFetch();
		assert.equal(captured.url, "https://api.perplexity.ai/chat/completions");
		assert.equal(JSON.parse(captured.init.body).model, "sonar");
		const text = r.content[0].text;
		assert.match(text, /Perplexity answer/);
		assert.match(text, /The answer\./);
		assert.match(text, /x\.example/);
	});

	it("searxng: settings instance url, json format", async () => {
		let captured;
		setFetch(async (url) => {
			captured = { url };
			return jsonResponse({ results: [{ title: "S", url: "https://s", content: "c", score: 3.5 }] });
		});
		const home = makeHome({ settings: { searxngUrl: "https://searx.example/" } });
		process.env.HOME = home;
		const r = await search.execute("t", { query: "q", provider: "searxng" }, undefined, undefined, baseCtx);
		process.env.HOME = REAL_HOME;
		fs.rmSync(home, { recursive: true, force: true });
		restoreFetch();
		assert.equal(captured.url, "https://searx.example/search?q=q&format=json");
		assert.match(r.content[0].text, /\[3\.50\] S/);
	});

	it("antigravity: delegates to google_search, parses and dedupes links", async () => {
		const ctx = {
			...baseCtx,
			tools: [{ name: "google_search" }],
			executeTool: async () => ({
				isError: false,
				result: { content: [{ type: "text", text: "[Title A](https://a.example) [Title A](https://a.example) [Title B](https://b.example)" }] },
			}),
		};
		const r = await search.execute("t", { query: "q", provider: "antigravity" }, undefined, undefined, ctx);
		const text = r.content[0].text;
		assert.equal(r.details.provider, "antigravity");
		assert.match(text, /Title A/);
		assert.match(text, /Title B/);
		assert.equal(text.match(/a\.example/g)?.length, 1, "duplicate link must be deduped");
	});

	it("failover: first provider fails, next serves; chain records both", async () => {
		delete process.env.BRAVE_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;
		setFetch(
			urlRouter({
				"api.deepseek.com": async () => jsonResponse("boom", 500),
				"searx.example": async () => jsonResponse({ results: [{ title: "F", url: "https://f", content: "c" }] }),
			}),
		);
		const home = makeHome({ settings: { searxngUrl: "https://searx.example", provider: "deepseek", providers: { deepseek: { apiKey: "k" } } } });
		process.env.HOME = home;
		const r = await search.execute("t", { query: "q" }, undefined, undefined, baseCtx);
		process.env.HOME = REAL_HOME;
		fs.rmSync(home, { recursive: true, force: true });
		restoreFetch();
		assert.equal(r.details.provider, "searxng");
		assert.equal(r.details.chain.length, 2);
		assert.equal(r.details.chain[0].ok, false);
		assert.match(r.details.chain[0].error, /HTTP 500/);
		assert.match(r.content[0].text, /Web search via searxng/);
	});

	it("all providers failing throws an aggregated error", async () => {
		setFetch(async () => jsonResponse("down", 503));
		await assert.rejects(
			() => search.execute("t", { query: "q", provider: "searxng" }, undefined, undefined, baseCtx),
			/All search providers failed.*HTTP 503/s,
		);
		restoreFetch();
	});
});

describe("web_fetch", () => {
	after(() => {
		restoreFetch();
		delete process.env.DEEPSEEK_API_KEY;
	});

	it("rejects non-http urls before any request", async () => {
		await assert.rejects(() => fetchTool.execute("t", { url: "ftp://x/y" }, undefined, undefined, baseCtx), /http/);
	});

	it("elides large pages with a truthful marker", async () => {
		process.env.DEEPSEEK_API_KEY = "ds-key";
		setFetch(async () =>
			jsonResponse({ title: "T", content: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") }),
		);
		const r = await fetchTool.execute("t", { url: "https://example.com/big" }, undefined, undefined, baseCtx);
		restoreFetch();
		assert.equal(r.details.elided, true);
		assert.equal(r.details.totalLines, 500);
		const text = r.content[0].text;
		assert.match(text, /\[300 of 500 lines elided\]/);
		assert.ok(text.split("\n").length <= 205);
	});
});

describe("renderer contract (ctrl+o / click expansion)", () => {
	const searchResult = fakeResult({ provider: "deepseek", resultCount: 2, chain: [{ provider: "deepseek", ok: true }] }, "Web search via deepseek: q — 2 results\n1. [2.40] hit");
	it("collapsed is a single line naming the provider", () => {
		const line = renderLines(search.renderResult(searchResult, { expanded: false, isPartial: false }, fakeTheme));
		assert.equal(line.split("\n").length, 1);
		assert.match(line, /deepseek/);
	});
	it("expanded shows the full results", () => {
		assert.match(renderLines(search.renderResult(searchResult, { expanded: true, isPartial: false }, fakeTheme)), /hit/);
	});
	it("over-long bodies cap at 200 lines with marker", () => {
		const text = Array.from({ length: 260 }, (_, i) => `l${i}`).join("\n");
		assert.match(renderLines(search.renderResult(fakeResult({}, text), { expanded: true, isPartial: false }, fakeTheme)), /\.\.\. 60 more lines/);
	});
	it("partial renders progress, never the body", () => {
		const p = renderLines(search.renderResult(fakeResult({}, "SECRET"), { expanded: true, isPartial: true }, fakeTheme));
		assert.match(p, /searching/);
		assert.doesNotMatch(p, /SECRET/);
	});
	it("fallback is surfaced in the collapsed line", () => {
		const line = renderLines(
			search.renderResult(fakeResult({ provider: "searxng", resultCount: 1, chain: [{ provider: "deepseek", ok: false }, { provider: "searxng", ok: true }] }, "body"), { expanded: false, isPartial: false }, fakeTheme),
		);
		assert.match(line, /fell back from deepseek/);
	});
	const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

	it("renderCall stays within visible width (ellipsis suffix allowed)", () => {
		const c = search.renderCall({ query: "x".repeat(300), count: 10 }, fakeTheme);
		assert.ok(c.render(40).every((l) => visible(l) <= 43), `lines: ${JSON.stringify(c.render(40))}`);
	});
});

// --- live smoke (opt-in) --------------------------------------------------------

if (flags.includes("--live")) {
	describe("live API smoke", () => {
		it("random search serves through an available provider", async () => {
			const r = await search.execute("t", { query: "DeepSeek API documentation", count: 3 }, undefined, undefined, baseCtx);
			assert.ok(mod.providerNames.includes(r.details.provider), `unexpected provider ${r.details.provider}`);
			assert.ok(r.details.resultCount > 0, JSON.stringify(r.details));
			assert.match(r.content[0].text, /Web search via/);
		});
		it("fetch returns markdown", async () => {
			process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || mod.resolveProviderKey("deepseek").key;
			const r = await fetchTool.execute("t", { url: "https://example.com" }, undefined, undefined, baseCtx);
			assert.ok(r.details.totalChars > 0);
		});
	});
}

console.log(`search-tools suite: node:test (offline hermetic; --live adds API smoke; providers: ${mod.providerNames.join(",")})`);
