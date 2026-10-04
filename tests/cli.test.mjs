import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("--help prints usage and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Error:/);
  assert.match(result.stdout, /Usage: node cli\.mjs --folder PATH/);
  assert.match(result.stdout, /--folder/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /PI_QUERY_STORE_DIR/);
  assert.match(result.stdout, /Exit codes:/);
  assert.match(result.stdout, /no writes, no inference and no network/);
});

test("-h is an alias for --help", () => {
  const result = run(["-h"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node cli\.mjs --folder PATH/);
});

test("no arguments prints usage and exits 2", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: node cli\.mjs --folder PATH/);
});

test("missing --folder is a bad argument", () => {
  const result = run(["--question", "Where is auth checked?"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--folder is required/);
});

test("missing --question without --dry-run is a bad argument", () => {
  const result = run(["--folder", os.tmpdir()]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--question is required/);
});

test("invalid option is a bad argument", () => {
  const result = run(["--folder", os.tmpdir(), "--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test("duplicate option is a bad argument", () => {
  const result = run(["--folder", os.tmpdir(), "--folder", os.tmpdir()]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Duplicate option: --folder/);
});

test("missing option value is a bad argument", () => {
  const result = run(["--folder"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing value for --folder/);
});

test("dry run --json reports pending paths offline and creates no store", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "query-cli-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "project");
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, "b.ts"), "export const b = 1;\n");
  await fsp.writeFile(path.join(folder, "a.ts"), "export const a = 1;\n");
  await fsp.writeFile(path.join(folder, "ignored.json"), "{}\n");
  const store = path.join(root, "store");
  const result = run(["--folder", folder, "--dry-run", "--json"], {
    PI_QUERY_STORE_DIR: store,
    // Prove the dry run never reaches local inference configuration.
    SETTINGS_SUBAGENTX_PATH: path.join(root, "does-not-exist.json"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.folder, await fsp.realpath(folder));
  assert.equal(payload.eligible, 2);
  assert.equal(payload.indexed, 0);
  assert.deepEqual(payload.pending, {
    added: ["a.ts", "b.ts"],
    changed: [],
    deleted: [],
    unchanged: [],
  });
  assert.deepEqual(payload.sync, { updated: 2, deleted: 0, unchanged: 0 });
  assert.equal(typeof payload.database, "string");
  assert.ok(payload.database.length > 0);
  assert.equal(fs.existsSync(store), false, "dry run must not create the store directory");
});

test("dry run keeps progress off stdout in --json mode", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "query-cli-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "project");
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, "only.ts"), "export const only = 1;\n");
  const result = run(["--folder", folder, "--dry-run", "--json"], {
    PI_QUERY_STORE_DIR: path.join(root, "store"),
    SETTINGS_SUBAGENTX_PATH: path.join(root, "missing.json"),
  });
  assert.equal(result.status, 0, result.stderr);
  // stdout must be exactly one JSON document, never progress lines.
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});
