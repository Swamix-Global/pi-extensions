// Live footer probe: measures the real pi TUI status line captured from a tmux
// pane against pi-tui's own visibleWidth, at several viewport widths.
// Usage: node scripts/quota-footer-probe.mjs [session] [widths...]
import { execFileSync } from "node:child_process";
import * as tui from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import * as ext from "../util-quota-helper/build/util-quota-helper.js";

const session = process.argv[2] ?? "qe";
const widths = process.argv.slice(3).map(Number);
const cols = widths.length > 0 ? widths : [120, 100, 85, 70];

const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });

function statusLine() {
	const lines = tmux("capture-pane", "-p", "-t", session).split("\n");
	return lines.find(l => l.includes("⚡") || l.includes("quota"))?.trimEnd() ?? "";
}

for (const width of cols) {
	tmux("resize-window", "-t", session, "-x", String(width), "-y", "32");
	await new Promise(r => setTimeout(r, 1200));
	const line = statusLine();
	const mine = ext.visibleWidth(line);
	const theirs = tui.visibleWidth(line);
	const pad = width - theirs;
	const tail = line.slice(Math.max(0, line.length - 26));
	const led = line.indexOf("[");
	console.log(
		JSON.stringify({ width, ours: mine, piTui: theirs, slack: pad, body: tail }),
	);
}
