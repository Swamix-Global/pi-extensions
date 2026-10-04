import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { queryProject, scanSources, sourceChunks } from "../lib/query-engine.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "query-engine-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, name, content) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
function rows(root) {
  const db = new DatabaseSync(path.join(root, "query-engine.db"));
  try {
    return db.prepare("SELECT * FROM files ORDER BY path").all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
function mock() {
  const calls = [];
  return {
    calls,
    complete: async (prompt, options) => {
      const input = JSON.parse(prompt);
      calls.push({ input, options });
      options.onUsage?.({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
      if (options.source === "query-answer") {
        const names = [...input.project_map.matchAll(/^"([^"]+)" :/gm)].map((match) => match[1]);
        return JSON.stringify({ answer: "Context from the complete map.", files: names.map((name) => ({ path: name, reason: "Relevant code" })), limitations: ["Verify source"] });
      }
      return `Summary for ${input.path}: ${input.content || input.chunk_summaries.join(" ")}`;
    },
  };
}

test("exact one-to-one map, alphabetical order, exclusions and folder ownership", async (t) => {
  const root = await fixture(t);
  for (const [name, content] of [["z.ts", "Z"], ["a.py", "A"], ["docs/info.md", "Docs"], ["view.svelte", "View"], ["site.css", "CSS"], ["index.html", "HTML"], ["notes.txt", "Notes"], ["script.js", "JS"]]) await write(root, name, content);
  for (const name of ["node_modules/pkg/a.js", ".venv/site/a.py", "dist/out.js", ".git/info.md", "__pycache__/a.py", "data.json"]) await write(root, name, "ignored");
  const outside = await fixture(t);
  await write(outside, "secret.ts", "outside");
  await fs.symlink(outside, path.join(root, "linked"));
  await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
  const backend = mock();
  const result = await queryProject({ folder: root, question: "Explain project" }, backend);
  assert.equal(result.indexed, 8);
  assert.equal(result.database, path.join(root, "query-engine.db"));
  assert.equal((await fs.readdir(outside)).includes("query-engine.db"), false);
  const indexed = rows(root);
  const map = backend.calls.at(-1).input.project_map;
  assert.deepEqual(indexed.map((row) => row.path), ["a.py", "docs/info.md", "index.html", "notes.txt", "script.js", "site.css", "view.svelte", "z.ts"]);
  assert.equal(indexed.every((row) => /^[a-f0-9]{64}$/.test(row.content_hash) && !Number.isNaN(Date.parse(row.index_time))), true);
  assert.deepEqual(Object.keys(indexed[0]).sort(), ["content_hash", "index_time", "path", "summary"]);
  for (const row of indexed) assert.ok(map.includes(`${JSON.stringify(row.path)} : ${row.summary}`));
  assert.ok(map.indexOf('"a.py"') < map.indexOf('"z.ts"'));
  assert.equal(result.usage.totalTokens, 63);
});

test("unchanged files reuse summaries; changes/additions/deletions sync before query", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "before");
  await write(root, "b.md", "retained");
  const backend = mock();
  await queryProject({ folder: root, question: "first" }, backend);
  const first = rows(root);
  backend.calls.length = 0;
  const same = await queryProject({ folder: root, question: "second" }, backend);
  assert.deepEqual(rows(root), first);
  assert.deepEqual(same.sync, { updated: 0, deleted: 0, unchanged: 2 });
  assert.equal(backend.calls.length, 1);
  await write(root, "a.ts", "after!"); // Same byte length; hashes, not stat/size heuristics.
  await fs.unlink(path.join(root, "b.md"));
  await write(root, "new.py", "added");
  backend.calls.length = 0;
  const changed = await queryProject({ folder: root, question: "third" }, backend);
  assert.deepEqual(changed.sync, { updated: 2, deleted: 1, unchanged: 0 });
  assert.equal(backend.calls.filter((call) => call.options.source === "query-index").length, 2);
  assert.deepEqual(rows(root).map((row) => row.path), ["a.ts", "new.py"]);
  assert.ok(backend.calls.at(-1).input.project_map.includes("after!"));
  assert.equal(backend.calls.at(-1).input.project_map.includes("b.md"), false);
});

test("failed summary leaves complete old index intact; no stale query", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "before");
  await write(root, "gone.md", "old");
  await queryProject({ folder: root, question: "first" }, mock());
  const before = rows(root);
  await write(root, "a.ts", "changed");
  await fs.unlink(path.join(root, "gone.md"));
  await write(root, "fail.py", "new");
  const backend = mock();
  const complete = backend.complete;
  backend.complete = async (prompt, options) => JSON.parse(prompt).path === "fail.py" ? null : complete(prompt, options);
  await assert.rejects(queryProject({ folder: root, question: "failed" }, backend), /Local inference failed/);
  assert.deepEqual(rows(root), before);
  assert.equal(backend.calls.some((call) => call.options.source === "query-answer"), false);
});

test("large Unicode sources are consumed fully without splitting characters or clipping", async (t) => {
  const root = await fixture(t);
  const content = "界😀".repeat(6000) + "TAIL_SENTINEL";
  assert.equal(sourceChunks(content).join(""), content);
  assert.ok(sourceChunks(content).every((chunk) => Buffer.byteLength(chunk) <= 16000));
  await write(root, "large.ts", content);
  const backend = mock();
  const result = await queryProject({ folder: root, question: "tail?" }, backend);
  const parts = backend.calls.filter((call) => call.options.source === "query-index");
  assert.equal(parts.map((call) => call.input.content).join(""), content);
  assert.ok(result.files[0].summary.includes("TAIL_SENTINEL"));
});

test("source changes while indexing fail without committing partial state", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "initial");
  const backend = mock();
  const complete = backend.complete;
  backend.complete = async (prompt, options) => {
    if (options.source === "query-index") await write(root, "a.ts", "raced");
    return complete(prompt, options);
  };
  await assert.rejects(queryProject({ folder: root, question: "race" }, backend), /changed during indexing/);
  assert.deepEqual(rows(root), []);
});

test("source changes while answering fail instead of returning stale context", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "initial");
  const backend = mock();
  const complete = backend.complete;
  backend.complete = async (prompt, options) => {
    if (options.source === "query-answer") await write(root, "a.ts", "raced");
    return complete(prompt, options);
  };
  await assert.rejects(queryProject({ folder: root, question: "race" }, backend), /changed while answering/);
});

test("invalid answers and fabricated file paths fail closed", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "code");
  for (const answer of ["not JSON", "null", "[]", "42", JSON.stringify({ answer: "invented", files: [{ path: "../outside.ts", reason: "bad" }], limitations: [] })]) {
    const backend = mock();
    const complete = backend.complete;
    backend.complete = (prompt, options) => options.source === "query-answer" ? answer : complete(prompt, options);
    await assert.rejects(queryProject({ folder: root, question: "where?" }, backend), /invalid JSON|outside the source map/);
  }
});

test("empty project and concurrent same-folder calls remain consistent", async (t) => {
  const root = await fixture(t);
  const backend = mock();
  const empty = await queryProject({ folder: root, question: "empty?" }, backend);
  assert.equal(empty.indexed, 0);
  assert.deepEqual(empty.files, []);
  await write(root, "a.ts", "one file");
  backend.calls.length = 0;
  const results = await Promise.all([
    queryProject({ folder: root, question: "one" }, backend),
    queryProject({ folder: root, question: "two" }, backend),
  ]);
  assert.deepEqual(results.map((result) => result.sync.updated), [1, 0]);
  assert.equal(backend.calls.filter((call) => call.options.source === "query-index").length, 1);
});

test("pre-aborted and offline calls do not index or use old context", async (t) => {
  const root = await fixture(t);
  await write(root, "a.ts", "code");
  const controller = new AbortController();
  controller.abort();
  const backend = mock();
  await assert.rejects(queryProject({ folder: root, question: "abort", signal: controller.signal }, backend), /abort/i);
  assert.equal(backend.calls.length, 0);
  await assert.rejects(queryProject({ folder: root, question: "offline" }, {
    ...backend, check: async () => { throw new Error("offline"); },
  }), /offline/);
  assert.equal((await fs.readdir(root)).includes("query-engine.db"), false);
});

test("symlinked databases cannot write outside folder; invalid source text fails explicitly", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const target = path.join(outside, "database");
  await fs.writeFile(target, "untouched");
  await fs.symlink(target, path.join(root, "query-engine.db"));
  await assert.rejects(queryProject({ folder: root, question: "test" }, mock()), /ELOOP/);
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
  await fs.unlink(path.join(root, "query-engine.db"));
  await fs.writeFile(path.join(root, "binary.ts"), Buffer.from([0xff]));
  await assert.rejects(scanSources(root), /not UTF-8/);
});

test("tokenizer text is excluded only beside a regular tokenizer marker", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await write(outside, "tokenizer.json", "{}");
  // A real tokenizer directory: the regular marker makes adjacent text artifacts non-source.
  await write(root, "models/download/tokenizer_config.json", "{}");
  await write(root, "models/download/merges.txt", "MERGES_TOKENIZER_ARTIFACT\n".repeat(40000));
  await write(root, "models/download/vocab.txt", "VOCAB_TOKENIZER_ARTIFACT");
  await write(root, "models/download/README.md", "Model readme");
  await write(root, "models/download/parser.py", "def parse(): pass");
  // A merges.txt with no marker beside it stays an ordinary source file.
  await write(root, "docs/merges.txt", "DOCS_MERGES");
  await write(root, "src/models/model.ts", "export const model = 1;");
  // Cache directories are excluded even when their files look like sources.
  await write(root, "hf-cache/anything.md", "HF_CACHE_ARTIFACT");
  await write(root, ".tmp/temp.py", "TMP_ARTIFACT");
  // A symlinked marker is not a regular file and must not trigger exclusion.
  await write(root, "vendor/merges.txt", "VENDOR_MERGES");
  await fs.symlink(path.join(outside, "tokenizer.json"), path.join(root, "vendor/tokenizer.json"));
  const retained = ["docs/merges.txt", "models/download/README.md", "models/download/parser.py", "src/models/model.ts", "vendor/merges.txt"];
  const excluded = ["models/download/merges.txt", "models/download/vocab.txt", "hf-cache/anything.md", ".tmp/temp.py"];
  const scanned = await scanSources(root);
  assert.deepEqual([...scanned.keys()], retained);
  const backend = mock();
  const result = await queryProject({ folder: root, question: "Where is the model defined?" }, backend);
  assert.equal(result.indexed, retained.length);
  assert.deepEqual(result.files.map((file) => file.path).sort(), retained);
  const indexCalls = backend.calls.filter((call) => call.options.source === "query-index");
  assert.deepEqual([...new Set(indexCalls.map((call) => call.input.path))].sort(), retained);
  const answered = backend.calls.find((call) => call.options.source === "query-answer");
  for (const name of excluded) {
    assert.equal(answered.input.project_map.includes(name), false, `${name} leaked into the project map`);
    assert.equal(indexCalls.some((call) => call.input.path === name), false, `${name} was indexed`);
  }
  const artifacts = ["MERGES_TOKENIZER_ARTIFACT", "VOCAB_TOKENIZER_ARTIFACT", "HF_CACHE_ARTIFACT", "TMP_ARTIFACT"];
  for (const artifact of artifacts) assert.equal(JSON.stringify(backend.calls).includes(artifact), false, `${artifact} reached inference`);
});

test("shell and config files are indexed while launcher symlinks are skipped", async (t) => {
  const root = await fixture(t);
  await write(root, "start.sh", "#!/bin/sh\necho start");
  await write(root, "env.bash", "export A=1");
  await write(root, "settings.yaml", "key: value");
  await write(root, "recipe.yml", "steps: []");
  await write(root, "pyproject.toml", "[project]\nname = 'x'");
  await fs.symlink(path.join(root, "start.sh"), path.join(root, "launcher.sh"));
  const retained = ["env.bash", "pyproject.toml", "recipe.yml", "settings.yaml", "start.sh"];
  const scanned = await scanSources(root);
  assert.deepEqual([...scanned.keys()], retained);
  const backend = mock();
  const result = await queryProject({ folder: root, question: "How do I start this?" }, backend);
  assert.equal(result.indexed, retained.length);
  assert.deepEqual(result.files.map((file) => file.path).sort(), retained);
  assert.deepEqual(rows(root).map((row) => row.path), retained);
  assert.equal(backend.calls.some((call) => call.input.path === "launcher.sh"), false);
});

test("large files index chunks concurrently but never exceed four in-flight calls", async (t) => {
  const root = await fixture(t);
  const sources = new Map();
  for (const name of ["big-a.ts", "big-b.ts", "big-c.ts"]) {
    const content = name[4].repeat(50000);
    assert.ok(sourceChunks(content).length > 3, `${name} must exercise multiple chunks`);
    sources.set(name, content);
    await write(root, name, content);
  }
  const calls = [];
  const active = { now: 0, max: 0 };
  const perPath = new Map();
  const perPathMax = new Map();
  const backend = {
    complete: async (prompt, options) => {
      const input = JSON.parse(prompt);
      const key = input.path ?? "";
      calls.push({ input, options });
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      const pathActive = (perPath.get(key) || 0) + 1;
      perPath.set(key, pathActive);
      perPathMax.set(key, Math.max(perPathMax.get(key) || 0, pathActive));
      options.onUsage?.({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.source === "query-answer") {
          const names = [...input.project_map.matchAll(/^"([^"]+)" :/gm)].map((match) => match[1]);
          return JSON.stringify({ answer: "Large files indexed.", files: names.map((name) => ({ path: name, reason: "large" })), limitations: [] });
        }
        if (options.source === "query-index-merge") return "merged note";
        return `note ${input.path} ${input.part}`;
      } finally {
        active.now -= 1;
        perPath.set(key, perPath.get(key) - 1);
      }
    },
  };
  const progress = [];
  const result = await queryProject({ folder: root, question: "Index the large files.", onProgress: (text) => progress.push(text) }, backend);
  assert.equal(result.indexed, 3);
  assert.ok(active.max <= 4, `maxActive ${active.max} exceeded four`);
  assert.ok(active.max > 1, "no concurrent indexing inference observed");
  const chunkConcurrency = Math.max(...[...perPathMax].filter(([name]) => sources.has(name)).map(([, count]) => count));
  assert.ok(chunkConcurrency > 1, "no file ran more than one chunk concurrently");
  for (const [name, content] of sources) {
    const chunks = calls.filter((call) => call.options.source === "query-index" && call.input.path === name).sort((a, b) => a.input.part - b.input.part);
    assert.equal(chunks.map((call) => call.input.content).join(""), content, `${name} chunks are incomplete`);
  }
  assert.ok(progress.some((text) => text.includes("chunk")), `progress missing chunk: ${progress}`);
  assert.ok(progress.some((text) => text.includes("Indexed 3/3")), `progress missing Indexed 3/3: ${progress}`);
});
