import assert from "node:assert/strict";
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
const store = path.join(root, "store");
try {
  const folder = path.join(root, "project");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "demo.ts"), "export function handler(request) { return request; }\n");

  // Load the real extension through the supported Pi SDK resource loader.
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

  // Registration and schema contract.
  const tool = loaded.extensions[0].tools.get("query")?.definition;
  assert.ok(tool, "Pi resource loader must register query");
  assert.equal(tool.name, "query");
  assert.ok(tool.promptGuidelines[0].includes("highest preference"));
  assert.ok(tool.outputSchema, "query must declare an output schema");
  assert.deepEqual(tool.parameters.required, ["folder"]);
  assert.ok(tool.parameters.properties.folder.minLength >= 1);
  assert.ok(!tool.parameters.required.includes("question"));
  assert.ok(!tool.parameters.required.includes("dryRun"));
  const variants = tool.outputSchema.anyOf;
  assert.ok(Array.isArray(variants) && variants.length === 2, "output schema must cover dry-run and query results");
  assert.equal(variants[0].properties.dryRun.const, true);
  assert.equal(variants[1].properties.dryRun.const, false);
  assert.ok(variants[0].properties.pending, "dry-run variant must expose pending changes");
  assert.ok(variants[1].properties.answer, "query variant must expose the answer");

  // Run the offline dry run through the extension's Python subprocess.
  process.env.PI_QUERY_STORE_DIR = store;
  const preview = await tool.execute("dry", { folder: "project", dryRun: true }, undefined, undefined, { cwd: root });
  assert.equal(preview.structuredContent.dryRun, true);
  assert.equal(preview.structuredContent.folder, await fs.realpath(folder));
  assert.equal(preview.structuredContent.indexed, 0);
  assert.equal(preview.structuredContent.eligible, 1);
  assert.deepEqual(preview.structuredContent.pending.added, ["demo.ts"]);
  assert.deepEqual(preview.structuredContent.sync, { updated: 1, deleted: 0, unchanged: 0 });
  assert.ok(preview.structuredContent.database.startsWith(store + path.sep), "store path must honor PI_QUERY_STORE_DIR");
  assert.match(preview.content[0].text, /Dry run: 1 eligible files/);
  assert.equal(preview.structuredContent.answer, undefined, "dry runs must not perform inference");

  // A plan must leave no cache behind.
  await assert.rejects(fs.stat(store), { code: "ENOENT" });
  await assert.rejects(tool.execute("missing", {}, undefined, undefined, { cwd: root }), /folder/i);

  console.log("query extension smoke OK (Pi SDK loader registration, schemas, offline Python dry run, no store writes)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
