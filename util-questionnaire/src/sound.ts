/**
 * Attention sound for questionnaire triggers.
 *
 * As soon as a question is shown, a short synthesized WAV ("question-beep.wav",
 * a smooth futuristic rising chirp with harmonic shimmer and stereo echo tails)
 * is played through the native audio stack — PulseAudio first (paplay, which on
 * WSLg routes to the Windows host speakers), then raw ALSA (aplay), then SDL
 * (ffplay). The beep repeats every 10 seconds while the user hasn't focused the
 * UI; the first keypress or questionnaire completion stops it.
 *
 * Environment:
 *   PI_QUESTIONNAIRE_SOUND=off        disable the attention sound entirely
 *   PI_QUESTIONNAIRE_SOUND_WAV=<path> override the WAV asset location
 *   PI_QUESTIONNAIRE_SOUND_INTERVAL_MS=n  override the 10s repeat interval
 *   PI_QUESTIONNAIRE_SOUND_DEBUG=<file>   append JSONL play events for diagnosis
 *
 * Playback is strictly fire-and-forget: every failure path degrades to silence
 * and can never break the questionnaire itself.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPEAT_MS = 10_000;

interface Player {
	name: string;
	cmd: string;
	args(file: string): string[];
}

function debug(event: string, extra: Record<string, unknown> = {}): void {
	const logFile = process.env.PI_QUESTIONNAIRE_SOUND_DEBUG;
	if (!logFile || logFile === "0") return;
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...extra }) + "\n");
	} catch {
		/* logging must never break the tool */
	}
}

function soundDisabled(): boolean {
	const v = (process.env.PI_QUESTIONNAIRE_SOUND ?? "").toLowerCase();
	return v === "0" || v === "off" || v === "false";
}

function resolveWav(): string | null {
	const candidates: string[] = [];
	if (process.env.PI_QUESTIONNAIRE_SOUND_WAV) candidates.push(process.env.PI_QUESTIONNAIRE_SOUND_WAV);
	try {
		candidates.push(fileURLToPath(new URL("../assets/question-beep.wav", import.meta.url)));
	} catch {
		/* non-file module URL */
	}
	candidates.push(join(homedir(), ".pi/agent/extensions/util-questionnaire/assets/question-beep.wav"));
	return candidates.find((p) => existsSync(p)) ?? null;
}

// Native playback chain, most standard first.
function resolvePlayer(): Player | null {
	const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	const has = (bin: string) => dirs.some((d) => existsSync(join(d, bin)));
	if (has("paplay")) return { name: "paplay", cmd: "paplay", args: (f) => [f] };
	if (has("aplay")) return { name: "aplay", cmd: "aplay", args: (f) => ["-q", f] };
	if (has("ffplay")) {
		return { name: "ffplay", cmd: "ffplay", args: (f) => ["-nodsp", "-autoexit", "-loglevel", "quiet", f] };
	}
	return null;
}

export interface AttentionLoop {
	stop(): void;
}

const noopLoop: AttentionLoop = { stop() {} };

export function createAttentionLoop(): AttentionLoop {
	if (soundDisabled()) return noopLoop;
	const wav = resolveWav();
	const player = resolvePlayer();
	if (!wav || !player) {
		debug("unavailable", { wav, player: player?.name ?? null });
		return noopLoop;
	}

	const repeatMs = Math.max(50, Number(process.env.PI_QUESTIONNAIRE_SOUND_INTERVAL_MS) || DEFAULT_REPEAT_MS);
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

	debug("begin", { wav, player: player.name, repeatMs });
	beep();
	const timer = setInterval(beep, repeatMs);
	timer.unref?.();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			debug("stop", { plays });
			// Let an in-flight beep ring out (~1.2s) rather than click off mid-sample.
		},
	};
}
