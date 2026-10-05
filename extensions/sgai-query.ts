import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryProject } from "../lib/query-engine.mjs";
import { formatDry, formatNormal } from "../lib/format-result.mjs";

const syncSchema = Type.Object({
  updated: Type.Number({ description: "Files added or re-summarized (planned count in dry runs)." }),
  deleted: Type.Number({ description: "Cached files removed (planned count in dry runs)." }),
  unchanged: Type.Number({ description: "Files whose content hash already matched the cache." }),
});

const pendingSchema = Type.Object({
  added: Type.Array(Type.String(), { description: "Eligible source paths not yet in the cache." }),
  changed: Type.Array(Type.String(), { description: "Eligible source paths whose content hash changed." }),
  deleted: Type.Array(Type.String(), { description: "Cached paths no longer present on disk." }),
  unchanged: Type.Array(Type.String(), { description: "Cached paths whose content hash still matches." }),
});

const dryRunSchema = Type.Object({
  dryRun: Type.Literal(true, { description: "True for a planning result." }),
  folder: Type.String({ description: "Canonical absolute folder that was scanned." }),
  database: Type.String({ description: "Absolute path of the store database for this folder." }),
  indexed: Type.Number({ description: "Cached row count before this sync." }),
  eligible: Type.Number({ description: "Eligible source files found on disk." }),
  pending: pendingSchema,
  sync: syncSchema,
});

const resultSchema = Type.Object({
  dryRun: Type.Literal(false, { description: "False for a normal query result." }),
  folder: Type.String({ description: "Canonical absolute folder that was indexed." }),
  database: Type.String({ description: "Absolute path of the store database for this folder." }),
  indexed: Type.Number({ description: "Indexed source file count." }),
  sync: syncSchema,
  answer: Type.String({ description: "Summary-based answer to the question." }),
  files: Type.Array(Type.Object({
    path: Type.String(),
    reason: Type.String(),
    summary: Type.String(),
  })),
  limitations: Type.Array(Type.String()),
});

export default function queryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "query",
    label: "Project Query",
    description: "Preferred first tool for project/folder codebase discovery. Indexes eligible source files into a per-folder cache under the global store (~/.pi/agent/query-engine, overridable with PI_QUERY_STORE_DIR), then asks local Nemotron through SGLang using ALL alphabetically sorted file summaries. Returns an answer, relevant files to read in order, and context. folder is required and resolved relative to the session cwd. Use dryRun:true to preview pending added/changed/deleted files, counts and the store path with no writes, no inference and no network. Not exact source evidence; use read afterward to verify code. Never edits source files and never uses remote inference.",
    promptSnippet: "Discover codebase structure and locate relevant files using the complete local project map.",
    promptGuidelines: [
      "Give query highest preference for codebase exploration, file discovery and project-level questions, before exploratory read/find/grep calls. Then read the recommended files for exact evidence and before editing. Explicit file reads and non-codebase files may go directly to read.",
      "Always pass folder (absolute or relative to the session cwd); it is required and selects the folder whose per-folder cache is used. Use dryRun:true to preview pending added/changed/deleted/unchanged files and the store path before a slow first index; dry runs perform no writes, no inference and no network calls and may omit question.",
      "query returns summary-based discovery, not exact source evidence. If query fails, report the failure; do not treat old summaries as verified code.",
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      folder: Type.String({
        minLength: 1,
        description: "Required folder to index and query. Absolute or relative to the session cwd. Owns a cache entry keyed by its canonical path.",
      }),
      question: Type.Optional(Type.String({
        minLength: 1,
        description: "Project-level question, or the code and files to locate. Required (non-empty) unless dryRun is true.",
      })),
      dryRun: Type.Optional(Type.Boolean({
        description: "When true, only scan the folder and report pending cache changes (added, changed, deleted, unchanged), counts and the store path. No writes, inference or network calls; question may be omitted.",
      })),
    }),
    outputSchema: Type.Union([dryRunSchema, resultSchema]),
    async execute(_id, params, signal, onUpdate, ctx) {
      const rawFolder = typeof params.folder === "string" ? params.folder : "";
      if (!rawFolder.trim()) throw new Error("folder is required and must be a non-empty path.");
      if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
      const dryRun = params.dryRun === true;
      const rawQuestion = typeof params.question === "string" ? params.question.trim() : "";
      if (!dryRun && !rawQuestion) throw new Error("question is required unless dryRun is true.");
      const folder = path.resolve(ctx.cwd, rawFolder);
      const onProgress = (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
      if (dryRun) {
        const result = await queryProject({ folder, dryRun: true, signal, onProgress });
        return {
          content: [{ type: "text", text: formatDry(result) }],
          details: result,
          structuredContent: result,
        };
      }
      const { usage, ...result } = await queryProject({ folder, question: rawQuestion, signal, onProgress });
      return {
        content: [{ type: "text", text: formatNormal(result) }],
        details: result,
        structuredContent: result,
        usage,
      };
    },
  });
}
