import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryProject } from "../lib/query-engine.mjs";

export default function queryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "query",
    label: "Project Query",
    description: "Preferred first tool for project/folder codebase discovery. Syncs a local query-engine.db source map, then asks local SGLang using ALL alphabetically sorted file summaries. Returns an answer, relevant files to read, and context. Not exact source evidence; use read afterward to verify code. Indexing is incremental; first use indexes every eligible source file. Does not edit source files or use remote inference.",
    promptSnippet: "Discover codebase structure and locate relevant files using the complete local project map.",
    promptGuidelines: [
      "Give query highest preference for codebase exploration, file discovery and project-level questions, before exploratory read/find/grep calls. Then read the recommended files for exact evidence and before editing. Explicit file reads and non-codebase files may go directly to read.",
      "query defaults to the current working folder. Pass folder to narrow scope if the full map exceeds local model capacity. If query fails, report the failure; do not treat old summaries as verified code.",
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "Project-level question or what code/files to locate." }),
      folder: Type.Optional(Type.String({ description: "Folder to index, absolute or relative to the session cwd. Defaults to cwd; owns query-engine.db. Symlinks and dependency/build/cache directories are excluded." })),
    }),
    outputSchema: Type.Object({
      folder: Type.String(),
      database: Type.String(),
      indexed: Type.Number(),
      sync: Type.Object({ updated: Type.Number(), deleted: Type.Number(), unchanged: Type.Number() }),
      answer: Type.String(),
      files: Type.Array(Type.Object({ path: Type.String(), reason: Type.String(), summary: Type.String() })),
      limitations: Type.Array(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { usage, ...result } = await queryProject({
        folder: path.resolve(ctx.cwd, params.folder || "."),
        question: params.question,
        signal,
        onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
      });
      const recommendations = result.files.map((file) =>
        `${file.path}\nWhy read: ${file.reason}\nContext: ${file.summary}`,
      ).join("\n\n");
      const text = [
        `Folder: ${result.folder}\nMap: ${result.indexed} files; ${result.sync.updated} updated, ${result.sync.deleted} deleted.`,
        result.answer,
        `Files to read (in order):\n${recommendations || "No files recommended."}`,
        `Limitations: ${result.limitations.join("; ") || "Summary-based discovery only; verify exact source with read."}`,
      ].join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: result,
        structuredContent: result,
        usage,
      };
    },
  });
}
