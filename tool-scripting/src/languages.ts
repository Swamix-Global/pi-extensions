/**
 * Language adapters for tool-scripting. Each adapter owns everything language
 * specific — parameter schema, tool description, source file, argv, display
 * formatting — while runner.ts owns the shared execution lifecycle (cwd,
 * timeout, abort, logging, elision). Adding a language = adding one adapter
 * here and wiring it in index.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";

export interface PreparedRun {
	sourceFile: string;
	argv: string[];
	env?: Record<string, string>;
	stdin?: string;
}

export type PrepareResult =
	| { kind: "ok"; run: PreparedRun }
	| { kind: "blocked"; reason: string }
	| { kind: "uv-missing" };

export interface CallBits {
	/** Muted hint segments for the call title (deps, interpreter, ...). */
	bits: string[];
	/** Timeout actually in force, for display and the wait-budget bar. */
	waitS: number;
}

export interface LanguageAdapter {
	id: string;
	toolName: string;
	toolDescription: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: ReturnType<typeof Type.Object>;
	/** Fallback wait budget when params.timeout is absent. */
	defaultWaitS: number;
	/** Hard ceiling for params.timeout. */
	maxWaitS: number;
	/** Model-facing status prefix, e.g. "[bash]". */
	prefix: string;
	/** Persist extra per-language fields into meta.json. */
	metaFields(params: Record<string, unknown>): Record<string, unknown>;
	/** Validate params and materialize the run: write the source file, return argv. */
	prepare(runDir: string, params: Record<string, unknown>): PrepareResult;
	/** Display-only source formatting (one entry per rendered line). */
	formatSource(source: string): string[];
	/** Muted title hints for the call view. */
	callBits(params: Record<string, unknown>): CallBits;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const CATASTROPHIC: Array<[RegExp, string]> = [
	[/rm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?\/(\s|$)/, "rm -rf /"],
	[/mkfs(\.\w+)?\s/, "mkfs (raw filesystem creation)"],
	[/dd\s+[^|]*of=\/dev\/(sd|nvme|hd)/, "dd to raw disk"],
	[/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/, "fork bomb"],
	[/chmod\s+-R\s+777\s+\/(\s|$)/, "chmod -R 777 /"],
];

export function denyReason(command: string): string | undefined {
	return CATASTROPHIC.find(([re]) => re.test(command))?.[1];
}

/**
 * Display-only re-layout for bash: put each top-level `;` / `&&` / `||`
 * segment on its own line, prefixed with its operator. The executed command is
 * never rewritten — this only affects the call view. Quotes, $(...), backticks,
 * escapes and heredoc bodies are tracked so separators inside them are left
 * untouched.
 */
export function formatBashSource(source: string): string[] {
	const out: string[] = [];
	const push = (segment: string, op: string) => {
		const text = segment.replace(/^\n+/, "").trim();
		if (!text) return;
		// Segments may span lines (heredocs, quoted newlines); emit each physical
		// line separately, with the operator prefix on the first line only.
		const parts = text.split("\n").filter((p) => p.trim());
		parts.forEach((part, i) => out.push(i === 0 && op ? `${op} ${part}` : part));
	};
	let buf = "";
	let op = "";
	let sQuote = false;
	let dQuote = false;
	let escape = false;
	let depth = 0;
	let heredoc: string | null = null;
	let lineBuf = "";

	const scanSegment = (text: string) => {
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (escape) {
				buf += c;
				escape = false;
				continue;
			}
			if (c === "\\" && !sQuote) {
				buf += c;
				escape = true;
				continue;
			}
			if (!dQuote && c === "'") {
				sQuote = !sQuote;
				buf += c;
				continue;
			}
			if (!sQuote && c === '"') {
				dQuote = !dQuote;
				buf += c;
				continue;
			}
			if (!sQuote && !dQuote && depth === 0) {
				if (c === ";") {
					push(buf, op);
					buf = "";
					op = ";";
					continue;
				}
				if ((c === "&" || c === "|") && text[i + 1] === c) {
					push(buf, op);
					buf = "";
					op = c === "&" ? "&&" : "||";
					i++;
					continue;
				}
			}
			if (!sQuote && !dQuote) {
				if (c === "$" && text[i + 1] === "(") {
					depth++;
					buf += "$(";
					i++;
					continue;
				}
				if (c === "`" || c === "(") {
					depth++;
					buf += c;
					continue;
				}
				if (c === ")" || c === "`") {
					depth = Math.max(0, depth - 1);
					buf += c;
					continue;
				}
			}
			buf += c;
		}
	};

	for (const line of source.split("\n")) {
		if (heredoc !== null) {
			lineBuf += `${line}\n`;
			if (line.trim() === heredoc) {
				buf += lineBuf;
				lineBuf = "";
				heredoc = null;
			}
			continue;
		}
		// A raw newline at depth 0 outside quotes separates commands too.
		scanSegment(`${line}\n`);
		if (!sQuote && !dQuote && !escape && depth === 0) {
			const heredocMatch = buf.match(/<<-?\s*['"]?(\w+)['"]?\s*\\?\n$/);
			if (heredocMatch) {
				heredoc = heredocMatch[1];
				lineBuf = "";
				continue;
			}
			push(buf, op);
			buf = "";
			op = "";
		}
	}
	buf += lineBuf;
	push(buf, op);
	return out;
}

const bashParameters = Type.Object({
	name: Type.String({
		description:
			"What this command is for, in 5 words or fewer — the display leads with it (e.g. 'build project', 'check test failures').",
	}),
	command: Type.String({
		description:
			"The bash command to run. May be a short sequence — ideally no more than 3 chained commands, " +
			"one per line. Separators (; && ||) are split onto their own display lines; the executed command is untouched.",
	}),
	directory: Type.Optional(
		Type.String({
			description:
				"Working directory for the command (default: current project directory). Shown as a hint in the display.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Seconds to wait before returning; default 60, hard cap 60. If the command is still running " +
				"at the deadline the call returns immediately without blocking, with a timeout report " +
				"(pid + log path + how to poll or stop it) while the process keeps running.",
		}),
	),
});

export const bashAdapter: LanguageAdapter = {
	id: "bash",
	toolName: "bash",
	prefix: "[bash]",
	defaultWaitS: 60,
	maxWaitS: 60,
	parameters: bashParameters,
	toolDescription:
		"Execute a bash command with live head+tail progress. Params: name (required, purpose in ≤5 words), " +
		"command (bash; one command per line, ideally ≤3 chained), directory (optional working dir, default " +
		"project dir), timeout (wait seconds, default 60, hard cap 60). The call returns within the wait: on " +
		"completion with the output (huge outputs elided head+tail, full log path included); if still running " +
		"at the deadline it returns immediately without blocking with the pid and log path — poll later with " +
		"`tail` on the log or stop with `kill <pid>`. Catastrophic commands (rm -rf /, mkfs, raw-disk dd, fork " +
		"bombs) are rejected. Each call is logged under <project>/.pi/scripting/bash/<date>-<slug>/ " +
		"{cmd.sh,out.log,meta.json}.",
	metaFields: (params) => ({ command: params.command }),
	prepare(runDir, params) {
		const command = typeof params.command === "string" ? params.command : "";
		if (!command.trim()) return { kind: "blocked", reason: "command must be a non-empty string" };
		const reason = denyReason(command);
		if (reason) return { kind: "blocked", reason };
		const sourceFile = path.join(runDir, "cmd.sh");
		fs.writeFileSync(sourceFile, `#!/usr/bin/env bash\n${command}\n`);
		return { kind: "ok", run: { sourceFile, argv: ["/usr/bin/env", "bash", sourceFile] } };
	},
	formatSource: (source) => formatBashSource(source),
	callBits(params) {
		return {
			bits: [],
			waitS: clampWait(params.timeout, bashAdapter.defaultWaitS, bashAdapter.maxWaitS),
		};
	},
};

// ---------------------------------------------------------------------------
// python
// ---------------------------------------------------------------------------

/** Resolve the uv binary: explicit env override, default user install, then PATH. */
export function uvBinary(): string {
	if (process.env.UV_BIN && fs.existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
	const user = path.join(os.homedir(), ".local", "bin", "uv");
	if (fs.existsSync(user)) return user;
	return "uv";
}

const pythonParameters = Type.Object({
	name: Type.String({
		description:
			"What this script is for, in 5 words or fewer — the display leads with it (e.g. 'parse benchmark json', 'migrate settings format').",
	}),
	code: Type.String({
		description:
			"The complete Python script source. It is written verbatim to script.py and executed by uv, " +
			"so include every import and statement it needs. Never wrap it in quotes or heredocs; the " +
			"parameter is raw source and the call view renders it with Python syntax highlighting.",
	}),
	deps: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional ephemeral dependencies resolved on the fly via `uv run --with` (PEP 508 names, " +
				'e.g. ["requests", "rich>=13"]). uv caches environments, so repeat runs are fast. ' +
				"Prefer the stdlib when it is enough; declare deps here instead of shelling out to pip.",
		}),
	),
	python: Type.Optional(
		Type.String({
			description: 'Optional interpreter version for `uv run --python` (e.g. "3.12"). Default: uv\'s default interpreter.',
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Optional string piped to the script's standard input." })),
	directory: Type.Optional(
		Type.String({ description: "Working directory for the script (default: current project directory)." }),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Seconds to wait before returning; default 60, hard cap 120 (uv dependency resolution on a cold " +
				"cache can take a while, so budget extra time when deps are declared). If the script is still " +
				"running at the deadline the call returns immediately without blocking, with the pid and log path.",
		}),
	),
});

export const pythonAdapter: LanguageAdapter = {
	id: "python",
	toolName: "python",
	prefix: "[python]",
	defaultWaitS: 60,
	maxWaitS: 120,
	parameters: pythonParameters,
	toolDescription:
		"Execute an arbitrary Python script on the fly under uv — the preferred Python path, ahead of bash. " +
		"This tool exists so that Python work never goes " +
		"through bash heredocs (`python3 - <<EOF`), which concatenate into unreadable terminal noise. " +
		"Params: name (required, purpose in ≤5 words), code (required, the complete raw Python source — " +
		"imports included; it is written to script.py and executed, never quoted or heredoc-wrapped), " +
		"deps (optional PEP 508 dependency list resolved ephemerally by `uv run --with`, cached across " +
		"runs), python (optional interpreter version such as \"3.12\" for `uv run --python`), stdin " +
		"(optional string piped to the script), directory (optional working directory, default project " +
		"dir), timeout (wait seconds, default 60, hard cap 120). Each call gets a run directory under " +
		"<project>/.pi/scripting/python/<id>/ holding script.py, out.log and meta.json, so every invocation is " +
		"reproducible and auditable after the fact. While waiting, stdout+stderr are streamed to the UI " +
		"as a live head/tail preview; on completion the full output is returned (huge outputs elided " +
		"head+tail with the full log path retained). A script still running at the deadline never blocks: " +
		"the call returns a timeout report with the pid, log path, and ready-made poll/stop commands " +
		"while the process keeps running. Bytecode writing is disabled so runs leave no __pycache__ " +
		"litter. Use this tool instead of bash whenever the work is Python: parsing JSON/YAML, computing " +
		"statistics over files, reformatting data, quick one-off migrations, batch edits too structured " +
		"for sed — anything where you would otherwise write python3 -c or a heredoc. Reach for bash only " +
		"when the task is genuinely shell-shaped (process management, pipes between OS tools, git/uv " +
		"CLI invocations).",
	promptSnippet:
		"Preferred way to run Python: uv-backed scripts with real syntax highlighting, ephemeral deps and bounded output.",
	promptGuidelines: [
		"Prefer the python tool over bash for every Python-shaped task — parsing JSON/YAML, statistics, data munging, migrations, batch edits too structured for sed, anything you would otherwise run as python3 -c or a heredoc. Bash stays for genuinely shell-shaped work: process management, pipes between OS tools, git/uv CLI.",
		"Never run Python through bash heredocs or inline -c flags; the concatenated output is unreadable and unbounded. Put the complete source in code, declare non-stdlib imports in deps (PEP 508, e.g. rich>=13) so uv resolves them ephemerally, and never pip install into the environment.",
	],
	metaFields: (params) => ({
		code: params.code,
		deps: Array.isArray(params.deps) ? params.deps : [],
		pythonVersion: typeof params.python === "string" ? params.python : undefined,
	}),
	prepare(runDir, params) {
		const code = typeof params.code === "string" ? params.code : "";
		if (!code.trim()) return { kind: "blocked", reason: "code must be a non-empty Python script" };
		const deps = Array.isArray(params.deps) ? params.deps.filter((d) => typeof d === "string" && String(d).trim()) : [];
		const pythonVersion = typeof params.python === "string" && params.python.trim() ? params.python.trim() : undefined;
		const uv = uvBinary();
		try {
			if (uv !== "uv") fs.accessSync(uv, fs.constants.X_OK);
		} catch {
			return { kind: "uv-missing" };
		}
		const sourceFile = path.join(runDir, "script.py");
		fs.writeFileSync(sourceFile, code.endsWith("\n") ? code : `${code}\n`);
		const argv = ["run", "--quiet", "--no-progress"];
		if (pythonVersion) argv.push("--python", pythonVersion);
		for (const dep of deps) argv.push("--with", String(dep));
		argv.push("python", sourceFile);
		return {
			kind: "ok",
			run: {
				sourceFile,
				argv: [uv, ...argv],
				env: { PYTHONDONTWRITEBYTECODE: "1" },
				stdin: typeof params.stdin === "string" ? params.stdin : undefined,
			},
		};
	},
	formatSource: (source) => source.split("\n"),
	callBits(params) {
		const bits: string[] = [];
		if (Array.isArray(params.deps) && params.deps.length) bits.push(`uv --with ${params.deps.join(", ")}`);
		if (typeof params.python === "string" && params.python.trim()) bits.push(`py ${params.python.trim()}`);
		return { bits, waitS: clampWait(params.timeout, pythonAdapter.defaultWaitS, pythonAdapter.maxWaitS) };
	},
};

export function clampWait(timeout: unknown, defaultWaitS: number, maxWaitS: number): number {
	return Math.min(Math.max(Math.round(typeof timeout === "number" ? timeout : defaultWaitS), 1), maxWaitS);
}

export const ADAPTERS: LanguageAdapter[] = [bashAdapter, pythonAdapter];
