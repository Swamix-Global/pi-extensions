// tool-filemap — fast git-aware folder file map backed by a Rust binary shipped
// beside this bundle (build/filemap). Git repos honor .gitignore chains; other
// trees fall back to standard ignores. Folders first, files after, alphabetical,
// depth- and item-capped.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BINARY = fileURLToPath(new URL("./filemap", import.meta.url));

const filemapParameters = Type.Object({
	path: Type.String({ description: "Folder to map (absolute, or relative to the session cwd)." }),
	maxItems: Type.Optional(Type.Number({ minimum: 1, maximum: 100000, description: "Maximum entries listed (default 1000)." })),
	maxDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 8, description: "Maximum directory depth (default 3)." })),
});

function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
	const n = Math.round(typeof v === "number" ? v : dflt);
	return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
}

function runBinary(args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(BINARY, args, { stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", kill, { once: true });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`filemap failed to start: ${e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (code === 0) resolve(out);
			else reject(new Error(err.trim() || `filemap exited with code ${code}`));
		});
	});
}

function headerOf(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "filemap",
		label: "filemap",
		description:
			"Fast git-aware source file map of a folder: directories first then files, alphabetical, " +
			"depth-capped (default 3) and item-capped (default 1000). Honors .gitignore chains in git repos, " +
			"otherwise falls back to standard ignores (node_modules, build outputs, caches, hidden entries). " +
			"Use it to snapshot folder structure instead of exploratory find/ls.",
		parameters: filemapParameters,
		annotations: { readOnlyHint: true },
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const root = String(params?.path ?? "").trim();
			if (!root) throw new Error("path is required");
			const abs = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
			const maxItems = clampInt(params?.maxItems, 1000, 1, 100000);
			const maxDepth = clampInt(params?.maxDepth, 3, 1, 8);
			if (!existsSync(BINARY)) {
				throw new Error(`filemap binary missing at ${BINARY} — rebuild with: bash extensions/tool-filemap/install.sh`);
			}
			const text = await runBinary([abs, "--max-items", String(maxItems), "--max-depth", String(maxDepth)], signal);
			return {
				content: [{ type: "text" as const, text }],
				details: { path: abs, maxItems, maxDepth, header: headerOf(text) },
			};
		},
		renderCall(args: any, theme: any) {
			const line =
				theme.fg("toolTitle", theme.bold("filemap ")) +
				theme.fg("accent", String(args?.path ?? "")) +
				theme.fg("muted", ` · depth ${typeof args?.maxDepth === "number" ? args.maxDepth : 3} · cap ${typeof args?.maxItems === "number" ? args.maxItems : 1000}`);
			return {
				render(width: number) {
					return [truncateToWidth(line, width)];
				},
				invalidate() {},
			};
		},
		renderResult(result: any, { isPartial, expanded }: { isPartial: boolean; expanded: boolean }, theme: any) {
			if (isPartial) {
				return new Text(theme.fg("warning", "● mapping…"), 0, 0);
			}
			const content = result?.content?.[0] as { type?: string; text?: string } | undefined;
			const text = content?.type === "text" && content.text ? content.text : "";
			const header = (result?.details as { header?: string } | undefined)?.header ?? headerOf(text);
			const m = header.match(/, (\d+) items\)/);
			const items = m ? m[1] : "?";
			const mode = header.includes("git ignores") ? "git ignores" : "standard ignores";
			const summary =
				theme.fg("success", `✔ ${items} items · ${mode}`) +
				theme.fg("dim", " · ctrl+o to expand");
			if (!expanded || !text) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${theme.fg("dim", text)}`, 0, 0);
		},
	});
}
