// Read-only Pathfinder contract resolution. Skills already load roles; this observes their reads.
// It never injects instructions, launches a session or changes a connected repository.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { RoleContract } from "../src/data/roleContract";

const MAX_CONTRACT = 128 * 1024;
const MAX_TRANSCRIPT = 8 * 1024 * 1024;
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const normal = (text: string) => text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/^\s*\d+[→\t]/, "").trimEnd()).join("\n").trim();

function readSmall(file: string): string {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > MAX_CONTRACT) throw new Error("Contract is not a readable text file under 128 KiB");
  return readFileSync(file, "utf8");
}

/** Missing worktree files may use the checkout copy; unreadable files do not silently fall back. */
export function resolveRoleContract(root: string, worktree: string | null, role: string, session: string | null, agentType: string | null): RoleContract {
  const result: RoleContract = { role, session, source: null, origin: worktree ? "worktree" : "checkout", text: null, hash: null, error: null, agentType, definition: null, conflict: null, evidence: null };
  if (!/^[a-z][a-z0-9-]*$/.test(role)) return { ...result, error: "Invalid Pathfinder role name; no contract was resolved." };
  const local = join(worktree ?? root, "roles", `${role}.md`);
  const source = worktree && !existsSync(local) ? join(root, "roles", `${role}.md`) : local;
  result.source = canonical(source);
  if (source !== local) result.origin = "checkout-fallback";
  try {
    result.text = readSmall(source);
    if (!result.text.trim()) throw new Error("Contract is empty");
    result.hash = digest(result.text);
  } catch (error) {
    result.text = null;
    result.error = `Cannot read roles/${role}.md: ${(error as Error).message}`;
  }
  // A named definition is a second instruction source, not a replacement for the recorded role.
  // Only an explicit instruction to read a different role is a detected conflict. Other prose stays unverified.
  if (agentType && /^[a-zA-Z0-9_-]+$/.test(agentType)) {
    const defLocal = join(worktree ?? root, ".claude", "agents", `${agentType}.md`);
    const def = existsSync(defLocal) ? defLocal : join(root, ".claude", "agents", `${agentType}.md`);
    if (existsSync(def)) {
      result.definition = canonical(def);
      try {
        const text = readSmall(def);
        const references = [...text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:Read|Follow)\s+`?(?:[^\s`]*\/)?roles\/([a-z][a-z0-9-]*)\.md`?/g)].map((m) => m[1]);
        const other = references.filter((name) => name !== role);
        if (other.length) result.conflict = `Named agent ${agentType} instructs the session to read ${[...new Set(other)].map((name) => `roles/${name}.md`).join(", ")}; the Pathfinder brief records ${role}.`;
      } catch {
        result.conflict = `Named agent definition cannot be inspected: ${result.definition}`;
      }
    }
  }
  return result;
}

type RecordLine = { line: number; record: Record<string, any> };
type Call = { source: string; tool: "Read" | "Bash" };

// Deliberately a small literal grammar, not a shell interpreter. Unknown commands, variables,
// substitutions, redirects, control flow and arbitrary pipes cannot establish source identity.
function tokens(text: string): string[] | null {
  if (/[`$<>\\\n\r]/.test(text)) return null;
  const found = text.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) ?? [];
  if (found.join(" ") !== text.trim().replace(/\s+/g, " ")) return null;
  return found.map((word) => /^["']/.test(word) ? word.slice(1, -1) : word);
}

function literalReads(command: string, cwd: string): string[] {
  // The only supported redirection suppresses read diagnostics; successful full output is still required.
  command = command.replace(/\s+2>\/dev\/null(?=\s|;|$)/g, "");
  if (/[`$<>\\\n\r]/.test(command) || /\|\||[(){}]/.test(command)) return [];
  const parts = command.split(/(&&|;|\|)/);
  const reads: string[] = [];
  let at = cwd;
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i].trim() && i === parts.length - 1) continue;
    const args = tokens(parts[i].trim());
    if (!args?.length) return [];
    const [exe, ...rest] = args;
    if (exe === "cd") {
      if (rest.length !== 1 || parts[i + 1] !== "&&" || parts[i - 1] === "|") return [];
      at = rest[0].startsWith("~/") && parts[i].trim().startsWith("cd ~/") ? join(homedir(), rest[0].slice(2)) : resolve(at, rest[0]);
    } else if (exe === "cat" || exe === "/bin/cat") {
      if (!rest.length || rest.some((word) => word.startsWith("-")) || parts[i - 1] === "|") return [];
      reads.push(...rest.map((file) => canonical(resolve(at, file))));
    } else if (exe === "sed" && rest.length === 3 && rest[0] === "-n" && /^1,\d+p$/.test(rest[1]) && parts[i - 1] !== "|") {
      reads.push(canonical(resolve(at, rest[2])));
    } else if (exe === "head" && /^-(?:n)?\d+$/.test(rest[0] ?? "") && rest.length === 1 && parts[i - 1] === "|") {
      // Bounded cat output can still contain the full contract; its paired result decides.
    } else if ((exe === "ls" || exe === "/bin/ls" || exe === "pwd") && !parts.includes("|")) {
      // Common inspection calls combine cat and directory listing. Neither produces contract evidence itself.
    } else return [];
  }
  return reads;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n") : "";
}

/** A successful read result containing the whole current contract, from this transcript only. */
export function contractReadEvidence(lines: RecordLine[], contract: RoleContract, transcript: string): RoleContract["evidence"] {
  if (!contract.source || !contract.text || !contract.hash || contract.error) return null;
  const calls = new Map<string, Call>();
  const expected = normal(contract.text);
  for (const { line, record } of lines) {
    if (contract.session === null && record.isSidechain === true) continue;
    const parts = record.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (record.type === "assistant" && part?.type === "tool_use" && typeof part.id === "string") {
        calls.delete(part.id); // A repeated ID cannot borrow an earlier call to a different source.
        const input = part.input ?? {};
        const cwd = typeof record.cwd === "string" && isAbsolute(record.cwd) ? record.cwd : null;
        let reads: string[] = [];
        if (part.name === "Read" && typeof input.file_path === "string" && (isAbsolute(input.file_path) || cwd)) {
          reads = [canonical(resolve(cwd ?? "/", input.file_path))];
        } else if (part.name === "Bash" && typeof input.command === "string" && cwd) reads = literalReads(input.command, cwd);
        if (reads.includes(contract.source)) calls.set(part.id, { source: contract.source, tool: part.name });
      }
      if (record.type === "user" && part?.type === "tool_result" && typeof part.tool_use_id === "string") {
        const call = calls.get(part.tool_use_id);
        calls.delete(part.tool_use_id);
        if (call && (part.is_error === false || part.is_error === undefined) && normal(textContent(part.content)).includes(expected)) {
          return { transcript, line, toolId: part.tool_use_id, tool: call.tool, source: call.source, hash: contract.hash };
        }
      }
    }
  }
  return null;
}

/** Cache only derived evidence; source changes and transcript revisions invalidate it. */
export class RoleContractObserver {
  private cache = new Map<string, { revision: string; evidence: RoleContract["evidence"] }>();

  observe(root: string, worktree: string | null, role: string, session: string | null, agentType: string | null, transcript: string | null): RoleContract {
    const contract = resolveRoleContract(root, worktree, role, session, agentType);
    if (!transcript || contract.error) return contract;
    try {
      const stat = statSync(transcript);
      const revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${contract.source}:${contract.hash}`;
      const cached = this.cache.get(transcript);
      if (cached?.revision === revision) return { ...contract, evidence: cached.evidence };
      const fd = openSync(transcript, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_TRANSCRIPT));
        const count = readSync(fd, buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, count).toString("utf8");
      } finally { closeSync(fd); }
      const lines: RecordLine[] = [];
      for (const [index, line] of text.split("\n").entries()) {
        try { lines.push({ line: index + 1, record: JSON.parse(line) }); } catch { /* partial/unrelated line */ }
      }
      contract.evidence = contractReadEvidence(lines, contract, transcript);
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(transcript, { revision, evidence: contract.evidence });
    } catch { /* Missing/unreadable evidence is unverified, never a load. */ }
    return contract;
  }
}
