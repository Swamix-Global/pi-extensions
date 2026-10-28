/**
 * Border utilities for tool-scripting boxlets.
 *
 * Frames are drawn at the actual viewport width on every render, so they stay
 * correct across resizes. Content text keeps its own ANSI styling; the frame
 * uses a muted color so the boundary reads clearly against the content.
 *
 * The progress bar is a wait-budget indicator (elapsed / wait seconds), not a
 * task-completion estimate: it advances monotonically with wall time and locks
 * once the run settles. Fraction and label are supplied per render by the
 * caller from the latest tool details, so partial updates repaint it live.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

export interface ProgressBar {
	/** Elapsed / wait, clamped to [0, 1]. */
	fraction: number;
	/** Plain-text status label, e.g. "⏳ 12s/60s" or "✔ 3.2s". */
	label: string;
	/** Color for the filled portion of the bar and the label. */
	fill: (text: string) => string;
}

/** Top border row. Without a bar it is a plain labelled rule; with a bar the
 *  rule doubles as the wait-budget progress bar spanning the full width. */
export function renderTop(width: number, border: (t: string) => string, label: string, bar?: ProgressBar): string {
	const labelVisual = visibleWidth(label);
	if (!bar) return border(`╭─${label}${"─".repeat(Math.max(0, width - 3 - labelVisual))}╮`);
	const usable = Math.max(0, width - 2);
	const barWidth = Math.max(0, usable - labelVisual);
	const filled = Math.max(0, Math.min(barWidth, Math.round(barWidth * Math.min(1, Math.max(0, bar.fraction)))));
	const left = "━".repeat(filled);
	const right = "─".repeat(Math.max(0, barWidth - filled));
	// The bar spans the entire top border; the status label rides inside it.
	return `╭${bar.fill(left)}${bar.fill(label)}${border(right)}╮`;
}
