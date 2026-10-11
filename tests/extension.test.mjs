import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load the installed Pi SDK and real extension, not a stub of Pi's API.
const candidates = [
  fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
  path.join(os.homedir(), ".pi/agent/node_modules/@earendil-works/pi-coding-agent"),
  "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
];
let sdkRoot;
for (const candidate of candidates) {
  try { sdkRoot = await fs.realpath(candidate); break; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
assert.ok(sdkRoot, "Install Pi before running the functional test");
const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8"));
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(path.join(sdkRoot, manifest.exports["."].import)).href);
const environment = Object.fromEntries(["PI_QUERY_STORE_DIR", "PI_CODING_AGENT_DIR", "SETTINGS_SUBAGENTX_PATH", "LOCALAI_DB_PATH", "PATH", "QUERY_TEST_MUTATE_SOURCE", "QUERY_TEST_SYMLINK_SOURCE", "QUERY_TEST_SYMLINK_TARGET"].map((key) => [key, process.env[key]]));
const restoreEnvironment = () => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
for (const key of ["QUERY_TEST_MUTATE_SOURCE", "QUERY_TEST_SYMLINK_SOURCE", "QUERY_TEST_SYMLINK_TARGET"]) delete process.env[key];
const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const assertSchemaAgreement = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys);
const assertChapterCoverage = (text, files, lineCounts) => {
  const body = text.split("\n\nGeneration completed ")[0];
  const blocks = body.split("\n\n");
  let cursor = 0, chapterCount = 0;
  for (const file of files) {
    const count = lineCounts.get(file.path);
    for (let start = 0; start < count; start += 100) {
      const end = Math.min(start + 100, count);
      assert.equal(blocks[cursor++], file.path, "chapter files must preserve lexical rank order");
      assert.equal(blocks[cursor++], `${start}-${end}`, `missing chapter ${file.path} ${start}-${end}`);
      assert.ok(wordCount(blocks[cursor++]) >= 90 && wordCount(blocks[cursor - 1]) <= 110,
        `chapter summary should be about 100 words, got ${wordCount(blocks[cursor - 1])}`);
      chapterCount += 1;
    }
  }
  assert.equal(cursor, blocks.length, "all chapter text should be covered exactly once");
  assert.ok(chapterCount > 0);
};

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "query-extension-")));
let server;
try {
  const folder = path.join(root, "project"), store = path.join(root, "store"), source = path.join(folder, "demo.ts"), secondSource = path.join(folder, "handler-support.ts");
  const contractsFolder = path.join(root, ".pi", "subagents", "contracts");
  const agentDir = path.join(root, "agent"), libDir = path.join(agentDir, "lib");
  const sourceAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  await fs.mkdir(folder);
  await fs.mkdir(libDir, { recursive: true });
  await fs.copyFile(path.join(sourceAgentDir, "lib", "local-ai.mjs"), path.join(libDir, "local-ai.mjs"));
  await fs.copyFile(path.join(sourceAgentDir, "lib", "queued-fetch.mjs"), path.join(libDir, "queued-fetch.mjs"));
  const demoLines = Array.from({ length: 425 }, (_, index) => `const handler${String(index).padStart(3, "0")} = "handler";`);
  const supportLines = Array.from({ length: 225 }, (_, index) => `const helper${String(index).padStart(3, "0")} = "handler";`);
  const demoText = `${demoLines.join("\n")}\n`;
  const supportText = `${supportLines.join("\n")}\n`;
  await fs.writeFile(source, demoText);
  await fs.writeFile(secondSource, supportText);
  await fs.mkdir(contractsFolder, { recursive: true });
  await fs.writeFile(path.join(contractsFolder, "20260101-query-contract.md"), "# Query extension contract\nA deterministic prior contract records chapter summaries and retrieval paths.\n");

  let requestMode = "success", active = 0, maximumActive = 0, holdStarted;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
  const requestBodies = [];
  server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (requestBodies.length >= 4) releaseFirstWave();
      await firstWave;
      if (requestMode === "hold") {
        holdStarted?.();
        await new Promise((resolve) => response.once("close", resolve));
        active -= 1;
        return;
      }
      if (requestMode === "failure") {
        response.writeHead(503);
        response.end("local model unavailable");
        active -= 1;
        return;
      }
      if (requestMode === "missing-usage") {
        response.setHeader("content-type", "text/event-stream");
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "unmeasured response" } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        active -= 1;
        return;
      }
      const summary = "This chapter describes the source implementation and its relationship to surrounding code. ".repeat(8).trim();
      const usage = {
        prompt_tokens: 20,
        completion_tokens: 103,
        total_tokens: 123,
        completion_tokens_details: { reasoning_tokens: 7 },
      };
      response.setHeader("content-type", "text/event-stream");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: summary } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      active -= 1;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const settingsPath = path.join(root, "settings-subagentx.json"), localDb = path.join(root, "localai.db");
  await fs.writeFile(settingsPath, JSON.stringify({ localBackendUrl: base, localModel: "chapter-test-model", localMaxTokens: 4096 }));
  process.env.PI_QUERY_STORE_DIR = store;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.SETTINGS_SUBAGENTX_PATH = settingsPath;
  process.env.LOCALAI_DB_PATH = localDb;

  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: path.join(root, "pi-agent"), settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/sgai-query.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tool = loader.getExtensions().extensions[0].tools.get("query").definition;
  const execute = (params, signal, onUpdate) => tool.execute("functional", params, signal, onUpdate, { cwd: root });

  // Capture the real subprocess argv, then optionally mutate a source after the
  // Python query has indexed it but before the adapter verifies its SQLite hash.
  const realPython = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const binDir = path.join(root, "bin"), capturePath = path.join(root, "argv.bin"), cliOutput = path.join(root, "cli-output.json");
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "python3"),
    `#!/bin/sh\nprintf '%s\\0' "$@" > ${quote(capturePath)}\n${quote(realPython)} "$@" > ${quote(cliOutput)}\nstatus=$?\nif [ -n "${"$"}{QUERY_TEST_MUTATE_SOURCE:-}" ]; then printf 'const changed = "after-index";\\n' > "${"$"}QUERY_TEST_MUTATE_SOURCE"; fi\nif [ -n "${"$"}{QUERY_TEST_SYMLINK_SOURCE:-}" ]; then rm -f "${"$"}QUERY_TEST_SYMLINK_SOURCE"; ln -s "${"$"}QUERY_TEST_SYMLINK_TARGET" "${"$"}QUERY_TEST_SYMLINK_SOURCE"; fi\ncat ${quote(cliOutput)}\nexit "$status"\n`);
  await fs.chmod(path.join(binDir, "python3"), 0o755);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;

  const resultVariant = tool.outputSchema.anyOf.find((variant) => variant.properties?.files);
  const dryVariant = tool.outputSchema.anyOf.find((variant) => variant.properties?.pending);
  assert.ok(resultVariant && dryVariant, "output schema variants missing");
  const fileKeys = Object.keys(resultVariant.properties.files.items.properties).sort();
  const sectionKeys = Object.keys(resultVariant.properties.files.items.properties.sections.items.properties).sort();
  assert.deepEqual(fileKeys, ["bm25", "line", "mapKind", "path", "reason", "score", "sections", "tfidf"]);
  assert.deepEqual(sectionKeys, ["endLine", "line", "name", "purpose"]);
  const mapKinds = resultVariant.properties.files.items.properties.mapKind.anyOf.map((variant) => variant.const).sort();
  assert.deepEqual(mapKinds, ["fallback", "structural"]);
  const assertFile = (file) => {
    assertSchemaAgreement(file, fileKeys);
    assert.ok(mapKinds.includes(file.mapKind), `unexpected map kind: ${file.mapKind}`);
    for (const section of file.sections) assertSchemaAgreement(section, sectionKeys);
  };

  const beforeDryRun = requestBodies.length;
  const preview = await execute({ folder, dryRun: true });
  assert.deepEqual(preview.structuredContent.pending.added, [source, secondSource]);
  assertSchemaAgreement(preview.structuredContent, Object.keys(dryVariant.properties).sort());
  assert.equal(requestBodies.length, beforeDryRun, "dry run must not call LocalAI");
  await assert.rejects(fs.stat(store), { code: "ENOENT" });

  const updates = [];
  const first = await execute({ folder, question: "handler" }, undefined, (update) => updates.push(update.content[0].text));
  assert.deepEqual(first.structuredContent.sync, { updated: 2, deleted: 0, unchanged: 0 });
  assert.equal(first.structuredContent.files.length, 2);
  assert.equal(first.details, first.structuredContent, "native details and structured paths must remain the Python result");
  const firstFile = first.structuredContent.files[0];
  assert.equal(firstFile.path, source);
  assert.equal(firstFile.line, 1);
  assert.equal(firstFile.mapKind, "structural");
  assertFile(firstFile);
  first.structuredContent.files.forEach(assertFile);
  assert.deepEqual(first.structuredContent.files.map((file) => file.path), [source, secondSource]);
  assertChapterCoverage(first.content[0].text, first.structuredContent.files, new Map([[source, 425], [secondSource, 225]]));
  assert.doesNotMatch(first.content[0].text, /^\s*[-*•]/m, "normal prose must not use the former bullet/map style");
  assert.doesNotMatch(first.content[0].text, /why:|map: structural|export function handler/);
  assert.equal(first.usage.input, 8 * 20);
  assert.equal(first.usage.output, 8 * 103, "server completion totals include reasoning tokens");
  assert.equal(first.usage.reasoning, 8 * 7);
  assert.equal(first.usage.totalTokens, 8 * 123);
  assert.match(first.content[0].text, /Server-token aggregate: 824 final output tokens including reasoning/);
  assert.match(first.content[0].text, /Per-call final totals: chapter 1 \(0-100\) used 103 server-reported output tokens including reasoning in [\d.]+ seconds with \d+ progress updates/);
  assert.match(first.content[0].text, /Provisional stream rate updates:/);
  assert.ok(updates.some((text) => text.includes("Provisional per-call stream-rate")));
  assert.ok(updates.some((text) => text.includes("Server-reported final output tokens")));
  assert.equal(maximumActive, 4, "chapter calls must use four concurrent LocalAI streams");
  assert.equal(requestBodies.length, 8);
  const callsBeforeContractLookup = requestBodies.length;
  const contractLookup = await execute({ folder: contractsFolder, question: "query extension chapter summaries" });
  assert.equal(requestBodies.length, callsBeforeContractLookup, "contract lookup must skip LocalAI generation");
  assert.equal(contractLookup.content[0].text, contractLookup.structuredContent.files.map((file) => file.path).join("\n"));
  assert.equal(contractLookup.structuredContent.files.length, 1);
  for (const body of requestBodies) {
    assert.equal(body.stream, true);
    assert.equal(body.stream_options?.include_usage, true);
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.model, "chapter-test-model");
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.chat_template_kwargs.enable_thinking, true);
    assert.equal(body.chat_template_kwargs.reasoning_effort, "low");
  }

  // The Python boundary must preserve the original query bytes, and the adapter
  // must keep the Python ranked file order in its plain chapter rendering.
  const preservedQuestion = "\n\t  handler 检索\r\nsecond  line  \n";
  const captured = await execute({ folder, question: preservedQuestion });
  assert.deepEqual(captured.structuredContent.files.map((file) => file.path), first.structuredContent.files.map((file) => file.path));
  const argv = (await fs.readFile(capturePath, "utf8")).split("\0").slice(0, -1);
  assert.deepEqual(argv,
    [fileURLToPath(new URL("../cli.py", import.meta.url)), "--folder", folder, "--json", "--question", preservedQuestion]);

  // A post-index byte change and a post-index symlink swap both stop before any
  // model call, preserving snapshot integrity rather than summarizing stale data.
  let callCount = requestBodies.length;
  process.env.QUERY_TEST_MUTATE_SOURCE = source;
  await assert.rejects(execute({ folder, question: "handler" }), /no longer matches its indexed SHA-256/);
  delete process.env.QUERY_TEST_MUTATE_SOURCE;
  assert.equal(requestBodies.length, callCount, "stale bytes must be refused before generation");
  await fs.writeFile(source, demoText);
  process.env.QUERY_TEST_SYMLINK_SOURCE = source;
  process.env.QUERY_TEST_SYMLINK_TARGET = secondSource;
  await assert.rejects(execute({ folder, question: "handler" }), /symlink|changed while reading/i);
  delete process.env.QUERY_TEST_SYMLINK_SOURCE;
  delete process.env.QUERY_TEST_SYMLINK_TARGET;
  assert.equal(requestBodies.length, callCount, "symlink sources must be refused before generation");
  await fs.unlink(source);
  await fs.writeFile(source, demoText);

  await fs.writeFile(source, `// updated marker\n${demoText}`);
  const changed = await execute({ folder, question: "handler" });
  assert.deepEqual(changed.structuredContent.sync, { updated: 1, deleted: 0, unchanged: 1 });
  const changedFile = changed.structuredContent.files[0];
  assert.equal(changedFile.path, source);
  assert.equal(changedFile.line, 2);
  assert.equal(changedFile.mapKind, "structural");
  assert.deepEqual(changedFile.sections[0], { line: 1, endLine: 1, name: "preamble", purpose: "leading comments and setup" });
  assertFile(changedFile);
  assertChapterCoverage(changed.content[0].text, changed.structuredContent.files, new Map([[source, 426], [secondSource, 225]]));

  // A local backend error is never converted into an invented chapter summary.
  requestMode = "failure";
  await assert.rejects(execute({ folder, question: "handler" }), /LocalAI did not return a summary/);
  requestMode = "missing-usage";
  await assert.rejects(execute({ folder, question: "handler" }), /omitted final server token usage/);
  requestMode = "success";

  // The same AbortSignal passed to execute cancels active LocalAI requests.
  requestMode = "hold";
  const requestStarted = new Promise((resolve) => { holdStarted = resolve; });
  const controller = new AbortController();
  const cancelled = execute({ folder, question: "handler" }, controller.signal);
  await requestStarted;
  controller.abort(new Error("cancelled by extension test"));
  await assert.rejects(cancelled, /cancelled by extension test/);
  requestMode = "success";
  holdStarted = undefined;

  await fs.unlink(source);
  const deleted = await execute({ folder, question: "handler" });
  assert.equal(deleted.structuredContent.sync.deleted, 1);
  assert.deepEqual(deleted.structuredContent.files.map((file) => file.path), [secondSource]);
  await fs.unlink(secondSource);
  const empty = await execute({ folder, question: "handler" });
  assert.equal(empty.structuredContent.sync.deleted, 1);
  assert.deepEqual(empty.structuredContent.files, []);
  assert.equal(empty.content[0].text, "No lexical matches.");
  await assert.rejects(execute({ folder: "relative", dryRun: true }), /absolute/i);
  await fs.writeFile(source, "\0");
  await assert.rejects(execute({ folder, question: "handler" }), /binary/i);

  if (process.env.PI_QUERY_CHAPTER_LIVE === "1") {
    const folder = process.env.PI_QUERY_CHAPTER_FOLDER || "/home/ubuntu/src/GigaTrader-v2";
    const question = process.env.PI_QUERY_CHAPTER_QUESTION || "GigaTrader architecture ranking workers predictors analytics frontend backend";
    restoreEnvironment();
    process.env.PI_CODING_AGENT_DIR ||= path.join(os.homedir(), ".pi", "agent");
    const progress = [];
    const started = performance.now();
    const live = await execute({ folder, question }, undefined, (update) => {
      const text = update.content[0].text;
      progress.push(text);
      process.stderr.write(`${text}\n`);
    });
    const queryWallMs = performance.now() - started;
    const outputPath = `/tmp/query-chapter-live-${process.pid}-${Date.now()}.txt`;
    const reportPath = outputPath.replace(/\.txt$/, ".json");
    const output = live.content[0].text;
    const chapters = [...output.matchAll(/^\d+-\d+$/gm)].length;
    const generation = output.match(/Generation completed (\d+) chapters in ([\d.]+) seconds wall time\./);
    const aggregate = output.match(/Server-token aggregate: (\d+) final output tokens including reasoning, or ([\d.]+) tokens per second/);
    assert.ok(generation && aggregate, "live output must expose generation and server-token throughput metrics");
    const report = {
      folder,
      question,
      rankedPaths: live.structuredContent.files.map((file) => file.path),
      chapters,
      generatedChapters: Number(generation[1]),
      queryWallMs,
      generationWallSeconds: Number(generation[2]),
      usage: live.usage,
      serverOutputTokensIncludingReasoning: Number(aggregate[1]),
      aggregateServerTokensPerSecond: Number(aggregate[2]),
      perCallFinalTotals: output.match(/Per-call final totals: ([\s\S]*?)\n\nProvisional stream rate updates:/)?.[1] ?? "not available",
      progressUpdates: progress,
      provisionalRateLabels: progress.filter((text) => text.includes("Provisional per-call stream-rate")),
    };
    await fs.writeFile(outputPath, output);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`LIVE text: ${outputPath}\nLIVE metrics: ${reportPath}\nLIVE server-token aggregate: ${report.serverOutputTokensIncludingReasoning} final output tokens including reasoning in ${report.generationWallSeconds.toFixed(2)} generation seconds (${report.aggregateServerTokensPerSecond.toFixed(1)} tokens per second)`);
  }
  console.log("PASS query Pi extension: ranked plain chapters, verified source snapshots, LocalAI wire options/usage/concurrency, dry run, cancellation and explicit failures");
} finally {
  restoreEnvironment();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(root, { recursive: true, force: true });
}
