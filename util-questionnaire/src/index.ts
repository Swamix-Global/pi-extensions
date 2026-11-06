/**
 * Questionnaire — paginated multiple-choice clarification tool.
 *
 * Lets the agent ask the user structured questions before starting work:
 * one question per screen, options paginated PAGE_SIZE per page with
 * ←→ paging, 1-9 quick picks, multi-select checkboxes, "Type something…"
 * free-text answers, tab navigation between questions, and a final
 * Review & Submit page. Non-TUI sessions fail clearly so the model falls
 * back to asking in prose.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { readExtensionSettings, writeExtensionSettings } from "./extension-settings";
import { createAttentionLoop, SOUND_NAMES } from "./sound";

const PAGE_SIZE = 9; // digits 1-9 address every visible option
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 60;

// --- types -------------------------------------------------------------------

interface QOption {
	label: string;
	value: string;
	description?: string;
	isOther?: boolean;
}

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QOption[];
	multi: boolean;
	allowOther: boolean;
}

interface Answer {
	id: string;
	label: string;
	prompt: string;
	multi: boolean;
	labels: string[]; // selected predefined option labels
	values: string[]; // selected predefined option values
	indices: number[]; // 1-based option numbers (excluding "other")
	custom: string[]; // free-text answers
}

interface QuestionnaireDetails {
	intro?: string;
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// --- schema ------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	value: Type.Optional(Type.String({ description: "Value returned when selected (defaults to label)" })),
	description: Type.Optional(Type.String({ description: "Optional hint shown under the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable identifier for the answer (defaults to q1, q2, …)" })),
	label: Type.Optional(Type.String({ description: "Short tab label, e.g. 'Scope', 'Priority' (defaults to Q1, Q2…)" })),
	prompt: Type.String({ description: "The full question text shown to the user" }),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: MAX_OPTIONS,
		description: "Answer choices; long lists are paginated automatically",
	}),
	multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Add a 'Type something…' free-text option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	intro: Type.Optional(Type.String({ description: "One line of context shown above the questions" })),
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Questions to ask, in order",
	}),
});

// --- helpers -----------------------------------------------------------------

function errorResult(message: string, questions: Question[] = []) {
	const details: QuestionnaireDetails = { questions, answers: [], cancelled: true };
	return { content: [{ type: "text" as const, text: message }], details, isError: true };
}

function answerSummary(a: Answer): string {
	const picked = a.labels.map((l, i) => (a.indices[i] ? `${a.indices[i]}. ${l}` : l));
	const typed = a.custom.map((t) => `typed "${t}"`);
	return [...picked, ...typed].join("; ") || "(no answer)";
}

// --- extension ---------------------------------------------------------------

const SETTINGS_NAME = "utilQuestionnaire";
const DEFAULT_INTERVAL_MS = 10_000;

function registerSettingsCommand(pi: ExtensionAPI): void {
	try {
		pi.registerCommand?.("settings:util-questionnaire", {
		description:
			"[u] (settings.json:extensionSettings.utilQuestionnaire) Questionnaire sound settings — " +
			"/settings:util-questionnaire [sound <name|off>|interval <ms>|soundPath <path|off>|debug <path|off>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const state = readExtensionSettings(SETTINGS_NAME);
			const currentSound = typeof state.sound === "string" ? state.sound : "chirp";
			const currentInterval = typeof state.intervalMs === "number" ? state.intervalMs : DEFAULT_INTERVAL_MS;
			const currentPath = typeof state.soundPath === "string" ? state.soundPath : "";
			const currentDebug = typeof state.debug === "string" && state.debug !== "off" ? state.debug : "off";
			const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);

			if (!parts.length) {
				ctx.ui.notify(
					`Questionnaire: sound=${currentSound}, interval=${currentInterval}ms, ` +
						`soundPath=${currentPath || "bundled"}, debug=${currentDebug}. ` +
						`Sounds: ${SOUND_NAMES.join(", ")}, off.`,
					"info",
				);
				return;
			}

			const key = parts[0].toLowerCase();
			const value = parts.slice(1).join(" ").replace(/^(["'])(.*)\1$/, "$2");
			if (key === "sound") {
				const selected = value.toLowerCase();
				if (selected !== "off" && selected !== "default" && !(SOUND_NAMES as readonly string[]).includes(selected)) {
					ctx.ui.notify(`Invalid sound "${value}". Choose ${SOUND_NAMES.join(", ")}, off, or default.`, "warning");
					return;
				}
				const sound = selected === "default" ? "chirp" : selected;
				writeExtensionSettings(SETTINGS_NAME, { sound });
				ctx.ui.notify(`Questionnaire sound: ${sound} [u]`, "info");
				return;
			}
			if (key === "interval") {
				const intervalMs = value.toLowerCase() === "default" ? DEFAULT_INTERVAL_MS : Number(value);
				if (!Number.isFinite(intervalMs) || intervalMs < 50) {
					ctx.ui.notify("Interval must be at least 50 milliseconds (or use default).", "warning");
					return;
				}
				writeExtensionSettings(SETTINGS_NAME, { intervalMs });
				ctx.ui.notify(`Questionnaire sound repeat: ${intervalMs}ms [u]`, "info");
				return;
			}
			if (key === "soundpath" || key === "debug") {
				const settingKey = key === "soundpath" ? "soundPath" : "debug";
				const settingValue = !value || value.toLowerCase() === "off" || value.toLowerCase() === "default" ? "" : value;
				writeExtensionSettings(SETTINGS_NAME, { [settingKey]: settingValue });
				ctx.ui.notify(`Questionnaire ${settingKey}: ${settingValue || "off"} [u]`, "info");
				return;
			}

			ctx.ui.notify(
				`Usage: /settings:util-questionnaire [sound <${SOUND_NAMES.join("|")}|off|default>|interval <ms|default>|soundPath <path|off>|debug <path|off>]`,
				"warning",
			);
		},
		});
	} catch {}
}

export default function questionnaire(pi: ExtensionAPI) {
	registerSettingsCommand(pi);
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user clarifying multiple-choice questions before starting work. Use whenever the task " +
			"has ambiguity in scope, approach, constraints or preferences — this resolves intent in one pass " +
			"instead of guessing. Provide 2-6 concrete, mutually-distinct options per question (long lists are " +
			"paginated), plus optional free-text. The tool blocks until the user answers or cancels.",
		parameters: QuestionnaireParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult(
					"questionnaire needs an interactive TUI session; it is unavailable here. Ask the user your " +
						"clarifying questions in plain chat instead.",
				);
			}

			const questions: Question[] = params.questions.slice(0, MAX_QUESTIONS).map((q, i) => {
				const options: QOption[] = q.options.slice(0, MAX_OPTIONS).map((o) => ({
					label: o.label,
					value: o.value ?? o.label,
					description: o.description,
				}));
				if (q.allowOther !== false) {
					options.push({
						label: q.multi ? "Add a custom answer…" : "Type something…",
						value: "__other__",
						isOther: true,
					});
				}
				return {
					id: q.id || `q${i + 1}`,
					label: q.label || `Q${i + 1}`,
					prompt: q.prompt,
					options,
					multi: q.multi === true,
					allowOther: q.allowOther !== false,
				};
			});

			if (questions.length === 0 || questions.some((q) => q.options.length === 0)) {
				return errorResult("Error: questionnaire needs at least one question with options.", questions);
			}

			const isMulti = questions.length > 1;
			const reviewRow = questions.length; // index of the submit row on the review page

			// Attention sound: beep as soon as the question appears, repeat every
			// 10s while the user hasn't focused the UI; stopped on first keypress
			// or when the questionnaire completes.
			const attention = createAttentionLoop();

			let result: QuestionnaireDetails;
			try {
				result = await ctx.ui.custom<QuestionnaireDetails>((tui, theme, _kb, done) => {
				// state
				let qIdx = 0;
				let optIdx = 0;
				let review = false;
				let revRow = reviewRow;
				let inputMode = false;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();
				const toggles = new Map<string, Set<number>>(); // per question: selected global option indices
				const customs = new Map<string, string[]>(); // per question: free-text drafts

				// The first keypress anywhere means the user is looking at the
				// question — silence the repeating attention beep.
				let focused = false;
				const markFocused = () => {
					if (!focused) {
						focused = true;
						attention.stop();
					}
				};

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({
						intro: params.intro,
						questions,
						answers: Array.from(answers.values()),
						cancelled,
					});
				}

				const q = () => questions[qIdx];
				const opts = () => q().options;
				const page = () => Math.floor(optIdx / PAGE_SIZE);
				const pageStart = () => page() * PAGE_SIZE;
				const pageEnd = () => Math.min(opts().length, pageStart() + PAGE_SIZE);
				const totalPages = () => Math.ceil(opts().length / PAGE_SIZE);
				const allAnswered = () => questions.every((question) => answers.has(question.id));

				function gotoQuestion(index: number) {
					qIdx = index;
					review = false;
					optIdx = 0;
					refresh();
				}

				function cycleTab(forward: boolean) {
					if (!isMulti) return;
					const views = questions.length + 1; // questions + review
					const current = review ? questions.length : qIdx;
					const next = ((forward ? current + 1 : current - 1) + views) % views;
					if (next === questions.length) {
						review = true;
						revRow = reviewRow;
					} else {
						gotoQuestion(next);
					}
					optIdx = 0;
					refresh();
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (allAnswered()) {
						review = true;
						revRow = reviewRow;
						optIdx = 0;
						refresh();
						return;
					}
					// next unanswered question after the current one, wrapping once
					for (let step = 1; step <= questions.length; step++) {
						const next = (qIdx + step) % questions.length;
						if (!answers.has(questions[next].id)) {
							gotoQuestion(next);
							return;
						}
					}
				}

				function saveSingle(optionIndex: number) {
					const opt = opts()[optionIndex];
					if (!opt) return;
					const question = q();
					answers.set(question.id, {
						id: question.id,
						label: question.label,
						prompt: question.prompt,
						multi: false,
						labels: [opt.label],
						values: [opt.value],
						indices: [optionIndex + 1],
						custom: [],
					});
					advanceAfterAnswer();
				}

				function confirmMulti() {
					const question = q();
					const set = toggles.get(question.id) ?? new Set<number>();
					const picked = [...set].filter((i) => !opts()[i]?.isOther);
					const texts = customs.get(question.id) ?? [];
					if (picked.length === 0 && texts.length === 0) {
						const opt = opts()[optIdx];
						if (opt?.isOther) return; // caller opens the editor instead
						if (opt) picked.push(optIdx);
					}
					if (picked.length === 0 && texts.length === 0) return;
					const real = picked.map((i) => opts()[i]).filter(Boolean);
					answers.set(question.id, {
						id: question.id,
						label: question.label,
						prompt: question.prompt,
						multi: true,
						labels: real.map((o) => o.label),
						values: real.map((o) => o.value),
						indices: picked.map((i) => i + 1),
						custom: texts,
					});
					advanceAfterAnswer();
				}

				editor.onSubmit = (value) => {
					const text = value.trim();
					const question = q();
					if (!text) {
						inputMode = false;
						editor.setText("");
						refresh();
						return;
					}
					if (question.multi) {
						const list = customs.get(question.id) ?? [];
						list.push(text);
						customs.set(question.id, list);
					} else {
						answers.set(question.id, {
							id: question.id,
							label: question.label,
							prompt: question.prompt,
							multi: false,
							labels: [text],
							values: [text],
							indices: [],
							custom: [text],
						});
					}
					inputMode = false;
					editor.setText("");
					if (question.multi) confirmMulti();
					else advanceAfterAnswer();
				};

				function toggle(index: number) {
					const question = q();
					const set = toggles.get(question.id) ?? new Set<number>();
					if (set.has(index)) set.delete(index);
					else set.add(index);
					toggles.set(question.id, set);
					refresh();
				}

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (review) {
						if (matchesKey(data, Key.up)) {
							revRow = Math.max(0, revRow - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							revRow = Math.min(reviewRow, revRow + 1);
							refresh();
							return;
						}
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							cycleTab(matchesKey(data, Key.tab));
							return;
						}
						if (matchesKey(data, Key.enter)) {
							if (revRow === reviewRow) {
								if (allAnswered()) submit(false);
							} else {
								gotoQuestion(revRow);
							}
							return;
						}
						if (matchesKey(data, Key.escape)) submit(true);
						return;
					}

					if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
						cycleTab(matchesKey(data, Key.tab));
						return;
					}

					if (totalPages() > 1 && matchesKey(data, Key.left)) {
						optIdx = Math.max(0, pageStart() - PAGE_SIZE);
						refresh();
						return;
					}
					if (totalPages() > 1 && matchesKey(data, Key.right)) {
						optIdx = Math.min(opts().length - 1, pageStart() + PAGE_SIZE);
						refresh();
						return;
					}
					if (matchesKey(data, Key.pageUp)) {
						optIdx = Math.max(0, pageStart() - PAGE_SIZE);
						refresh();
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						optIdx = Math.min(opts().length - 1, pageStart() + PAGE_SIZE);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optIdx = Math.max(0, optIdx - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optIdx = Math.min(opts().length - 1, optIdx + 1);
						refresh();
						return;
					}

					// quick pick: digits 1-9 select the visible option at that position
					if (data.length === 1 && data >= "1" && data <= "9") {
						const target = pageStart() + (Number(data) - 1);
						if (target < pageEnd()) {
							const opt = opts()[target];
							if (opt.isOther) {
								inputMode = true;
								editor.setText("");
								refresh();
							} else if (q().multi) {
								toggle(target);
							} else {
								saveSingle(target);
							}
						}
						return;
					}

					if (q().multi && matchesKey(data, Key.space) && !opts()[optIdx]?.isOther) {
						toggle(optIdx);
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const opt = opts()[optIdx];
						if (!opt) return;
						if (opt.isOther) {
							inputMode = true;
							editor.setText("");
							refresh();
							return;
						}
						if (q().multi) confirmMulti();
						else saveSingle(optIdx);
						return;
					}

					if (matchesKey(data, Key.escape)) submit(true);
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

					const addWrapped = (text: string) => {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					};
					const addPrefixed = (prefix: string, text: string) => {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const cont = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
						}
					};
					const addRight = (text: string) => {
						const pad = Math.max(0, renderWidth - visibleWidth(text) - 1);
						lines.push(" ".repeat(pad) + text);
					};

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// tab bar: one marker per question + review
					if (isMulti) {
						const tabs: string[] = [];
						for (let i = 0; i < questions.length; i++) {
							const active = !review && i === qIdx;
							const answered = answers.has(questions[i].id);
							const box = answered ? "■" : "□";
							const body = ` ${box} ${questions[i].label} `;
							const color = answered ? "success" : "muted";
							tabs.push(
								active
									? theme.bg("selectedBg", theme.fg("text", body))
									: theme.fg(color, body),
							);
						}
						const reviewText = " ✓ review ";
						tabs.push(
							review
								? theme.bg("selectedBg", theme.fg("text", reviewText))
								: theme.fg(allAnswered() ? "success" : "dim", reviewText),
						);
						addPrefixed(" ", tabs.join(" "));
						lines.push("");
					}

					if (inputMode) {
						addPrefixed(" ", theme.fg("text", q().prompt));
						lines.push("");
						addPrefixed(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addPrefixed(" ", theme.fg("dim", "Enter to save • Esc to go back"));
					} else if (review) {
						addPrefixed(" ", theme.fg("accent", theme.bold("Review & submit")));
						lines.push("");
						for (let i = 0; i < questions.length; i++) {
							const question = questions[i];
							const answer = answers.get(question.id);
							const selected = i === revRow;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const marker = answer ? theme.fg("success", "■ ") : theme.fg("dim", "□ ");
							const name = theme.fg("text", theme.bold(`${question.label}`));
							const sep = theme.fg("dim", " — ");
							const value = answer
								? theme.fg("muted", answerSummary(answer))
								: theme.fg("warning", "unanswered");
							addPrefixed(prefix, `${marker}${name}${sep}${value}`);
						}
						const canSubmit = allAnswered();
						const submitPrefix = revRow === reviewRow ? theme.fg("accent", "> ") : "  ";
						const submitLabel = canSubmit
							? theme.fg("success", theme.bold("✓ Submit answers"))
							: theme.fg("dim", "✓ Submit answers");
						lines.push("");
						addPrefixed(submitPrefix, submitLabel);
						if (!canSubmit) {
							const missing = questions
								.filter((question) => !answers.has(question.id))
								.map((question) => question.label)
								.join(", ");
							lines.push("");
							addPrefixed(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
						lines.push("");
						addPrefixed(" ", theme.fg("dim", "↑↓ move • Enter change / submit • Esc cancel"));
					} else {
						const question = q();
						addPrefixed(
							" ",
							theme.fg("dim", `Question ${qIdx + 1} of ${questions.length}`) +
								(params.intro && qIdx === 0
									? theme.fg("dim", ` · ${params.intro}`)
									: ""),
						);
						lines.push("");
						addPrefixed(" ", theme.fg("text", theme.bold(question.prompt)));
						lines.push("");

						const start = pageStart();
						const end = pageEnd();
						for (let i = start; i < end; i++) {
							const opt = opts()[i];
							const local = i - start + 1;
							const selected = i === optIdx;
							const checked = question.multi && (toggles.get(question.id)?.has(i) ?? false);
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const box = question.multi ? (checked ? theme.fg("success", "[x] ") : "[ ] ") : "";
							const label = theme.fg(selected ? "accent" : "text", `${local}. ${opt.label}`);
							addPrefixed(prefix, `${box}${label}`);
							if (opt.description) {
								addPrefixed("     ", theme.fg("muted", opt.description));
							}
						}

						const multiNote = question.multi
							? `${(customs.get(question.id) ?? []).length} custom · ${(toggles.get(question.id)?.size ?? 0)} selected`
							: "";
						if (totalPages() > 1 || multiNote) {
							lines.push("");
							const pageInfo =
								totalPages() > 1 ? theme.fg("dim", `‹ page ${page() + 1}/${totalPages()} ›`) : "";
							const note = multiNote ? theme.fg("dim", `✎ ${multiNote}`) : "";
							const gap = " ".repeat(Math.max(1, renderWidth - visibleWidth(pageInfo) - visibleWidth(note) - 2));
							lines.push(" " + note + gap + pageInfo);
						}

						lines.push("");
						let help: string;
						if (question.multi) {
							help = "Space/1-9 toggle • Enter confirm • ←→ page";
						} else {
							help = "↑↓ move • 1-9 pick • Enter select";
						}
						if (isMulti) help += " • Tab next question";
						help += " • Esc cancel";
						addPrefixed(" ", theme.fg("dim", help));
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput: (data: string) => {
						markFocused();
						handleInput(data);
					},
				};
				});
			} finally {
				attention.stop();
			}

			if (result.cancelled) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled the questionnaire (Esc). Ask the questions in plain chat before proceeding.",
						},
					],
					details: result,
				};
			}

			const byId = new Map(result.answers.map((a) => [a.id, a]));
			// Self-contained transcript: full question text + every option + the
			// complete answer, so the model never loses intent to summarization and
			// cannot re-ask the same questions.
			const body = questions
				.map((question, qi) => {
					const options = question.options
						.map((o, oi) => {
							let line = `  ${oi + 1}. ${o.label}`;
							if (o.value && o.value !== o.label) line += ` (value: ${o.value})`;
							if (o.description) line += ` — ${o.description}`;
							return line;
						})
						.join("\n");
					const multi = question.multi ? " [multi-select allowed]" : "";
					const a = byId.get(question.id);
					if (!a) {
						return `Q${qi + 1} [${question.label}]: ${question.prompt}${multi}\nOptions:\n${options}\nAnswer: (no answer)`;
					}
					const picked = a.labels
						.map((l, i) => {
							const idx = a.indices[i];
							const opt = idx ? question.options[idx - 1] : undefined;
							const value = opt?.value && opt.value !== opt.label ? ` (value: ${opt.value})` : "";
							return idx ? `${idx}. ${l}${value}` : `${l}${value}`;
						})
						.join("; ");
					const typed = a.custom.length ? `custom typed: ${a.custom.map((t) => `"${t}"`).join(", ")}` : "";
					const answer = [picked, typed].filter(Boolean).join("; ") || "(no answer)";
					return `Q${qi + 1} [${question.label}]: ${question.prompt}${multi}\nOptions:\n${options}\nAnswer: ${answer}`;
				})
				.join("\n\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `User answered ${result.answers.length}/${questions.length} questions. Full transcript:\n${body}`,
					},
				],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((x) => x.label || x.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "✖ Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) =>
				theme.fg("success", "✓ ") +
				theme.fg("accent", a.label) +
				theme.fg("dim", ": ") +
				theme.fg("text", answerSummary(a)),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
