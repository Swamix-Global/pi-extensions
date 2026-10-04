#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { queryProject } from "./lib/query-engine.mjs";
import { formatDry, formatNormal } from "./lib/format-result.mjs";
export { formatDry, formatNormal } from "./lib/format-result.mjs";

const USAGE = `Usage: node cli.mjs --folder PATH [--question QUESTION | --dry-run] [--json]

Run the local query engine from the command line. The engine caches eligible
source summaries for a folder and answers a question using local SGLang
inference. Summaries are discovery context, not exact source evidence.

Required:
  --folder PATH        Folder to index and query. Required and non-empty.
                       Relative paths resolve from the current working directory.

Query:
  --question QUESTION  Non-empty question to answer. Required unless --dry-run
                       is used.
  --dry-run            Plan only: scan the folder and report pending cache
                       changes. Performs no writes, no inference and no network
                       calls.

Output:
  --json               Print exactly one JSON document to stdout. Progress and
                       errors go to stderr; execution failures also return
                       {"error":"..."} on stdout.
  -h, --help           Show this help text and exit 0.

Storage:
  Summaries are cached under PI_QUERY_STORE_DIR, defaulting to
  <agent-dir>/query-engine (default ~/.pi/agent/query-engine), keyed by the
  canonical folder path (SHA-256). PI_CODING_AGENT_DIR changes <agent-dir>.
  Each folder owns one database. Legacy project-local caches are not migrated.

Filtering:
  Eligible extensions include py, js, mjs, cjs, ts, tsx, jsx, md, html, css,
  svelte, txt, sh, bash, yaml, yml and toml. Dependency, build and cache
  directories such as node_modules, .git, dist and build are skipped. Symlinks,
  and tokenizer vocabulary tables are skipped. Binary/invalid UTF-8 files with
  eligible extensions fail explicitly. No .gitignore filtering; README.md
  documents all exclusions and limits.

Exit codes:
  0  success
  1  execution error (engine or inference failed)
  2  bad arguments (missing, duplicate or unknown options)

Examples:
  node cli.mjs --folder ./src --question "Where is authentication checked?"
  node cli.mjs --folder ./src --dry-run --json
  node cli.mjs --help
`;

class UsageError extends Error {}

const VALUE_FLAGS = new Map([
  ["--folder", "folder"],
  ["--question", "question"],
]);
const BOOLEAN_FLAGS = new Map([
  ["--dry-run", "dryRun"],
  ["--json", "json"],
  ["--help", "help"],
  ["-h", "help"],
]);

export function parseArgs(argv) {
  const options = { folder: undefined, question: undefined, dryRun: false, json: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`);
      const name = BOOLEAN_FLAGS.get(flag);
      if (seen.has(name)) throw new UsageError(`Duplicate option: ${flag}`);
      seen.add(name);
      options[name] = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const name = VALUE_FLAGS.get(flag);
      if (seen.has(name)) throw new UsageError(`Duplicate option: ${flag}`);
      seen.add(name);
      let value = inline;
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value === "" || value.startsWith("--") || value === "-h") {
          throw new UsageError(`Missing value for ${flag}`);
        }
        index++;
      }
      if (value === "") throw new UsageError(`Missing value for ${flag}`);
      options[name] = value;
      continue;
    }
    if (raw.startsWith("-")) throw new UsageError(`Unknown option: ${raw}`);
    throw new UsageError(`Unexpected argument: ${raw}`);
  }
  return options;
}

export function validate(options) {
  if (options.help) return;
  if (!options.folder || !options.folder.trim()) {
    throw new UsageError("--folder is required and must be a non-empty path");
  }
  if (!options.dryRun && (!options.question || !options.question.trim())) {
    throw new UsageError("--question is required (non-empty) unless --dry-run is used");
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (argv.length === 0) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    validate(options);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  const folder = path.resolve(process.cwd(), options.folder);
  const question = options.question?.trim();
  const onProgress = (text) => stderr.write(`[query] ${text}\n`);
  try {
    const result = options.dryRun
      ? await queryProject({ folder, dryRun: true, onProgress })
      : await queryProject({ folder, question, onProgress });
    if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
    else stdout.write(`${options.dryRun ? formatDry(result) : formatNormal(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) stdout.write(`${JSON.stringify({ error: message })}\n`);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
