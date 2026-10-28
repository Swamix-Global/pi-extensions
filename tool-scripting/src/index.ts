/**
 * tool-scripting — unified script executor for Pi.
 *
 * One extension, one shared runner (cwd, timeout, abort, logging, row-capped
 * boxed views, wait-budget progress bar), many language adapters. Bash and
 * Python ship today; new languages are added in languages.ts.
 *
 * Settings: `extensionSettings.toolScripting` in ~/.pi/agent/settings.json —
 * `{ enabled?: boolean; bash?: boolean; python?: boolean }`, all defaulting
 * to on (the retired smartBash/smartPython toggles are not carried over).
 * Command:
 * /settings:tool-scripting [on|off|bash on|off|python on|off].
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import { ADAPTERS, type LanguageAdapter } from "./languages.ts";
import { runScript } from "./runner.ts";
import { ScriptCallBox, ScriptResultBox } from "./render.ts";

interface ToolScriptingSettings {
	enabled?: boolean;
	bash?: boolean;
	python?: boolean;
}

function readSettings(): ToolScriptingSettings {
	// New namespace, clean slate: both languages default on. The retired
	// smartBash/smartPython keys are intentionally not carried over — this is a
	// different tool, not a rename of either.
	return readExtensionSettings("toolScripting") as ToolScriptingSettings;
}

function languageEnabled(settings: ToolScriptingSettings, id: string): boolean {
	if (settings.enabled === false) return false;
	const value = (settings as Record<string, unknown>)[id];
	return value === undefined ? true : value !== false;
}

const settingsHelp =
	"/settings:tool-scripting [on|off|bash on|off|python on|off] — toggle both tools or one language. " +
	"Settings live at extensionSettings.toolScripting in ~/.pi/agent/settings.json; legacy smartBash/smartPython toggles migrate automatically. Reload with /reload.";

function handleSettingsCommand(args: string | undefined): { content: Array<{ type: "text"; text: string }> } {
	const settings = readSettings();
	const apply = (patch: ToolScriptingSettings) => writeExtensionSettings("toolScripting", patch);
	const status = () =>
		`tool-scripting: bash ${languageEnabled(settings, "bash") ? "on" : "off"} · python ${languageEnabled(settings, "python") ? "on" : "off"} · global ${settings.enabled === false ? "off" : "on"}\n${settingsHelp}`;
	const arg = (args ?? "").trim().toLowerCase();
	if (!arg) return { content: [{ type: "text", text: status() }] };
	if (arg === "on" || arg === "off") {
		apply({ enabled: arg === "on" });
		return { content: [{ type: "text", text: `tool-scripting globally ${arg}. Run /reload to apply.\n${settingsHelp}` }] };
	}
	const match = arg.match(/^(bash|python)\s+(on|off)$/);
	if (match) {
		apply({ [match[1]]: match[2] === "on" } as ToolScriptingSettings);
		return { content: [{ type: "text", text: `tool-scripting ${match[1]} ${match[2]}. Run /reload to apply.\n${settingsHelp}` }] };
	}
	return { content: [{ type: "text", text: `Unknown arguments: ${args ?? ""}\n${settingsHelp}` }] };
}

const factory: ExtensionFactory = async () => {
	const settings = readSettings();
	const tools = ADAPTERS.filter((adapter) => languageEnabled(settings, adapter.id)).map((adapter: LanguageAdapter) => ({
		type: "function" as const,
		name: adapter.toolName,
		description: adapter.toolDescription,
		parameters: adapter.parameters,
		...(adapter.promptSnippet ? { promptSnippet: adapter.promptSnippet } : {}),
		...(adapter.promptGuidelines ? { promptGuidelines: adapter.promptGuidelines } : {}),
		execute: (
			args: Record<string, unknown>,
			ctx: { signal?: AbortSignal; onUpdate?: (partial: unknown) => void; cwd?: string } | undefined,
		) =>
			runScript(
				adapter,
				args,
				ctx?.signal,
				ctx?.onUpdate as ((partial: Awaited<ReturnType<typeof runScript>>) => void) | undefined,
				{ cwd: ctx?.cwd },
			),
		renderCall: (args: Record<string, unknown>, theme: { fg: (c: string, t: string) => string; bold: (t: string) => string }) =>
			new ScriptCallBox(adapter, args, theme),
		renderResult: (
			result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
			opts: { expanded: boolean; isPartial: boolean },
			theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
		) => new ScriptResultBox(adapter, result as never, opts, theme),
	}));
	return {
		tools,
		commands: [
			{
				name: "settings:tool-scripting",
				description: "Configure tool-scripting: on|off for both tools, or bash/python individually",
				handler: handleSettingsCommand,
			},
		],
	};
};

export default factory;
