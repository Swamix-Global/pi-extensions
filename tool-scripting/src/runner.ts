/**
 * Shared execution lifecycle for every tool-scripting language adapter.
 *
 * The runner owns the wrapper concerns so adapters stay declarative: working
 * directory, wait budget, non-blocking timeout handoff, abort with process
 * group teardown, per-run logging under <cwd>/.pi/scripting/<language>/<id>/,
 * live head/tail previews through onUpdate partials, and the 64 KiB cap on
 * model-visible output. Timeout never kills the work: the call returns at the
 * deadline with pid, log path and ready-made poll/stop commands while the
 * process keeps running.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { boundText, TOOL_OUTPUT_BYTES } from "./output-budget.ts";
import { clampWait, type LanguageAdapter } from "./languages.ts";

const POLL_MS = 100;
/** Fire the timeout handoff slightly before the host enforces the declared
 *  timeout, so the wrapper always returns the rich pid/kill/poll result. */
const TIMEOUT_LEAD_MS = 400;
const UI_INTERVAL_MS = 1000;
const PREVIEW_BYTES = 4096;
const KEEP_LINES = 5;
const VERBATIM_LINES = 200;
const VERBATIM_BYTES = TOOL_OUTPUT_BYTES - 4096; // room for status and retrieval metadata
const ELIDE_SIDE_LINES = 100;

export interface ScriptDetails {
	status: "running" | "done" | "timeout" | "aborted" | "blocked" | "uv-missing";
	language: string;
	name: string;
	directory: string;
	waitS: number;
	run: string;
	log: string;
	sourceFile?: string;
	pid?: number;
	exit?: number;
	signal?: string;
	elapsedS?: number;
	head: string[];
	tail: string[];
	totalLines: number;
	elided?: boolean;
}

export interface AgentToolResultLike {
	content: Array<{ type: "text"; text: string }>;
	details?: ScriptDetails;
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.slice(0, 5)
			.join("-")
			.slice(0, 40) || "run"
	);
}

export function expandDir(dir: string): string {
	if (dir === "~") return os.homedir();
	if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
	return path.resolve(dir);
}

/** Incremental log watcher: head-5 once, running line count, fresh tail-5 per poll. */
export function makeLogWatcher(logPath: string) {
	let pos = 0;
	let totalLines = 0;
	let head: string[] = [];
	const read = (offset: number, length: number): string => {
		const fd = fs.openSync(logPath, "r");
		try {
			const buf = Buffer.alloc(length);
			fs.readSync(fd, buf, 0, length, offset);
			return buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	};
	const lines = (chunk: string): string[] => chunk.split("\n").map((l) => l.replace(/\r$/, ""));
	return function poll(): { head: string[]; tail: string[]; totalLines: number } {
		let bytes = 0;
		try {
			bytes = fs.statSync(logPath).size;
		} catch {
			return { head, tail: [], totalLines };
		}
		if (pos === 0 && bytes > 0) head = lines(read(0, Math.min(bytes, PREVIEW_BYTES))).filter(Boolean).slice(0, KEEP_LINES);
		while (bytes > pos) {
			const length = Math.min(bytes - pos, VERBATIM_BYTES);
			const chunk = read(pos, length);
			totalLines += (chunk.match(/\n/g) ?? []).length;
			pos += length;
		}
		let tail: string[] = [];
		if (bytes > 0) {
			const start = Math.max(0, bytes - PREVIEW_BYTES);
			tail = lines(read(start, bytes - start)).filter((l) => l !== "").slice(-KEEP_LINES);
		}
		return { head, tail, totalLines };
	};
}

export function elideLog(logPath: string): { text: string; totalLines: number; elided: boolean } {
	const fd = fs.openSync(logPath, "r");
	try {
		const bytes = fs.fstatSync(fd).size;
		const buffer = Buffer.alloc(VERBATIM_BYTES);
		let totalLines = 0;
		let lastByte = -1;
		for (let pos = 0; pos < bytes;) {
			const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - pos), pos);
			if (!count) break;
			for (let i = 0; i < count; i++) if (buffer[i] === 10) totalLines++;
			lastByte = buffer[count - 1];
			pos += count;
		}
		if (lastByte !== -1 && lastByte !== 10) totalLines++;
		const sample = (start: number, length: number) => {
			const count = fs.readSync(fd, buffer, 0, length, start);
			let first = 0;
			if (start > 0) while (first < count && (buffer[first] & 0xc0) === 0x80) first++;
			return new TextDecoder().decode(buffer.subarray(first, count), { stream: start + count < bytes });
		};
		if (bytes <= VERBATIM_BYTES && totalLines <= VERBATIM_LINES) {
			const raw = sample(0, bytes).replace(/\n$/, "");
			const text = boundText(raw, VERBATIM_BYTES, `\n… [decoded output truncated; full log: ${logPath}] …\n`);
			return { text, totalLines, elided: text !== raw };
		}
		const head = sample(0, Math.min(bytes, VERBATIM_BYTES)).split("\n").slice(0, ELIDE_SIDE_LINES).join("\n");
		const tail = sample(Math.max(0, bytes - VERBATIM_BYTES), Math.min(bytes, VERBATIM_BYTES)).replace(/\n$/, "").split("\n").slice(-ELIDE_SIDE_LINES).join("\n");
		const omitted = Math.max(0, totalLines - 2 * ELIDE_SIDE_LINES);
		const marker = `\n... [${omitted} of ${totalLines} lines elided; ${bytes} bytes total; full log: ${logPath}] ...\n`;
		return { text: boundText(`${head}${marker}${tail}`, VERBATIM_BYTES, marker), totalLines, elided: true };
	} finally {
		fs.closeSync(fd);
	}
}

function now(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function killTree(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

const blockedDetails = (adapter: LanguageAdapter, name: string): ScriptDetails => ({
	status: "blocked",
	language: adapter.id,
	name,
	directory: "",
	waitS: 0,
	run: "",
	log: "",
	head: [],
	tail: [],
	totalLines: 0,
});

/**
 * Run one script through the shared lifecycle. `params` is the raw tool call
 * payload; adapters validate and materialize the language-specific run.
 */
export async function runScript(
	adapter: LanguageAdapter,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResultLike) => void) | undefined,
	ctx: { cwd?: string } | undefined,
): Promise<AgentToolResultLike> {
	const name = typeof params.name === "string" ? params.name.trim() : "";
	if (!name) throw new Error("name is required: what is this run for, in ≤5 words");

	const defaultDir = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
	const directory = expandDir(
		typeof params.directory === "string" && params.directory.trim() ? params.directory : defaultDir,
	);
	if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
		throw new Error(`directory does not exist or is not a directory: ${directory}`);
	const waitS = clampWait(params.timeout, adapter.defaultWaitS, adapter.maxWaitS);

	// Materialize the run directory and the language-specific source/argv.
	const slug = slugify(name);
	const runsDir = path.join(directory, ".pi", "scripting", adapter.id);
	fs.mkdirSync(runsDir, { recursive: true });
	let run = `${now()}-${slug}`;
	for (let i = 2; fs.existsSync(path.join(runsDir, run)); i++) run = `${now()}-${slug}-${i}`;
	const runDir = path.join(runsDir, run);
	fs.mkdirSync(runDir, { recursive: true });

	const prepared = adapter.prepare(runDir, params);
	if (prepared.kind === "blocked") {
		return {
			content: [{ type: "text", text: `${adapter.prefix} blocked: ${prepared.reason}` }],
			details: blockedDetails(adapter, name),
		};
	}
	if (prepared.kind === "uv-missing") {
		return {
			content: [
				{
					type: "text",
					text:
						`${adapter.prefix} uv not found. Install it (curl -LsSf https://astral.sh/uv/install.sh | sh) ` +
						"or set UV_BIN to the uv binary, then retry.",
				},
			],
			details: { ...blockedDetails(adapter, name), status: "uv-missing" },
		};
	}

	const { sourceFile, argv, env, stdin } = prepared.run;
	const logPath = path.join(runDir, "out.log");
	const metaPath = path.join(runDir, "meta.json");
	const outputText = (text: string) => boundText(text, TOOL_OUTPUT_BYTES, `\n… [output truncated; full log: ${logPath}] …\n`);
	const writeMeta = (patch: Partial<ScriptDetails> & Record<string, unknown>) =>
		fs.writeFileSync(metaPath, JSON.stringify({ run, name, directory, waitS, ...adapter.metaFields(params), ...patch }, null, 2));

	const logFd = fs.openSync(logPath, "a");
	const child = spawn(argv[0], argv.slice(1), {
		cwd: directory,
		detached: true,
		env: env ? { ...process.env, ...env } : process.env,
		stdio: [stdin === undefined ? "ignore" : "pipe", logFd, logFd],
	});
	fs.closeSync(logFd);
	if (stdin !== undefined) {
		child.stdin!.on("error", () => {});
		child.stdin!.end(stdin);
	}
	const pid = child.pid;
	writeMeta({ status: "running", pid, log: logPath, sourceFile });

	const started = Date.now();
	const pollLog = makeLogWatcher(logPath);
	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
	let exit: number | undefined;
	let exitSignal: string | undefined;
	let spawnError: Error | undefined;
	let aborted = false;
	child.on("exit", (code, sig) => {
		exit = code ?? -1;
		exitSignal = sig ?? undefined;
	});
	child.on("error", (err) => {
		spawnError = err;
	});
	const onAbort = () => {
		aborted = true;
	};
	signal?.addEventListener("abort", onAbort);

	const baseDetails = (): ScriptDetails => ({
		status: "running",
		language: adapter.id,
		name,
		directory,
		waitS,
		run,
		log: logPath,
		sourceFile,
		pid,
		head: [],
		tail: [],
		totalLines: 0,
	});

	try {
		let lastUi = 0;
		while (exit === undefined && spawnError === undefined && !aborted) {
			if (Date.now() - started >= Math.max(200, waitS * 1000 - TIMEOUT_LEAD_MS)) {
				const preview = pollLog();
				const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
				writeMeta({ status: "timeout", pid, log: logPath, elapsedS });
				const tailText = preview.tail.join("\n");
				return {
					content: [
						{
							type: "text",
							text: outputText(
								`${adapter.prefix} timed out waiting after ${waitS}s — "${name}" is still running (pid ${pid}).\n` +
								`log: ${logPath}\n` +
								`poll: bash { name: "check ${slug}", command: "tail -n 200 '${logPath}'", timeout: 10 }\n` +
								`stop: bash { name: "stop ${slug}", command: "kill ${pid}" }\n` +
								(tailText ? `\n${tailText}` : "")),
						},
					],
					details: {
						...baseDetails(),
						status: "timeout",
						elapsedS,
						head: preview.head,
						tail: preview.tail,
						totalLines: preview.totalLines,
					},
				};
			}
			if (Date.now() - lastUi >= UI_INTERVAL_MS) {
				lastUi = Date.now();
				const preview = pollLog();
				const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
				onUpdate?.({
					content: [{ type: "text", text: outputText(`${adapter.prefix} ${name} — running ${Math.round(elapsedS)}s`) }],
					details: { ...baseDetails(), elapsedS, head: preview.head, tail: preview.tail, totalLines: preview.totalLines },
				});
			}
			await wait(POLL_MS);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	if (aborted && exit === undefined) {
		if (pid) {
			killTree(pid);
			for (let i = 0; i < 10 && exit === undefined; i++) await wait(200);
			if (exit === undefined) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				for (let i = 0; i < 10 && exit === undefined; i++) await wait(200);
			}
		}
		const preview = pollLog();
		writeMeta({ status: "aborted", pid, log: logPath });
		return {
			content: [{ type: "text", text: outputText(`${adapter.prefix} aborted — killed "${name}" (pid ${pid}).\nlog: ${logPath}`) }],
			details: { ...baseDetails(), status: "aborted", head: preview.head, tail: preview.tail, totalLines: preview.totalLines },
		};
	}
	if (spawnError) throw new Error(`failed to start ${adapter.id} run: ${spawnError.message}`);

	const preview = pollLog();
	const { text, totalLines, elided } = elideLog(logPath);
	const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
	writeMeta({ status: "done", pid, log: logPath, exit, elapsedS, signal: exitSignal, totalLines });
	const statusLine = `${adapter.prefix} done exit=${exit}${exitSignal ? ` (${exitSignal})` : ""} · ${elapsedS}s · "${name}"`;
	return {
		content: [{ type: "text", text: outputText(text.trim() ? `${statusLine}\n${text}` : statusLine) }],
		details: {
			...baseDetails(),
			status: "done",
			exit,
			signal: exitSignal,
			elapsedS,
			head: preview.head,
			tail: preview.tail,
			totalLines,
			elided,
		},
	};
}
