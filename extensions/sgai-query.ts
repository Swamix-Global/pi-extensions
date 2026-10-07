import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.py", import.meta.url));

const syncSchema = Type.Object({
  updated: Type.Number({ description: "Files added or hash-reindexed (planned count in dry runs)." }),
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
  answer: Type.String({ description: "Local lexical retrieval result, not a generated semantic answer." }),
  files: Type.Array(Type.Object({
    path: Type.String(),
    reason: Type.String(),
    score: Type.Number(),
    bm25: Type.Number(),
    tfidf: Type.Number(),
    line: Type.Number(),
    excerpt: Type.String(),
  })),
  limitations: Type.Array(Type.String()),
});

export default function queryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "query",
    label: "Project Query",
    description: "Preferred first tool for codebase discovery. Requires an absolute folder path. Synchronizes a minimal per-folder SQLite cache of absolute file paths and SHA-256 content hashes, deleting stale rows before reindexing. Ranks fresh full source text locally with corpus BM25 + TF-IDF fused by RRF; returns up to ten matching absolute paths and verbatim excerpts. No summarizer, models, API keys or network. Use dryRun:true to preview hash changes without writes. Never edits sources; read complete files before editing.",
    promptSnippet: "Find relevant source files locally with BM25 + TF-IDF and hash-only freshness.",
    promptGuidelines: [
      "Give query highest preference for codebase exploration, file discovery and project-level questions, before exploratory read/find/grep calls. Then read the recommended files for exact evidence and before editing. Explicit file reads and non-codebase files may go directly to read.",
      "Always pass an absolute folder path; relative paths are rejected. dryRun:true previews hash changes and the absolute store path without writes; question may be omitted.",
      "query returns lexical matches and bounded source excerpts, not a semantic model answer. Read the complete recommended files before editing. If query fails, report it; never use stale rows as evidence.",
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      folder: Type.String({
        minLength: 1,
        description: "Required absolute folder path. Relative paths are rejected. Owns a cache entry keyed by its canonical path.",
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
    async execute(_id, params, signal, onUpdate, _ctx) {
      const rawFolder = typeof params.folder === "string" ? params.folder : "";
      if (!rawFolder.trim() || !path.isAbsolute(rawFolder)) throw new Error("folder must be a non-empty absolute path.");
      if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
      const dryRun = params.dryRun === true;
      const rawQuestion = typeof params.question === "string" ? params.question.trim() : "";
      if (!dryRun && !rawQuestion) throw new Error("question is required unless dryRun is true.");
      const folder = rawFolder;
      onUpdate?.({ content: [{ type: "text", text: dryRun ? "Planning hash sync offline…" : "Syncing file hashes and ranking sources locally…" }], details: undefined });
      const args = [cli, "--folder", folder, "--json", ...(dryRun ? ["--dry-run"] : ["--question", rawQuestion])];
      const process = await pi.exec("python3", args, { signal });
      if (process.code !== 0) throw new Error(process.stderr || process.stdout || "Python query engine failed");
      const result = JSON.parse(process.stdout);
      const text = dryRun
        ? `Folder: ${result.folder}\nStore: ${result.database}\nDry run: ${result.eligible} eligible files\n${JSON.stringify(result.pending, null, 2)}`
        : `Folder: ${result.folder}\nStore: ${result.database}\n${result.answer}\n\nFiles to read (in order):\n${result.files.map((file) => `${file.path}:${file.line}\nWhy read: ${file.reason}\nExcerpt:\n${file.excerpt}`).join("\n\n")}\n\nLimitations: ${result.limitations.join("; ")}`;
      return {
        content: [{ type: "text", text }],
        details: result,
        structuredContent: result,
      };
    },
  });
}
