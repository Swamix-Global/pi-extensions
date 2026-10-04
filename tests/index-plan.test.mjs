import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { planProject, queryProject } from "../lib/query-engine.mjs";
import { indexLocation } from "../lib/index-store.mjs";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "query-plan-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const folder = path.join(base, "source");
  await fs.mkdir(folder);
  return { base, folder, storeDir: path.join(base, "store") };
}
const complete = async (prompt, options) => options.source === "query-answer"
  ? JSON.stringify({ answer: "Answer", files: [], limitations: [] }) : `Summary: ${JSON.parse(prompt).content}`;

async function snapshot(directory) {
  const result = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.stat(file);
    result[name] = { bytes: (await fs.readFile(file)).toString("base64"), mtime: stat.mtimeMs, mode: stat.mode };
  }
  return result;
}

test("fresh dry run is offline, lists eligible pending paths and writes nothing", async (t) => {
  const { folder, storeDir } = await fixture(t);
  await fs.writeFile(path.join(folder, "a.ts"), "code");
  await fs.writeFile(path.join(folder, "start.sh"), "echo run");
  await fs.writeFile(path.join(folder, "ignored.json"), "{}");
  const noBackend = () => { throw new Error("Backend must not be invoked"); };
  const result = await queryProject({ folder, dryRun: true }, { storeDir, check: noBackend, complete: noBackend });
  assert.equal(result.dryRun, true);
  assert.equal(result.indexed, 0);
  assert.equal(result.eligible, 2);
  assert.deepEqual(result.pending, { added: ["a.ts", "start.sh"], changed: [], deleted: [], unchanged: [] });
  assert.deepEqual(result.sync, { updated: 2, deleted: 0, unchanged: 0 });
  await assert.rejects(fs.stat(storeDir), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(folder)).sort(), ["a.ts", "ignored.json", "start.sh"]);
});

test("cached dry run identifies exact added/changed/deleted/unchanged paths without changing store", async (t) => {
  const { folder, storeDir } = await fixture(t);
  for (const name of ["a.ts", "gone.md", "stable.sh"]) await fs.writeFile(path.join(folder, name), "before");
  await queryProject({ folder, question: "index" }, { storeDir, complete });
  await fs.writeFile(path.join(folder, "a.ts"), "after!");
  await fs.unlink(path.join(folder, "gone.md"));
  await fs.writeFile(path.join(folder, "new.py"), "new");
  const before = await snapshot(storeDir);
  const result = await planProject({ folder }, { storeDir });
  assert.equal(result.indexed, 3);
  assert.equal(result.eligible, 3);
  assert.deepEqual(result.pending, { added: ["new.py"], changed: ["a.ts"], deleted: ["gone.md"], unchanged: ["stable.sh"] });
  assert.deepEqual(result.sync, { updated: 2, deleted: 1, unchanged: 1 });
  assert.deepEqual(await snapshot(storeDir), before);
  const actual = await queryProject({ folder, question: "sync" }, { storeDir, complete });
  assert.deepEqual(actual.sync, result.sync);
});

test("canonical folder keys reuse aliases but isolate other folders and subfolders", async (t) => {
  const { base, folder, storeDir } = await fixture(t);
  const other = path.join(base, "other");
  const sub = path.join(folder, "sub");
  await fs.mkdir(other);
  await fs.mkdir(sub);
  await fs.writeFile(path.join(folder, "same.ts"), "first");
  await fs.writeFile(path.join(other, "same.ts"), "second");
  await fs.symlink(folder, path.join(base, "alias"));
  const first = await queryProject({ folder, question: "one" }, { storeDir, complete });
  const alias = await planProject({ folder: path.join(base, "alias") }, { storeDir });
  assert.equal(alias.database, first.database);
  assert.deepEqual(alias.sync, { updated: 0, deleted: 0, unchanged: 1 });
  const second = await queryProject({ folder: other, question: "two" }, { storeDir, complete });
  const child = await planProject({ folder: sub }, { storeDir });
  assert.notEqual(second.database, first.database);
  assert.notEqual(child.database, first.database);
  assert.ok(path.basename(first.database).match(/^[a-f0-9]{64}\.db$/));
  assert.equal((await fs.readdir(folder)).includes("query-engine.db"), false);
});

test("missing/blank folders, non-folders, invalid dryRun and cancellation fail explicitly", async (t) => {
  const { folder, storeDir } = await fixture(t);
  for (const bad of [undefined, "", "  "]) {
    await assert.rejects(planProject({ folder: bad }, { storeDir }), /folder is required/);
  }
  const file = path.join(folder, "a.ts");
  await fs.writeFile(file, "source");
  await assert.rejects(planProject({ folder: file }, { storeDir }), /Not a folder/);
  await assert.rejects(queryProject({ folder, dryRun: "true" }, { storeDir }), /boolean/);
  await assert.rejects(queryProject({ folder }, { storeDir, complete }), /question is required/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(planProject({ folder, signal: controller.signal }, { storeDir }), /abort/i);
  await assert.rejects(fs.stat(storeDir), { code: "ENOENT" });
});

test("symlinked stores and database sidecars cannot redirect writes", async (t) => {
  const { base, folder, storeDir } = await fixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, storeDir);
  await assert.rejects(queryProject({ folder, question: "index" }, { storeDir, complete }), /symlink/);
  await assert.rejects(planProject({ folder }, { storeDir }), /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(storeDir);
  await fs.mkdir(storeDir);
  const location = indexLocation(folder, storeDir);
  const target = path.join(outside, "untouched");
  await fs.writeFile(target, "untouched");
  await fs.symlink(target, `${location.database}-journal`);
  await assert.rejects(queryProject({ folder, question: "index" }, { storeDir, complete }), /Unsafe index/);
  await assert.rejects(planProject({ folder }, { storeDir }), /Unsafe index/);
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
});

test("hardlinks and mismatched folder identity fail closed", async (t) => {
  const { folder, storeDir } = await fixture(t);
  const result = await queryProject({ folder, question: "index" }, { storeDir, complete });
  const db = new DatabaseSync(result.database);
  db.prepare("UPDATE project SET folder = ? WHERE id = 1").run("/wrong-folder");
  db.close();
  await assert.rejects(planProject({ folder }, { storeDir }), /identity mismatch/);
  await assert.rejects(queryProject({ folder, question: "wrong" }, { storeDir, complete }), /identity mismatch/);
  await fs.link(result.database, path.join(storeDir, "hardlink.db"));
  await assert.rejects(planProject({ folder }, { storeDir }), /Unsafe index/);
});

test("WAL dry runs fail before SQLite can create sidecars", async (t) => {
  const { folder, storeDir } = await fixture(t);
  const result = await queryProject({ folder, question: "index" }, { storeDir, complete });
  const db = new DatabaseSync(result.database);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const before = await snapshot(storeDir);
  await assert.rejects(planProject({ folder }, { storeDir }), /refusing WAL sidecar writes/);
  assert.deepEqual(await snapshot(storeDir), before);
});

test("legacy folder-local database remains untouched; global store rebuild is explicit", async (t) => {
  const { folder, storeDir } = await fixture(t);
  const legacy = path.join(folder, "query-engine.db");
  await fs.writeFile(legacy, "legacy contents");
  await fs.writeFile(path.join(folder, "a.ts"), "source");
  const result = await planProject({ folder }, { storeDir });
  assert.deepEqual(result.pending.added, ["a.ts"]);
  await queryProject({ folder, question: "index" }, { storeDir, complete });
  assert.equal(await fs.readFile(legacy, "utf8"), "legacy contents");
});
