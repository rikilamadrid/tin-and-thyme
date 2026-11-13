// Tin & Thyme · the run policy: command guardrails for what an orchestration's coordinator and
// workers type into the Bash tool. The PreToolUse guard (runPolicyGuard.ts) asks `checkCommand`
// for Bash and `checkFileWrite` for the Write/Edit tools.
//
// Both policies are guardrails, not isolation and not a security boundary. They catch mistakes and
// commands written plainly. They trust the Tin & Thyme install and its dist-server, the files in the
// kitchen folder (~/.controlroom/<key>/), the working directory the hook reports, and the shell that
// runs the command. An agent that changes one of those, or writes a command the shell reads
// differently from this parser, gets past them. What GitHub can enforce instead, and an activation
// plan: docs/run-policy-enforcement.md.
//
// Two policies, chosen per kitchen in ~/.controlroom/<key>/run-policy.json
// (`tin-and-thyme policy --set=…`) and fixed into the coordinator's hook command when it starts:
//
//   local-only  (default)  the legacy rule, unchanged: a Bash command whose TEXT matches
//                          BLOCKED_COMMANDS (git push, gh pr|issue|release|repo|api, vercel,
//                          netlify, npm|pnpm publish) is refused. A text match only.
//   github-dev             GitHub development on ONE repository. A shape check over the Bash text:
//                          the command is parsed as bash, and every git and gh command the parser
//                          finds (also inside $(…), backticks, sh -c, eval, find -exec and the
//                          wrappers below) must have one of the shapes this file recognises, or it
//                          is refused. Only git and gh are shape-checked; other programs run unchecked:
//                            gh       reads; `issue create|edit|comment|close|reopen`,
//                                     `label create|edit`, `pr create|edit|comment|ready|review`
//                                     with exactly `-R <repo>` and only the flags listed in
//                                     GH_WRITES (PRs: --head ticket/*, --base main; reviews:
//                                     --comment or --request-changes); `api` GET only.
//                            git push `git [-C dir] push [-u|-q|-v|-n|--porcelain|--no-verify]
//                                     <named remote of the repo> <[src:]ticket/<name>>…`.
//                            git      the local built-ins in GIT_LOCAL, without the options that
//                                     run a command (rebase -x, submodule foreach, …), and
//                                     aliases that resolve to one of them.
//                          A program name or a git/gh argument computed in a bash form the parser
//                          knows ($X, $(…), globs, braces) is refused, except a quoted gh
//                          --title/--body value. Each refusal is a human gate.
//
// What this does NOT enforce is in POLICY_LIMITS, printed by the CLI and logged at coordinator
// start. The short version: the guard reads Bash text. It is not a sandbox. Anything that runs
// command text the guard never sees (a script, node -e, a git hook, git config that runs a
// program), and shell forms the parser does not model (zsh expansions, builtins that evaluate a
// string, unknown wrappers: the knownBypass cases in scripts/run-policy-test.ts), is bounded only
// by the credentials the process can reach and by what GitHub enforces server-side.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type RunPolicy = { mode: "local-only" } | { mode: "github-dev"; repo: string };

export const LOCAL_ONLY: RunPolicy = { mode: "local-only" };
export const POLICY_FILE = "run-policy.json";
/** A record of what the running coordinator's guard enforces, written at coordinator start. The guard does not read it. */
export const ACTIVE_POLICY_FILE = "active-policy.json";
/** The kitchen-state files an agent's Write/Edit tools may never change (they define or carry the guard). */
export const PROTECTED_FILES = [POLICY_FILE, ACTIVE_POLICY_FILE, "run-policy-guard.mjs", "no-push-guard.mjs", "coordinator-settings.json"];
/** At most this many git lookups per guard call (5 s each), so the guard stays well under Claude Code's 60 s hook timeout. */
export const MAX_GIT_LOOKUPS = 8;

/** Where the external enforcement model and the activation plan are written down (in the Tin & Thyme repository, not the npm package). */
export const ENFORCEMENT_DOC = "docs/run-policy-enforcement.md";
const ENFORCEMENT_DOC_URL = `https://github.com/rikilamadrid/tin-and-thyme/blob/main/${ENFORCEMENT_DOC}`;

/** Stated plainly wherever the policy is shown: what the guard does not enforce. */
export const POLICY_LIMITS = [
  `A command guardrail, not isolation and not a security boundary. Both policies read the text of each Bash command and catch mistakes and commands written plainly. They trust the Tin & Thyme install and its dist-server, the files in the kitchen folder (~/.controlroom/<kitchen>/), the working directory the hook reports, and the shell that runs the command; an agent that changes one of those, or writes a command the shell reads differently from the guard, gets past it. Real limits on GitHub come from GitHub itself (rulesets or branch protection, required reviews, a separate agent identity) and from which credentials the agent process can reach: see ${ENFORCEMENT_DOC} in the Tin & Thyme repository (${ENFORCEMENT_DOC_URL}).`,
  "Not a sandbox. The guard reads the text of each Bash command. What that command starts is not checked: scripts and shell functions, node/python/ruby/perl (node -e and python -c included), make, pnpm run, curl or any HTTP client, programs that run command text from their arguments or input (ssh, parallel, watch, …), git hooks, git or gh configuration that runs a program (core.pager, core.sshCommand, core.hooksPath, diff and merge tools), and the orchestration engine's own gh calls. Those can do whatever any credential the process can reach allows (the gh login, git credential helpers, SSH keys, npm and deploy logins), not only the token you meant the run to use.",
  "Bash can change the policy and guard files in both modes; they are ordinary files in ~/.controlroom/<kitchen>/. The kitchen copy of the guard is checked against the SHA-256 fixed when the coordinator started, so a changed or emptied copy blocks every guarded tool call until the coordinator restarts. A restart does not restore anything: it hashes whatever guard the Tin & Thyme install's dist-server holds then and trusts it, so a guard rewritten there is trusted from the next start. A changed run-policy.json takes effect the next time the coordinator starts (github-dev must still name the repository's origin then): check `tin-and-thyme policy` before starting. github-dev also refuses Bash commands that name these files literally; a glob or a variable gets past that check. Bash can also rewrite coordinator-settings.json; whether Claude Code rereads it during a session is not verified.",
  "Only the Bash, Write, Edit, MultiEdit and NotebookEdit tools are guarded; MCP and web tools are not. Write/Edit may not change the policy, guard or settings files, compared by name (case-insensitively) and by file identity.",
  "local-only matches the command text with a regular expression, exactly as before: a command that builds the words (G=git; $G push …, $(echo git) push …, git --git-dir /x push …) or hides them in a script gets past it.",
  "github-dev parses commands as bash, but the Bash tool may run zsh, and the parser does not follow every way a shell runs text. Known to get past it today (recorded as knownBypass cases in scripts/run-policy-test.ts, not fixed): zsh `=cmd` expansion, glob qualifiers and the (e) flag (=gh 'pr' merge 1, ls /(e:'…':), ${(e)x}); builtins that evaluate a string or a file (trap '…' EXIT, source or . of /dev/stdin, bash /dev/stdin with a here-string); builtin cd or command cd before a push, which then pushes from another repository; programs that run another program (xcrun, arch, script) with a quoted word; and git merge -s <strategy>, which runs a git-merge-<name> program. There will be others.",
  "github-dev: gh issue and label writes may touch any issue or label in the repository, not only ticket issues, and --body-file may name any file the process can read, whose content is posted. Pull requests must say --base main. gh api is GET only, and gh api graphql is refused even for reads.",
  "github-dev: remotes, aliases and git config are resolved in the working directory Claude Code reports for the call (or git -C), and each Bash call is assumed to start a fresh shell. Environment set outside the command (your shell profile, CLAUDE_ENV_FILE, GH_HOST, GIT_*) and gh's own config are not seen.",
  "It covers the coordinator session the kitchen starts and the subagents inside it, not other sessions. A guard call that outlived Claude Code's hook timeout would count as a non-blocking error; the guard makes at most 8 git lookups of up to 5 s each to stay under it.",
];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The legacy local-only rule, unchanged: any push, and gh pr|issue|release|repo|api, publish and deploy tools. */
export const BLOCKED_COMMANDS = String.raw`\bgit(\s+(-C|-c)\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+push\b|\bgh\s+(pr|issue|release|repo|api)\b|\bvercel\b|\bnetlify\b|\bnpm\s+publish\b|\bpnpm\s+publish\b`;

export function parsePolicy(raw: unknown): { policy: RunPolicy; problem: string | null } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.mode === "local-only") return { policy: LOCAL_ONLY, problem: null };
  if (r.mode === "github-dev") {
    if (typeof r.repo === "string" && REPO_RE.test(r.repo)) return { policy: { mode: "github-dev", repo: r.repo }, problem: null };
    return { policy: LOCAL_ONLY, problem: `github-dev needs "repo": "owner/name" (got ${JSON.stringify(r.repo)}); using local-only` };
  }
  return { policy: LOCAL_ONLY, problem: `unknown run policy mode ${JSON.stringify(r.mode)}; using local-only` };
}

/** The kitchen's configured policy. A missing file is local-only; a broken one is local-only plus a problem. */
export function readPolicy(dir: string, file = POLICY_FILE): { policy: RunPolicy; problem: string | null } {
  const path = join(dir, file);
  if (!existsSync(path)) return { policy: LOCAL_ONLY, problem: null };
  try {
    return parsePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return { policy: LOCAL_ONLY, problem: `${path} is not valid JSON (${(e as Error).message}); using local-only` };
  }
}

export function writePolicy(dir: string, policy: RunPolicy, file = POLICY_FILE) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(`${path}.tmp`, JSON.stringify(policy, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

/** The guard's argv for a policy: it is fixed in the hook command, so no file read at check time can widen it. */
export function policyArgs(p: RunPolicy): string[] {
  return p.mode === "local-only" ? ["local-only"] : ["github-dev", p.repo];
}

export function describePolicy(p: RunPolicy): string {
  return p.mode === "local-only"
    ? "local only: a command guardrail, not a security boundary. A Bash command whose text names git push, gh pr/issue/release/repo/api, vercel, netlify or npm/pnpm publish is refused (a text match that catches mistakes and plain commands; it does not see what scripts or programs do, and a command that builds the words gets past it)"
    : `GitHub development on ${p.repo}: a command guardrail, not isolation and not a security boundary. Bash commands written plainly may run gh reads, issue and label writes, pull requests from ticket/* into main, comment and request-changes reviews, and git push of ticket/* branches to a remote of that repository; merges, approvals, other branches, releases, publish and deploys written plainly are refused. It is not a sandbox: scripts, programs, git hooks, git config and shell forms the guard does not parse (zsh expansions, trap, source, unknown wrappers) can still do whatever the credentials on this machine allow. Protect main, tags and merges on GitHub itself (${ENFORCEMENT_DOC})`;
}

/**
 * `owner/name` from a GitHub remote URL, or null. Only github.com itself counts: `git@github.com:o/n`,
 * `ssh://git@github.com/o/n` and `https://[user@]github.com/o/n`, each with an optional `.git`.
 */
export function repoFromUrl(url: string): string | null {
  const u = url.trim();
  const m =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^ssh:\/\/git@github\.com(?::22)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^https:\/\/(?:[^@/\s]+@)?github\.com(?::443)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `owner/name` that every push URL of the repo's origin points at, or null when absent, not GitHub, or mixed. */
export function originRepo(root: string): string | null {
  try {
    const out = execFileSync("git", ["-C", root, "remote", "get-url", "--push", "--all", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const repos = out.split("\n").filter(Boolean).map(repoFromUrl);
    if (!repos.length || repos.some((r) => !r || r.toLowerCase() !== repos[0]!.toLowerCase())) return null;
    return repos[0]!;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Write/Edit tools

/**
 * Refuses a Write/Edit/MultiEdit/NotebookEdit of a protected file in the kitchen state folder
 * (`stateDir`). Compared by path, case-insensitively (macOS and Windows file names are), with
 * symlinks resolved, and by file identity (device and inode), which also catches hard links.
 */
export function checkFileWrite(filePath: string, cwd: string, stateDir: string): Verdict {
  if (!filePath) return deny("this file tool call names no file");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const lower = (p: string) => p.toLowerCase();
  const state = new Set([resolve(stateDir), real(stateDir)].filter((x): x is string => !!x).map(lower));
  const names = PROTECTED_FILES.map(lower);
  const abs = resolve(cwd, filePath);
  const parentReal = real(dirname(abs));
  const candidates = [abs, real(abs), parentReal ? join(parentReal, basename(abs)) : null].filter((x): x is string => !!x);
  const refuse = (name: string) => deny(`${name} defines this run's guard; only you can change it (tin-and-thyme policy --set=…)`);
  for (const c of candidates) {
    if (state.has(lower(dirname(c))) && names.includes(lower(basename(c)))) return refuse(basename(c));
  }
  const id = (p: string) => {
    try {
      const s = statSync(p);
      return `${s.dev}:${s.ino}`;
    } catch {
      return null;
    }
  };
  const target = id(abs);
  if (target) {
    for (const f of PROTECTED_FILES) if (id(join(stateDir, f)) === target) return refuse(f);
  }
  return ALLOW;
}

// ---------------------------------------------------------------- the decision

export type Verdict = { allow: true } | { allow: false; reason: string };

export interface CheckContext {
  /** The command's working directory, as the hook reports it. */
  cwd: string;
  /** The GitHub `owner/name` every push URL of a named git remote points at, resolved in `dir`; null when unknown or mixed. */
  remoteRepo(remote: string, dir: string): string | null;
  /** `git config --get-all <key>` in `dir`: [] when unset, null when it could not be read. */
  gitConfig(key: string, dir: string): string[] | null;
}

const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

// ---------------------------------------------------------------- the shell lexer (github-dev)

/**
 * One shell word. `dynamic`: the shell computes part of it ($X, $(…), `…`, ${…}, $'…', globs,
 * braces, a leading ~), so its value is not the text. `split`: it may become several words
 * (unquoted expansion, globs, "$@").
 */
export interface Word {
  text: string;
  dynamic: boolean;
  split: boolean;
  /** Computed only because of an unquoted glob or brace (no $ or ` expansion). */
  globOnly?: boolean;
}
interface Lexed {
  commands: Word[][];
  /** Command substitutions, process substitutions and backtick bodies: scripts that run, checked on their own. */
  subs: string[];
  end: number;
  error: string | null;
}

const VAR_START = /[A-Za-z_0-9@*#?$!-]/;

function backtick(s: string, i: number): { body: string; end: number } | null {
  let j = i + 1;
  while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
  if (j >= s.length) return null;
  return { body: s.slice(i + 1, j).replace(/\\([`\\$])/g, "$1"), end: j };
}

/** Index of the `}` closing the `{` at `i`, or -1. */
function matchBrace(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") {
      const k = s.indexOf("'", j + 1);
      if (k < 0) return -1;
      j = k;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
  }
  return -1;
}

interface Expanded {
  text: string;
  subs: string[];
  dynamic: boolean;
  split: boolean;
  end: number;
  error: string | null;
}

/** Text where $… expands: inside "…" (stop = '"') or an unquoted heredoc body (stop = null). */
function scanExpanding(s: string, start: number, stop: '"' | null): Expanded {
  let text = "";
  let dynamic = false;
  let split = false;
  const subs: string[] = [];
  const err = (error: string): Expanded => ({ text, subs, dynamic, split, end: s.length, error });
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (stop && c === stop) return { text, subs, dynamic, split, end: i, error: null };
    if (c === "\\") {
      const n = s[i + 1] ?? "";
      if ((stop ? /["\\$`\n]/ : /[\\$`]/).test(n) && n !== "") {
        if (n !== "\n") text += n;
        i += 2;
      } else {
        text += c;
        i++;
      }
      continue;
    }
    if (c === "`") {
      const b = backtick(s, i);
      if (!b) return err("an unterminated ` substitution");
      subs.push(b.body);
      text += s.slice(i, b.end + 1);
      dynamic = true;
      i = b.end + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      const inner = lexFrom(s, i + 2, ")");
      if (inner.error) return err(inner.error);
      subs.push(s.slice(i + 2, inner.end));
      text += s.slice(i, inner.end + 1);
      dynamic = true;
      i = inner.end + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "{") {
      const j = matchBrace(s, i + 1);
      if (j < 0) return err("an unterminated ${");
      const body = s.slice(i + 2, j);
      const inner = scanExpanding(body, 0, null);
      if (inner.error) return err(inner.error);
      subs.push(...inner.subs);
      if (body === "@" || /\[[@*]\]/.test(body)) split = true;
      text += s.slice(i, j + 1);
      dynamic = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && VAR_START.test(s[i + 1] ?? "")) {
      let j = i + 1;
      if (/[A-Za-z_]/.test(s[j])) while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      else j++;
      if (s[i + 1] === "@") split = true;
      text += s.slice(i, j);
      dynamic = true;
      i = j;
      continue;
    }
    text += c;
    i++;
  }
  if (stop) return err('an unterminated " quote');
  return { text, subs, dynamic, split, end: i, error: null };
}

/**
 * Lexes shell text from `start` into simple commands, until the end or (until = ")") the `)` that
 * closes a `$(`. Understands quotes, escapes, comments, $… expansions, command and process
 * substitution, redirections and heredocs. Anything it can't read (an open quote, a heredoc that
 * never ends) is an error, and github-dev refuses the command. It models bash only: zsh's `=cmd`,
 * glob qualifiers and parameter flags such as (e) read as plain words here (POLICY_LIMITS).
 */
function lexFrom(s: string, start: number, until: ")" | null): Lexed {
  const commands: Word[][] = [];
  const subs: string[] = [];
  let words: Word[] = [];
  let text = "";
  let unq = "";
  let has = false;
  let dyn = false;
  let split = false;
  let dropNext = false;
  let depth = 0;
  const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];
  const fail = (error: string): Lexed => ({ commands, subs, end: s.length, error });
  const flushWord = () => {
    if (has) {
      const expands = dyn;
      let glob = false;
      if (/[*?]|\[.*\]/.test(unq) || /\{[^}]*(,|\.\.)[^}]*\}/.test(unq)) {
        dyn = true;
        split = true;
        glob = true;
      }
      if (unq.startsWith("~")) dyn = true;
      if (dropNext) dropNext = false;
      else words.push({ text, dynamic: dyn, split, ...(glob && !expands ? { globOnly: true } : {}) });
    }
    text = "";
    unq = "";
    has = false;
    dyn = false;
    split = false;
  };
  const flushCmd = () => {
    flushWord();
    dropNext = false;
    if (words.length) commands.push(words);
    words = [];
  };
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return fail("an unterminated ' quote");
      text += s.slice(i + 1, j);
      has = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return fail("an unterminated $' quote");
      text += s.slice(i, j + 1);
      has = dyn = true;
      i = j + 1;
      continue;
    }
    if (c === '"' || (c === "$" && s[i + 1] === '"')) {
      const q = scanExpanding(s, c === "$" ? i + 2 : i + 1, '"');
      if (q.error) return fail(q.error);
      text += q.text;
      subs.push(...q.subs);
      has = true;
      if (q.dynamic) dyn = true;
      if (q.split) split = true;
      i = q.end + 1;
      continue;
    }
    if (c === "`") {
      const b = backtick(s, i);
      if (!b) return fail("an unterminated ` substitution");
      subs.push(b.body);
      text += s.slice(i, b.end + 1);
      has = dyn = split = true;
      i = b.end + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      const inner = lexFrom(s, i + 2, ")");
      if (inner.error) return fail(inner.error);
      subs.push(s.slice(i + 2, inner.end));
      text += s.slice(i, inner.end + 1);
      has = dyn = split = true;
      i = inner.end + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "{") {
      const j = matchBrace(s, i + 1);
      if (j < 0) return fail("an unterminated ${");
      const inner = scanExpanding(s.slice(i + 2, j), 0, null);
      if (inner.error) return fail(inner.error);
      subs.push(...inner.subs);
      text += s.slice(i, j + 1);
      has = dyn = split = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && VAR_START.test(s[i + 1] ?? "")) {
      let j = i + 1;
      if (/[A-Za-z_]/.test(s[j])) while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      else j++;
      text += s.slice(i, j);
      has = dyn = split = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < s.length) {
        text += s[i + 1];
        has = true;
      }
      i += 2;
      continue;
    }
    if (c === "#" && !has) {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      flushCmd();
      i++;
      for (const doc of heredocs) {
        let body = "";
        let done = false;
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          const line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length : nl + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) {
            done = true;
            break;
          }
          body += line + "\n";
        }
        if (!done) return fail(`a heredoc that never ends (${doc.delim})`);
        if (!doc.quoted) {
          const q = scanExpanding(body, 0, null);
          if (q.error) return fail(q.error);
          subs.push(...q.subs);
        }
      }
      heredocs.length = 0;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      i++;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && s[i + 1] === ">")) {
      if ((c === "<" || c === ">") && s[i + 1] === "(") {
        flushWord();
        const inner = lexFrom(s, i + 2, ")");
        if (inner.error) return fail(inner.error);
        subs.push(s.slice(i + 2, inner.end));
        text = s.slice(i, inner.end + 1);
        has = dyn = true;
        i = inner.end + 1;
        continue;
      }
      if (has && !dyn && text === unq && /^\d+$/.test(text)) {
        text = unq = "";
        has = false; // a file descriptor number: 2>&1
      } else flushWord();
      if (s.startsWith("<<<", i)) {
        i += 3;
        dropNext = true;
        continue;
      }
      if (s.startsWith("<<", i)) {
        i += 2;
        const strip = s[i] === "-";
        if (strip) i++;
        while (s[i] === " " || s[i] === "\t") i++;
        let delim = "";
        let quoted = false;
        while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
          const ch = s[i];
          if (ch === "'" || ch === '"') {
            const j = s.indexOf(ch, i + 1);
            if (j < 0) return fail("an unterminated heredoc delimiter");
            delim += s.slice(i + 1, j);
            quoted = true;
            i = j + 1;
          } else if (ch === "\\") {
            delim += s[i + 1] ?? "";
            quoted = true;
            i += 2;
          } else {
            delim += ch;
            i++;
          }
        }
        if (!delim) return fail("a heredoc without a delimiter");
        heredocs.push({ delim, quoted, strip });
        continue;
      }
      const op = /^(&>>|&>|>>|>\||>&|<&|<>|>|<)/.exec(s.slice(i))![0];
      i += op.length;
      dropNext = true;
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      flushCmd();
      i++;
      continue;
    }
    if (c === "(") {
      flushCmd();
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      flushCmd();
      if (until === ")" && depth === 0) {
        if (heredocs.length) return fail("a heredoc that never ends");
        return { commands, subs, end: i, error: null };
      }
      depth--;
      i++;
      continue;
    }
    if ((c === "{" || c === "}") && !has && " \t\n;&|)".includes(s[i + 1] ?? " ")) {
      flushCmd(); // a { …; } group
      i++;
      continue;
    }
    text += c;
    unq += c;
    has = true;
    i++;
  }
  if (until) return fail("an unterminated $(");
  flushCmd();
  if (heredocs.length) return fail("a heredoc that never ends");
  return { commands, subs, end: i, error: null };
}

/** The simple commands of a shell text, as plain words (top level only; for tests and tools). */
export function splitShell(command: string): string[][] {
  return lexFrom(command, 0, null).commands.map((ws) => ws.map((w) => w.text));
}

// ---------------------------------------------------------------- from shell text to the commands that run

const base = (w: string) => w.replace(/^.*\//, "");
/** Reserved words that may start a simple command; the command after them is what runs. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "coproc"]);
/** Reserved words that start something which is not itself a command (their substitutions are still checked). */
const NOT_A_COMMAND = new Set(["for", "select", "case", "function", "in", "esac"]);
/** Programs that run another program given later on their command line. A fixed list: others (xcrun, arch, script, …) are not unwrapped (POLICY_LIMITS). */
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "sudo", "doas", "nice", "timeout", "caffeinate", "stdbuf", "setsid", "ionice", "chrt", "flock", "unbuffer", "chronic", "watch", "nodemon", "entr"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** The programs this policy decides about. */
const OUTWARD = new Set(["git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "bunx", "vercel", "netlify"]);
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s;
const DECLARE = new Set(["export", "declare", "typeset", "readonly", "local"]);
/** A word whose program the policy must follow into (so a wrapper's later words are scanned for it). */
const followed = (w: Word) => {
  const b = base(w.text);
  return OUTWARD.has(b) || /^git-/.test(b) || SHELLS.has(b) || WRAPPERS.has(b) || ["eval", "xargs", "find", "env", "source", "."].includes(b);
};
const COMPUTED = "the program it runs is computed by the shell ($…, `…`, a glob or a brace), so the policy can't tell what runs; write the program name out";

interface Assign {
  name: string;
  value: string;
  dynamic: boolean;
}
interface Flat {
  argv: Word[];
}
interface Tree {
  commands: Flat[];
  assigns: Assign[];
  /** cd, pushd, popd or env -C somewhere in the command. */
  changesDir: boolean;
}

/** Every command the Bash text runs that the policy can see, with nesting resolved, or the reason it can't be read. */
function flatten(script: string, depth: number, tree: Tree): string | null {
  if (depth > 6) return "this command nests shells too deeply to check";
  const lx = lexFrom(script, 0, null);
  if (lx.error) return `the policy can't parse this command (${lx.error}); write it plainly`;
  for (const sub of lx.subs) {
    const r = flatten(sub, depth + 1, tree);
    if (r) return r;
  }
  for (const words of lx.commands) {
    const r = unwrap(words, depth, tree);
    if (r) return r;
  }
  return null;
}

/** Strips keywords, assignments and wrappers from one simple command and records what runs. */
function unwrap(words: Word[], depth: number, tree: Tree): string | null {
  let i = 0;
  while (i < words.length && !words[i].dynamic && KEYWORDS.has(words[i].text)) i++;
  if (i < words.length && !words[i].dynamic && NOT_A_COMMAND.has(words[i].text)) return null;
  const nested = (script: string) => flatten(script, depth + 1, tree);
  for (;;) {
    while (i < words.length && ASSIGN_RE.test(words[i].text)) {
      const [, name, value] = ASSIGN_RE.exec(words[i].text)!;
      tree.assigns.push({ name, value, dynamic: words[i].dynamic });
      i++;
    }
    const w = words[i];
    if (w === undefined) return null;
    if (w.dynamic) return COMPUTED;
    const b = base(w.text);
    const rest = words.slice(i + 1);
    if (b === "cd" || b === "pushd" || b === "popd") tree.changesDir = true;
    if (DECLARE.has(b)) {
      for (const a of rest) {
        const m = ASSIGN_RE.exec(a.text);
        if (m) tree.assigns.push({ name: m[1], value: m[2], dynamic: a.dynamic });
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.text)) tree.assigns.push({ name: a.text, value: "", dynamic: true });
      }
      return null;
    }
    if (b === "alias") {
      if (rest.some((a) => a.text.includes("=") || a.dynamic)) return "defining a shell alias can hide a command from the policy; run the command itself";
      return null;
    }
    if (b === "env") {
      let j = i + 1;
      for (; j < words.length; j++) {
        const t = words[j];
        if (t.dynamic) return COMPUTED;
        if (["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"].includes(t.text)) continue;
        if (t.text === "-u" || t.text === "--unset") j++;
        else if (/^(-u.|--unset=)/.test(t.text)) continue;
        else if (t.text === "-C" || t.text === "--chdir" || /^(-C.|--chdir=)/.test(t.text)) {
          tree.changesDir = true;
          if (t.text === "-C" || t.text === "--chdir") j++;
        } else if (/^(-S|--split-string)/.test(t.text)) return "env -S runs a command line the policy doesn't parse; run the command directly";
        else if (t.text.startsWith("-")) return `env ${t.text} isn't an option this policy recognises; run the command directly`;
        else break;
      }
      i = j;
      continue;
    }
    if (WRAPPERS.has(b)) {
      let j = i + 1;
      for (; j < words.length; j++) {
        if (words[j].dynamic) return COMPUTED;
        const m = ASSIGN_RE.exec(words[j].text);
        if (m) tree.assigns.push({ name: m[1], value: m[2], dynamic: false });
        if (followed(words[j])) break;
      }
      if (j >= words.length) return null; // the wrapped program is not one this policy decides about
      i = j;
      continue;
    }
    if (SHELLS.has(b)) {
      let script: Word | undefined;
      let file = false;
      let stdin = false;
      for (let j = i + 1; j < words.length; j++) {
        const t = words[j];
        if (t.dynamic) return COMPUTED;
        if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(t.text)) {
          j++;
          continue;
        }
        if (/^-[A-Za-z]+$/.test(t.text) && t.text.includes("c")) {
          script = words[j + 1];
          if (!script) return "a shell -c without a script";
          break;
        }
        if (/^[-+][A-Za-z]+$/.test(t.text)) {
          if (t.text.includes("s")) stdin = true;
          continue;
        }
        if (t.text.startsWith("--")) continue;
        if (t.text === "-") stdin = true;
        else file = true;
        break;
      }
      if (script) return script.dynamic ? COMPUTED : nested(script.text);
      if (!file || stdin) return `${b} reading commands from its input isn't checked by the policy; run the commands directly`;
      return null; // a script file: not inspected (POLICY_LIMITS)
    }
    if (b === "eval") {
      if (rest.some((a) => a.dynamic)) return COMPUTED;
      return nested(rest.map((a) => a.text).join(" "));
    }
    if (b === "xargs") {
      for (const t of rest) {
        if (t.dynamic) return COMPUTED;
        if (followed(t)) return `xargs supplies the arguments of \`${t.text}\` from its input, so the policy can't check them; run the command directly`;
      }
      return null;
    }
    if (b === "find") {
      for (let j = i + 1; j < words.length; j++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[j].text)) continue;
        const end = words.findIndex((x, k) => k > j && (x.text === ";" || x.text === "+"));
        if (end < 0) return `find ${words[j].text} without a closing ; or +`;
        const sub = words.slice(j + 1, end).map((x) => (x.text.includes("{}") ? { ...x, dynamic: true, split: true } : x));
        const r = unwrap(sub, depth + 1, tree);
        if (r) return r;
        j = end;
      }
      return null;
    }
    tree.commands.push({ argv: words.slice(i) });
    return null;
  }
}

/** What github-dev carries through one check. */
interface DevCheck {
  policy: Extract<RunPolicy, { mode: "github-dev" }>;
  ctx: CheckContext;
  tree: Tree;
  /** Set when the command also changes directory, git config, remotes, PATH or GIT_* env: any push in it is refused. */
  pushHazard: string | null;
}

/** Names of the guard's own files. A github-dev Bash command that names one is refused; a glob or variable gets past this (POLICY_LIMITS). */
const PROTECTED_RE = new RegExp(PROTECTED_FILES.map((f) => f.replace(/[.]/g, "\\.")).join("|"), "i");

export function checkCommand(policy: RunPolicy, command: string, ctx: CheckContext): Verdict {
  if (policy.mode === "local-only") {
    return new RegExp(BLOCKED_COMMANDS).test(command)
      ? deny("this run is local only. Do not push, open or edit pull requests or GitHub issues, call the GitHub API, or deploy")
      : ALLOW;
  }
  if (PROTECTED_RE.test(command)) return deny("this command touches the run policy or its guard; only you change those (tin-and-thyme policy --set=…)");
  const tree: Tree = { commands: [], assigns: [], changesDir: false };
  const problem = flatten(command, 0, tree);
  if (problem) return deny(problem);
  const dc: DevCheck = { policy, ctx, tree, pushHazard: pushHazard(tree) };
  let accounted = false;
  for (const { argv } of tree.commands) {
    const v = checkArgv(dc, argv);
    if (v === null) continue;
    accounted = true;
    if (!v.allow) return v;
  }
  // The old tripwire still applies: unquoted text that looks like a push or a gh write must have been parsed above.
  // A speed bump for plain mistakes only: a quoted word ('push', 'pr') gets past it (POLICY_LIMITS).
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  if (!accounted && new RegExp(BLOCKED_COMMANDS).test(unquoted)) return deny("this looks like a push, GitHub or deploy command written in a way the policy can't check; run it plainly");
  return ALLOW;
}

/** The git subcommand of a git argv (after its global options), or null. */
function gitSub(args: Word[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (a === "-C" || a === "-c") i++;
    else if (!a.startsWith("-")) return a;
  }
  return null;
}

/**
 * Things in the same Bash command that can make a push go somewhere the guard did not check:
 * changing directory (the guard resolves the remote in the hook's cwd), rewriting git config or
 * remotes before the push runs, PATH (another git) and GIT_* environment. The directory check sees
 * cd, pushd, popd and env -C written as the command itself; `builtin cd` and `command cd` are not
 * seen (a known bypass, POLICY_LIMITS).
 */
function pushHazard(tree: Tree): string | null {
  if (tree.changesDir) return "it also changes directory, so the guard can't tell which repository the push runs in";
  for (const { argv } of tree.commands) {
    const b = base(argv[0].text);
    const sub = b === "git" ? gitSub(argv.slice(1)) : /^git-/.test(b) ? b.slice(4) : null;
    if (sub === "config" || sub === "remote") return "it also changes git config or remotes, which can redirect the push";
  }
  const env = tree.assigns.find((a) => /^GIT_/.test(a.name) || a.name === "PATH");
  if (env) return `it sets ${env.name}, which can redirect the push`;
  return null;
}

/** null: not a command this policy decides about. */
function checkArgv(dc: DevCheck, argv: Word[]): Verdict | null {
  const prog = base(argv[0].text);
  const args = argv.slice(1);
  if (prog === "gh") return checkGh(dc, args);
  if (prog === "git") return checkGit(dc, args);
  if (/^git-./.test(prog)) return checkGit(dc, [{ text: prog.slice(4), dynamic: false, split: false }, ...args]);
  if (prog === "vercel" || prog === "netlify") return deny(`deploys (${prog}) need your approval`);
  if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    const at = args.findIndex((a) => !a.text.startsWith("-"));
    if (at < 0) return null;
    if (args[at].dynamic) return deny(COMPUTED);
    let sub = args[at].text;
    if (prog === "yarn" && sub === "npm") sub = args[at + 1]?.text ?? "";
    if (["publish", "unpublish", "deprecate", "dist-tag", "owner", "access"].includes(sub)) return deny(`\`${prog} ${sub}\` changes the published package and needs your approval`);
    if (["dlx", "exec", "x"].includes(sub)) return args.length > at + 1 ? checkFollowed(dc, args.slice(at + 1)) : null;
    return null;
  }
  if (prog === "npx" || prog === "bunx") {
    const at = args.findIndex((a) => !a.text.startsWith("-"));
    return at < 0 ? null : checkFollowed(dc, args.slice(at));
  }
  return null;
}

function checkFollowed(dc: DevCheck, argv: Word[]): Verdict | null {
  if (argv[0].dynamic) return deny(COMPUTED);
  const tree: Tree = { commands: [], assigns: [], changesDir: false };
  const problem = unwrap(argv, 1, tree);
  if (problem) return deny(problem);
  dc.tree.assigns.push(...tree.assigns);
  let seen: Verdict | null = null;
  for (const c of tree.commands) {
    const v = checkArgv(dc, c.argv);
    if (v && !v.allow) return v;
    seen ??= v;
  }
  return seen;
}

// ---------------------------------------------------------------- gh

const GH_READS: Record<string, string[]> = {
  issue: ["list", "view", "status"],
  pr: ["list", "view", "status", "diff", "checks"],
  label: ["list"],
  repo: ["view", "list"],
  release: ["list", "view"],
  run: ["list", "view", "watch"],
  workflow: ["list", "view"],
  search: ["*"],
  auth: ["status"],
  status: ["*"],
  browse: ["*"],
  help: ["*"],
};
const GH_HUMAN: Record<string, string> = {
  "pr merge": "merging a pull request is yours to approve",
  "pr close": "closing a pull request needs your approval",
  "pr checkout": "gh pr checkout changes the local checkout; it needs your approval",
  "issue delete": "deleting an issue is destructive",
  "issue transfer": "transferring an issue is destructive",
  "label delete": "deleting a label is destructive",
};
/** The one branch ticket PRs may target. Retargeting or other bases are a human call. */
const PR_BASE = "main";
const TICKET_BRANCH = /^ticket\/[A-Za-z0-9._/-]+$/;

/** A gh flag: `long`/`short` names; `value` takes the next word (or `--long=value`); `data` may be a quoted computed value; `repeat` may be given more than once. */
type GhFlag = { long: string; short?: string; value?: boolean; data?: boolean; repeat?: boolean };
type GhWrite = { flags: GhFlag[]; target: "none" | "issue" | "pr" | "label" };
const f = (long: string, short?: string, o: Omit<GhFlag, "long" | "short"> = {}): GhFlag => ({ long, short, value: true, ...o });
const bool = (long: string, short?: string): GhFlag => ({ long, short, value: false });
const TITLE = f("--title", "-t", { data: true });
const BODY = f("--body", "-b", { data: true });
const BODY_FILE = f("--body-file", "-F");
const MILESTONE = f("--milestone", "-m");
const many = (long: string, short?: string) => f(long, short, { repeat: true });
/** Every gh write this policy allows, with every flag it may carry. Any other flag, or a flag written another way (-Bdev, --comment=false, a bundle), is refused. */
const GH_WRITES: Record<string, GhWrite> = {
  "issue create": { target: "none", flags: [TITLE, BODY, BODY_FILE, MILESTONE, many("--label", "-l"), many("--assignee", "-a"), many("--project", "-p")] },
  "issue edit": { target: "issue", flags: [TITLE, BODY, BODY_FILE, MILESTONE, bool("--remove-milestone"), many("--add-label"), many("--remove-label"), many("--add-assignee"), many("--remove-assignee"), many("--add-project"), many("--remove-project")] },
  "issue comment": { target: "issue", flags: [BODY, BODY_FILE] },
  "issue close": { target: "issue", flags: [f("--comment", "-c", { data: true }), f("--reason", "-r")] },
  "issue reopen": { target: "issue", flags: [f("--comment", "-c", { data: true })] },
  "label create": { target: "label", flags: [f("--color", "-c"), f("--description", "-d", { data: true }), bool("--force", "-f")] },
  "label edit": { target: "label", flags: [f("--color", "-c"), f("--description", "-d", { data: true })] },
  "pr create": { target: "none", flags: [f("--head", "-H"), f("--base", "-B"), TITLE, BODY, BODY_FILE, MILESTONE, bool("--draft", "-d"), bool("--fill", "-f"), bool("--fill-first"), bool("--fill-verbose"), many("--label", "-l"), many("--assignee", "-a"), many("--reviewer", "-r")] },
  "pr edit": { target: "pr", flags: [TITLE, BODY, BODY_FILE, MILESTONE, bool("--remove-milestone"), many("--add-label"), many("--remove-label"), many("--add-reviewer"), many("--remove-reviewer"), many("--add-assignee"), many("--remove-assignee")] },
  "pr comment": { target: "pr", flags: [BODY, BODY_FILE] },
  "pr ready": { target: "pr", flags: [] },
  "pr review": { target: "pr", flags: [bool("--comment", "-c"), bool("--request-changes", "-r"), BODY, BODY_FILE] },
};
const REPO_FLAG: GhFlag = f("--repo", "-R");

function checkGh(dc: DevCheck, args: Word[]): Verdict {
  const { policy } = dc;
  if (!args.length) return ALLOW;
  if (args[0].text.startsWith("-")) {
    return args.length === 1 && ["--version", "--help", "-h"].includes(args[0].text) ? ALLOW : deny("put gh's options after the command (gh <group> <action> …)");
  }
  if (args[0].dynamic) return deny(COMPUTED);
  const group = args[0].text;
  if (group === "api") return checkGhApi(args.slice(1));
  if (args[1]?.dynamic) return deny(COMPUTED);
  const action = args[1]?.text;
  const reads = GH_READS[group];
  // A mistake catcher, not a secret boundary: `gh auth token` is refused below (not a listed read), but a script, an unparsed shell form or another credential still prints one.
  if (group === "auth" && args.slice(2).some((a) => a.dynamic || /^(-t|--show-token)$|^--sh/.test(a.text))) return deny("gh auth status --show-token would print the token into the transcript; leave the flag out");
  if (reads &&(reads.includes("*") || (action !== undefined && reads.includes(action)))) return ALLOW;
  const human = GH_HUMAN[`${group} ${action}`];
  if (human) return deny(human);
  const spec = GH_WRITES[`${group} ${action}`];
  if (!spec) return deny(`\`gh ${group}${action ? " " + action : ""}\` is outside this run's GitHub development policy and needs your approval`);
  const gh = dc.tree.assigns.find((a) => /^GH_|^GITHUB_/.test(a.name) || a.name === "PATH");
  if (gh) return deny(`this command sets ${gh.name}, which can send gh to another host, repository or program`);

  const label = `gh ${group} ${action}`;
  const flags = [REPO_FLAG, ...spec.flags];
  const given = new Map<string, string[]>();
  const positional: Word[] = [];
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const t = w.text;
    if (!t.startsWith("-") || t === "-") {
      if (w.dynamic) return deny(`${label}: ${t} is computed by the shell; write it out`);
      positional.push(w);
      continue;
    }
    if (w.dynamic) return deny(`${label}: the option ${t} is computed by the shell; write it out`);
    if (t === "--") return deny(`${label}: "--" isn't needed here; leave it out`);
    const eq = t.startsWith("--") ? t.indexOf("=") : -1;
    const name = eq > 0 ? t.slice(0, eq) : t;
    const flag = flags.find((x) => x.long === name || x.short === name);
    if (!flag) {
      if (/^-[A-Za-z]./.test(t)) return deny(`${label}: write each option on its own and its value after a space (got ${t})`);
      return deny(`${label}: ${t} isn't an option this policy allows for ${label}`);
    }
    let value = "";
    if (flag.value) {
      if (eq > 0) value = t.slice(eq + 1);
      else {
        const v = rest[++i];
        if (v === undefined) return deny(`${label}: ${t} needs a value`);
        if (v.dynamic && !(flag.data && !v.split)) return deny(`${label}: the value of ${t} is computed by the shell; write it out${flag.data ? ' or quote it ("$(…)")' : ""}`);
        value = v.text;
      }
    } else if (eq > 0) return deny(`${label}: write ${name} without a value (got ${t})`);
    const prev = given.get(flag.long) ?? [];
    if (prev.length && !flag.repeat) return deny(`${label}: ${flag.long} is given more than once`);
    given.set(flag.long, [...prev, value]);
  }

  const repos = given.get("--repo");
  if (!repos) return deny(`\`${label}\` must name the repository: add -R ${policy.repo}`);
  if (repos[0].toLowerCase() !== policy.repo.toLowerCase()) return deny(`this run writes only to ${policy.repo}, not ${repos[0] || "(empty)"}`);
  if (spec.target === "none" && positional.length) return deny(`${label} takes no ${positional[0].text} here`);
  if (spec.target !== "none") {
    if (positional.length !== 1) return deny(`${label} must name exactly one ${spec.target}`);
    const p = positional[0].text;
    if (spec.target === "issue" && !/^\d+$/.test(p)) return deny(`${label}: name the issue by its number, not ${p}`);
    if (spec.target === "pr" && !/^\d+$/.test(p) && !(TICKET_BRANCH.test(p) && !p.includes(".."))) return deny(`${label}: name the pull request by its number or its ticket/* branch, not ${p}`);
  }

  if (label === "gh pr review") {
    const kinds = ["--comment", "--request-changes"].filter((k) => given.has(k));
    if (kinds.length !== 1) return deny("a review must be exactly one of --comment or --request-changes; approving is yours");
  }
  if (label === "gh pr create") {
    const heads = given.get("--head") ?? [];
    if (heads.length !== 1 || !TICKET_BRANCH.test(heads[0]) || heads[0].includes("..")) return deny("a pull request must name its ticket branch: --head ticket/<key>-<slug>");
    const bases = given.get("--base") ?? [];
    if (bases.length !== 1 || bases[0] !== PR_BASE) return deny(`ticket pull requests go into ${PR_BASE}: add --base ${PR_BASE} (another base needs your approval)`);
  }
  return ALLOW;
}

function checkGhApi(args: Word[]): Verdict {
  let method: string | null = null;
  let fields = false;
  const endpoints: string[] = [];
  const valued = new Set(["--jq", "-q", "--template", "-t", "--cache", "--hostname", "--preview", "-p"]);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const a = w.text;
    // A computed word may only be a quoted value of a field or output flag, never an option, method or endpoint.
    const prev = i > 0 ? args[i - 1].text : "";
    // An endpoint glob (repos/x/issues?state=all) can expand only to path names, never to an option.
    const pathGlob = w.globOnly && w.text.includes("/") && !w.text.startsWith("-");
    if (w.dynamic && !pathGlob && (w.split || !(["-f", "-F", "--field", "--raw-field"].includes(prev) || valued.has(prev)))) return deny("gh api: an argument is computed by the shell; write it out");
    if (a === "-X" || a === "--method") method = (args[++i]?.text ?? "").toUpperCase();
    else if (a.startsWith("--method=")) method = a.slice(9).toUpperCase();
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field"].includes(a)) {
      fields = true;
      i++;
    } else if (/^--(raw-)?field=/.test(a)) fields = true;
    else if (a === "-H" || a === "--header") {
      const h = args[++i];
      if (!h || h.dynamic || !/^accept\s*:/i.test(h.text)) return deny("gh api: only Accept headers are allowed");
    } else if (valued.has(a)) i++;
    else if (/^--(jq|template|cache|hostname|preview)=/.test(a)) continue;
    else if (["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"].includes(a)) continue;
    else if (a.startsWith("-")) return deny(`gh api: ${a} isn't an option this policy allows`);
    else endpoints.push(a);
  }
  if (endpoints.length !== 1) return deny("gh api: name exactly one endpoint");
  if (endpoints[0] === "graphql") return deny("`gh api graphql` is a POST, so it is refused in this run, reads included; use the gh commands or a REST GET");
  if ((method ?? (fields ? "POST" : "GET")) === "GET") return ALLOW;
  return deny("`gh api` is read-only in this run (GET); use the gh issue/label/pr commands for writes");
}

// ---------------------------------------------------------------- git

/** Global options git may carry here. Anything else before the subcommand (--git-dir, --work-tree, --exec-path, --config-env, --bare, …) is refused. */
const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "-p", "--paginate", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-advice", "--version", "--help", "-v", "-h"]);
/** `git -c <key>=…` keys that don't run anything or redirect git. Section and key names are case-insensitive. */
const GIT_SAFE_C = /^(user\.(name|email)|(commit|tag)\.gpgsign|color\.[a-z.]+|core\.quotepath|advice\.[a-z]+|init\.defaultbranch)$/i;
/** The git built-ins this policy lets run (besides push, checked on its own). Anything else is refused: unknown names (git would autocorrect them or run a git-<name> program), and built-ins that talk to a remote or run commands (send-pack, http-push, filter-branch, difftool, mergetool, hook, for-each-repo, subtree, credential, …). Allowed built-ins can still start other programs in ways not checked here: `git merge -s <strategy>` runs git-merge-<strategy> (POLICY_LIMITS). */
const GIT_LOCAL = new Set(
  "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects describe diff diff-files diff-index diff-tree fetch for-each-ref format-patch fsck gc grep hash-object help init interpret-trailers log ls-files ls-remote ls-tree merge merge-base merge-file merge-tree mktag mktree mv name-rev notes pack-refs patch-id prune pull range-diff read-tree rebase reflog remote repack replace rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree".split(" "),
);
/**
 * Options of allowed built-ins that run a command given on the command line. Short letters are
 * refused anywhere in a short-option bundle; long names are refused in any abbreviation git
 * would accept. A computed word in one of these subcommands is refused too.
 */
const GIT_RUNS: Record<string, { short?: string; long?: string[]; words?: string[] }> = {
  rebase: { short: "x", long: ["exec"] },
  archive: { long: ["remote", "exec"] },
  clone: { short: "uc", long: ["upload-pack", "template", "config"] },
  fetch: { long: ["upload-pack"] },
  pull: { long: ["upload-pack"] },
  "ls-remote": { short: "u", long: ["upload-pack"] },
  grep: { short: "O", long: ["open-files-in-pager"] },
  submodule: { words: ["foreach"] },
  bisect: { words: ["run"] },
};
/** GIT_* variables a git command may be given: data, or an editor that does nothing. */
const GIT_ENV_OK = (a: Assign) =>
  !a.dynamic &&
  (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(a.name) || a.name === "GIT_TERMINAL_PROMPT" || (/^GIT_(SEQUENCE_)?EDITOR$/.test(a.name) && ["true", ":"].includes(a.value)) || (a.name === "GIT_PAGER" && a.value === "cat"));
/** The only options git push may carry here, each written on its own. */
const PUSH_OK = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress", "-n", "--dry-run", "--porcelain", "--no-verify"]);
/** Why a refused push option needs the human; matched against any abbreviation of the long name. */
const PUSH_REFUSED: [string, string][] = [
  ["force", "force pushes"], ["force-with-lease", "force pushes"], ["force-if-includes", "force pushes"],
  ["delete", "deleting remote branches"], ["prune", "pruning remote branches"], ["mirror", "mirror pushes"],
  ["all", "pushing every branch"], ["branches", "pushing every branch"], ["tags", "pushing tags"], ["follow-tags", "pushing tags"],
  ["receive-pack", "a custom receive-pack"], ["exec", "a custom receive-pack"], ["repo", "pushing to --repo instead of a named remote"],
];

function checkGit(dc: DevCheck, args: Word[]): Verdict {
  const { ctx } = dc;
  let dir = ctx.cwd;
  let i = 0;
  let usedC = false;
  for (; i < args.length; i++) {
    const w = args[i];
    if (w.dynamic) return deny(`git: ${w.text} is computed by the shell; write it out`);
    const a = w.text;
    if (a === "-C") {
      const d = args[++i];
      if (!d || d.dynamic) return deny("git -C needs a directory written out");
      dir = resolveDir(dir, d.text);
    } else if (a === "-c") {
      const kv = args[++i];
      if (!kv || kv.dynamic) return deny("git -c needs a key=value written out");
      const key = kv.text.split("=")[0];
      if (/^alias\./i.test(key)) return deny("defining a git alias inline can hide a push; run the command plainly");
      if (!GIT_SAFE_C.test(key)) return deny(`git -c ${key} can run a program or redirect git; only user.name/email, gpgsign, color, advice and core.quotepath may be set inline here`);
      usedC = true;
    } else if (a.startsWith("--config-env")) return deny("git --config-env can hide a push or redirect it; run the command plainly");
    else if (GIT_GLOBAL_OK.has(a)) continue;
    else if (a.startsWith("-")) return deny(`git ${a} before the subcommand isn't an option this policy recognises (it can change which repository or program git uses)`);
    else break;
  }
  if (i >= args.length) return ALLOW; // git --version
  if (args[i].dynamic) return deny(COMPUTED);

  const badEnv = dc.tree.assigns.find((a) => (/^GIT_/.test(a.name) && !GIT_ENV_OK(a)) || a.name === "PATH");
  if (badEnv) return deny(`this command sets ${badEnv.name}, which can make git run another program or use another repository`);

  // Resolve aliases (git expands them recursively) to the built-in that runs.
  let argv = args.slice(i);
  let viaAlias: string | null = null;
  for (let depth = 0; ; depth++) {
    const sub = argv[0].text;
    if (sub === "push" || GIT_LOCAL.has(sub)) break;
    if (depth >= 5) return deny(`git aliases nest too deeply to check (${viaAlias})`);
    const alias = ctx.gitConfig(`alias.${sub}`, dir);
    if (alias === null) return deny(`can't read git config to tell whether \`git ${sub}\` is an alias`);
    if (!alias.length) return deny(`\`git ${sub}\` isn't a git command this policy allows (it is not one of its local built-ins or an alias of one; git could autocorrect it or run a git-${sub} program)`);
    if (alias.some((v) => v.trim().startsWith("!"))) return deny(`\`git ${sub}\` is an alias that runs a shell; run the real command plainly`);
    const lx = lexFrom(alias[alias.length - 1], 0, null);
    if (lx.error || lx.commands.length !== 1 || lx.subs.length || lx.commands[0].some((x) => x.dynamic)) return deny(`can't read the git alias \`${sub}\`; run the real command plainly`);
    viaAlias ??= sub;
    argv = [...lx.commands[0], ...argv.slice(1)];
  }
  const sub = argv[0].text;
  const rest = argv.slice(1);
  if (sub === "push") {
    if (viaAlias) return deny(`\`git ${viaAlias}\` is an alias that pushes; run the real command plainly: git push origin ticket/<key>-<slug>`);
    if (usedC) return deny("git -c before push can redirect it; push without it: git push origin ticket/<key>-<slug>");
    return checkPush(dc, rest, dir);
  }
  const runs = GIT_RUNS[sub];
  if (runs) {
    for (const w of rest) {
      if (w.dynamic) return deny(`git ${sub}: ${w.text} is computed by the shell, and git ${sub} has options that run commands; write it out`);
      const t = w.text;
      if (/^-[^-]/.test(t) && runs.short && [...t.slice(1)].some((ch) => runs.short!.includes(ch))) return deny(`git ${sub} ${t} runs a command the policy can't check; it needs your approval`);
      if (t.startsWith("--") && t.length > 2) {
        const name = t.slice(2).split("=")[0];
        if (runs.long?.some((l) => l.startsWith(name))) return deny(`git ${sub} ${t} runs a command the policy can't check; it needs your approval`);
      }
      if (runs.words?.includes(t)) return deny(`git ${sub} ${t} runs a command the policy can't check; it needs your approval`);
    }
  }
  return ALLOW;
}

function pushOptionRefusal(a: string): string {
  if (a.startsWith("--")) {
    const name = a.slice(2).split("=")[0];
    const hit = PUSH_REFUSED.find(([long]) => name && long.startsWith(name));
    if (hit) return `git push ${a} means ${hit[1]}, which needs your approval`;
  } else {
    if (a.includes("f")) return "force pushes need your approval";
    if (a.includes("d")) return "deleting remote branches needs your approval";
  }
  return `git push ${a} isn't an option this policy allows; it takes only ${[...PUSH_OK].join(", ")}, each written on its own`;
}

function checkPush(dc: DevCheck, rest: Word[], dir: string): Verdict {
  const { policy, ctx } = dc;
  if (dc.pushHazard) return deny(`this push can't be checked because ${dc.pushHazard}; run the push on its own (git -C <dir> push … is fine)`);
  const positional: string[] = [];
  for (const w of rest) {
    if (w.dynamic) return deny(`git push: ${w.text} is computed by the shell; write the remote and the ticket branch out`);
    const a = w.text;
    if (a === "--") return deny('git push: leave out "--"');
    if (PUSH_OK.has(a)) continue;
    if (a.startsWith("-")) return deny(pushOptionRefusal(a));
    positional.push(a);
  }
  const [remote, ...refspecs] = positional;
  if (!remote || !refspecs.length) return deny(`name the remote and the ticket branch: git push origin ticket/<key>-<slug> (a bare push could reach main)`);
  // A URL skips the remote's config but not url.<base>.insteadOf rewrites, which the guard can't see: use a named remote.
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return deny(`push to a named remote (git push origin …), not "${remote}"`);
  const target = ctx.remoteRepo(remote, dir);
  if (!target) return deny(`can't tell which repository remote "${remote}" pushes to (every push URL must be ${policy.repo} on github.com)`);
  if (target.toLowerCase() !== policy.repo.toLowerCase()) return deny(`this run pushes only to ${policy.repo}, not ${target}`);
  for (const spec of refspecs) {
    if (spec.startsWith("+")) return deny("force pushes (+refspec) need your approval");
    const colon = spec.indexOf(":");
    // `:dst` (an empty source) deletes dst on the remote.
    if (colon === 0) return deny("deleting a remote branch needs your approval");
    if (colon < 0) {
      // Without `:dst`, a remote.<r>.push mapping decides the destination.
      const mapped = ctx.gitConfig(`remote.${remote}.push`, dir);
      if (mapped === null) return deny(`can't read git config for remote "${remote}"`);
      if (mapped.length) return deny(`remote "${remote}" has a push mapping (remote.${remote}.push), so name the destination: ${spec}:ticket/<key>-<slug>`);
    }
    const dst = colon < 0 ? spec : spec.slice(colon + 1);
    if (!dst) return deny("name the destination: <src>:ticket/<key>-<slug>");
    const branch = dst.replace(/^refs\/heads\//, "");
    if (branch.startsWith("refs/")) return deny(`pushing ${dst} needs your approval`);
    if (!TICKET_BRANCH.test(branch) || branch.includes("..")) return deny(`this run pushes only ticket/* branches; pushing ${branch} needs your approval`);
  }
  return ALLOW;
}

function resolveDir(from: string, to: string): string {
  if (!to) return from;
  return to.startsWith("/") || /^[A-Za-z]:[\\/]/.test(to) ? to : join(from, to);
}
