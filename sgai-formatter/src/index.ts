/**
 * SGAI Formatter — consolidated clean-markdown.js + pretty-render.ts.
 * Clean Markdown with large/zoomed headings, boxed code blocks, plus bash tool
 * syntax highlighting and prose decoration.
 * Settings live in pi's shared settings.json under extensionSettings.formatter;
 * /settings:formatter toggles them and a change applies on /reload.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, visibleWidth, Text } from "@earendil-works/pi-tui";
import { extensionSettingsFilePath, hasExtensionSetting, readExtensionSettings, writeExtensionSettings } from "./extension-settings";

export const DEFAULT_FORMATTER_SETTINGS = { enabled: true } as const;

/** The shared settings file all extensions bind to: pi's own settings.json. */
export const settingsPath = extensionSettingsFilePath;

function readSettingsState(): { settings: { enabled: boolean }; source: "u" | "d" } {
	const enabled = readExtensionSettings("formatter").enabled;
	if (typeof enabled === "boolean") return { settings: { enabled }, source: "u" };
	return { settings: { enabled: DEFAULT_FORMATTER_SETTINGS.enabled }, source: "d" };
}

export function readSettings(): { enabled: boolean } {
	return readSettingsState().settings;
}

export function writeSettings(enabled: boolean): void {
	try {
		writeExtensionSettings("formatter", { enabled });
	} catch (error) {
		console.error(`[SETTINGS_FORMATTER_WRITE_FAILED]: ${error}`);
	}
}

function moduleEnabled(): boolean {
	return readSettings().enabled;
}

const DECORATIVE_TAGS = ["incident", "panel", "callout", "card", "artifact", "unit"];
const DECORATIVE_TAG_RE = new RegExp(`</?(?:${DECORATIVE_TAGS.join("|")})(?:\\s[^<>]*)?/?>`, "g");
const DECORATIVE_ENTITY_RE = new RegExp(`&lt;\\s*/?\\s*(?:${DECORATIVE_TAGS.join("|")})(?:\\s[^<>]*?)?/?\\s*&gt;`, "g");

function demoteDecorativeTags(line: string): string {
	return line
		.split(/(`+[^`]*`+)/)
		.map((segment) => (segment.startsWith("`") ? segment : segment.replace(DECORATIVE_ENTITY_RE, "").replace(DECORATIVE_TAG_RE, "")))
		.join("");
}

const ANSI = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
};

function colorizeStatusGlyphs(line: string): string {
	return line
		.replace(/(✓\s*PASS)/g, `${ANSI.green}${ANSI.bold}$1${ANSI.reset}`)
		.replace(/(✗\s*FAIL)/g, `${ANSI.red}${ANSI.bold}$1${ANSI.reset}`)
		.replace(/(⚠\s*WARNING)/g, `${ANSI.yellow}${ANSI.bold}$1${ANSI.reset}`)
		.replace(/(ℹ\s*INFO)/g, `${ANSI.cyan}$1${ANSI.reset}`);
}

function highlightSource(code: string, lang: string): string[] {
	if (!code) return [];
	const normalized = lang.trim().toLowerCase();
	if (normalized === "yaml" || normalized === "yml") return highlightYaml(code);
	try {
		return highlightCode(code, lang);
	} catch {
		return code.split("\n");
	}
}

// cli-highlight's yaml grammar paints whole lines one flat color (keys, values,
// comments alike), which reads as lost formatting. This line-oriented colorizer
// restores structure: keys, strings, numbers, literals, comments, punctuation.
const YAML_COLOR = {
	key: "\x1b[38;5;75m",
	string: "\x1b[38;5;114m",
	number: "\x1b[38;5;209m",
	literal: "\x1b[38;5;176m",
	punct: "\x1b[38;5;245m",
	comment: "\x1b[2m",
	reset: "\x1b[39m",
	dim: "\x1b[2m",
};

function yamlSpan(color: string, text: string): string {
	return `${color}${text}${YAML_COLOR.reset}`;
}

/** Color one scalar token (no quotes, no key colon): number, literal, or plain string. */
function yamlScalar(text: string): string {
	if (/^(true|false|null|~|yes|no|on|off)$/i.test(text)) return yamlSpan(YAML_COLOR.literal, text);
	if (/^[+-]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i.test(text))
		return yamlSpan(YAML_COLOR.number, text);
	return yamlSpan(YAML_COLOR.string, text);
}

/** Split "key: value" / "key:" at the first structural colon outside quotes. */
function yamlSplitKey(rest: string): { key: string; value: string } | undefined {
	let quote: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const ch = rest[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ":" && (i + 1 === rest.length || rest[i + 1] === " ")) {
			return { key: rest.slice(0, i + 1), value: rest.slice(i + 1) };
		}
	}
	return undefined;
}

/** Color a value segment: flow collections, quoted strings, scalars, trailing comments. */
function yamlValue(value: string): string {
	let out = "";
	let rest = value;
	const flowMatch = rest.match(/^(\s*)([\[{])([\s\S]*?)([\]}])(\s*)(#.*)?$/);
	if (flowMatch) {
		out += flowMatch[1];
		out += yamlSpan(YAML_COLOR.punct, flowMatch[2]);
		for (const part of flowMatch[3].split(/(,)/)) {
			const trimmed = part.trim();
			out += part === "," ? yamlSpan(YAML_COLOR.punct, ",") : part.length ? (trimmed ? yamlScalar(trimmed).replace(trimmed, yamlScalar(part.trim())) : part) : part;
			if (part === ",") continue;
		}
		out += yamlSpan(YAML_COLOR.punct, flowMatch[4]);
		out += flowMatch[5];
		if (flowMatch[6]) out += yamlSpan(YAML_COLOR.comment, flowMatch[6]);
		return out;
	}
	const trailing = rest.match(/^(\s)(#.*)$/);
	if (trailing) return yamlValue(rest.slice(0, trailing.index)) + yamlSpan(YAML_COLOR.comment, trailing[2]);
	const quoted = rest.match(/^(\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*)$/);
	if (quoted) return `${quoted[1]}${yamlSpan(YAML_COLOR.string, quoted[2])}${quoted[3]}`;
	const block = rest.match(/^(\s*)([|>][-+]?)(\s*)$/);
	if (block) return `${block[1]}${yamlSpan(YAML_COLOR.punct, block[2])}${block[3]}`;
	const lead = rest.match(/^\s*/);
	const core = rest.slice(lead?.[0].length ?? 0);
	return `${lead?.[0] ?? ""}${core ? yamlScalar(core) : ""}`;
}

/** Highlight one YAML line; `blockIndent` tracks | /> block-scalar bodies to leave them plain. */
function yamlLine(line: string, state: { blockIndent: number }): string {
	if (state.blockIndent > 0) {
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (line.trim() === "" || indent >= state.blockIndent) return line;
		state.blockIndent = 0;
	}
	if (line.trim() === "") return line;
	const comment = line.match(/^(\s*)(#.*)$/);
	if (comment) return `${comment[1]}${yamlSpan(YAML_COLOR.comment, comment[2])}`;
	const indent = line.match(/^\s*/)?.[0] ?? "";
	let rest = line.slice(indent.length);
	let prefix = "";
	const dash = rest.match(/^(-\s+)([\s\S]*)$/);
	if (dash) {
		prefix += yamlSpan(YAML_COLOR.punct, "-") + " ";
		rest = dash[2];
	}
	const split = yamlSplitKey(rest);
	if (split) {
		const keyText = split.key.replace(/:$/, "");
		const shown = split.key.endsWith(":") ? keyText : keyText;
		let out = prefix + yamlSpan(YAML_COLOR.key, shown) + yamlSpan(YAML_COLOR.punct, ":");
		const value = split.value;
		const blockScalar = value.match(/^(\s+)([|>][-+]?)(\s*)$/);
		if (blockScalar) {
			state.blockIndent = indent.length + 2;
			out += `${blockScalar[1]}${yamlSpan(YAML_COLOR.punct, blockScalar[2])}${blockScalar[3]}`;
		} else if (value.trim()) {
			out += yamlValue(value);
		}
		return out;
	}
	if (dash) return prefix + yamlValue(rest);
	if (/^[&*][\w-]+/.test(rest)) return indent + yamlSpan(YAML_COLOR.punct, rest);
	return indent + rest;
}

export function highlightYaml(code: string): string[] {
	const state = { blockIndent: 0 };
	return code.split("\n").map((line) => {
		try {
			return yamlLine(line, state);
		} catch {
			return line;
		}
	});
}

function formatCodeBlock(lines: string[], lang: string, availableWidth?: number): string {
	const rawCode = lines.join("\n");
	const highlightedLines = highlightSource(rawCode, lang);

	const terminalWidth =
		typeof availableWidth === "number" && Number.isFinite(availableWidth) && availableWidth > 0
			? Math.floor(availableWidth)
			: process.stdout?.columns && process.stdout.columns > 0
				? process.stdout.columns
				: 80;

	const targetBoxWidth = Math.max(4, terminalWidth - 2);
	const innerWidth = Math.max(1, targetBoxWidth - 4);

	const title = lang ? ` ${lang} ` : " ";
	const topBorderWidth = Math.max(0, targetBoxWidth - 3 - visibleWidth(title));
	const top = `${ANSI.dim}╭─${ANSI.reset}${ANSI.cyan}${title}${ANSI.reset}${ANSI.dim}${"─".repeat(topBorderWidth)}╮${ANSI.reset}`;
	const bottom = `${ANSI.dim}╰${"─".repeat(Math.max(0, targetBoxWidth - 2))}╯${ANSI.reset}`;

	const wrappedLines = highlightedLines.flatMap((line) => wrapTextWithAnsi(line, innerWidth));
	const body = wrappedLines.map((line) => {
		const vLen = visibleWidth(line);
		const padding = Math.max(0, innerWidth - vLen);
		return `${ANSI.dim}│${ANSI.reset} ${line}${" ".repeat(padding)} ${ANSI.dim}│${ANSI.reset}`;
	});

	return [top, ...body, bottom].join("\n");
}

export function formatMarkdown(markdown: string, ctx: { messageType?: string; availableWidth?: number } = {}): string {
	if (!markdown) return "";
	if (ctx?.messageType === "assistant-thinking") return markdown;
	const { availableWidth } = ctx;

	const lines = markdown.split("\n");
	const result: string[] = [];
	let inCodeBlock = false;
	let codeBlockLines: string[] = [];
	let codeBlockLang = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			if (!inCodeBlock) {
				inCodeBlock = true;
				codeBlockLang = trimmed.replace(/^[`~]{3,}/, "").trim();
				codeBlockLines = [];
			} else {
				inCodeBlock = false;
				const boxed = formatCodeBlock(codeBlockLines, codeBlockLang, availableWidth);
				result.push(boxed);
			}
			continue;
		}

		if (inCodeBlock) {
			codeBlockLines.push(line);
			continue;
		}

		// Idempotence: never re-decorate a code box this function already rendered.
		const bare = line.replace(/\x1b\[[0-9;]*m/g, "").trimStart();
		if (bare.startsWith("╭") || bare.startsWith("│") || bare.startsWith("╰")) {
			result.push(line);
			continue;
		}

		const h1Match = line.match(/^#\s+(.+)$/);
		if (h1Match) {
			const text = h1Match[1].trim();
			result.push(`\n━ ${ANSI.cyan}${ANSI.bold}${text.toUpperCase()}${ANSI.reset} ━`);
			continue;
		}

		const h2Match = line.match(/^##\s+(.+)$/);
		if (h2Match) {
			const text = h2Match[1].trim();
			result.push(`\n▸ ${ANSI.cyan}${ANSI.bold}${text}${ANSI.reset}`);
			continue;
		}

		const h3PlusMatch = line.match(/^#{3,6}\s+(.+)$/);
		if (h3PlusMatch) {
			const text = h3PlusMatch[1].trim();
			result.push(`• **${text}**`);
			continue;
		}

		result.push(decorateMarkdownLine(colorizeStatusGlyphs(demoteDecorativeTags(line))));
	}

	if (inCodeBlock) {
		const boxed = formatCodeBlock(codeBlockLines, codeBlockLang, availableWidth);
		result.push(boxed);
	}

	return result.join("\n");
}

const INTERP_LANG: Record<string, string> = {
	python: "python",
	python3: "python",
	node: "javascript",
	nodejs: "javascript",
	bun: "javascript",
	deno: "typescript",
	ruby: "ruby",
	perl: "perl",
};

const INLINE_CODE_RE =
	/\b(python3?|node|nodejs|bun|deno|ruby|perl)\b((?:[^'"\n]*?\s))((?:-c|--code|-e|--eval)\s*)(['"])([\s\S]*?)\4/g;

function hl(code: string, lang: string): string {
	if (!code) return "";
	try {
		return highlightCode(code, lang).join("\n");
	} catch {
		return code;
	}
}

export function highlightCommand(command: string): string {
	if (!command) return command;
	let out = "";
	let last = 0;
	for (const m of command.matchAll(INLINE_CODE_RE)) {
		const lang = INTERP_LANG[m[1]] ?? "javascript";
		const start = m.index ?? 0;
		out += hl(command.slice(last, start), "bash");
		out += hl(`${m[1]}${m[2]}${m[3]}`, "bash");
		out += `${m[4]}${hl(m[5], lang)}${m[4]}`;
		last = start + m[0].length;
	}
	return out + hl(command.slice(last), "bash");
}

const PATH_TOKEN = /(?:~\/|\.\/|\.\.\/|\/)?[\w.@+-]+(?:\/[\w.@+~-]+)+\/?/;
const FLAG_TOKEN = /(?<=\s)--?[A-Za-z][\w-]*/;
const NUMBER_TOKEN = /\b\d[\d,_]*(?:\.\d+)?(?:%|[A-Za-z]{1,3})?\b/;
const TOKEN_RE = new RegExp([PATH_TOKEN.source, FLAG_TOKEN.source, NUMBER_TOKEN.source].join("|"), "g");

export function decorateProseSpan(text: string): string {
	if (text.length < 2 || !/[\w/]/.test(text)) return text;
	const md = getMarkdownTheme();
	let out = "";
	let last = 0;
	const brackets = (s: string) => s.replace(/[()[\]{}]/g, (ch) => md.linkUrl(ch));
	for (const m of text.matchAll(TOKEN_RE)) {
		out += brackets(text.slice(last, m.index));
		const token = m[0];
		if (token.includes("/")) out += md.code(token);
		else if (/^--?[A-Za-z]/.test(token)) out += md.heading(token);
		else out += md.link(token);
		last = (m.index ?? 0) + token.length;
	}
	return out + brackets(text.slice(last));
}

// Protected spans pass through undecorated: inline code, markdown links/reference links,
// and bare http(s) URLs — ANSI injected inside a URL corrupts the markdown lexer's
// autolink and renders mangled duplicate links.
const PROTECT_RE = /(`+[^`]*`+|!\?\[[^\]]*\]\([^)]*\)|!\?\[[^\]]*\]\[[^\]]*\]|https?:\/\/[^\s<>\[\]()]+)/g;

function decorateMarkdownLine(line: string): string {
	if (!line.trim()) return line;
	const parts = line.split(PROTECT_RE);
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 0) parts[i] = decorateProseSpan(parts[i]);
	}
	return parts.join("");
}

export default function (pi: ExtensionAPI) {
	try {
		pi.registerCommand?.("settings:formatter", {
			description: "[u] (settings.json:extensionSettings.formatter) Formatter settings — markdown/bash rendering (/settings:formatter [on|off])",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const { settings, source } = readSettingsState();
				const tag = source === "u" ? "[u]" : "[d]";
				const arg = String(args ?? "").trim().toLowerCase();
				if (arg && !["on", "off", "toggle"].includes(arg)) {
					ctx.ui.notify(`Formatter: ${tag} ${settings.enabled ? "on" : "off"} — pass on, off or nothing`, "warning");
					return;
				}
				const enabled = arg === "on" ? true : arg === "off" ? false : !settings.enabled;
				if (enabled === settings.enabled) {
					ctx.ui.notify(`Formatter: ${tag} ${enabled ? "on" : "off"} — already`, "info");
					return;
				}
				writeSettings(enabled);
				ctx.ui.notify(`Formatter: [u] ${enabled ? "on" : "off"} — /reload to apply`, "info");
			},
		});
	} catch {}

	if (!moduleEnabled()) return;

	// One formatter for assistant messages and custom tool Markdown components.
	pi.registerMarkdownTransformer((markdown, ctx) => formatMarkdown(markdown, ctx));
	let disconnect = () => {};
	const connect = () => {
		disconnect();
		disconnect = pi.events.on("sgai:format-markdown", (data: unknown) => {
			const request = data as { markdown?: string; availableWidth?: number; messageType?: string; reply?: (text: string) => void } | null;
			if (typeof request?.markdown !== "string" || typeof request.reply !== "function") return;
			request.reply(formatMarkdown(request.markdown, request));
		});
	};
	connect();
	pi.on("session_start", connect);
	pi.on("session_shutdown", () => { disconnect(); disconnect = () => {}; });

	// pretty-render: bash tool renderer + prose decoration
	pi.registerToolRenderer((toolName, next) => {
		if (toolName === "bash") {
			const renderers = next() ?? {};
			return {
				...renderers,
				renderCall(args: any, theme: any, context: any) {
					const state = context.state as { startedAt?: number } | undefined;
					if (state && context.executionStarted && state.startedAt === undefined) {
						state.startedAt = Date.now();
					}
					let text = theme.fg("toolTitle", theme.bold("$ ")) + highlightCommand(args?.command ?? "");
					if (args?.timeout) text += theme.fg("dim", ` (timeout ${args.timeout}s)`);
					return new Text(text, 0, 0);
				},
			};
		}
		return next();
	});
}
