/**
 * Shared display views for tool-scripting.
 *
 * Every call renders two boxed "boxlets": the code box (call view, language
 * formatted source) and the output box (result view, live preview → final
 * output). The collapsed output boxlet caps its content at DISPLAY_ROWS
 * visible terminal rows; expanding (ctrl+o) raises the budget to
 * EXPANDED_ROWS (50 lines) so up to 50 output lines are shown by default.
 * Whenever lines remain hidden, a single exact marker row
 * "… N more lines truncated" states how many; the full log path always rides
 * in the header border beside the status so navigation needs no extra rows.
 * The full output always remains in the model-visible result and on disk.
 * The output box doubles its top border as the wait-budget progress bar
 * (elapsed / wait seconds): one bar per call, updated through partial
 * results. It is a wait-budget indicator, not a task-completion estimate.
 */
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderTop, type ProgressBar } from "./box.ts";
import type { LanguageAdapter } from "./languages.ts";
import type { ScriptDetails } from "./runner.ts";

const DISPLAY_ROWS = 10; // collapsed content rows per boxlet
const EXPANDED_ROWS = 50; // output rows when the user expands (ctrl+o)
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

/** Compact log path for the header border: full → last two segments → tail. */
function compactLog(path: string, avail: number): string {
	const s = shortenHome(path);
	if (visibleWidth(s) <= avail) return s;
	const tail2 = `…/${s.split("/").slice(-2).join("/")}`;
	if (visibleWidth(tail2) <= avail) return tail2;
	const min = Math.min(s.length, Math.max(11, avail - 1));
	return `…${s.slice(-min)}`;
}

interface Capped {
	/** Wrapped terminal rows that fit. */
	rows: string[];
	/** Original lines not fully visible (the exact truncation count). */
	hidden: number;
}

/** Wrap `lines`, keep at most `max` rows; report exactly how many original
 *  lines were dropped (or cut mid-line) so the marker can state the count. */
function capLines(lines: string[], inner: number, max: number): Capped {
	const groups = lines.map((line) => wrapTextWithAnsi(line, inner));
	const rows: string[] = [];
	let kept = 0;
	let overflow = false;
	for (let g = 0; g < groups.length; g++) {
		const group = groups[g];
		if (rows.length + group.length <= max) {
			rows.push(...group);
			kept++;
		} else {
			const fit = Math.max(0, max - rows.length);
			if (fit > 0) rows.push(...group.slice(0, fit));
			overflow = true;
			break;
		}
	}
	return { rows, hidden: overflow ? lines.length - kept : 0 };
}

function frameRow(border: (t: string) => string, inner: number, text: string): string {
	const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
	return `${border("│")} ${text}${pad} ${border("│")}`;
}

/** Call view: language-formatted source in a box, capped at DISPLAY_ROWS rows when collapsed,
 *  expanding on click or ctrl+o to display the complete, un-truncated full source. */
export class ScriptCallBox implements Component {
	private localExpanded = false;

	constructor(
		private adapter: LanguageAdapter,
		private args: Record<string, unknown>,
		private theme: Theme,
		private context?: {
			expanded?: boolean;
			isPartial?: boolean;
			state?: Record<string, unknown>;
			invalidate?: () => void;
		},
	) {}

	invalidate(): void {}

	private get isExpanded(): boolean {
		if (typeof this.context?.expanded === "boolean") return this.context.expanded;
		if (this.context?.state && typeof this.context.state.callExpanded === "boolean") {
			return Boolean(this.context.state.callExpanded);
		}
		return this.localExpanded;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		// In Pi TUI after settlement, ToolExecutionComponent wraps this call component in a MouseRegion
		// that handles click by toggling this.setExpanded(!this.expanded). Returning undefined lets
		// the click bubble up to trigger full-component expansion and re-render both call and result.
		if (this.context && !this.context.isPartial && typeof this.context.expanded === "boolean") {
			return undefined;
		}
		// While still partial or in standalone environments, toggle expansion locally so clicking
		// always expands/collapses the call view immediately.
		this.localExpanded = !this.isExpanded;
		if (this.context?.state) this.context.state.callExpanded = this.localExpanded;
		this.context?.invalidate?.();
		return { handled: true };
	}

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
			const rows = [title, ...code].flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width)));
			return this.isExpanded ? rows : rows.slice(0, DISPLAY_ROWS + 2);
		}
		const inner = Math.max(4, width - 4);
		const out: string[] = [renderTop(width, border, ` ${this.adapter.id} `)];
		out.push(frameRow(border, inner, title));
		if (this.isExpanded) {
			for (const line of code) {
				const wrapped = wrapTextWithAnsi(line, inner);
				const rows = wrapped.length ? wrapped : [""];
				for (const row of rows) out.push(frameRow(border, inner, row));
			}
		} else {
			// Reserve one row for the truncation marker when anything will be hidden.
			const reserve = code.length > CODE_ROWS ? 1 : 0;
			const capped = capLines(code, inner, Math.max(1, CODE_ROWS - reserve));
			for (const row of capped.rows) out.push(frameRow(border, inner, row));
			if (capped.hidden > 0) out.push(frameRow(border, inner, this.theme.fg("muted", "… source truncated for display (full source on disk · click to expand)")));
		}
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return out;
	}
}

/** Result view: live/final output; the top border carries status, wait bar,
 *  and the compact log path — content rows carry only output and, when
 *  anything is hidden, one exact "… N more lines truncated" marker. */
export class ScriptResultBox implements Component {
	constructor(
		private adapter: LanguageAdapter,
		private result: { content?: Array<{ type: string; text?: string }>; details?: Partial<ScriptDetails> },
		private opts: { expanded: boolean; isPartial: boolean },
		private theme: Theme,
	) {}

	invalidate(): void {}

	/** Strip the runner's status prefix line from the result text. */
	private outputText(): string[] {
		const text = (this.result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		const stripped = text.startsWith(this.adapter.prefix) ? text.split("\n").slice(1).join("\n") : text;
		return stripped ? stripped.split("\n") : [];
	}

	/** Live head/tail preview for partial and handed-off runs. */
	private previewLines(d: Partial<ScriptDetails>): string[] {
		const head = (d.head ?? []).slice(0, 3);
		const tail = (d.tail ?? []).slice(-3);
		const total = d.totalLines ?? 0;
		const overlap = Math.max(0, head.length + tail.length - total);
		return [...head, ...tail.slice(overlap)];
	}

	render(width: number): string[] {
		const border = (s: string) => this.theme.fg("muted", s);
		const d = (this.result.details ?? {}) as Partial<ScriptDetails>;
		const elapsed = d.elapsedS ?? 0;
		const waitS = d.waitS ?? this.adapter.defaultWaitS;
		const settled = !this.opts.isPartial && !!d.status;
		const dim = (l: string) => this.theme.fg("dim", l);

		// Content rows: live preview while running; full output when settled.
		let outputLines: string[];
		if (this.opts.isPartial || d.status === "timeout") {
			outputLines = this.previewLines(d).map(dim);
		} else if (d.status && d.status !== "blocked" && d.status !== "uv-missing") {
			outputLines = this.outputText().map(dim);
		} else if (!d.status) {
			// Legacy built-in tools have no scripting details; render saved text.
			outputLines = (this.result.content ?? [])
				.filter((c) => c.type === "text" && c.text)
				.flatMap((c) => (c.text as string).split("\n"))
				.map(dim);
		} else {
			outputLines = [];
		}

		// One explanatory row only for states the border label cannot carry.
		const noteRows: string[] = [];
		if (d.status === "timeout") noteRows.push(this.theme.fg("warning", "still running — returned without blocking"));
		if (d.status === "blocked") noteRows.push(this.theme.fg("error", "by catastrophic-command guard"));
		if (d.status === "uv-missing") noteRows.push(this.theme.fg("error", "uv not found — install uv to run"));

		const budget = Math.max(1, (this.opts.expanded ? EXPANDED_ROWS : DISPLAY_ROWS) - noteRows.length);
		// Reserve one row for the truncation marker when anything will be hidden.
		const reserve = outputLines.length > budget ? 1 : 0;
		const innerWidth = Math.max(4, width - 4);
		const capped = capLines(outputLines, innerWidth, Math.max(1, budget - reserve));
		const markerRows =
			capped.hidden > 0 ? wrapTextWithAnsi(this.theme.fg("muted", `… ${capped.hidden} more lines truncated`), innerWidth) : [];

		// Header border: status label + compact log path beside it.
		const label = barText(d, waitS);
		const prefix = `${this.adapter.id} ${label} · `;
		const logAvail = Math.max(12, width - visibleWidth(prefix) - 4);
		const header = `${this.adapter.id} ${label}${d.log ? ` · ${compactLog(d.log, logAvail)}` : ""}`;
		const color = statusColor(d, this.opts);

		if (width < MIN_WIDTH) {
			return [this.theme.fg(color, header), ...noteRows, ...capped.rows, ...markerRows]
				.flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width)))
				.slice(0, EXPANDED_ROWS + 2);
		}
		const inner = Math.max(4, width - 4);
		const fraction = Math.min(1, Math.max(0, elapsed / Math.max(1, waitS)));
		const bar: ProgressBar = { fraction, label, fill: (t) => this.theme.fg(color, t) };
		const out: string[] = [renderTop(width, border, header, settled && d.status === "done" ? undefined : bar)];
		for (const row of [...noteRows, ...capped.rows, ...markerRows].flatMap((l) => wrapTextWithAnsi(l, inner))) {
			out.push(frameRow(border, inner, row));
		}
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return out;
	}
}

function statusColor(d: Partial<ScriptDetails>, opts: { isPartial: boolean }): string {
	if (opts.isPartial) return "warning";
	if (d.status === "timeout") return "warning";
	if (d.status === "aborted" || d.status === "blocked" || d.status === "uv-missing") return "error";
	if (d.status === "done") return d.exit === 0 ? "success" : "error";
	return "muted";
}

function barText(d: Partial<ScriptDetails>, waitS: number): string {
	const elapsed = d.elapsedS ?? 0;
	if (d.status === "timeout") return `timeout ${waitS}s+ pid ${d.pid ?? ""}`;
	if (d.status === "aborted") return `aborted pid ${d.pid ?? ""}`;
	if (d.status === "blocked") return "blocked";
	if (d.status === "uv-missing") return "uv missing";
	if (d.status === "running") return `run ${Math.round(elapsed)}s/${waitS}s`;
	if (d.status === "done" && d.exit === 0) return `done ${elapsed}s`;
	if (d.status === "done") return `exit=${d.exit} · ${elapsed}s`;
	return `${elapsed}s`;
}
