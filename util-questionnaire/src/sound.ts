/**
 * Questionnaire attention chimes configured in settings.json under
 * extensionSettings.utilQuestionnaire; see /settings:util-questionnaire.
 * All bundled WAVs live together in assets/sounds/.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readExtensionSettings } from "./extension-settings";

const DEFAULT_REPEAT_MS = 10_000;
const SETTINGS_NAME = "utilQuestionnaire";

/** Bundled sound variants kept in assets/sounds/ — order is the picker order. */
export const SOUND_NAMES = ["chirp", "pulse", "orchestral", "glass", "harp"] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export interface SoundConfig {
	sound: SoundName | "off";
	soundPath: string;
	intervalMs: number;
	debug: string;
}

export function soundConfig(): SoundConfig {
	const settings = readExtensionSettings(SETTINGS_NAME);
	const raw = typeof settings.sound === "string" ? settings.sound.toLowerCase().trim() : "chirp";
	const sound: SoundName | "off" =
		raw === "off"
			? "off"
			: (SOUND_NAMES as readonly string[]).includes(raw)
				? (raw as SoundName)
				: "chirp";
	const interval = typeof settings.intervalMs === "number" ? settings.intervalMs : DEFAULT_REPEAT_MS;
	return {
		sound,
		soundPath: typeof settings.soundPath === "string" ? settings.soundPath.trim() : "",
		intervalMs: Number.isFinite(interval) && interval > 0 ? Math.max(50, interval) : DEFAULT_REPEAT_MS,
		debug: typeof settings.debug === "string" && settings.debug !== "off" ? settings.debug.trim() : "",
	};
}

function debug(event: string, extra: Record<string, unknown> = {}): void {
	const logFile = soundConfig().debug;
	if (!logFile) return;
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...extra }) + "\n");
	} catch {
		/* logging must never break the tool */
	}
}

/** Bundled variant WAV for a sound name, or the soundPath override. */
function resolveWav(sound: SoundName, soundPath: string): string | null {
	const candidates: string[] = [];
	if (soundPath) candidates.push(soundPath);
	try {
		candidates.push(fileURLToPath(new URL(`../assets/sounds/${sound}.wav`, import.meta.url)));
	} catch {
		/* non-file module URL */
	}
	candidates.push(join(homedir(), `.pi/agent/extensions/util-questionnaire/assets/sounds/${sound}.wav`));
	return candidates.find((p) => existsSync(p)) ?? null;
}

// Native playback chain, most standard first.
function resolvePlayer(): Player | null {
	const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	const has = (bin: string) => dirs.some((d) => existsSync(join(d, bin)));
	if (has("paplay")) return { name: "paplay", cmd: "paplay", args: (f) => [f] };
	if (has("aplay")) return { name: "aplay", cmd: "aplay", args: (f) => ["-q", f] };
	if (has("ffplay")) return { name: "ffplay", cmd: "ffplay", args: (f) => ["-nodsp", "-autoexit", "-loglevel", "quiet", f] };
	return null;
}

interface Player {
	name: string;
	cmd: string;
	args(file: string): string[];
}

export interface AttentionLoop {
	stop(): void;
}

const noopLoop: AttentionLoop = { stop() {} };

export function createAttentionLoop(): AttentionLoop {
	const cfg = soundConfig();
	if (cfg.sound === "off") return noopLoop;
	const wav = resolveWav(cfg.sound, cfg.soundPath);
	const player = resolvePlayer();
	if (!wav || !player) {
		debug("unavailable", { wav, player: player?.name ?? null, sound: cfg.sound });
		return noopLoop;
	}

	let stopped = false;
	let current: ChildProcess | null = null;
	let plays = 0;

	const beep = () => {
		if (stopped) return;
		try {
			current?.kill(); // never overlap streams
			const child = spawn(player.cmd, player.args(wav), { stdio: "ignore", detached: true });
			child.unref();
			child.on("error", () => {}); // binary vanished between PATH scan and spawn
			child.on("exit", (code) => debug("played", { player: player.name, code, play: ++plays, wav }));
			current = child;
		} catch (err) {
			debug("spawn-failed", { error: String(err) });
		}
	};

	debug("begin", { wav, player: player.name, repeatMs: cfg.intervalMs, sound: cfg.sound });
	beep();
	const timer = setInterval(beep, cfg.intervalMs);
	timer.unref?.();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			debug("stop", { plays });
			// Let an in-flight chime ring out rather than click off mid-sample.
		},
	};
}
