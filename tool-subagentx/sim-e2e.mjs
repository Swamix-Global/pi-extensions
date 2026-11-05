import { default as subagentxFactory, taskTldrCache, formatTokens } from './build/reloadable/tool-subagentx.js';

// ---- mock pi API -------------------------------------------------------
let registered = null;
const pi = {
  on: () => {},
  registerCommand: () => {},
  registerTool: (tool) => { registered = tool; },
};
subagentxFactory(pi);
const tool = registered;

// ---- mock theme --------------------------------------------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  accent: (s) => `\x1b[36m${s}\x1b[22m`,
  warning: (s) => `\x1b[33m${s}\x1b[22m`,
  success: (s) => `\x1b[32m${s}\x1b[22m`,
  error: (s) => `\x1b[31m${s}\x1b[22m`,
  muted: (s) => `\x1b[90m${s}\x1b[22m`,
  toolOutput: (s) => `\x1b[97m${s}\x1b[22m`,
  toolTitle: (s) => `\x1b[35m${s}\x1b[22m`,
};
const theme = new Proxy({}, { get: (_t, prop) => (prop === 'fg' ? (color, s) => (C[color] ?? (x => x))(s) : C[prop] ?? (x => x)) });

const out = [];
const rule = (label) => out.push(`\x1b[90m··· ${label} ···\x1b[22m`);

// 1. Collapsed call — TLDR may now occupy two wrapped lines
const task = 'Audit build scripts and install tooling across all extension packages for version pinning consistency, verify retired tools are pruned, and confirm the deploy path bundles are fresh';
taskTldrCache.set(task, 'Audit build scripts and install tooling across extension packages for version pinning, retired-tool pruning and fresh deploy bundles');
rule('COLLAPSED CALL — two-line TLDR (100 cols)');
const call = tool.renderCall({ task, profile: 'explorer' }, theme, { expanded: false, invalidate: () => {} });
out.push(...call.render(100));

// 2. Running — polished activity ticker: last 5 parsed steps, newest dimmed,
//    abort hint combined into the single metrics line.
rule('RUNNING (100 cols) — polished ticker, no JSON');
const activity = {
  lines: [
    '✔ read extensions/install.sh · 410ms',
    '✔ grep bun build --target · 380ms',
    '✔ read tool-scripting/build.sh · 205ms',
    'Building the comparison matrix of build',
    '↵ turn · ↓1.2k tok',
  ],
  active: 'Comparing bun minify targets across package builds',
};
const partialRes = {
  content: [{ type: 'text', text: 'Comparing bun minify targets across package builds' }],
  details: { profile: 'explorer', model: 'sglang/lfm3-1.7b-fp8', elapsedMs: 25400, activity, attempts: [{ model: 'sglang/lfm3-1.7b-fp8', usage: { input: 3800, output: 1200, cacheRead: 39000, cacheWrite: 0, cost: 0, turns: 2 } }], usage: { input: 3800, output: 1200, cacheRead: 39000, cacheWrite: 0, cost: 0, turns: 2 } },
  isError: false,
};
const running = tool.renderResult(partialRes, { expanded: false, isPartial: true }, theme);
out.push(...running.render(100));

// 3. Narrow running — abort hint drops, ticker stacks gracefully
rule('RUNNING (70 cols, narrow) — hint drops, no clipping');
out.push(...running.render(70));

// 4. Success collapsed with bottom stats dashboard
rule('SUCCESS (100 cols) — preview + stats pills');
const doneRes = {
  content: [{ type: 'text', text: '## Verdict: consistent\n\nAll four core packages pin bun targets identically.\n\n| Package | Target |\n|---|---|\n| tool-scripting | bun-build |\n| tool-search | bun-build |' }],
  details: { profile: 'explorer', model: 'sglang/lfm3-1.7b-fp8', elapsedMs: 41200, attempts: [{ usage: { input: 6100, output: 2100, cacheRead: 44200, cacheWrite: 0, cost: 0, turns: 4 } }], usage: { input: 6100, output: 2100, cacheRead: 44200, cacheWrite: 0, cost: 0, turns: 4 } },
  isError: false,
};
const done = tool.renderResult(doneRes, { expanded: false, isPartial: false }, theme);
const doneLines = typeof done.render === 'function' ? done.render(100) : [];
out.push(...doneLines);

import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/simx.txt', out.join('\n') + '\n');
console.log('rendered', out.length, 'lines');
