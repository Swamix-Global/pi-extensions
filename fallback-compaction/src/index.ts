/**
 * Native Fallback Compaction Extension for Pi.
 *
 * Caps tool results during live runs and repairs oversized legacy request context.
 * If settled context reaches the proactive threshold (default: 100,000 tokens),
 * this automatically triggers Pi's native compaction (`ctx.compact()`), creating
 * a structured CompactionEntry in the session and reclaiming context.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extensionSettingsFilePath, readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import { registerContextBudget } from "./context-budget.ts";

export const DEFAULT_FALLBACK_COMPACTION_THRESHOLD = 100_000;

export const settingsPath = extensionSettingsFilePath;

export interface FallbackCompactionSettings {
	enabled: boolean;
	thresholdTokens: number;
}

interface SettingsState {
	settings: FallbackCompactionSettings;
	enabledSource: "u" | "d";
	thresholdSource: "u" | "d";
}

function readSettingsState(): SettingsState {
	const raw: Record<string, unknown> = readExtensionSettings("fallbackCompaction");

	const enabledIsUser = typeof raw?.enabled === "boolean";
	const thresholdIsUser =
		typeof raw?.thresholdTokens === "number" &&
		Number.isSafeInteger(raw.thresholdTokens) &&
		raw.thresholdTokens > 0;
	return {
		settings: {
			enabled: enabledIsUser ? (raw?.enabled as boolean) : true,
			thresholdTokens: thresholdIsUser
				? (raw?.thresholdTokens as number)
				: DEFAULT_FALLBACK_COMPACTION_THRESHOLD,
		},
		enabledSource: enabledIsUser ? "u" : "d",
		thresholdSource: thresholdIsUser ? "u" : "d",
	};
}

export function readSettings(): FallbackCompactionSettings {
	return readSettingsState().settings;
}

export function writeSettings(settings: Partial<FallbackCompactionSettings>): void {
	try {
		const current = readSettings();
		writeExtensionSettings("fallbackCompaction", { ...current, ...settings });
	} catch (error) {
		console.error(`[SETTINGS_FALLBACK_COMPACTION_WRITE_FAILED]: ${error}`);
	}
}

export interface CompactionChecker {
	isCompacting: boolean;
	checkAndCompact: (ctx: ExtensionContext) => boolean;
}

/** If neither onComplete nor onError fired, release the lock after this long. */
const STALE_LOCK_MS = 5 * 60_000;

export function createCompactionChecker(): CompactionChecker {
	let isCompacting = false;
	let lockSince = 0;
	let lastAttemptTokens = 0;

	const checkAndCompact = (ctx: ExtensionContext): boolean => {
		if (isCompacting && Date.now() - lockSince > STALE_LOCK_MS) isCompacting = false;
		if (isCompacting) return false;
		const cfg = readSettings();
		if (!cfg.enabled) return false;

		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number") return false;

		// Prevent infinite compaction loops: do not re-compact if context has not grown since last attempt
		if (usage.tokens >= cfg.thresholdTokens && usage.tokens > lastAttemptTokens) {
			isCompacting = true;
			lockSince = Date.now();
			lastAttemptTokens = usage.tokens;
			const thresholdStr = (cfg.thresholdTokens / 1000).toFixed(0);
			ctx.ui?.notify?.(
				`Context reached ${usage.tokens.toLocaleString()} tokens (>= ${thresholdStr}k). Triggering native fallback compaction...`,
				"info",
			);
			try {
				// AgentSession.compact() aborts the in-flight run and never resumes it.
				// We only ever call it from `agent_settled`, where nothing is running.
				ctx.compact({
					onComplete: (result) => {
						isCompacting = false;
						lockSince = 0;
						lastAttemptTokens = result.estimatedTokensAfter ?? usage.tokens;
						ctx.ui?.notify?.(
							`Native fallback compaction complete: ${result.tokensBefore?.toLocaleString() ?? "context"} tokens compacted.`,
							"info",
						);
					},
					onError: (err) => {
						isCompacting = false;
						lockSince = 0;
						const msg = err?.message || String(err);
						if (!msg.includes("Already compacted") && !msg.includes("too small")) {
							ctx.ui?.notify?.(`Native fallback compaction error: ${msg}`, "warning");
						}
					},
				});
				return true;
			} catch (error) {
				isCompacting = false;
				lockSince = 0;
				const msg = error instanceof Error ? error.message : String(error);
				if (!msg.includes("Already compacted") && !msg.includes("too small")) {
					ctx.ui?.notify?.(`Native fallback compaction trigger failed: ${msg}`, "warning");
				}
				return false;
			}
		}
		return false;
	};

	return {
		get isCompacting() {
			return isCompacting;
		},
		set isCompacting(val: boolean) {
			isCompacting = val;
		},
		checkAndCompact,
	};
}

export default function (pi: ExtensionAPI) {
	registerContextBudget(pi, settingsPath);
	const checker = createCompactionChecker();

	try {
		pi.registerCommand?.("settings:fallback-compaction", {
			description:
				"[u] (settings.json:extensionSettings.fallbackCompaction) Fallback native compaction settings — /settings:fallback-compaction [on|off|<tokens>]",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const state = readSettingsState();
				const current = state.settings;
				const arg = String(args ?? "").trim().toLowerCase();

				if (!arg) {
					ctx.ui.notify(
						`Fallback compaction: [${state.enabledSource}] ${current.enabled ? "on" : "off"}, threshold: [${state.thresholdSource}] ${current.thresholdTokens.toLocaleString()} tokens`,
						"info",
					);
					return;
				}

				if (arg === "on" || arg === "off") {
					const enabled = arg === "on";
					writeSettings({ enabled });
					ctx.ui.notify(`Fallback compaction: [u] ${enabled ? "on" : "off"} — ${settingsPath()}`, "info");
					return;
				}

				const num = Number(arg.replace(/k$/i, "000"));
				if (Number.isSafeInteger(num) && num >= 1000) {
					writeSettings({ thresholdTokens: num, enabled: true });
					ctx.ui.notify(
						`Fallback compaction: [u] threshold ${num.toLocaleString()} tokens (on) — ${settingsPath()}`,
						"info",
					);
					return;
				}

				ctx.ui.notify(
					`Invalid argument "${args}". Usage: /settings:fallback-compaction [on|off|<tokens>] (e.g. 100k or 100000)`,
					"warning",
				);
			},
		});
	} catch {}

	// Only `agent_settled` guarantees no automatic retry, compaction, or queued
	// continuation remains — so ctx.compact()'s internal abort() interrupts nothing
	// and the session is ready for the next user message. Triggering from
	// turn_end/agent_end used to abort the live run after every tool batch;
	// the session then went idle and the user had to type "resume" by hand.
	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		checker.checkAndCompact(ctx);
	});
}
