import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLocalUsage, readGlobalLocalUsage } from '../build/reloadable/tool-subagentx.js';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'reloadable', 'tool-subagentx.js');

test('in-process burst of recordLocalUsage keeps exact totals (sync RMW, no lost increments)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subagentx-ledger-'));
  process.env.PI_SUBAGENTX_DATA_DIR = dir;
  try {
    const calls = 200;
    let final;
    for (let i = 0; i < calls; i++) {
      final = recordLocalUsage('sglang/lfm3-1.7b-fp8', 'explorer', true,
        { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0, turns: 1 }, 10);
    }
    assert.equal(final.totalRuns, calls);
    assert.equal(final.inputTokens, calls * 10);
    assert.equal(final.outputTokens, calls * 20);
    assert.equal(final.cacheReadTokens, calls * 5);
    assert.equal(final.totalTokens, calls * 35);
    assert.equal(final.totalDurationMs, calls * 10);

    const persisted = JSON.parse(readFileSync(join(dir, 'subagentx-local-usage.json'), 'utf8'));
    assert.equal(persisted.totalRuns, calls, 'persisted ledger matches memory totals');
  } finally {
    delete process.env.PI_SUBAGENTX_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-process ledger updates merge under the lockfile without lost increments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subagentx-ledger-x-'));
  const workerLocal = join(dir, 'worker-local.mjs');
  const workerCloud = join(dir, 'worker-cloud.mjs');
  writeFileSync(workerLocal, `const { recordLocalUsage } = await import(${JSON.stringify(bundle)});
recordLocalUsage('sglang/lfm3-1.7b-fp8', 'worker', true,
  { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, 25);
`);
  writeFileSync(workerCloud, `const { recordLocalUsage } = await import(${JSON.stringify(bundle)});
recordLocalUsage('openai/gpt-6-luna', 'default', true,
  { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, 999);
`);

  try {
    // All 16 local children race on the same ledger file simultaneously, mixed
    // with 4 non-local (cloud) children whose runs must NOT touch this counter.
    const exits = [];
    for (let i = 0; i < 16 + 4; i++) {
      const worker = i < 16 ? workerLocal : workerCloud;
      exits.push(new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker],
          { env: { ...process.env, PI_SUBAGENTX_DATA_DIR: dir } });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', (code) => (code === 0 ? resolve(code) : reject(new Error(`child ${i} exited ${code}: ${err}`))));
      }));
    }
    await Promise.all(exits);

    const saved = process.env.PI_SUBAGENTX_DATA_DIR;
    process.env.PI_SUBAGENTX_DATA_DIR = dir;
    const totals = readGlobalLocalUsage();
    process.env.PI_SUBAGENTX_DATA_DIR = saved;

    assert.equal(totals.totalRuns, 16, 'every concurrent local run counted exactly once');
    assert.equal(totals.successfulRuns, 16);
    assert.equal(totals.inputTokens, 1600, 'non-local cloud runs excluded from the local counter');
    assert.equal(totals.outputTokens, 3200);
    assert.equal(totals.totalDurationMs, 400);
    assert.equal(totals.failedRuns, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
