import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "query-extension-")));
const previousStore = process.env.PI_QUERY_STORE_DIR;
try {
  const folder = path.join(root, "project"), store = path.join(root, "store"), source = path.join(folder, "demo.ts");
  await fs.mkdir(folder);
  await fs.writeFile(source, "export function handler(request) { return request; }\n");
  process.env.PI_QUERY_STORE_DIR = store;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: path.join(root, "agent"), settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/sgai-query.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tool = loader.getExtensions().extensions[0].tools.get("query").definition;
  const execute = (params) => tool.execute("functional", params, undefined, undefined, { cwd: root });

  const preview = await execute({ folder, dryRun: true });
  assert.deepEqual(preview.structuredContent.pending.added, [source]);
  await assert.rejects(fs.stat(store), { code: "ENOENT" });
  const first = await execute({ folder, question: "handler" });
  assert.equal(first.structuredContent.files[0].path, source);
  assert.match(first.content[0].text, /demo\.ts:1[\s\S]*Excerpt:\nexport function handler/);

  await fs.writeFile(source, "export function handler(request) { return request.body; }\n");
  const changed = await execute({ folder, question: "handler" });
  assert.deepEqual(changed.structuredContent.sync, { updated: 1, deleted: 0, unchanged: 0 });
  assert.match(changed.structuredContent.files[0].excerpt, /request\.body/);
  await fs.unlink(source);
  const deleted = await execute({ folder, question: "handler" });
  assert.equal(deleted.structuredContent.sync.deleted, 1);
  assert.deepEqual(deleted.structuredContent.files, []);
  await assert.rejects(execute({ folder: "relative", dryRun: true }), /absolute/i);
  await fs.writeFile(source, "\0");
  await assert.rejects(execute({ folder, question: "handler" }), /binary/i);
  console.log("PASS query Pi extension: preview, retrieval, changed/deleted sources and explicit errors");
} finally {
  if (previousStore === undefined) delete process.env.PI_QUERY_STORE_DIR;
  else process.env.PI_QUERY_STORE_DIR = previousStore;
  await fs.rm(root, { recursive: true, force: true });
}
