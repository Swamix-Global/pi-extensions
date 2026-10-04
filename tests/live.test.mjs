import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { queryProject } from "../lib/query-engine.mjs";

test("real SGLang indexes, answers and syncs a folder", { timeout: 180000 }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "query-engine-live-"));
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "query-engine-live-store-"));
  process.env.PI_QUERY_STORE_DIR = store;
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  t.after(() => fs.rm(store, { recursive: true, force: true }));
  await fs.writeFile(path.join(folder, "calculator.py"), "def add(left, right):\n    return left + right\n");
  await fs.writeFile(path.join(folder, "cli.js"), "// Prints the calculator CLI help.\nconsole.log('Use add(left, right) in calculator.py');\n");
  const preview = await queryProject({ folder, dryRun: true, signal: t.signal });
  assert.deepEqual(preview.pending.added, ["calculator.py", "cli.js"]);
  assert.equal((await fs.readdir(store)).length, 0);
  const first = await queryProject({
    folder,
    question: "Where is addition implemented, and what file should I read to verify its inputs and return value?",
    signal: t.signal,
  });
  assert.equal(first.indexed, 2);
  assert.deepEqual(first.sync, { updated: 2, deleted: 0, unchanged: 0 });
  assert.ok(first.files.some((file) => file.path === "calculator.py"));
  assert.ok(first.answer.trim());
  assert.equal(path.dirname(first.database), store);
  const cached = await queryProject({ folder, dryRun: true, signal: t.signal });
  assert.deepEqual(cached.sync, { updated: 0, deleted: 0, unchanged: 2 });

  await fs.writeFile(path.join(folder, "calculator.py"), "def multiply(left, right):\n    return left * right\n");
  await fs.unlink(path.join(folder, "cli.js"));
  await fs.writeFile(path.join(folder, "README.md"), "# Calculator\nThe Python module now exports multiply(left, right).\n");
  const second = await queryProject({
    folder,
    question: "Where is multiplication implemented now? Recommend its implementation file.",
    signal: t.signal,
  });
  assert.equal(second.indexed, 2);
  assert.deepEqual(second.sync, { updated: 2, deleted: 1, unchanged: 0 });
  assert.ok(second.files.some((file) => file.path === "calculator.py"));
  assert.ok(second.files.every((file) => file.path !== "cli.js"));
  console.log(`Live query OK: ${second.answer}`);
});
