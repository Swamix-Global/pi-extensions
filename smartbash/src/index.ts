/**
 * smartbash — direct, display-first bash tool for Pi (replaces pi-job smart-bash).
 *
 * Overrides the built-in "bash" tool:
 * - name      purpose of the command in ≤5 words; the display leads with it
 * - command   bash to run, one command per line (≤3 chained is ideal);
 *             rendered with real newlines in the call view
 * - directory optional working directory, shown as a hint (default: project dir)
 * - timeout   seconds to wait before returning; default 60, hard cap 60.
 *             A command still running at the deadline NEVER blocks the main
 *             thread: the call returns at once with a timeout report (pid,
 *             log path, poll/stop commands) while the process keeps running.
 *
 * Every call gets a run directory <project>/.pi/smartbash/<id>/ with cmd.sh,
 * out.log and meta.json. While waiting, output is polled every second and
 * streamed to the UI as head-5 + tail-5 lines. Large outputs are elided
 * head+tail (100/100 lines) with the full log path retained. Displayed lines
 * wrap to terminal width; expanding reveals the full returned output.
 *
 * Toggle via /settings:smartbash on|off (settings.json:extensionSettings.smartBash).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import { boundText, TOOL_OUTPUT_BYTES } from "./output-budget.ts";

const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 60;
const POLL_MS = 500;
const UI_INTERVAL_MS = 1000;
const PREVIEW_BYTES = 4096;
const KEEP_LINES = 5;
const VERBATIM_LINES = 200;
const VERBATIM_BYTES = TOOL_OUTPUT_BYTES - 4096; // room for status and retrieval metadata
const ELIDE_SIDE_LINES = 100;

export interface SmartBashDetails {
	status: "running" | "done" | "timeout" | "aborted" | "blocked";
	name: string;
	directory: string;
	waitS: number;
	run: string;
	log: string;
	pid?: number;
	exit?: number;
	signal?: string;
	elapsedS?: number;
	head: string[];
	tail: string[];
	totalLines: number;
	elided?: boolean;
}

export function readSmartBashSettings(): { enabled: boolean } {
	const enabled = readExtensionSettings("smartBash").enabled;
	return { enabled: typeof enabled === "boolean" ? enabled : true };
}

export function writeSmartBashSettings(enabled: boolean): boolean {
	try {
		writeExtensionSettings("smartBash", { enabled });
		return true;
	} catch {
		return false;
	}
}

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
			return buffer.subarray(0, count).toString("utf8");
		};
		if (bytes <= VERBATIM_BYTES && totalLines <= VERBATIM_LINES)
			return { text: sample(0, bytes).replace(/\n$/, ""), totalLines, elided: false };
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

const smartBashParameters = Type.Object({
	name: Type.String({
		description:
			"What this command is for, in 5 words or fewer — the display leads with it (e.g. 'build project', 'check test failures').",
	}),
	command: Type.String({
		description:
			"The bash command to run. May be a short sequence — ideally no more than 3 chained commands, " +
			"one per line (newlines render as separate lines in the display).",
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("settings:smartbash", {
		description: "Toggle the smartbash tool: /settings:smartbash [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeSmartBashSettings(arg === "on");
				ctx.ui.notify(`smartbash is now ${arg}. Run /reload to apply.`, "info");
			} else {
				const current = readSmartBashSettings().enabled ? "on" : "off";
				ctx.ui.notify(`smartbash is currently ${current}. Use '/settings:smartbash on|off' to toggle.`, "info");
			}
		},
	});

	if (!readSmartBashSettings().enabled) return;

	pi.registerTool({
		name: "bash",
		label: "smartbash",
		description:
			"Execute a bash command with live head+tail progress. Params: name (required, purpose in ≤5 words), " +
			"command (bash; one command per line, ideally ≤3 chained), directory (optional working dir, default " +
			"project dir), timeout (wait seconds, default 60, hard cap 60). The call returns within the wait: on " +
			"completion with the output (huge outputs elided head+tail, full log path included); if still running " +
			"at the deadline it returns immediately without blocking with the pid and log path — poll later with " +
			"`tail` on the log or stop with `kill <pid>`. Catastrophic commands (rm -rf /, mkfs, raw-disk dd, fork " +
			"bombs) are rejected. Each call is logged under <project>/.pi/smartbash/.",
		parameters: smartBashParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const command = typeof params.command === "string" ? params.command : "";
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!command.trim()) throw new Error("command must be a non-empty string");
			if (!name) throw new Error("name is required: what is this command for, in ≤5 words");

			const reason = denyReason(command);
			if (reason) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`[smartbash] blocked: ${reason}\n` +
								"The command matches a catastrophic-pattern guard. If it is genuinely intended, " +
								"restate it in a narrower, explicit form (e.g. target a specific path instead of /).",
						},
					],
					details: { status: "blocked", name, head: [], tail: [], totalLines: 0, run: "", log: "", waitS: 0, directory: "" } as SmartBashDetails,
				};
			}

			const defaultDir = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
			const directory = expandDir(
				typeof params.directory === "string" && params.directory.trim() ? params.directory : defaultDir,
			);
			if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
				throw new Error(`directory does not exist or is not a directory: ${directory}`);
			const waitS = Math.min(Math.max(Math.round(typeof params.timeout === "number" ? params.timeout : DEFAULT_WAIT_S), 1), MAX_WAIT_S);

			const slug = slugify(name);
			const runsDir = path.join(directory, ".pi", "smartbash");
			fs.mkdirSync(runsDir, { recursive: true });
			let run = `${now()}-${slug}`;
			for (let i = 2; fs.existsSync(path.join(runsDir, run)); i++) run = `${now()}-${slug}-${i}`;
			const runDir = path.join(runsDir, run);
			fs.mkdirSync(runDir, { recursive: true });
			const logPath = path.join(runDir, "out.log");
			const metaPath = path.join(runDir, "meta.json");
			fs.writeFileSync(path.join(runDir, "cmd.sh"), `#!/usr/bin/env bash\n${command}\n`);
			const writeMeta = (patch: Partial<SmartBashDetails> & Record<string, unknown>) =>
				fs.writeFileSync(metaPath, JSON.stringify({ run, name, command, directory, waitS, ...patch }, null, 2));

			const logFd = fs.openSync(logPath, "a");
			const child = spawn("/usr/bin/env", ["bash", path.join(runDir, "cmd.sh")], {
				cwd: directory,
				detached: true,
				stdio: ["ignore", logFd, logFd],
			});
			fs.closeSync(logFd);
			const pid = child.pid;
			writeMeta({ status: "running", pid, log: logPath });

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

			try {
				let lastUi = 0;
				while (exit === undefined && spawnError === undefined && !aborted) {
					if (Date.now() - started >= waitS * 1000) {
						const preview = pollLog();
						const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
						writeMeta({ status: "timeout", pid, log: logPath, elapsedS });
						const tailText = preview.tail.join("\n");
						return {
							content: [
								{
									type: "text" as const,
									text:
										`[smartbash] timed out waiting after ${waitS}s — "${name}" is still running (pid ${pid}).\n` +
										`log: ${logPath}\n` +
										`poll: bash { name: "check ${slug}", command: "tail -n 200 '${logPath}'", timeout: 10 }\n` +
										`stop: bash { name: "stop ${slug}", command: "kill ${pid}" }\n` +
										(tailText ? `\n${tailText}` : ""),
								},
							],
							details: {
								status: "timeout", name, directory, waitS, run, log: logPath, pid,
								elapsedS, head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
							} as SmartBashDetails,
						};
					}
					if (Date.now() - lastUi >= UI_INTERVAL_MS) {
						lastUi = Date.now();
						const preview = pollLog();
						onUpdate?.({
							content: [{ type: "text" as const, text: `[smartbash] ${name} — running ${Math.round((Date.now() - started) / 1000)}s` }],
							details: {
								status: "running", name, directory, waitS, run, log: logPath, pid,
								elapsedS: Number(((Date.now() - started) / 1000).toFixed(1)),
								head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
							} as SmartBashDetails,
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
					content: [{ type: "text" as const, text: `[smartbash] aborted — killed "${name}" (pid ${pid}).\nlog: ${logPath}` }],
					details: {
						status: "aborted", name, directory, waitS, run, log: logPath, pid,
						head: preview.head, tail: preview.tail, totalLines: preview.totalLines,
					} as SmartBashDetails,
				};
			}
			if (spawnError) throw new Error(`failed to start command: ${spawnError.message}`);

			const preview = pollLog();
			const { text, totalLines, elided } = elideLog(logPath);
			const elapsedS = Number(((Date.now() - started) / 1000).toFixed(1));
			writeMeta({ status: "done", pid, log: logPath, exit, elapsedS, signal: exitSignal, totalLines });
			const statusLine = `[smartbash] done exit=${exit}${exitSignal ? ` (${exitSignal})` : ""} · ${elapsedS}s · "${name}"`;
			return {
				content: [{ type: "text" as const, text: text.trim() ? `${statusLine}\n${text}` : statusLine }],
				details: {
					status: "done", name, directory, waitS, run, log: logPath, pid, exit, signal: exitSignal,
					elapsedS, head: preview.head, tail: preview.tail, totalLines, elided,
				} as SmartBashDetails,
			};
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("smartbash ")) + theme.fg("accent", args.name ?? "");
			const dirHint = theme.fg("muted", `· ${args.directory ? shortenHome(String(args.directory)) : "~ (project)"}`);
			const tHint = theme.fg("muted", `· ${typeof args.timeout === "number" ? Math.min(args.timeout, MAX_WAIT_S) : DEFAULT_WAIT_S}s`);
			const lines = [`${title} ${dirHint} ${tHint}`];
			for (const l of String(args.command ?? "").split("\n")) lines.push(`  ${theme.fg("dim", l)}`);
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = (result.details ?? {}) as Partial<SmartBashDetails>;
			const lines: string[] = [];
			const elapsed = d.elapsedS !== undefined ? ` · ${d.elapsedS}s` : "";
			if (isPartial) {
				lines.push(theme.fg("warning", `● running${elapsed} · ${d.name ?? ""}`));
			} else if (d.status === "timeout") {
				lines.push(theme.fg("warning", `⏱ still running after ${d.waitS ?? DEFAULT_WAIT_S}s (pid ${d.pid}) — returned without blocking`));
			} else if (d.status === "aborted") {
				lines.push(theme.fg("error", `✖ aborted (killed pid ${d.pid})`));
			} else if (d.status === "blocked") {
				lines.push(theme.fg("error", "✖ blocked by catastrophic-command guard"));
			} else {
				const ok = d.exit === 0;
				lines.push(ok ? theme.fg("success", `✔ done exit=0${elapsed}`) : theme.fg("error", `✖ exit=${d.exit}${elapsed}`));
			}
			if (expanded && !isPartial) {
				let output = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
				if (d.status === "done") output = output.replace(/^\[smartbash\][^\n]*(?:\n|$)/, "");
				if (output) for (const line of output.split("\n")) lines.push(`  ${theme.fg("dim", line)}`);
			} else {
				const head = (d.head ?? []).slice(0, 3);
				const tail = (d.tail ?? []).slice(-3);
				const gap = (d.totalLines ?? 0) > head.length + tail.length;
				for (const l of head) lines.push(`  ${theme.fg("dim", l)}`);
				if (gap) lines.push(theme.fg("muted", `  … ${d.totalLines} lines total (expand for output)`));
				for (const l of tail) lines.push(`  ${theme.fg("dim", l)}`);
			}
			if (d.status === "timeout" || elidedOrLong(d)) lines.push(theme.fg("muted", `  log: ${d.log ?? ""}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function elidedOrLong(d: Partial<SmartBashDetails>): boolean {
	return d.elided === true || (d.totalLines ?? 0) > 2 * ((d.head?.length ?? 0) + (d.tail?.length ?? 0)) + 6;
}
