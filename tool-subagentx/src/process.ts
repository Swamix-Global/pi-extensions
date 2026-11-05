import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

// Pi's bash tool can create a separate process group. Capture descendants as well
// as the CLI group before terminating it; a group kill alone would miss those.
function descendants(root: number): number[] {
  const parents = new Map<number, number>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      } catch { /* process exited */ }
    }
  } catch { /* non-Linux: process-group termination still applies */ }
  const found = new Set([root]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of parents) {
      if (found.has(parent) && !found.has(pid)) { found.add(pid); added = true; }
    }
  }
  return [...found].reverse();
}

export function runProcess(options: {
  command: string; args: string[]; input: string; cwd: string;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
  maxBytes?: number; graceMs?: number;
  onStream?: (chunk: string, stream: "stdout" | "stderr") => void;
}): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", code: null, error: "cancelled" });
  return new Promise((resolve) => {
    // No artificial limit by default. If maxBytes is explicitly provided, enforce it.
    const limit = typeof options.maxBytes === "number" && options.maxBytes > 0 ? options.maxBytes : Infinity;
    const grace = options.graceMs ?? 750;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: string | undefined;
    let code: number | null = null;
    let done = false, closed = false, stopping = false;
    let deadline: NodeJS.Timeout | undefined, killer: NodeJS.Timeout | undefined;
    let targets: number[] = [];
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch { /* exited */ }
      }
      for (const pid of targets) { try { process.kill(pid, signal); } catch { /* exited */ } }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline); clearTimeout(killer);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ stdout, stderr, code, ...(error ? { error } : {}) });
    };
    const stop = (reason: string) => {
      if (done || stopping) return;
      stopping = true;
      error = reason;
      clearTimeout(deadline);
      targets = child.pid ? descendants(child.pid) : [];
      kill("SIGTERM");
      // Do not clear escalation just because the CLI exits: descendants may live.
      killer = setTimeout(() => { kill("SIGKILL"); finish(); }, grace);
    };
    const abort = () => stop("cancelled");
    const collect = (stream: "stdout" | "stderr", data: Buffer) => {
      if (done || stopping) return;
      if (limit !== Infinity) {
        const total = stdoutBytes + stderrBytes + data.length;
        if (total > limit) {
          stop(`output exceeded ${limit} bytes`);
          return;
        }
      }
      if (stream === "stdout") {
        stdoutChunks.push(data);
        stdoutBytes += data.length;
      } else {
        stderrChunks.push(data);
        stderrBytes += data.length;
      }
      try {
        options.onStream?.(data.toString("utf8"), stream);
      } catch {}
    };
    child.stdout.on("data", (data) => collect("stdout", data));
    child.stderr.on("data", (data) => collect("stderr", data));
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") stop(`stdin: ${err.message}`);
    });
    child.on("error", (err) => { error = err.message; if (!stopping) finish(); });
    child.on("close", (exit, signal) => {
      closed = true;
      code = exit;
      if (signal && !error) error = `terminated by ${signal}`;
      if (!stopping) finish();
    });
    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0 && options.timeoutMs !== Infinity) {
      deadline = setTimeout(() => stop(`timeout after ${options.timeoutMs! / 1000}s`), options.timeoutMs);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else if (!closed && !done) child.stdin.end(options.input);
  });
}
