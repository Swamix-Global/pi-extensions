import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import factory, {
  DEFAULT_MODELS, PROFILES, childArgs, getReasoning, ActivityFeed,
  parseChildOutput, runProcess, readGlobalLocalUsage, recordLocalUsage, isLocalModel
} from '../build/reloadable/tool-subagentx.js';

const temporary = () => mkdtempSync(join(tmpdir(), 'subagentx-test-'));
const text = res => res.content.map(part => part.text).join('\n');
function harness() {
  const tools = [], commands = {}, events = {};
  factory({ registerTool: tool => tools.push(tool), registerCommand: (name, cmd) => commands[name] = cmd,
    on: (name, fn) => events[name] = fn });
  return { tool: tools[0], tools, commands, events };
}

test('strict task-only schema, profiles and no synthetic limit on timeout', () => {
  const { tool, tools } = harness();
  assert.equal(tools.length, 1);
  assert.equal(tool.name, 'subagentx');
  assert.deepEqual(tool.parameters.required, ['task']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['task', 'profile', 'model', 'timeout_seconds']);
  assert.equal(tool.parameters.properties.timeout_seconds.maximum, undefined, 'no synthetic maximum on timeout_seconds');
  assert.equal(PROFILES.explorer.tools, 'read,grep,find,ls,filemap');
  assert.equal(PROFILES.worker.tools, 'read,grep,find,ls,bash,edit,write');
  for (const profile of Object.keys(PROFILES)) {
    const args = childArgs(profile, 'zai-coding-cn/glm-5.3', 'high');
    for (const flag of ['--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-approve']) {
      assert.ok(args.includes(flag), `missing flag: ${flag}`);
    }
    assert.equal(args.includes('--no-context-files'), false, 'context files (AGENTS.md) must not be blocked');
    assert.equal(args.includes('--offline'), false, 'offline flag must not be passed');
    assert.equal(args[args.indexOf('--tools') + 1], PROFILES[profile].tools);
    assert.equal(args[args.indexOf('--model') + 1], 'glm-5.3');
  }
  assert.equal(getReasoning(DEFAULT_MODELS[0], {}), 'max');
  assert.equal(getReasoning(DEFAULT_MODELS[1], {}), 'high');
  assert.equal(getReasoning(DEFAULT_MODELS[1], { modelReasoning: { [DEFAULT_MODELS[1]]: 'low' } }), 'low');
});

test('child JSON output parsing: usage totals and text extraction', () => {
  const line1 = JSON.stringify({ type: 'turn_end', message: { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cost: { total: 0.01 } }, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'part one' }] } });
  const line2 = JSON.stringify({ type: 'turn_end', message: { role: 'assistant', usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }, content: [{ type: 'text', text: 'final report' }] } });
  const parsed = parseChildOutput(`noise\n${line1}\n{broken json\n${line2}\n`);
  assert.equal(parsed.text, 'final report');
  assert.deepEqual(parsed.usage, { input: 150, output: 30, cacheRead: 5, cacheWrite: 0, cost: 0.03, turns: 2 });
  const plain = parseChildOutput('plain text fallback');
  assert.equal(plain.text, 'plain text fallback');
  assert.equal(plain.usage, null);
});

test('global local model usage counter persists across sessions', () => {
  const isLocal = isLocalModel('sglang/lfm3-1.7b-fp8', 'explorer');
  assert.equal(isLocal, true);
  assert.equal(isLocalModel('openai/gpt-6-luna', 'default'), false);
  const before = readGlobalLocalUsage();
  assert.ok(typeof before.totalTokens === 'number');
  assert.ok(typeof before.totalRuns === 'number');
  const updated = recordLocalUsage('sglang/lfm3-1.7b-fp8', 'explorer', true, { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, cost: 0, turns: 1 }, 1500);
  assert.equal(updated.totalRuns, before.totalRuns + 1);
  assert.equal(updated.totalTokens, before.totalTokens + 350);
  assert.equal(updated.inputTokens, before.inputTokens + 100);
  assert.equal(updated.outputTokens, before.outputTokens + 50);
  assert.equal(updated.cacheReadTokens, before.cacheReadTokens + 200);
  const reRead = readGlobalLocalUsage();
  assert.equal(reRead.totalRuns, updated.totalRuns);
  assert.equal(reRead.totalTokens, updated.totalTokens);
});

test('neat high-aesthetic rendering: call preview and comprehensive bottom stats line', () => {
  const { tool } = harness();
  const theme = {
    fg: (col, str) => `[${col}]${str}[/${col}]`,
    bold: str => `*${str}*`,
    italic: str => `_${str}_`,
  };

  // 1. Call rendering: collapsed vs expanded
  const longTask = 'First line of task instructions.\nSecond line with details.\nThird line with constraints.\nFourth line.';
  const callCollapsed = tool.renderCall({ profile: 'explorer', task: longTask }, theme, { expanded: false });
  const collapsedLines = callCollapsed.render(80);
  assert.ok(collapsedLines.length <= 3, 'collapsed call must be compact, not dumping all lines');
  assert.ok(collapsedLines.join('\n').includes('First line of task'));
  assert.ok(collapsedLines.join('\n').includes('w)'), 'word count badge present');

  const callExpanded = tool.renderCall({ profile: 'explorer', task: longTask }, theme, { expanded: true });
  const expandedLines = callExpanded.render(80);
  assert.ok(expandedLines.length >= 4, 'expanded call must show full task');
  assert.ok(expandedLines.join('\n').includes('*First line of task instructions.*'), 'expanded task is styled in bold');

  // 2. Result rendering: partial, error, and success with bottom stats line
  const partialDetails = {
    profile: 'explorer', model: 'sglang/lfm3-1.7b-fp8', elapsedMs: 3200,
    activity: { lines: ['⚡ read src/index.ts', '✔ read · 0.4s', 'Comparing package manifests across workspaces'], active: 'Scanning re' },
  };
  const partial = tool.renderResult({ content: [{ type: 'text', text: 'Step 1\nStep 2' }], details: partialDetails }, { expanded: false, isPartial: true }, theme);
  const partialRendered = partial.render(100).join('\n');
  assert.ok(partialRendered.includes('RUNNING'));
  assert.ok(partialRendered.includes('Ctrl+C aborts'), 'abort hint combined into the metrics line');
  assert.ok(!partialRendered.includes('⏳'), 'no dedicated delegated-status line');
  assert.ok(partialRendered.includes('⚡ read src/index.ts'), 'parsed activity step rendered in ticker');
  assert.ok(partialRendered.includes('Comparing package manifests'), 'settled assistant text rendered at full opacity');
  assert.ok(!partialRendered.includes('Scanning re'), 'in-flight assistant line buffered, never rendered mid-flight');
  assert.ok(!partialRendered.includes('message_update'), 'raw child JSON never leaks into the ticker');
  assert.ok(!partialRendered.includes('[dim]Scanning'), 'no 50% fade dim on streaming text');
  const narrowPartial = partial.render(70).join('\n');
  assert.ok(narrowPartial.includes('RUNNING'), 'narrow viewport keeps the metrics line');
  assert.ok(!narrowPartial.includes('Ctrl+C aborts'), 'abort hint drops before clipping on narrow viewports');

  const resultData = {
    content: [{ type: 'text', text: '### Summary\nPoint 1: all good\nPoint 2: verified\nPoint 3: done' }],
    details: {
      profile: 'explorer', model: 'sglang/lfm3-1.7b-fp8', elapsedMs: 4400,
      usage: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, cost: 0, turns: 2 }
    }
  };
  const resCollapsed = tool.renderResult(resultData, { expanded: false, isPartial: false }, theme);
  const resLines = resCollapsed.render(100);
  const renderedOutput = resLines.join('\n');
  assert.ok(renderedOutput.includes('Completed'), 'success header present');
  assert.ok(renderedOutput.includes('Point 1: all good'), 'preview of findings present');
  assert.ok(renderedOutput.includes('1.2k'), 'input tokens displayed');
  assert.ok(renderedOutput.includes('300'), 'output tokens displayed');
  assert.ok(renderedOutput.includes('5.0k'), 'cache read tokens displayed');
  assert.ok(renderedOutput.includes('$0.00'), 'cost displayed');
  assert.ok(renderedOutput.includes('⚡ Local:'), 'global local model usage counter displayed at bottom line');

  // Error result has stats line too
  const errorData = {
    content: [{ type: 'text', text: 'Connection refused\nDetails about socket error' }],
    details: { profile: 'worker', model: 'sglang/lfm3-1.7b-fp8', elapsedMs: 1200, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
    isError: true,
  };
  const resError = tool.renderResult(errorData, { expanded: false, isPartial: false }, theme);
  const errorOutput = resError.render(100).join('\n');
  assert.ok(errorOutput.includes('Failed'), 'error header present');
  assert.ok(errorOutput.includes('Connection refused'), 'error text present');
  assert.ok(errorOutput.includes('⚡ Local:'), 'global local stats present on error bottom line');
});

test('actual factory IPC, rotation, failover, settings, no run files, concurrent calls and reload', async () => {
  const cwd = temporary(), bin = join(cwd, 'bin'), settings = join(cwd, 'settings.json');
  mkdirSync(bin);
  writeFileSync(settings, JSON.stringify({ extensionSettings: { subagentx: {} } }));
  writeFileSync(join(bin, 'pi'), `#!/usr/bin/env node
let input=''; process.stdin.on('data', chunk=>input+=chunk); process.stdin.on('end',()=>{
 const args=process.argv.slice(2), provider=args[args.indexOf('--provider')+1];
 if(input.includes('FAIL_QUOTA') && provider==='openai'){process.stderr.write('429 quota exhausted');process.exitCode=1;return;}
 if(input.includes('FAIL_OTHER')){process.stderr.write('invalid task');process.exitCode=2;return;}
 if(input.includes('EMPTY_RESPONSE'))return;
 process.stdout.write(JSON.stringify({args,input,cwd:process.cwd()}));
});`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, PI_EXTENSION_SETTINGS_PATH: process.env.PI_EXTENSION_SETTINGS_PATH };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PI_EXTENSION_SETTINGS_PATH = settings;
  try {
    const h = harness();
    const call = (args, signal) => h.tool.execute('test', args, signal, undefined, { cwd });
    const literal = '@missing.yaml\ntask: literal, not parsed\n/command';
    const first = await call({ task: literal });
    assert.ok(!first.isError, text(first));
    const packet = JSON.parse(text(first));
    assert.equal(packet.input, `Delegated task (literal text):\n${literal}`);
    assert.ok(!packet.args.includes(literal));
    assert.equal(first.details.model, DEFAULT_MODELS[0]);
    assert.equal((await call({ task: 'second' })).details.model, DEFAULT_MODELS[1]);
    assert.equal((await call({ profile: 'explorer', task: 'local' })).details.model, 'sglang/lfm3-1.7b-fp8');
    assert.equal((await call({ profile: 'worker', task: 'local' })).details.model, 'sglang/lfm3-1.7b-fp8');
    const quota = await call({ task: 'FAIL_QUOTA' });
    assert.equal(quota.details.attempts.length, 2);
    assert.equal(quota.details.model, DEFAULT_MODELS[1]);
    assert.equal((await call({ task: 'after failover' })).details.model, DEFAULT_MODELS[1]);
    const manual = await call({ task: 'override', model: DEFAULT_MODELS[1] });
    assert.equal(manual.details.model, DEFAULT_MODELS[1]);
    assert.equal((await call({ task: 'rotation unchanged' })).details.model, DEFAULT_MODELS[0]);
    const pair = await Promise.all([call({ task: 'parallel one' }), call({ task: 'parallel two' })]);
    assert.deepEqual(pair.map(res=>res.details.model), [DEFAULT_MODELS[1], DEFAULT_MODELS[0]]);
    for (const task of ['FAIL_OTHER', 'EMPTY_RESPONSE']) assert.equal((await call({ task, profile: 'worker' })).isError, true);
    assert.equal((await call({ task: 'bad provider', model: 'openrouter/z-ai/glm-5.3' })).isError, true);
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await call({ task: 'never spawn' }, cancelled.signal)).isError, true);
    const before = readFileSync(settings, 'utf8');
    assert.deepEqual(readdirSync(cwd).sort(), ['bin', 'settings.json']);
    assert.equal(readFileSync(settings, 'utf8'), before);
    const notices = [];
    await h.commands['settings:subagentx'].handler('reasoning zai-coding-cn/glm-5.3 low', { ui: { notify: (...args)=>notices.push(args) } });
    assert.equal(JSON.parse(readFileSync(settings)).extensionSettings.subagentx.modelReasoning[DEFAULT_MODELS[1]], 'low');
    const loader = (await import('../build/tool-subagentx.js')).default;
    const registers = [];
    const pi = { on() {}, registerCommand() {}, registerTool: tool=>registers.push(tool) };
    await loader(pi); await loader(pi);
    assert.equal(registers.length, 2);
    assert.notEqual(registers[0].execute, registers[1].execute);
    await h.events.session_shutdown();
    assert.equal((await call({ task: 'after shutdown' })).isError, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('process handles large output without synthetic limits, timeout and abort', async () => {
  const cwd = temporary();
  try {
    const run = (script, extra={}) => runProcess({ command: process.execPath, args: ['-e', script], input: 'test', cwd, timeoutMs: 5000, graceMs: 100, ...extra });
    assert.equal((await run("process.stderr.write('bad');process.exit(7)")).code, 7);
    const missing = await runProcess({ command: join(cwd, 'absent'), args: [], input: '', cwd, timeoutMs: 1000 });
    assert.match(missing.error, /ENOENT/);
    
    // Large output > 1.5MB should succeed without synthetic limit
    const large = await run("process.stdout.write('x'.repeat(1500000))");
    assert.equal(large.error, undefined);
    assert.equal(large.stdout.length, 1500000);

    // Explicit maxBytes only enforced when passed
    const overflow = await run("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)", { maxBytes: 1024 });
    assert.match(overflow.error, /output exceeded/);
    assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);

    assert.match((await run('setInterval(()=>{},1000)', { timeoutMs: 100 })).error, /timeout/);
    const ctrl = new AbortController();
    const promise = run('setInterval(()=>{},1000)', { signal: ctrl.signal });
    setTimeout(()=>ctrl.abort(), 100);
    assert.equal((await promise).error, 'cancelled');
    const pre = new AbortController(); pre.abort();
    assert.equal((await run('throw Error("must not launch")', { signal: pre.signal })).error, 'cancelled');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('abort kills detached command descendants even when CLI exits first', async () => {
  const cwd = temporary(), file = join(cwd, 'pid');
  try {
    const ctrl = new AbortController();
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(file)},String(child.pid));setInterval(()=>{},1000);`;
    const promise = runProcess({ command: process.execPath, args: ['-e', source], input: '', cwd, signal: ctrl.signal, timeoutMs: 5000, graceMs: 150 });
    let pid;
    for (let i=0;i<100;i++) { try { pid=Number(readFileSync(file)); break; } catch {} await new Promise(r=>setTimeout(r,20)); }
    assert.ok(pid);
    await new Promise(r=>setTimeout(r,100));
    ctrl.abort();
    assert.equal((await promise).error, 'cancelled');
    await new Promise(r=>setTimeout(r,100));
    let state;
    try { const stat=readFileSync(`/proc/${pid}/stat`,'utf8');state=stat.slice(stat.lastIndexOf(')')+2)[0]; } catch { state='gone'; }
    assert.ok(['gone','Z'].includes(state), `descendant still running: ${state}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('ActivityFeed parses child NDJSON into polished transient steps (start/end collapse, no JSON)', () => {
  const feed = new ActivityFeed();
  // Chunk boundary splits the first wire event; the buffer must recover.
  const events = [
    JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/index.ts' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Building the\nsummary table' } }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'read', durationMs: 410, isError: false }),
    JSON.stringify({ type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'bun build --target' } }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'grep', durationMs: 380, isError: false }),
    JSON.stringify({ type: 'turn_end', message: { usage: { output: 311 } } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', toolName: 'read' } }),
    'not json at all',
  ].join('\n') + '\n';
  feed.push(events.slice(0, 10));
  feed.push(events.slice(10, events.indexOf('"toolName":"read","durationMs"')));

  const mid = feed.snapshot();
  assert.equal(mid.active, 'summary table', 'in-flight assistant text kept buffered in the feed (never displayed)');
  assert.deepEqual(mid.lines, ['Building the'], 'settled text line flushed immediately on arrival');

  feed.push(events.slice(events.indexOf('"toolName":"read","durationMs"')));
  const snap = feed.snapshot();
  assert.deepEqual(snap.lines, [
    'Building the',
    '✔ read src/index.ts · 410ms',
    '✔ grep bun build --target · 380ms',
    'summary table',
    '↵ turn · ↓311 tok',
  ]);
  assert.equal(snap.active, '', 'turn_end settles the in-flight line');
  assert.ok(!snap.lines.join('\n').includes('{'), 'raw JSON never leaks into the ticker');
  assert.ok(!snap.lines.join('\n').includes('↺'), 'toolcall echoes suppressed');

  // Overlapped tools settle the earlier start as ⚡ when a new start arrives.
  const overlap = new ActivityFeed();
  overlap.push([
    JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.md' } }),
    JSON.stringify({ type: 'tool_execution_start', toolName: 'grep', args: {} }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'grep', durationMs: 90, isError: false }),
  ].join('\n') + '\n');
  assert.deepEqual(overlap.snapshot().lines, ['⚡ read a.md', '✔ grep · 90ms'], 'overlapped start collapsed, not echoed twice');

  // Ticker cap: only the last 5 steps are retained (tool7 still pending, unseen).
  const bigFeed = new ActivityFeed();
  for (let i = 0; i < 8; i++) bigFeed.push(JSON.stringify({ type: 'tool_execution_start', toolName: `tool${i}`, args: {} }) + '\n');
  assert.equal(bigFeed.snapshot().lines.length, 5);
  assert.ok(bigFeed.snapshot().lines[0].includes('tool2'), 'oldest steps evicted, newest retained');
});
