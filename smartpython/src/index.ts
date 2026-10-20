/**
 * smartpython — uv-based, display-first Python executor for Pi.
 *
 * Registers the "python" tool and MUST be preferred over bash for any Python
 * work:
 * - name      purpose of the script in ≤5 words; the display leads with it
 * - code      the full Python source; rendered with real syntax highlighting
 *             in the call view (python language detection is implicit)
 * - deps      optional ephemeral dependencies, resolved on the fly by
 *             `uv run --with <dep>` (e.g. ["requests", "rich>=13"])
 * - python    optional interpreter version for `uv run --python` (e.g. "3.12")
 * - stdin     optional string piped to the script's stdin
 * - directory optional working directory (default: project dir)
 * - timeout   seconds to wait; default 60, hard cap 120. Still running at the
 *             deadline → the call returns at once with a timeout report (pid,
 *             log path, poll/stop commands) while the process keeps running.
 *
 * Every call gets a run directory <project>/.pi/smartpython/<id>/ with
 * script.py, out.log and meta.json. Output handling mirrors smartbash: live
 * head/tail preview while running, head+tail elision for huge outputs, full
 * log always on disk. `PYTHONDONTWRITEBYTECODE=1` keeps runs side-effect
 * free; uv caches resolved environments so repeat deps are fast.
 *
 * Toggle via /settings:smartpython on|off (settings.json:extensionSettings.smartPython).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import { boundText, TOOL_OUTPUT_BYTES } from "./output-budget.ts";

const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 120;
const POLL_MS = 500;
const UI_INTERVAL_MS = 1000;
const PREVIEW_BYTES = 4096;
const KEEP_LINES = 5;
const VERBATIM_LINES = 200;
const VERBATIM_BYTES = TOOL_OUTPUT_BYTES - 4096;
const ELIDE_SIDE_LINES = 100;
const CALL_CODE_LINES = 40;

export interface SmartPythonDetails {
	status: "running" | "done" | "timeout" | "aborted" | "uv-missing";
	name: string;
	directory: string;
	waitS: number;
	run: string;
	log: string;
	script: string;
	deps: string[];
	pythonVersion?: string;
	pid?: number;
	exit?: number;
	signal?: string;
	elapsedS?: number;
	head: string[];
	tail: string[];
	totalLines: number;
	elided?: boolean;
}

export function readSmartPythonSettings(): { enabled: boolean } {
	const enabled = readExtensionSettings("smartPython").enabled;
	return { enabled: typeof enabled === "boolean" ? enabled : true };
}

export function writeSmartPythonSettings(enabled: boolean): boolean {
	try {
		writeExtensionSettings("smartPython", { enabled });
		return true;
	} catch {
		return false;
	}
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

/** Resolve the uv binary: explicit env override, default user install, then PATH. */
export function uvBinary(): string {
	if (process.env.UV_BIN && fs.existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
	const user = path.join(os.homedir(), ".local", "bin", "uv");
	if (fs.existsSync(user)) return user;
	return "uv";
}

function highlightPython(code: string): string[] {
	try {
		return highlightCode(code, "python");
	} catch {
		return code.split("\n");
	}
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

function shortenHome(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
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
				"e.g. [\"requests\", \"rich>=13\"]). uv caches environments, so repeat runs are fast. " +
				"Prefer the stdlib when it is enough; declare deps here instead of shelling out to pip.",
		}),
	),
	python: Type.Optional(
		Type.String({
			description: "Optional interpreter version for `uv run --python` (e.g. \"3.12\"). Default: uv's default interpreter.",
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

const TOOL_DESCRIPTION =
	"Execute an arbitrary Python script on the fly under uv, with the source rendered as real " +
	"syntax-highlighted Python in the transcript. This tool exists so that Python work never goes " +
	"through bash heredocs (`python3 - <<EOF`), which concatenate into unreadable terminal noise. " +
	"Params: name (required, purpose in ≤5 words), code (required, the complete raw Python source — " +
	"imports included; it is written to script.py and executed, never quoted or heredoc-wrapped), " +
	"deps (optional PEP 508 dependency list resolved ephemerally by `uv run --with`, cached across " +
	"runs), python (optional interpreter version such as \"3.12\" for `uv run --python`), stdin " +
	"(optional string piped to the script), directory (optional working directory, default project " +
	"dir), timeout (wait seconds, default 60, hard cap 120). Each call gets a run directory under " +
	"<project>/.pi/smartpython/<id>/ holding script.py, out.log and meta.json, so every invocation is " +
	"reproducible and auditable after the fact. While waiting, stdout+stderr are streamed to the UI " +
	"as a live head/tail preview; on completion the full output is returned (huge outputs elided " +
	"head+tail with the full log path retained). A script still running at the deadline never blocks: " +
	"the call returns a timeout report with the pid, log path, and ready-made poll/stop commands " +
	"while the process keeps running. Bytecode writing is disabled so runs leave no __pycache__ " +
	"litter. Use this tool instead of bash whenever the work is Python: parsing JSON/YAML, computing " +
	"statistics over files, reformatting data, quick one-off migrations, batch edits too structured " +
	"for sed — anything where you would otherwise write python3 -c or a heredoc. Reach for bash only " +
	"when the task is genuinely shell-shaped (process management, pipes between OS tools, git/uv " +
	"CLI invocations). Catastrophic commands are not applicable here, but the same discipline " +
	"applies: target explicit paths, never operate blindly on /.";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("settings:smartpython", {
		description: "Toggle the smartpython tool: /settings:smartpython [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeSmartPythonSettings(arg === "on");
				ctx.ui.notify(`smartpython is now ${arg}. Run /reload to apply.`, "info");
			} else {
				const current = readSmartPythonSettings().enabled ? "on" : "off";
				ctx.ui.notify(`smartpython is currently ${current}. Use '/settings:smartpython on|off' to toggle.`, "info");
			}
		},
	});

	if (!readSmartPythonSettings().enabled) return;

	pi.registerTool({
		name: "python",
		label: "smartpython",
		description: TOOL_DESCRIPTION,
		parameters: pythonParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const code = typeof params.code === "string" ? params.code : "";
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!code.trim()) throw new Error("code must be a non-empty Python script");
			if (!name) throw new Error("name is required: what is this script for, in ≤5 words");
			const deps = Array.isArray(params.deps) ? params.deps.filter((d) => typeof d === "string" && d.trim()) : [];
			const pythonVersion = typeof params.python === "string" && params.python.trim() ? params.python.trim() : undefined;
			const stdinData = typeof params.stdin === "string" ? params.stdin : undefined;

			const defaultDir = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
			const directory = expandDir(
				typeof params.directory === "string" && params.directory.trim() ? params.directory : defaultDir,
			);
			if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
				throw new Error(`directory does not exist or is not a directory: ${directory}`);
			const waitS = Math.min(Math.max(Math.round(typeof params.timeout === "number" ? params.timeout : DEFAULT_WAIT_S), 1), MAX_WAIT_S);

			const uv = uvBinary();
			try {
				if (uv !== "uv") fs.accessSync(uv, fs.constants.X_OK);
			} catch {
				const details: SmartPythonDetails = {
					status: "uv-missing", name, directory, waitS, run: "", log: "", script: "", deps,
					pythonVersion, head: [], tail: [], totalLines: 0,
				};
				return {
					content: [{
						type: "text" as const,
						text:
							"[smartpython] uv not found. Install it (curl -LsSf https://astral.sh/uv/install.sh | sh) " +
							"or set UV_BIN to the uv binary, then retry.",
					}],
					details,
				};
			}

			const slug = slugify(name);
			const runsDir = path.join(directory, ".pi", "smartpython");
			fs.mkdirSync(runsDir, { recursive: true });
			let run = `${now()}-${slug}`;
			for (let i = 2; fs.existsSync(path.join(runsDir, run)); i++) run = `${now()}-${slug}-${i}`;
			const runDir = path.join(runsDir, run);
			fs.mkdirSync(runDir, { recursive: true });
			const logPath = path.join(runDir, "out.log");
			const scriptPath = path.join(runDir, "script.py");
			const metaPath = path.join(runDir, "meta.json");
			const outputText = (text: string) => boundText(text, TOOL_OUTPUT_BYTES, `\n… [output truncated; full log: ${logPath}] …\n`);
			fs.writeFileSync(scriptPath, code.endsWith("\n") ? code : `${code}\n`);
			const writeMeta = (patch: Partial<SmartPythonDetails> & Record<string, unknown>) =>
				fs.writeFileSync(metaPath, JSON.stringify({ run, name, deps, pythonVersion, directory, waitS, ...patch }, null, 2));

			const args = ["run", "--quiet", "--no-progress"];
			if (pythonVersion) args.push("--python", pythonVersion);
			for (const dep of deps) args.push("--with", dep);
			args.push("python", scriptPath);

			const logFd = fs.openSync(logPath, "a");
			const child = spawn(uv, args, {
				cwd: directory,
				detached: true,
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
				stdio: [stdinData === undefined ? "ignore" : "pipe", logFd, logFd],
			});
			fs.closeSync(logFd);
			if (stdinData !== undefined) {
				child.stdin!.on("error", () => {});
				child.stdin!.end(stdinData);
			}
			const pid = child.pid;
			writeMeta({ status: "running", pid, log: logPath });

			const started = Date.now();
			const pollLog = makeLogWatcher(logPath);
			const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
			let exit: number | undefined;
			let exitSignal: string | undefined;
			let spawnError: Error | undefined;
			let aborted = false;
			child.on("exit", (exitCode, sig) => {
				exit = exitCode ?? -1;
				exitSignal = sig ?? undefined;
			});
			child.on("error", (err) => {
				spawnError = err;
			});
			const onAbort = () => {
				aborted = true;
			};
			signal?.addEventListener("abort", onAbort);

			try {
				let lastUi = 0;
				while (exit === undefined && spawnError === undefined && !aborted) {
					if (Date.now() - started >= waitS * 1000) {
						const preview = pollLog();
						const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
						writeMeta({ status: "timeout", pid, log: logPath, elapsedS });
						const tailText = preview.tail.join("\n");
						return {
							content: [{
								type: "text" as const,
								text: outputText(
									`[smartpython] timed out waiting after ${waitS}s — "${name}" is still running (pid ${pid}).\n` +
									`log: ${logPath}\n` +
									`poll: bash { name: "check ${slug}", command: "tail -n 200 '${logPath}'", timeout: 10 }\n` +
									`stop: bash { name: "stop ${slug}", command: "kill ${pid}" }\n` +
									(tailText ? `\n${tailText}` : "")),
							}],
							details: {
								status: "timeout", name, directory, waitS, run, log: logPath, script: scriptPath, deps,
								pythonVersion, pid, elapsedS, head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
							} as SmartPythonDetails,
						};
					}
					if (Date.now() - lastUi >= UI_INTERVAL_MS) {
						lastUi = Date.now();
						const preview = pollLog();
						onUpdate?.({
							content: [{ type: "text" as const, text: outputText(`[smartpython] ${name} — running ${Math.round((Date.now() - started) / 1000)}s`) }],
							details: {
								status: "running", name, directory, waitS, run, log: logPath, script: scriptPath, deps,
								pythonVersion, pid, elapsedS: Number(((Date.now() - started) / 1000).toFixed(1)),
								head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
							} as SmartPythonDetails,
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
					content: [{ type: "text" as const, text: outputText(`[smartpython] aborted — killed "${name}" (pid ${pid}).\nlog: ${logPath}`) }],
					details: {
						status: "aborted", name, directory, waitS, run, log: logPath, script: scriptPath, deps, pythonVersion, pid,
						head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
					} as SmartPythonDetails,
				};
			}
			if (spawnError) throw new Error(`failed to start uv: ${spawnError.message}`);

			const preview = pollLog();
			const { text, totalLines, elided } = elideLog(logPath);
			const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
			writeMeta({ status: "done", pid, log: logPath, exit, elapsedS, signal: exitSignal, totalLines });
			const statusLine = `[smartpython] done exit=${exit}${exitSignal ? ` (${exitSignal})` : ""} · ${elapsedS}s · "${name}"`;
			return {
				content: [{ type: "text" as const, text: outputText(text.trim() ? `${statusLine}\n${text}` : statusLine) }],
				details: {
					status: "done", name, directory, waitS, run, log: logPath, script: scriptPath, deps, pythonVersion,
					pid, exit, signal: exitSignal, elapsedS, head: preview.head, tail: preview.tail, totalLines, elided,
				} as SmartPythonDetails,
			};
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("smartpython ")) + theme.fg("accent", args.name ?? "");
			const bits: string[] = [];
			if (Array.isArray(args.deps) && args.deps.length) bits.push(theme.fg("muted", `uv --with ${args.deps.join(", ")}`));
			if (typeof args.python === "string" && args.python.trim()) bits.push(theme.fg("muted", `py ${args.python.trim()}`));
			bits.push(theme.fg("muted", `${typeof args.timeout === "number" ? Math.min(args.timeout, MAX_WAIT_S) : DEFAULT_WAIT_S}s`));
			const lines = [`${title} ${bits.join(theme.fg("muted", " · "))}`];
			const code = String(args.code ?? "");
			const all = highlightPython(code);
			for (const l of all.slice(0, CALL_CODE_LINES)) lines.push(`  ${l}`);
			if (all.length > CALL_CODE_LINES) lines.push(theme.fg("muted", `  … ${all.length - CALL_CODE_LINES} more lines (script.py on disk)`));
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = (result.details ?? {}) as Partial<SmartPythonDetails>;
			const lines: string[] = [];
			const elapsed = d.elapsedS !== undefined ? ` · ${d.elapsedS}s` : "";
			if (isPartial) {
				lines.push(theme.fg("warning", `● running${elapsed} · ${d.name ?? ""}`));
			} else if (d.status === "timeout") {
				lines.push(theme.fg("warning", `⏱ still running after ${d.waitS ?? DEFAULT_WAIT_S}s (pid ${d.pid}) — returned without blocking`));
			} else if (d.status === "aborted") {
				lines.push(theme.fg("error", `✖ aborted (killed pid ${d.pid})`));
			} else if (d.status === "uv-missing") {
				lines.push(theme.fg("error", "✖ uv not found"));
			} else {
				const ok = d.exit === 0;
				lines.push(ok ? theme.fg("success", `✔ done exit=0${elapsed}`) : theme.fg("error", `✖ exit=${d.exit}${elapsed}`));
			}
			if (expanded && !isPartial) {
				let output = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
				if (d.status === "done") output = output.replace(/^\[smartpython\][^\n]*(?:\n|$)/, "");
				if (output) for (const line of output.split("\n")) lines.push(`  ${theme.fg("dim", line)}`);
			} else {
				const head = (d.head ?? []).slice(0, 3);
				const tail = (d.tail ?? []).slice(-3);
				const gap = (d.totalLines ?? 0) > head.length + tail.length;
				for (const l of head) lines.push(`  ${theme.fg("dim", l)}`);
				if (gap) lines.push(theme.fg("muted", `  … ${d.totalLines} lines total (expand for output)`));
				for (const l of tail) lines.push(`  ${theme.fg("dim", l)}`);
			}
			if (d.status === "timeout" || d.elided === true || (d.totalLines ?? 0) > 16) lines.push(theme.fg("muted", `  log: ${d.log ?? ""}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
