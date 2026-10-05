import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Locate the installed ESM-only host without adding duplicate runtime dependencies.
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
assert.ok(sdkRoot, "Install Pi before running the extension integration test");
const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8"));
const sdkEntry = path.join(sdkRoot, manifest.exports["."].import);
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(sdkEntry).href);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "query-extension-test-"));
const requests = [];
const model = "nemotron-3-nano-4b-fp8";
const server = createServer((request, response) => {
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: model }] }));
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    const answer = input.project_map !== undefined
      ? JSON.stringify({ answer: "The demo implements a handler.", files: [{ path: "demo.ts", reason: "Handler entry point" }], limitations: ["Read exact handler before editing"] })
      : "Demo module exports handler; accepts a request and returns a response.";
    response.setHeader("content-type", "text/event-stream");
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SETTINGS_SUBAGENTX_PATH = path.join(root, "settings.json");
  process.env.LOCALAI_DB_PATH = path.join(root, "usage.db");
  process.env.PI_QUERY_STORE_DIR = path.join(root, "indexes");
  await fs.writeFile(process.env.SETTINGS_SUBAGENTX_PATH, JSON.stringify({
    localBackendUrl: `http://127.0.0.1:${server.address().port}/v1`,
    localModel: model, localMaxTokens: 4096, reasoningEffort: "low",
  }));
  const folder = path.join(root, "project");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "demo.ts"), "export function handler(request) { return request; }");
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/sgai-query.ts", import.meta.url))],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tool = loaded.extensions[0].tools.get("query")?.definition;
  assert.ok(tool, "Pi resource loader must register query");
  assert.equal(tool.name, "query");
  assert.ok(tool.promptGuidelines[0].includes("highest preference"));
  assert.ok(tool.outputSchema);
  assert.ok(tool.parameters.required.includes("folder"));
  const preview = await tool.execute("dry", { folder: "project", dryRun: true }, undefined, undefined, { cwd: root });
  assert.equal(preview.structuredContent.dryRun, true);
  assert.deepEqual(preview.structuredContent.pending.added, ["demo.ts"]);
  assert.equal(requests.length, 0);
  await assert.rejects(fs.stat(process.env.PI_QUERY_STORE_DIR), { code: "ENOENT" });
  await assert.rejects(tool.execute("missing", { question: "where?" }, undefined, undefined, { cwd: root }), /folder/i);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: path.join(root, "agent"),
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(root),
  });
  try {
    assert.ok(session.getActiveToolNames().includes("query"), "query must be active by default");
    assert.ok(session.getActiveToolNames().includes("read"), "read must remain available");
    assert.ok(session.systemPrompt.includes("Give query highest preference"), "discovery preference must reach the model");
  } finally {
    session.dispose();
  }
  const progress = [];
  const result = await tool.execute("test", { question: "Where is handler?", folder: "project" }, new AbortController().signal,
    (update) => progress.push(update), { cwd: root });
  assert.equal(result.structuredContent.folder, folder);
  assert.equal(result.structuredContent.files[0].path, "demo.ts");
  assert.ok(result.content[0].text.includes("Demo module exports handler"));
  assert.equal(result.usage.totalTokens, 60);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((body) => body.model === model && body.chat_template_kwargs.enable_thinking === false && body.reasoning_effort === "low"));
  assert.equal(requests[0].response_format, undefined, "summaries remain plain text");
  assert.equal(requests[1].response_format.type, "json_schema", "answer must use constrained output");
  const schema = requests[1].response_format.json_schema.schema;
  assert.deepEqual(schema.required, ["answer", "files", "limitations"]);
  assert.deepEqual(schema.properties.files.items.properties.path.enum, ["demo.ts"], "grammar must restrict paths to the actual source map");
  assert.ok(progress.length >= 3);
  const second = await tool.execute("second", { folder: ".", question: "Explain handler" }, new AbortController().signal, undefined, { cwd: folder });
  assert.equal(second.structuredContent.sync.updated, 0);
  assert.equal(requests.length, 3);
  const beforeLegacy = requests.length;
  await fs.writeFile(process.env.SETTINGS_SUBAGENTX_PATH, JSON.stringify({
    localBackendUrl: `http://127.0.0.1:${server.address().port}/v1`,
    localModel: "granite-4.2-3b-fp8",
  }));
  await assert.rejects(tool.execute("legacy", { folder: ".", question: "Refuse the retired model" }, undefined, undefined, { cwd: folder }), /Unsupported local model/);
  assert.equal(requests.length, beforeLegacy, "a retired model must be refused before any backend call");
  await fs.writeFile(process.env.SETTINGS_SUBAGENTX_PATH, JSON.stringify({ localBackendUrl: "https://example.com/v1" }));
  await assert.rejects(tool.execute("remote", { folder: ".", question: "No uploads" }, undefined, undefined, { cwd: folder }), /loopback/);
  console.log("query extension integration OK (mock SGLang, real LocalAI, registration, preference, usage, model gate and folder scope)");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
