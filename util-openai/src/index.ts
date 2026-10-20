/**
 * util-openai — OpenAI configuration utility for Pi.
 * Shared defaults for ordinary OpenAI chat requests; no provider/auth replacement.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasExtensionSetting, readExtensionSettings, writeExtensionSettings } from "./extension-settings";

const SERVICE_TIERS = ["priority", "default", "auto", "flex"] as const;
type ServiceTier = typeof SERVICE_TIERS[number];
export const DEFAULT_UTIL_OPENAI_SETTINGS = { serviceTier: "priority" as ServiceTier };
export const DEFAULT_OPENAI_SETTINGS = DEFAULT_UTIL_OPENAI_SETTINGS;

function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && SERVICE_TIERS.includes(value as ServiceTier);
}

export function readSettings(): { serviceTier: ServiceTier } {
	const utilRaw = readExtensionSettings("utilOpenai");
	const legacyRaw = readExtensionSettings("openai");
	const serviceTier = (utilRaw?.serviceTier ?? legacyRaw?.serviceTier) as unknown;
	return { serviceTier: isServiceTier(serviceTier) ? serviceTier : DEFAULT_UTIL_OPENAI_SETTINGS.serviceTier };
}

export default function (pi: ExtensionAPI) {
	const commandHandler = async (args: string, ctx: ExtensionCommandContext) => {
		let tier = String(args ?? "").trim().toLowerCase();
		if (!tier) {
			const current = readSettings().serviceTier;
			if (ctx.mode !== "tui") {
				const source = hasExtensionSetting("utilOpenai", "serviceTier") || hasExtensionSetting("openai", "serviceTier") ? "[u]" : "[d]";
				ctx.ui.notify(`OpenAI service tier: ${current} ${source}. Set with /settings:util-openai ${SERVICE_TIERS.join("|")}`, "info");
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
		writeExtensionSettings("utilOpenai", { serviceTier: tier });
		writeExtensionSettings("openai", { serviceTier: tier });
		ctx.ui.notify(`OpenAI service tier: ${tier} [u]. Applies to the next OpenAI chat request; explicit request tiers take precedence.`, "info");
	};

	pi.registerCommand("settings:util-openai", {
		description: "[u] (settings.json:extensionSettings.utilOpenai) OpenAI service tier — /settings:util-openai [priority|default|auto|flex]",
		handler: commandHandler,
	});
	pi.registerCommand("settings:openai", {
		description: "[u] (alias for /settings:util-openai) — /settings:openai [priority|default|auto|flex]",
		handler: commandHandler,
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
