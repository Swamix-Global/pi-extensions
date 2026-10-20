/**
 * Pi extension settings helper, inlined into each bundle so extensions stay self-contained.
 * Reads and merge-patches settings.json:extensionSettings.<name>.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type SettingsBlock = Record<string, unknown>;

/** Agent dir resolved like pi itself: PI_CODING_AGENT_DIR override, else ~/.pi/agent. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** The one settings file all extensions bind to: pi's own settings.json (pi does not
 * validate unknown keys, and it deep-merges global + project copies).
 * PI_EXTENSION_SETTINGS_PATH redirects it for tests. */
export function extensionSettingsFilePath(): string {
	return process.env.PI_EXTENSION_SETTINGS_PATH || path.join(agentDir(), "settings.json");
}

function readSection(): Record<string, SettingsBlock> {
	try {
		const raw = JSON.parse(fs.readFileSync(extensionSettingsFilePath(), "utf8"));
		const section = raw?.extensionSettings;
		return section && typeof section === "object" && !Array.isArray(section) ? section : {};
	} catch {}
	return {};
}

/** One extension's option block from settings.json -> extensionSettings.<name>. */
export function readExtensionSettings(name: string): SettingsBlock {
	const block = readSection()[name];
	return block && typeof block === "object" && !Array.isArray(block) ? block : {};
}

/** Whether a key is explicitly user-set in the extension's block ([u] vs [d] tags). */
export function hasExtensionSetting(name: string, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(readExtensionSettings(name), key);
}

/** Atomic merge-patch of one extension's block into settings.json; returns the merged block. */
export function writeExtensionSettings(name: string, patch: SettingsBlock): SettingsBlock {
	const file = extensionSettingsFilePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	let raw: any = {};
	try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
	const current = raw.extensionSettings?.[name];
	raw.extensionSettings = {
		...raw.extensionSettings,
		[name]: {
			...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
			...patch,
		},
	};
	fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
	return raw.extensionSettings[name];
}
