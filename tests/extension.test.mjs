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

// Every nonblank rendered line must be a bullet; nested map lines stay indented.
const assertBulletOnly = (text) => {
  for (const line of text.split("\n")) {
    if (line.trim()) assert.match(line, /^\s*-\s+\S/, `not a bullet: ${line}`);
  }
};

// Returned objects must carry exactly the keys declared in the output schema.
const assertSchemaAgreement = (value, keys) => {
  assert.deepEqual(Object.keys(value).sort(), keys);
};

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

  // Schema agreement: derive expected file/section keys and map kinds from the declared output schema.
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

  const preview = await execute({ folder, dryRun: true });
  assert.deepEqual(preview.structuredContent.pending.added, [source]);
  assertSchemaAgreement(preview.structuredContent, Object.keys(dryVariant.properties).sort());
  await assert.rejects(fs.stat(store), { code: "ENOENT" });

  const first = await execute({ folder, question: "handler" });
  assert.equal(first.structuredContent.sync.updated, 1);
  assert.equal(first.structuredContent.files.length, 1);
  const firstFile = first.structuredContent.files[0];
  assert.equal(firstFile.path, source);
  assert.equal(firstFile.line, 1);
  assert.equal(firstFile.mapKind, "structural");
  assert.deepEqual(firstFile.sections, [{ line: 1, endLine: 1, name: "handler", purpose: "function" }]);
  assertFile(firstFile);
  assert.equal(Object.hasOwn(firstFile, "excerpt"), false);
  assertBulletOnly(first.content[0].text);
  assert.match(first.content[0].text, /demo\.ts:1/);
  assert.match(first.content[0].text, /- why: lexical: 1\/1 query terms \(handler\); best line 1/);
  assert.match(first.content[0].text, /^  - 1-1 handler: function$/m);
  assert.doesNotMatch(first.content[0].text, /export function handler/);

  await fs.writeFile(source, "// updated marker\nexport function handler(request) { return request.body; }\n");
  const changed = await execute({ folder, question: "handler" });
  assert.deepEqual(changed.structuredContent.sync, { updated: 1, deleted: 0, unchanged: 0 });
  const changedFile = changed.structuredContent.files[0];
  assert.equal(changedFile.path, source);
  assert.equal(changedFile.line, 2);
  assert.equal(changedFile.mapKind, "structural");
  assert.deepEqual(changedFile.sections, [
    { line: 1, endLine: 1, name: "preamble", purpose: "leading comments and setup" },
    { line: 2, endLine: 2, name: "handler", purpose: "function" },
  ]);
  assertFile(changedFile);
  assertBulletOnly(changed.content[0].text);
  assert.match(changed.content[0].text, /^  - 1-1 preamble: leading comments and setup$/m);
  assert.doesNotMatch(changed.content[0].text, /request\.body/);

  await fs.unlink(source);
  const deleted = await execute({ folder, question: "handler" });
  assert.equal(deleted.structuredContent.sync.deleted, 1);
  assert.deepEqual(deleted.structuredContent.files, []);
  assertBulletOnly(deleted.content[0].text);
  await assert.rejects(execute({ folder: "relative", dryRun: true }), /absolute/i);
  await fs.writeFile(source, "\0");
  await assert.rejects(execute({ folder, question: "handler" }), /binary/i);
  console.log("PASS query Pi extension: schema agreement, structural bullet maps without excerpts, fresh changed/deleted results and explicit errors");
} finally {
  if (previousStore === undefined) delete process.env.PI_QUERY_STORE_DIR;
  else process.env.PI_QUERY_STORE_DIR = previousStore;
  await fs.rm(root, { recursive: true, force: true });
}
