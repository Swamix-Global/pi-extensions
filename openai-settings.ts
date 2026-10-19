/** Shared defaults for ordinary OpenAI chat requests; no provider/auth replacement. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasExtensionSetting, readExtensionSettings, writeExtensionSettings } from "../lib/extension-settings.mjs";

const SERVICE_TIERS = ["priority", "default", "auto", "flex"] as const;
type ServiceTier = typeof SERVICE_TIERS[number];
export const DEFAULT_OPENAI_SETTINGS = { serviceTier: "priority" as ServiceTier };

function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && SERVICE_TIERS.includes(value as ServiceTier);
}

export function readSettings(): { serviceTier: ServiceTier } {
	const { serviceTier } = readExtensionSettings("openai");
	return { serviceTier: isServiceTier(serviceTier) ? serviceTier : DEFAULT_OPENAI_SETTINGS.serviceTier };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("settings:openai", {
		description: "[u] (settings.json:extensionSettings.openai) OpenAI service tier — /settings:openai [priority|default|auto|flex]",
		handler: async (args, ctx) => {
			let tier = String(args ?? "").trim().toLowerCase();
			if (!tier) {
				const current = readSettings().serviceTier;
				if (ctx.mode !== "tui") {
					const source = hasExtensionSetting("openai", "serviceTier") ? "[u]" : "[d]";
					ctx.ui.notify(`OpenAI service tier: ${current} ${source}. Set with /settings:openai ${SERVICE_TIERS.join("|")}`, "info");
					return;
				}
				const selected = await ctx.ui.select(`OpenAI service tier (current: ${current})`, [current, ...SERVICE_TIERS.filter((value) => value !== current)]);
				if (!selected) return;
				tier = selected;
			}
			if (!isServiceTier(tier)) {
				ctx.ui.notify(`Invalid OpenAI service tier. Choose ${SERVICE_TIERS.join(", ")}.`, "warning");
				return;
			}
			writeExtensionSettings("openai", { serviceTier: tier });
			ctx.ui.notify(`OpenAI service tier: ${tier} [u]. Applies to the next OpenAI chat request; explicit request tiers take precedence.`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "openai" || !["openai-responses", "openai-completions"].includes(model.api)) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		// The hook exposes the selected model, not a routed model. Leave mismatches alone.
		if (payload.model !== model.id || payload.service_tier !== undefined) return;
		return { ...payload, service_tier: readSettings().serviceTier };
	});
}
