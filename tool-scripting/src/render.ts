/**
 * Shared display views for tool-scripting.
 *
 * Every call renders two boxed "boxlets": the code box (call view, language
 * formatted source) and the output box (result view, live preview → final
 * output). Each boxlet caps its content at DISPLAY_ROWS visible terminal rows
 * counted after width-aware wrapping — collapsed or expanded — so a call can
 * never flood the screen; the full output always remains in the model-visible
 * result and on disk. The output box doubles its top border as the wait-budget
 * progress bar (elapsed / wait seconds): one bar per call, updated through
 * partial results. It is a wait-budget indicator, not a task-completion
 * estimate.
 */
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderTop, type ProgressBar } from "./box.ts";
import type { LanguageAdapter } from "./languages.ts";
import type { ScriptDetails } from "./runner.ts";

const DISPLAY_ROWS = 10;
const OUTPUT_ROWS = 8; // + 1 status row + 1 meta row = 10 per output boxlet
const CODE_ROWS = 9; // + 1 title row = 10 per code boxlet
const MIN_WIDTH = 16;

interface Theme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

function highlightFor(adapter: LanguageAdapter, source: string): string[] {
	if (adapter.id === "python") {
		try {
			return highlightCode(source, "python");
		} catch {
			return adapter.formatSource(source);
		}
	}
	return adapter.formatSource(source);
}

function shortenHome(p: string): string {
	const home = process.env.HOME ?? "";
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Wrap `lines`, then keep at most `max` rows; overflow collapses into a marker row. */
function capWrapped(lines: string[], inner: number, max: number, marker: (hiddenRows: number) => string): string[] {
	const groups = lines.map((line) => wrapTextWithAnsi(line, inner));
	const rows: string[] = [];
	let overflowGroup: number | null = null;
	let consumedInGroup = 0;
	outer: for (let g = 0; g < groups.length; g++) {
		for (let i = 0; i < groups[g].length; i++) {
			if (rows.length >= max) {
				overflowGroup = g;
				consumedInGroup = i;
				break outer;
			}
			rows.push(groups[g][i]);
		}
	}
	if (overflowGroup === null) return rows;
	let hidden = groups[overflowGroup].length - consumedInGroup;
	for (let g = overflowGroup + 1; g < groups.length; g++) hidden += groups[g].length;
	const markerRows = wrapTextWithAnsi(marker(hidden), inner);
	const kept = Math.max(0, max - markerRows.length);
	return [...rows.slice(0, kept), ...markerRows];
}

function frameRow(border: (t: string) => string, inner: number, text: string): string {
	const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
	return `${border("│")} ${text}${pad} ${border("│")}`;
}

/** Call view: language-formatted source in a box, capped at DISPLAY_ROWS rows. */
export class ScriptCallBox implements Component {
	constructor(
		private adapter: LanguageAdapter,
		private args: Record<string, unknown>,
		private theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const border = (s: string) => this.theme.fg("muted", s);
		const bits = this.adapter.callBits(this.args).bits;
		const waitS = this.adapter.callBits(this.args).waitS;
		const dir = typeof this.args.directory === "string" ? this.args.directory : "";
		const title =
			this.theme.fg("toolTitle", this.theme.bold(`tool-scripting ${this.adapter.id} `)) +
			this.theme.fg("accent", String(this.args.name ?? "")) +
			this.theme.fg("muted", ` · ${[...bits, `${waitS}s`].join(" · ")}${dir ? ` · ${shortenHome(dir)}` : ""}`);
		const source = String(this.args.code ?? this.args.command ?? "");
		const code = highlightFor(this.adapter, source).map((l) => this.theme.fg("dim", l));
		if (width < MIN_WIDTH) {
			return [title, ...code].flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width))).slice(0, DISPLAY_ROWS + 2);
		}
		const inner = Math.max(4, width - 4);
		const out: string[] = [renderTop(width, border, ` ${this.adapter.id} `)];
		out.push(frameRow(border, inner, title));
		const capped = capWrapped(code, inner, CODE_ROWS, () =>
			this.theme.fg("muted", `… source truncated for display (full source on disk)`),
		);
		for (const row of capped) out.push(frameRow(border, inner, row));
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return out;
	}
}

/** Result view: live/final output with the wait-budget bar as its top border. */
export class ScriptResultBox implements Component {
	constructor(
		private adapter: LanguageAdapter,
		private result: { content?: Array<{ type: string; text?: string }>; details?: Partial<ScriptDetails> },
		private opts: { expanded: boolean; isPartial: boolean },
		private theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const border = (s: string) => this.theme.fg("muted", s);
		const d = (this.result.details ?? {}) as Partial<ScriptDetails>;
		const elapsed = d.elapsedS ?? 0;
		const waitS = d.waitS ?? this.adapter.defaultWaitS;

		const { status, color } = statusFor(this.adapter, d, this.opts);
		const lines: string[] = [this.theme.fg(color, status)];

		const outputLines: string[] = [];
		if (this.opts.expanded && !this.opts.isPartial && d.status === "done") {
			const text = (this.result.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			const stripped = text.startsWith(this.adapter.prefix) ? text.split("\n").slice(1).join("\n") : text;
			if (stripped) for (const line of stripped.split("\n")) outputLines.push(this.theme.fg("dim", line));
		} else if (!d.status) {
			// Older built-in tools have no scripting details. Render their saved
			// text directly instead of silently displaying an empty box.
			for (const c of this.result.content ?? []) if (c.type === "text" && c.text) {
				for (const line of c.text.split("\n")) outputLines.push(this.theme.fg("dim", line));
			}
		} else {
			const head = (d.head ?? []).slice(0, 3);
			const tail = (d.tail ?? []).slice(-3);
			const total = d.totalLines ?? 0;
			for (const l of head) outputLines.push(this.theme.fg("dim", l));
			if (total > head.length + tail.length) outputLines.push(this.theme.fg("muted", `… ${total} lines total (full output in result + log)`));
			for (const l of tail.slice(Math.max(0, head.length + tail.length - total))) outputLines.push(this.theme.fg("dim", l));
		}
		const meta =
			d.status === "timeout" || d.status === "aborted" || d.elided || (d.totalLines ?? 0) > 10
				? this.theme.fg("muted", `log: ${d.log ?? ""}`)
				: this.theme.fg("muted", `${d.totalLines ?? 0} lines · log: ${d.log ?? ""}`);
		lines.push(meta);

		if (width < MIN_WIDTH) {
			return [this.theme.fg(color, `> ${barText(d, waitS)}`), ...lines]
				.flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width)))
				.slice(0, DISPLAY_ROWS + 2);
		}
		const inner = Math.max(4, width - 4);
		const fraction = Math.min(1, Math.max(0, elapsed / Math.max(1, waitS)));
		const bar: ProgressBar = { fraction, label: barText(d, waitS), fill: (t) => this.theme.fg(color, t) };
		const out: string[] = [renderTop(width, border, `${this.adapter.id} ${bar.label}`, bar)];
		const statusRows = wrapTextWithAnsi(lines[0], inner);
		const outputRows = capWrapped(outputLines, inner, OUTPUT_ROWS - Math.max(0, statusRows.length - 1), (hidden) =>
			this.theme.fg("muted", `… +more rows truncated (log: ${d.log ?? ""})`),
		);
		const metaRows = wrapTextWithAnsi(lines[lines.length - 1], inner);
		const body = capWrapped([...statusRows, ...outputRows, ...metaRows], inner, DISPLAY_ROWS, () => this.theme.fg("muted", "… more rows (see full log)"));
		for (const row of body) out.push(frameRow(border, inner, row));
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return out;
	}
}

function statusFor(
	adapter: LanguageAdapter,
	d: Partial<ScriptDetails>,
	opts: { isPartial: boolean },
): { status: string; color: string } {
	// ASCII markers only: glyphs with ambiguous terminal widths would break the
	// frame padding, which is computed from the same visible-width table.
	if (opts.isPartial) return { status: `running · ${d.name ?? ""}`, color: "warning" };
	if (d.status === "timeout") return { status: `still running after ${d.waitS ?? 0}s (pid ${d.pid}) — returned without blocking`, color: "warning" };
	if (d.status === "aborted") return { status: `aborted (killed pid ${d.pid})`, color: "error" };
	if (d.status === "blocked") return { status: "blocked by catastrophic-command guard", color: "error" };
	if (d.status === "uv-missing") return { status: "uv not found", color: "error" };
	if (d.status === "done") {
		const ok = d.exit === 0;
		return { status: `${ok ? "done exit=0" : `exit=${d.exit}`} · ${d.elapsedS ?? 0}s`, color: ok ? "success" : "error" };
	}
	return { status: `· ${d.status ?? ""}`, color: "muted" };
}

function barText(d: Partial<ScriptDetails>, waitS: number): string {
	const elapsed = d.elapsedS ?? 0;
	if (d.status === "timeout") return `wait ${waitS}s+ pid ${d.pid ?? ""}`;
	if (d.status === "aborted") return "aborted";
	if (d.status === "blocked") return "blocked";
	if (d.status === "uv-missing") return "uv missing";
	if (d.status === "running") return `run ${Math.round(elapsed)}s/${waitS}s`;
	if (d.status === "done" && d.exit === 0) return `done ${elapsed}s`;
	if (d.status === "done") return `exit=${d.exit} · ${elapsed}s`;
	return `${elapsed}s`;
}
