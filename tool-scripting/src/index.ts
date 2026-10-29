/** Unified script execution and display-time renderers for current and legacy calls. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import { bashAdapter, pythonAdapter, type LanguageAdapter } from "./languages.ts";
import { runScript } from "./runner.ts";
import { ScriptCallBox, ScriptResultBox } from "./render.ts";

const parameters = Type.Object({
 mode: Type.Union([Type.Literal("bash"), Type.Literal("python")], { description: 'Required: "bash" for shell commands; "python" for Python source executed with uv.' }),
 script: Type.String({ description: "Required: complete Bash commands or raw Python source; never wrap Python in a shell heredoc." }),
 title: Type.String({ description: "Required short purpose, e.g. 'inspect build' or 'parse JSON'." }),
 dir: Type.Optional(Type.String({ description: "Working directory; relative paths resolve against the session working directory. Defaults to the session directory." })),
 timeout: Type.Optional(Type.Number({ description: "Seconds to wait, default 60; maximum 60 for bash and 120 for python. On timeout the process continues and a PID and log path are returned." })),
 deps: Type.Optional(Type.Array(Type.String(), { description: 'Python only: ephemeral PEP 508 dependencies via uv --with, e.g. ["requests", "rich>=13"].' })),
 python: Type.Optional(Type.String({ description: 'Python only: interpreter version passed to uv, e.g. "3.12".' })),
 stdin: Type.Optional(Type.String({ description: "Optional standard input for Python." })),
});

function normalized(args: Record<string, unknown>, adapter: LanguageAdapter): Record<string, unknown> {
 return { ...args, name: args.title ?? args.name ?? adapter.id, directory: args.dir ?? args.directory,
  command: adapter.id === "bash" ? args.script ?? args.command ?? args.code : undefined,
  code: adapter.id === "python" ? args.script ?? args.code : undefined };
}
function enabled(id: string): boolean {
 const s = readExtensionSettings("toolScripting") as Record<string, unknown>;
 return s.enabled !== false && s[id] !== false;
}

export default function (pi: ExtensionAPI) {
 pi.registerTool({
  name: "script", label: "Script", parameters, renderShell: "self",
  description: 'Preferred tool for shell and Python execution. Set mode="bash" for shell commands, git and process management; set mode="python" for parsing, calculations and data processing. Required: script (complete raw source) and title (short purpose). Optional: dir (relative to the session directory) and timeout (seconds to wait, NOT a kill deadline). Python runs through uv and supports deps, python version and stdin. Each call starts a separate process with Pi\'s permissions; this is not a sandbox. Output is bounded and logged. On timeout the process continues: use the returned PID and log path to follow up rather than blindly retrying.',
  promptSnippet: "Execute Bash or uv-backed Python: mode, script, title; optional dir, timeout and Python deps. Timeout hands off a running process, not a kill deadline.",
  promptGuidelines: ["Prefer script for shell and Python execution. For Python use mode=python and raw source, not bash heredocs or python -c; declare ephemeral packages in deps.", "Use read and edit for targeted file inspection and edits; use script for execution."],
  async execute(_id, args, signal, onUpdate, ctx) {
   const adapter = args.mode === "bash" ? bashAdapter : pythonAdapter;
   if (!enabled(adapter.id)) throw new Error(`${adapter.id} is disabled in /settings:tool-scripting`);
   if (args.mode === "bash" && (args.deps?.length || args.python || args.stdin !== undefined)) throw new Error("deps, python and stdin are supported only in python mode");
   return runScript(adapter, normalized(args, adapter), signal, onUpdate, { cwd: ctx.cwd });
  },
  renderCall(args, theme) { const adapter = args.mode === "python" ? pythonAdapter : bashAdapter; return new ScriptCallBox(adapter, normalized(args, adapter), theme); },
  renderResult(result, opts, theme) { const adapter = result.details?.language === "python" ? pythonAdapter : bashAdapter; return new ScriptResultBox(adapter, result, opts, theme); },
 });
 // Registered independently of tool execution: Pi can redraw old bash/python
 // entries even if those tools no longer exist. Original call and result data
 // remain the source of truth; no session history is rewritten.
 pi.registerToolRenderer((name, next) => {
  if (name !== "bash" && name !== "python") return next();
  const adapter = name === "python" ? pythonAdapter : bashAdapter;
  return {
   renderShell: "self",
   renderCall: (args, theme) => new ScriptCallBox(adapter, normalized(args as Record<string, unknown>, adapter), theme),
   renderResult: (result, opts, theme) => new ScriptResultBox(adapter, result as never, opts, theme),
  };
 });
 pi.registerCommand("settings:tool-scripting", {
  description: "Show or configure script execution: on|off, bash on|off, or python on|off. Does not disable native Bash.",
  handler: async (args, ctx) => {
   const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
   if (parts.length === 1 && ["on", "off"].includes(parts[0])) writeExtensionSettings("toolScripting", { enabled: parts[0] === "on" });
   else if (parts.length === 2 && ["bash", "python"].includes(parts[0]) && ["on", "off"].includes(parts[1])) writeExtensionSettings("toolScripting", { [parts[0]]: parts[1] === "on" });
   else if (parts.length) { ctx.ui.notify("Usage: /settings:tool-scripting [on|off|bash on|off|python on|off]", "warning"); return; }
   ctx.ui.notify(`tool-scripting: bash ${enabled("bash") ? "on" : "off"}, python ${enabled("python") ? "on" : "off"}`, "info");
  },
 });
}
