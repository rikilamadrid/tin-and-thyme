import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  /** The program's stderr; when it wrote none and the run failed, Node's error message instead ("Command failed: <the full argv>", "spawn x ENOENT"). */
  stderr: string;
  /** Set by `run`: the program's own stderr only, never Node's error message (which echoes the arguments). */
  processStderr?: string;
  /** Set by `run`: the program was killed by `run` itself (its timeout, or its output limit). */
  killed?: boolean;
  /** Set by `run`: the signal that ended the program, if one did. */
  signal?: string | null;
  /** Set by `run`: Node's error code when the program could not be run or was stopped (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER). */
  errno?: string | null;
}

/** Runs a program without a shell. Never throws; check `ok`. `env` adds to (or overrides) the server's environment. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, env: opts.env ? { ...process.env, ...opts.env } : process.env },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean; signal?: NodeJS.Signals | null }) | null;
        const code = e && typeof e.code === "number" ? Number(e.code) : e ? null : 0;
        resolve({
          ok: !e,
          code: e ? (code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr || (e && !stderr ? e.message : "")),
          processStderr: String(stderr ?? ""),
          killed: e?.killed === true,
          signal: e?.signal ?? null,
          errno: e && typeof e.code === "string" ? e.code : null,
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** True when `cmd` is on PATH. */
export async function has(cmd: string): Promise<boolean> {
  const r = process.platform === "win32" ? await run("where", [cmd], { timeoutMs: 5000 }) : await run("sh", ["-c", `command -v ${cmd}`], { timeoutMs: 5000 });
  return r.ok && r.stdout.trim().length > 0;
}

/** Quotes a value for a POSIX shell command line. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
