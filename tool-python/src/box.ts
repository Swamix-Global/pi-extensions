/**
 * Width-aware bordered block for tool call/result views.
 *
 * The frame is drawn at the actual viewport width on every render, so it stays
 * correct across resizes and narrow terminals (plain wrapped fallback below
 * `minWidth`). Output text keeps its own ANSI styling; the frame uses a slightly
 * darker color so the boundary reads clearly against the content.
 */
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface BoxOptions {
	/** Frame color, e.g. `(text) => theme.fg("muted", text)`. */
	border: (text: string) => string;
	/** Label embedded in the top border; kept short so narrow widths still fit. */
	label?: string;
	/** Below this width, render plain wrapped lines without a frame (default 16). */
	minWidth?: number;
}

export class BoxedText implements Component {
	constructor(
		private lines: string[],
		private options: BoxOptions,
	) {}


	/** No cached state: every render() recomputes from the current width. */
	invalidate(): void {}

	render(width: number): string[] {
		const { border, label = "", minWidth = 16 } = this.options;
		if (width < minWidth) return this.lines.flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width)));
		const inner = Math.max(4, width - 4);
		const out: string[] = [];
		const labelVisual = visibleWidth(label);
		out.push(border(`╭─${label}${"─".repeat(Math.max(0, width - 3 - labelVisual))}╮`));
		for (const line of this.lines) {
			for (const wrapped of wrapTextWithAnsi(line, inner)) {
				const pad = " ".repeat(Math.max(0, inner - visibleWidth(wrapped)));
				out.push(`${border("│")} ${wrapped}${pad} ${border("│")}`);
			}
		}
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return out;
	}
}
