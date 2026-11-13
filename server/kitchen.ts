// Tin & Thyme kitchens: one local instance per repository.
//
// A kitchen is keyed by the repository's canonical root (its Git top level with
// symlinks resolved), never by its folder name alone: two repos called
// "my-app" in different places get different keys, different local state and
// different instances. The key is readable (`<folder>-<8 hex>`), and the hex is
// the start of the SHA-256 of the canonical root.
//
// Everything here lives in the user's home (~/.controlroom, ~/.jsmhq). Nothing
// is ever written into the repository a kitchen serves.
//
// Shared by the server (bundled into dist-server/main.mjs) and the
// `tin-and-thyme` command (dist-server/kitchen.mjs).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { describePolicy, originRepo, POLICY_LIMITS, readPolicy, repoFromUrl, writePolicy, type RunPolicy } from "./runPolicy";

export const APP = "tin-and-thyme";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "project";

/** The repository's canonical root: its Git top level, symlinks resolved. Throws a readable error outside a repo. */
export function canonicalRoot(start: string): string {
  const from = resolve(start);
  if (!existsSync(from)) throw new Error(`${from} does not exist.`);
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: statSync(from).isDirectory() ? from : resolve(from, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`${from} is not inside a Git repository.`);
  }
  return realpathSync(top);
}

/** `<folder>-<first 8 hex of sha256(canonical root)>`: unique per repository, stable across restarts. */
export function kitchenKey(root: string): string {
  return `${slugify(basename(root))}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

export const controlroomHome = () => join(homedir(), ".controlroom");
export const kitchensDir = () => join(controlroomHome(), "kitchens");
export const recordFile = (key: string) => join(kitchensDir(), `${key}.json`);
export const lockFile = (key: string) => join(kitchensDir(), `${key}.lock`);
export const logFile = (key: string) => join(kitchensDir(), `${key}.log`);

/** What a running kitchen wrote about itself (0600, in the user's home). */
export interface KitchenRecord {
  app: typeof APP;
  key: string;
  root: string;
  port: number;
  pid: number;
  /** Random per start: the health endpoint must report the same one before a kitchen is reused. */
  instance: string;
  url: string;
  startedAt: string;
}

export function readRecord(key: string): KitchenRecord | null {
  try {
    const r = JSON.parse(readFileSync(recordFile(key), "utf8"));
    return r && r.app === APP && typeof r.port === "number" && typeof r.instance === "string" ? (r as KitchenRecord) : null;
  } catch {
    return null;
  }
}

export function writeRecord(r: KitchenRecord) {
  mkdirSync(kitchensDir(), { recursive: true });
  const tmp = `${recordFile(r.key)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameSync(tmp, recordFile(r.key));
}

/** Removes the record only if it is still this instance's (a newer kitchen may have replaced it). */
export function clearRecord(key: string, instance: string) {
  if (readRecord(key)?.instance === instance) rmSync(recordFile(key), { force: true });
}

export interface KitStatus {
  ok: boolean;
  mode: string | null;
  missing: string[];
}

/** The Pathfinder kit Tin & Thyme needs in a repository (read only). */
export function pathfinderKit(root: string): KitStatus {
  const modeFile = join(root, "context", "execution-mode.md");
  const engine = join(root, "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");
  const missing: string[] = [];
  let mode: string | null = null;
  if (!existsSync(modeFile)) missing.push("context/execution-mode.md");
  else {
    mode = /<!--\s*pathfinder:execution-mode\s+([a-z-]+)\s*-->/.exec(readFileSync(modeFile, "utf8"))?.[1] ?? null;
    if (!mode) missing.push("the pathfinder:execution-mode marker in context/execution-mode.md");
  }
  if (!existsSync(engine)) missing.push("skills/orchestrate/engine/bin/orchestrate.mjs");
  return { ok: missing.length === 0, mode, missing };
}

/** What `/api/health` reports, so a caller can tell this kitchen from any other process on the port. */
export interface Health {
  ok: boolean;
  app?: string;
  key?: string;
  instance?: string;
}

export function probe(port: number, timeoutMs = 1500): Promise<Health | null> {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (s += d));
      res.on("end", () => {
        try {
          done(res.statusCode === 200 ? (JSON.parse(s) as Health) : null);
        } catch {
          done(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });
}

/** A recorded kitchen is reusable only if the process on its port says it is this exact instance of this exact repo. */
export async function verify(rec: KitchenRecord | null, key: string, root: string): Promise<boolean> {
  if (!rec || rec.key !== key || rec.root !== root) return false;
  const h = await probe(rec.port);
  return !!h?.ok && h.app === APP && h.key === key && h.instance === rec.instance;
}

/**
 * Local state from before kitchens were keyed by path lived under the folder name
 * (~/.controlroom/<folder>, ~/.jsmhq/<folder>). It is copied (never moved) into the keyed
 * folders only when it provably belongs to this repository: its saved coordinator transcript
 * sits in this repository's own Claude Code project folder. A same-named repo elsewhere starts fresh.
 */
export function adoptLegacyState(root: string, key: string): string | null {
  const legacy = slugify(basename(root));
  const oldCr = join(controlroomHome(), legacy);
  const newCr = join(controlroomHome(), key);
  if (legacy === key || existsSync(newCr) || !existsSync(oldCr)) return null;
  let transcript = "";
  try {
    transcript = JSON.parse(readFileSync(join(oldCr, "coordinator.json"), "utf8")).transcript ?? "";
  } catch {
    return null;
  }
  const ownProjects = join(homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-")) + sep;
  if (!transcript.startsWith(ownProjects)) return null;
  // The hook settings and guard name the old port, token and folder; the next coordinator start rewrites them.
  cpSync(oldCr, newCr, { recursive: true, filter: (src) => !/coordinator-settings\.json$|no-push-guard\.mjs$|run-policy-guard\.mjs$|active-policy\.json$/.test(src) });
  const oldHq = join(homedir(), ".jsmhq", legacy);
  const newHq = join(homedir(), ".jsmhq", key);
  if (existsSync(oldHq) && !existsSync(newHq)) {
    mkdirSync(newHq, { recursive: true });
    for (const f of readdirSync(oldHq)) if (f === "agent-token") cpSync(join(oldHq, f), join(newHq, f));
  }
  writeFileSync(join(newCr, "repo.json"), JSON.stringify({ root, key, adoptedFrom: oldCr }, null, 2));
  return oldCr;
}

/**
 * A Tin & Thyme for this repository started before kitchens existed (by hand, with HQ_REPO): it is
 * found through the hook settings it wrote for its coordinator (only the port is read), and only when
 * that legacy folder provably belongs to this repository. Returns the port if it still answers.
 */
export async function legacyInstancePort(root: string): Promise<number | null> {
  const dir = join(controlroomHome(), slugify(basename(root)));
  try {
    const transcript = JSON.parse(readFileSync(join(dir, "coordinator.json"), "utf8")).transcript ?? "";
    const ownProjects = join(homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-")) + sep;
    if (!transcript.startsWith(ownProjects)) return null;
    const port = Number(/127\.0\.0\.1:(\d+)\/hook\//.exec(readFileSync(join(dir, "coordinator-settings.json"), "utf8"))?.[1]);
    if (!port) return null;
    const h = await probe(port);
    return h?.ok && !h.app ? port : null;
  } catch {
    return null;
  }
}

/** Marks a keyed state folder with the repository it belongs to, and refuses one that belongs to another. */
export function claimStateDir(root: string, key: string) {
  const dir = join(controlroomHome(), key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "repo.json");
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.root && saved.root !== root) throw new Error(`${dir} belongs to ${saved.root}, not ${root} (key collision); move one of the folders aside.`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("key collision")) throw e;
  }
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ root, key }, null, 2));
}

// ---------------------------------------------------------------- run policy (for `tin-and-thyme policy`)

/** originRepo: every push URL of origin must be github.com/<owner>/<name> (anchored; see repoFromUrl). */
export { describePolicy, originRepo, POLICY_LIMITS, repoFromUrl, type RunPolicy };

/** The kitchen state folder holding run-policy.json. */
export const policyDir = (key: string) => join(controlroomHome(), key);
export const readRunPolicy = (key: string) => readPolicy(policyDir(key));
export const writeRunPolicy = (key: string, policy: RunPolicy) => writePolicy(policyDir(key), policy);
