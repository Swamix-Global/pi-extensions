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

const sectionSchema = Type.Object({
  line: Type.Number({ description: "1-based first physical line of the section." }),
  endLine: Type.Number({ description: "1-based inclusive last physical line of the section." }),
  name: Type.String({ description: "Declaration, heading or grouped construct name." }),
  purpose: Type.String({ description: "Short intent of the declaration or heading, not a semantic summary; shortened toward the soft per-file word budget." }),
});

const fileSchema = Type.Object({
  path: Type.String({ description: "Absolute path of the matched source file." }),
  reason: Type.String({ description: "Why the file matched: query-term coverage, path boost and strongest line." }),
  score: Type.Number({ description: "Fused reciprocal-rank-fusion score." }),
  bm25: Type.Number({ description: "Raw corpus BM25 score." }),
  tfidf: Type.Number({ description: "Raw sublinear TF-IDF cosine score." }),
  line: Type.Number({ description: "1-based strongest matching source line, not a section boundary." }),
  mapKind: Type.Union([Type.Literal("structural"), Type.Literal("fallback")], {
    description: "Structural when AST or lexical declaration detection applies; fallback blank-line blocks for unsupported or unparsable syntax.",
  }),
  sections: Type.Array(sectionSchema, {
    description: "Compact whole-file map: contiguous sections covering every physical line, never verbatim bodies; names and ranges are always kept while purposes shorten toward a soft roughly-hundred-word per-file allowance.",
  }),
});

const resultSchema = Type.Object({
  dryRun: Type.Literal(false, { description: "False for a normal query result." }),
  folder: Type.String({ description: "Canonical absolute folder that was indexed." }),
  database: Type.String({ description: "Absolute path of the store database for this folder." }),
  indexed: Type.Number({ description: "Indexed source file count." }),
  sync: syncSchema,
  answer: Type.String({ description: "Local lexical retrieval result, not a generated semantic answer." }),
  files: Type.Array(fileSchema),
  limitations: Type.Array(Type.String()),
});

// Render every nonblank line as a bullet: file path/reason plus indented line-range/name/purpose sections.
function renderResult(result: any): string {
  const lines = [
    `- Folder: ${result.folder}`,
    `- Store: ${result.database}`,
    `- Index: ${result.indexed} files (${result.sync.updated} updated, ${result.sync.deleted} deleted, ${result.sync.unchanged} unchanged).`,
    `- ${result.answer}`,
    "- File maps (in order):",
  ];
  for (const file of result.files) {
    lines.push(`- ${file.path}:${file.line}`);
    lines.push(`  - why: ${file.reason}`);
    lines.push(`  - map: ${file.mapKind}`);
    for (const section of file.sections) {
      lines.push(`  - ${section.line}-${section.endLine} ${section.name}: ${section.purpose}`);
    }
  }
  lines.push(`- Limitations: ${result.limitations.join("; ")}`);
  return lines.join("\n");
}

export default function queryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "query",
    label: "Project Query",
    description: "Preferred codebase discovery tool; requires an absolute folder. Scans source/build files (including C++, batch and shell) plus named project Markdown; excludes data/config and incidental prose. Ranks fresh full text using BM25 + TF-IDF/RRF and returns up to ten compact bullet maps: absolute path, section line ranges, names and purposes. Targets about 100 name/purpose words per file without dropping detected sections; unsupported syntax uses labeled fallback blocks. No source-body excerpts, models or network. Preserves SHA-256-only SQLite freshness and stale-row replacement. dryRun:true previews changes without writes. Maps are navigation aids, not semantic answers; read complete files before editing. Contract discovery reuses this same API: a canonical cwd/.pi/subagents/contracts root indexes every Markdown contract and skips Git-ignore checks while *.claim/ stays unscanned; lexical BM25 + TF-IDF/RRF matches (not vector embeddings) select at most three completed contract outputs. SubagentX supplies their full contents verbatim inside XML-delimited, subordinate reference context in the child user message before the current task. The question is forwarded to Python verbatim — whitespace, Unicode and line endings unchanged — so keep the original query in the child task.",
    promptSnippet: "Find relevant source files locally with BM25 + TF-IDF and compact whole-file maps.",
    promptGuidelines: [
      "Give query highest preference for codebase exploration, file discovery and project-level questions, before exploratory read/find/grep calls. Then read the recommended files for exact evidence and before editing. Explicit file reads and non-codebase files may go directly to read.",
      "Always pass an absolute folder path; relative paths are rejected. dryRun:true previews hash changes and the absolute store path without writes; question may be omitted.",
      "query returns compact whole-file structural maps of roughly a hundred words per file, never verbatim source bodies and never a semantic model answer. Read the complete recommended files before editing. If query fails, report it; never use stale rows as evidence.",
      "The index holds source and build text plus curated project Markdown only; data, config and unlisted Markdown are absent, so use explicit file reads for them.",
      "Contract discovery reuses this existing query API, not a separate tool: only a canonical cwd/.pi/subagents/contracts root indexes all Markdown and skips Git-ignore checks while *.claim/ stays unscanned; lexical BM25 + TF-IDF/RRF matches (not vector embeddings) guide launch filtering to at most three completed contract outputs. SubagentX supplies their full contents verbatim inside XML-delimited, subordinate reference context in the child user message before the current TASK. The question is forwarded to Python verbatim — whitespace, Unicode and line endings unchanged, trimmed only for the non-empty check — so keep the original query in the child task.",
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
      const question = typeof params.question === "string" ? params.question : "";
      if (!dryRun && !question.trim()) throw new Error("question is required unless dryRun is true.");
      const folder = rawFolder;
      onUpdate?.({ content: [{ type: "text", text: dryRun ? "Planning hash sync offline…" : "Syncing file hashes and ranking sources locally…" }], details: undefined });
      const args = [cli, "--folder", folder, "--json", ...(dryRun ? ["--dry-run"] : ["--question", question])];
      const process = await pi.exec("python3", args, { signal });
      if (process.code !== 0) throw new Error(process.stderr || process.stdout || "Python query engine failed");
      const result = JSON.parse(process.stdout);
      const text = dryRun
        ? `Folder: ${result.folder}\nStore: ${result.database}\nDry run: ${result.eligible} eligible files\n${JSON.stringify(result.pending, null, 2)}`
        : renderResult(result);
      return {
        content: [{ type: "text", text }],
        details: result,
        structuredContent: result,
      };
    },
  });
}
