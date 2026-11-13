// Tin & Thyme · the run-policy PreToolUse guard: a command guardrail that catches mistakes and
// plainly written commands, not isolation or a security boundary (runPolicy.ts POLICY_LIMITS,
// docs/run-policy-enforcement.md). It trusts the Tin & Thyme install and dist-server it comes from,
// the kitchen folder, the hook's cwd and the shell. Bundled to dist-server/run-policy-guard.mjs,
// copied into the kitchen state folder (~/.controlroom/<key>/) at coordinator start, and run by
// the hook command pathfinder.ts `guardHookCommand` builds, which reads this file once, checks its
// SHA-256 against the hash fixed at coordinator start, and runs those exact bytes. It can also be
// run directly (tests):
//
//   node run-policy-guard.mjs local-only
//   node run-policy-guard.mjs github-dev <owner/name>
//
// The policy is in the hook command itself, so rewriting run-policy.json or active-policy.json
// mid-run does not change it. That hook command lives in coordinator-settings.json, which Bash can
// rewrite; whether Claude Code rereads it mid-session is not verified (N6). Reads the hook's JSON on stdin:
//   Bash                                 -> checkCommand on tool_input.command
//   Write, Edit, MultiEdit, NotebookEdit -> checkFileWrite: the guard's own folder's policy files are refused
// Exit 0 allows; exit 2 blocks with the reason on stderr. Every failure — a bad policy argument,
// bad input (the 7b3eda3 guard allowed unparseable input; this one blocks it), an unknown tool, a
// crash — blocks (exit 2). If this file cannot run at all, the hook command turns that into exit 2.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { checkCommand, checkFileWrite, MAX_GIT_LOOKUPS, parsePolicy, repoFromUrl, type Verdict } from "./runPolicy";

const block = (msg: string): never => {
  process.stderr.write(msg);
  process.exit(2);
};
const gate = "Treat this step as a human decision: record it as a human gate (State: human-gate, Gate: <what you need>) and stop.";
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** The kitchen state folder: where this guard file lives (argv[1], also when the hook runs it from memory). */
const STATE_DIR = dirname(resolve(process.argv[1] ?? "."));

let lookups = 0;
const git = (dir: string, args: string[]) => {
  // A bounded number of lookups keeps the guard under Claude Code's hook timeout (POLICY_LIMITS).
  if (++lookups > MAX_GIT_LOOKUPS) throw new Error("git lookup budget spent");
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
};

/** The repo every push URL of a named remote resolves to (pushurl and insteadOf/pushInsteadOf applied), or null. */
function remoteRepo(remote: string, dir: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  try {
    const repos = git(dir, ["remote", "get-url", "--push", "--all", remote]).split("\n").filter(Boolean).map(repoFromUrl);
    if (!repos.length || repos.some((r) => !r || r.toLowerCase() !== repos[0]!.toLowerCase())) return null;
    return repos[0]!;
  } catch {
    return null;
  }
}

function gitConfig(key: string, dir: string): string[] | null {
  try {
    return git(dir, ["config", "--get-all", key]).split("\n").filter(Boolean);
  } catch (e) {
    // `git config --get-all` exits 1 when the key is unset; anything else (or a spent budget) is unreadable.
    return (e as { status?: number }).status === 1 ? [] : null;
  }
}

let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  try {
    const [mode, repo] = process.argv.slice(2);
    const { policy, problem } = parsePolicy({ mode, repo });
    if (problem) block(`Tin & Thyme run policy: ${problem}. The guard was started with a bad policy, so this is blocked. ${gate}`);
    const hook = JSON.parse(input || "{}") as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
    const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
    const tool = typeof hook.tool_name === "string" ? hook.tool_name : "Bash";
    const label = policy.mode === "local-only" ? "local only" : `GitHub development · ${policy.repo}`;
    let v: Verdict;
    if (tool === "Bash") {
      const command = typeof hook.tool_input?.command === "string" ? hook.tool_input.command : "";
      v = checkCommand(policy, command, { cwd, remoteRepo, gitConfig });
      if (!v.allow && lookups > MAX_GIT_LOOKUPS) v = { allow: false, reason: `this command needs more than ${MAX_GIT_LOOKUPS} git lookups to check; split it into smaller commands` };
    } else if (FILE_TOOLS.has(tool)) {
      const path = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path;
      v = checkFileWrite(typeof path === "string" ? path : "", cwd, STATE_DIR);
    } else {
      v = { allow: false, reason: `the guard does not check the ${tool} tool` };
    }
    if (!v.allow) block(`Tin & Thyme run policy (${label}): ${v.reason}. ${gate}`);
    process.exit(0);
  } catch (e) {
    block(`Tin & Thyme run policy: the guard could not check this command (${(e as Error).message}), so it is blocked. ${gate}`);
  }
});
