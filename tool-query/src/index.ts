import { fileURLToPath } from "node:url";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

const cli = fileURLToPath(new URL("../cli.py", import.meta.url));

const spanSchema = Type.Object({
  lines: Type.String({ description: "1-based inclusive 'start-end' file lines." }),
  quote: Type.String({ description: "Verbatim lines rebuilt from the file; ends with an ellipsis line when truncated." }),
  claims: Type.Array(Type.String(), { description: "One-sentence model readings grounded in the quoted lines." }),
  truncated: Type.Boolean({ description: "True when the span quote was shortened for compactness." }),
});

const evidencePacketSchema = Type.Object({
  folder: Type.String({ description: "Canonical absolute folder that was scanned." }),
  question: Type.String({ description: "The question the fanout answered." }),
  model: Type.String({ description: "Local model id used for extraction." }),
  scannedFiles: Type.Number({ description: "Eligible source files found by the deterministic scanner." }),
  windowsSearched: Type.Number({ description: "125-line windows sent to extraction." }),
  filesSearched: Type.Number({ description: "Distinct files behind those windows." }),
  searchedWindows: Type.Array(Type.Object({
    path: Type.String({ description: "Absolute path of the window." }),
    lines: Type.String({ description: "'start-end' line range of the window." }),
  }), { description: "Exactly which windows were searched, for coverage audit." }),
  evidence: Type.Array(Type.Object({
    path: Type.String({ description: "Absolute file path owning the spans." }),
    spans: Type.Array(spanSchema, { description: "Validated, deduplicated evidence spans." }),
  }), { description: "Per-file validated evidence; empty when nothing verifiable was found." }),
  unknowns: Type.Array(Type.String(), { description: "Observed gaps named by extraction windows." }),
  stats: Type.Object({
    findingsAccepted: Type.Number({ description: "Findings whose quotes located verbatim." }),
    findingsRejected: Type.Number({ description: "Findings dropped: fabricated quotes, bad claims, absence statements." }),
    windowsFailed: Type.Number({ description: "Windows whose extraction failed after retry." }),
    windowErrors: Type.Array(Type.String(), { description: "First few window failure reasons." }),
  }),
  usage: Type.Object({
    input: Type.Number({ description: "Server-reported prompt tokens." }),
    output: Type.Number({ description: "Server-reported completion tokens." }),
    cached: Type.Number({ description: "Server-reported cached prompt tokens." }),
    requests: Type.Number({ description: "Fresh inference requests made." }),
    cacheHits: Type.Number({ description: "Windows served from the content-hash evidence cache." }),
    elapsedSeconds: Type.Number({ description: "Wall time of the fanout." }),
  }),
  limitations: Type.Array(Type.String(), { description: "Standing caveats: claims are model readings, not runtime proof." }),
});

const fileEntrySchema = Type.Object({
  path: Type.String({ description: "Absolute eligible file path." }),
  lines: Type.Number({ description: "Physical line count." }),
});

const listSchema = Type.Object({
  folder: Type.String({ description: "Canonical absolute folder that was scanned." }),
  eligible: Type.Number({ description: "Number of eligible files." }),
  files: Type.Array(fileEntrySchema, { description: "Every eligible file with line counts." }),
});

function asUsage(usage: any) {
  const input = Number(usage?.input ?? 0);
  const output = Number(usage?.output ?? 0);
  return {
    input,
    output,
    cacheRead: Number(usage?.cached ?? 0),
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export default function toolQueryExtension(pi: ExtensionAPI) {
  const toolDefinition = {
    label: "tool-query",
    description:
      'Compile a source-verified evidence packet for one question about a folder: deterministic windows are selected by question terms, then a local model cites line ranges in parallel and quotes are rebuilt from the files themselves — verbatim by construction, with bad ranges and absence claims rejected. Scenario styles that work well: curiosity — {"folder":"/abs/repo","question":"how does request cancellation tear down child processes"}; refactor impact — {"folder":"/abs/repo","question":"if sendUserMessage signature changes, which callers and tests are affected"}; failure behavior — {"folder":"/abs/repo","question":"what happens when the formatter listener never replies"}. Phrase questions with concrete symbols and one intent; quotes cite exact lines, so read those spans before editing. Enumerate eligible files without model calls with {"folder":"/abs/repo","listFiles":true}.',
    promptSnippet: "Fanout one question across deterministic code windows; get verbatim-validated line-cited evidence packets.",
    promptGuidelines: [
      "One question per call, phrased with concrete symbols: 'how does X work', 'what does changing X affect', 'where is Y decided', 'what happens if X fails'. Broad multi-part questions dilute window selection.",
      "Evidence quotes are verbatim validated file lines; claims are model readings. Read the cited spans with read before editing, and treat unknowns as observed gaps to follow up.",
      "searchedWindows lists exactly which 125-line windows were searched; when the answer seems incomplete, re-ask with narrower terms rather than repeating the same question.",
      "Use listFiles:true to enumerate eligible files first when unsure the folder is the right scope; the scanner reads source and build files plus selected project Markdown only.",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      folder: Type.String({
        minLength: 1,
        description: "Absolute folder to scan, e.g. /home/ubuntu/src/sgai-pi/subagent-pack. Choose the owning folder, not a parent, so windows stay on topic.",
      }),
      question: Type.Optional(Type.String({
        minLength: 1,
        description: "One concrete question with real symbol names: 'how does formattedMarkdown request the shared formatter event'. Required unless listFiles is true.",
      })),
      listFiles: Type.Optional(Type.Boolean({
        description: "Enumerate eligible files with line counts; no model calls.",
      })),
      windows: Type.Optional(Type.Number({
        minimum: 2, maximum: 24,
        description: "Window budget, 2-24 (default 12). Each 125-line window is one bounded extraction request.",
      })),
      concurrency: Type.Optional(Type.Number({
        minimum: 2, maximum: 32,
        description: "Parallel extraction requests, 2-32 (default 12).",
      })),
    }),
    outputSchema: Type.Union([evidencePacketSchema, listSchema]),
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("tool-query ")) + theme.fg("accent", args.folder || "…") +
        "\n" + theme.fg("muted", args.listFiles ? "enumerate eligible files" : args.question || "…"),
        0, 0,
      );
    },
    renderResult(result: any, { expanded, isPartial }: any, theme: any) {
      const text = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      if (isPartial) return new Text(theme.fg("muted", text.split("\n")[0] + " …"), 0, 0);
      const lines = text.split("\n");
      const shown = expanded ? lines : lines.slice(0, 24);
      const view = new Container();
      view.addChild(new Markdown("```yaml\n" + shown.join("\n") + (shown.length < lines.length ? "\n… expand for the full packet" : "") + "\n```", 0, 0, getMarkdownTheme()));
      return view;
    },
    async execute(_id: string, params: any, signal: any) {
      const rawFolder = typeof params.folder === "string" ? params.folder : "";
      if (!rawFolder.trim() || !path.isAbsolute(rawFolder)) throw new Error("folder must be a non-empty absolute path.");
      const listFiles = params.listFiles === true;
      const question = typeof params.question === "string" ? params.question : "";
      if (!listFiles && !question.trim()) throw new Error("question is required unless listFiles is true.");
      const args = [cli, "--folder", rawFolder, "--json"];
      if (listFiles) {
        args.push("--list");
      } else {
        args.push("--question", question,
                  "--windows", String(params.windows ?? 12),
                  "--concurrency", String(params.concurrency ?? 12));
      }
      const process = await pi.exec("python3", args, { signal });
      if (process.code !== 0) throw new Error(process.stderr || process.stdout || "Python evidence engine failed");
      const parsed = JSON.parse(process.stdout);
      if (parsed && typeof parsed === "object" && "error" in parsed) throw new Error(String(parsed.error));
      const yamlText = typeof parsed.yaml === "string" ? parsed.yaml : JSON.stringify(parsed, null, 2);
      const structured = { ...parsed };
      delete structured.yaml;
      return {
        content: [{ type: "text", text: yamlText.trimEnd() }],
        details: structured,
        structuredContent: structured,
        ...(structured.usage ? { usage: asUsage(structured.usage) } : {}),
      };
    },
  };

  pi.registerTool({ name: "evidence", ...toolDefinition });
  pi.registerTool({ name: "query", ...toolDefinition });
}
