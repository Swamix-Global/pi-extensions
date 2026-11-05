/**
 * util-frankenstein — sequential A1:L2 model interleave as a Pi virtual model.
 *
 * Registers `frankenstein/auto`, which dispatches every routed provider call in
 * a fixed repeating cycle across two physical OpenAI Codex models:
 *
 *   slot 0 → openai-codex/gpt-6-astra at reasoning "high"
 *   slot 1 → openai-codex/gpt-6-luna at reasoning "max"
 *   slot 2 → openai-codex/gpt-6-luna at reasoning "max"
 *
 * The cycle advances on every agent-loop request — the first request after a
 * user message (`user`) and every tool-result follow-up (`continuation`) alike —
 * and keeps advancing across user turns, so the ratio holds over the whole call
 * sequence rather than resetting per turn. Cycle position is router state: Pi
 * stores it on the session branch, so it follows forks/tree navigation and
 * survives compaction and resume.
 *
 * Routing policy for the remaining request reasons:
 *   - `retry`   stays on the failed model/level and does not advance the cycle
 *               (keeps prompt caches and thinking signatures valid for retry).
 *   - `direct`  (compaction summaries and other out-of-loop calls) goes to
 *               Luna/max without advancing the cycle.
 *
 * Model provenance and signature handling stay fully native: Pi's per-request
 * transformation replays each model's own reasoning signatures and drops the
 * other model's, which the Astra↔Luna RPC PoC verified end-to-end
 * (.pi/experiments/astra-luna/REPORT.md). This extension only selects the
 * dispatch pair; it never rewrites history.
 *
 * Commands:
 *   /frankenstein on      switch the session to frankenstein/auto, saving the
 *                         current model + thinking level as the restore point
 *   /frankenstein off     restore the saved model + level (fallback: astra/high)
 *   /frankenstein status  cycle position, dispatch log and restore point
 * Selecting `frankenstein/auto` via /model also activates it; switching away
 * manually deactivates and drops the restore point.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

const VIRTUAL_PROVIDER = "frankenstein";
const VIRTUAL_ID = "auto";
const VIRTUAL_REF = `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`;

const PHYS_PROVIDER = "openai-codex";
const ASTRA_ID = "gpt-6-astra";
const LUNA_ID = "gpt-6-luna";
const ASTRA_LEVEL = "high" as const;
const LUNA_LEVEL = "max" as const;

/** Astra occupies 1 slot in every 3; Luna fills the remaining 2. */
const CYCLE = 3;

interface FrankState {
	/** Number of cycle-advancing requests routed so far on this branch. */
	slot: number;
}

interface RestorePoint {
	provider: string;
	id: string;
	level: string;
}

interface Dispatch {
	slot: number;
	ref: string;
	level: string;
	reason: string;
}

/** Restore point saved when frankenstein was activated; undefined when inactive. */
let saved: RestorePoint | undefined;
/** True while a setModel call made by this extension is in flight. */
let programmatic = false;
/** Recent dispatches for /frankenstein status (in-memory only). */
const log: Dispatch[] = [];

function isVirtual(model: { provider: string; id: string }): boolean {
	return model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID;
}

function phys(ctx: ExtensionContext, id: string): NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>> {
	const model = ctx.modelRegistry.find(PHYS_PROVIDER, id);
	if (!model) throw new Error(`frankenstein: ${PHYS_PROVIDER}/${id} is not in the catalog or has no credentials`);
	return model;
}

function dispatchFor(slot: number): { id: string; level: typeof ASTRA_LEVEL | typeof LUNA_LEVEL } {
	return slot % CYCLE === 0 ? { id: ASTRA_ID, level: ASTRA_LEVEL } : { id: LUNA_ID, level: LUNA_LEVEL };
}

function record(slot: number, ref: string, level: string, reason: string): void {
	log.push({ slot, ref, level, reason });
	if (log.length > 12) log.shift();
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<FrankState>({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_ID,
		name: "Frankenstein A1:L2",
		thinkingLevels: ["high"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		route(request: ModelRouteRequest<FrankState>, ctx: ExtensionContext): ModelRoute<FrankState> {
			// Retries: stay on the failed pair without advancing the cycle.
			if (request.reason === "retry" && request.failed) {
				return {
					model: request.failed.model,
					thinkingLevel: request.failed.thinkingLevel ?? LUNA_LEVEL,
				};
			}
			// Direct out-of-loop calls: Luna/max, cycle untouched.
			if (request.reason === "direct") {
				return { model: phys(ctx, LUNA_ID), thinkingLevel: LUNA_LEVEL };
			}
			const slot = request.state?.slot ?? 0;
			const pick = dispatchFor(slot);
			const model = phys(ctx, pick.id);
			record(slot, `${PHYS_PROVIDER}/${pick.id}`, pick.level, request.reason);
			return { model, thinkingLevel: pick.level, state: { slot: slot + 1 } };
		},
	});

	pi.on("model_select", (event) => {
		if (isVirtual(event.model)) {
			if (programmatic) {
				programmatic = false;
				return;
			}
			// Activated directly via /model: remember what was selected before.
			if (!saved && event.previousModel && !isVirtual(event.previousModel)) {
				saved = { provider: event.previousModel.provider, id: event.previousModel.id, level: ASTRA_LEVEL };
			}
			return;
		}
		// Any non-frankenstein selection (manual or our own restore) clears state.
		saved = undefined;
		programmatic = false;
	});

	pi.registerCommand("frankenstein", {
		description: "Toggle the frankenstein A1:L2 model interleave (astra high / luna max)",
		handler: async (args, ctx) => {
			const verb = args.trim().split(/\s+/)[0] || "status";
			const virtual = ctx.modelRegistry.find(VIRTUAL_PROVIDER, VIRTUAL_ID);
			if (!virtual) {
				ctx.ui?.notify("frankenstein: virtual model not registered", "error");
				return;
			}
			if (verb === "on") {
				if (isVirtual(ctx.model)) {
					ctx.ui?.notify("frankenstein already active", "info");
					return;
				}
				if (ctx.model) {
					saved = { provider: ctx.model.provider, id: ctx.model.id, level: ctx.getThinkingLevel() };
				}
				programmatic = true;
				const ok = await ctx.setModel(virtual);
				if (!ok) programmatic = false;
				ctx.setThinkingLevel(ASTRA_LEVEL);
				ctx.ui?.notify(
					`frankenstein on — cycle: ${ASTRA_ID}/${ASTRA_LEVEL} → ${LUNA_ID}/${LUNA_LEVEL} ×2` +
						(saved ? ` (restore: ${saved.provider}/${saved.id} @ ${saved.level})` : ""),
					"info",
				);
				return;
			}
			if (verb === "off") {
				if (!isVirtual(ctx.model)) {
					saved = undefined;
					ctx.ui?.notify("frankenstein is not active", "info");
					return;
				}
				const target = saved ?? { provider: PHYS_PROVIDER, id: ASTRA_ID, level: ASTRA_LEVEL };
				const restored = ctx.modelRegistry.find(target.provider, target.id);
				saved = undefined;
				if (!restored) {
					ctx.ui?.notify(`frankenstein off: cannot restore ${target.provider}/${target.id}`, "error");
					return;
				}
				programmatic = true;
				const ok = await ctx.setModel(restored);
				if (!ok) programmatic = false;
				ctx.setThinkingLevel(target.level as Parameters<typeof ctx.setThinkingLevel>[0]);
				ctx.ui?.notify(`frankenstein off — restored ${target.provider}/${target.id} @ ${target.level}`, "info");
				return;
			}
			if (verb === "status") {
				const slot = log.length ? (log[log.length - 1].slot + 1) % CYCLE : 0;
				const next = dispatchFor(log.length ? log[log.length - 1].slot + 1 : 0);
				const lines = [
					`frankenstein: ${isVirtual(ctx.model) ? "active" : "inactive"} — cycle astra/${ASTRA_LEVEL} 1 : luna/${LUNA_LEVEL} 2`,
					`next slot ${slot}: ${PHYS_PROVIDER}/${next.id} @ ${next.level}`,
					`restore point: ${saved ? `${saved.provider}/${saved.id} @ ${saved.level}` : "none (fallback astra/high)"}`,
				];
				for (const entry of log.slice(-6)) {
					lines.push(`  slot ${entry.slot} → ${entry.ref} @ ${entry.level} (${entry.reason})`);
				}
				ctx.ui?.notify(lines.join("\n"), "info");
				return;
			}
			ctx.ui?.notify(`unknown subcommand "${verb}" — use on | off | status`, "warning");
		},
	});

	// Convenience alias documented in the README; ignore if the name is taken.
	try {
		pi.registerCommand("status", {
			description: "Show frankenstein interleave status",
			handler: async (_args, ctx) => {
				if (!isVirtual(ctx.model)) return;
				const slot = log.length ? (log[log.length - 1].slot + 1) % CYCLE : 0;
				const next = dispatchFor(log.length ? log[log.length - 1].slot + 1 : 0);
				ctx.ui?.notify(
					`frankenstein active — next slot ${slot}: ${PHYS_PROVIDER}/${next.id} @ ${next.level}` +
						(log.length ? ` (last: slot ${log[log.length - 1].slot} → ${log[log.length - 1].ref})` : ""),
					"info",
				);
			},
		});
	} catch {
		// Another extension or core already owns /status; /frankenstein status remains.
	}
}
