// Delivery to agents. If the agent is idle at its prompt, HQ types the message
// into its terminal. If it's busy, the message waits and is handed over by the
// agent's Stop hook when its turn ends (Claude Code then continues with it).

import type { Hub } from "./hub";
import { randomUUID } from "node:crypto";
import { log } from "./lib/log";

export interface InboxItem {
  fromId: string; // agent id or "you"
  text: string;
  kind: "message" | "assign" | "notice"; // notice = from HQ itself (e.g. review results)
}

export interface Keyboard {
  type(agentId: string, text: string): Promise<boolean>;
  enter(agentId: string): Promise<boolean>;
}

const QUIET_MS = 1000; // no hooks for this long = the prompt has settled
const SUBMIT_CHECK_MS = 3000; // typed text should produce UserPromptSubmit by then

export class Inbox {
  private queues = new Map<string, InboxItem[]>();
  private sessionUp = new Set<string>(); // SessionStart seen: Claude Code's prompt exists
  private lastHook = new Map<string, number>();
  private lastSubmit = new Map<string, number>();
  private typing = new Set<string>();
  private requests = new Map<string, { marker: string; submitted: boolean; finish(error?: Error): void }>();
  private timer: NodeJS.Timeout;

  constructor(private hub: Hub, private keys: Keyboard) {
    // Safety net: retry anything queued for agents that have gone idle.
    this.timer = setInterval(() => {
      for (const id of this.queues.keys()) void this.tryType(id);
    }, 2000);
  }

  stop() {
    clearInterval(this.timer);
    for (const request of this.requests.values()) request.finish(new Error("The server stopped before the request finished."));
  }

  /** A single marked prompt, acknowledged by UserPromptSubmit then Stop. Never retries. */
  requestTurn(agentId: string, prompt: (marker: string) => string, timeoutMs = 120_000): Promise<string> {
    if (!this.canType(agentId) || this.pending(agentId))
      return Promise.reject(new Error("The agent's prompt is not ready or has queued messages. Wait until it is idle and try again."));
    const marker = `tt-request-${randomUUID()}`;
    this.typing.add(agentId); // ordinary inbox delivery must not share this prompt
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.requests.get(agentId)?.marker !== marker) return;
        clearTimeout(timer);
        this.requests.delete(agentId);
        this.typing.delete(agentId);
        if (error) reject(error);
        else resolve(marker);
      };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the agent to finish. No second prompt was sent.")), timeoutMs);
      this.requests.set(agentId, { marker, submitted: false, finish });
      // Do not await typing: even a stuck terminal operation must respect the timeout.
      Promise.resolve().then(() => this.requests.get(agentId)?.marker === marker
        ? this.keys.type(agentId, `[${marker}] ${prompt(marker)}`.replace(/\s*\n\s*/g, " "))
        : true).then(
        (ok) => { if (!ok) finish(new Error("Could not submit the prompt. No second prompt was sent.")); },
        () => finish(new Error("Could not submit the prompt. No second prompt was sent.")),
      );
    });
  }

  /** Called only for an actual Stop; notifications and screen polling cannot complete a request. */
  finishTurn(agentId: string) {
    const request = this.requests.get(agentId);
    if (request?.submitted) request.finish();
  }

  push(agentId: string, item: InboxItem) {
    const q = this.queues.get(agentId) ?? [];
    q.push(item);
    this.queues.set(agentId, q);
    void this.tryType(agentId);
  }

  /** When the agent's last hook arrived (0 if never). */
  lastHookAt(agentId: string): number {
    return this.lastHook.get(agentId) ?? 0;
  }

  pending(agentId: string) {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Every hook event goes through here (before the state change it causes). */
  noteHook(agentId: string, event: string, prompt?: string) {
    this.lastHook.set(agentId, Date.now());
    if (event === "SessionStart") this.sessionUp.add(agentId);
    if (event === "SessionEnd") this.sessionUp.delete(agentId);
    if (event === "UserPromptSubmit") this.lastSubmit.set(agentId, Date.now());
    const request = this.requests.get(agentId);
    if (request && event === "UserPromptSubmit") {
      if (prompt?.startsWith(`[${request.marker}]`)) request.submitted = true;
      else request.finish(new Error("Another prompt replaced the marked request. Nothing was resent."));
    }
    if (event === "SessionStart" || event === "SessionEnd") request?.finish(new Error("The agent's session changed before the request finished."));
    if (event === "Stop" || event === "SessionStart" || event === "Notification") setTimeout(() => void this.tryType(agentId), QUIET_MS + 100);
  }

  /** An already-running session was reattached: its prompt exists even though HQ missed SessionStart. */
  sessionReattached(agentId: string) {
    this.sessionUp.add(agentId);
  }

  /** The session stopped or restarted: Claude Code's prompt is gone until the next SessionStart. */
  sessionDown(agentId: string) {
    this.sessionUp.delete(agentId);
    this.requests.get(agentId)?.finish(new Error("The agent stopped before the request finished."));
  }

  forget(agentId: string) {
    this.queues.delete(agentId);
    this.sessionDown(agentId);
  }

  /** Called from the Stop hook: everything queued, as the reason Claude continues with. */
  takeForStop(agentId: string): string | null {
    // Let the marked turn stop before delivering new messages in a separate turn.
    if (this.requests.has(agentId)) return null;
    const q = this.queues.get(agentId);
    if (!q?.length) return null;
    this.queues.set(agentId, []);
    return this.format(q);
  }

  private canType(agentId: string): boolean {
    const st = this.hub.status(agentId);
    return (
      !!st &&
      this.sessionUp.has(agentId) &&
      st.session.state === "running" &&
      // A coordinator waiting on its workers has its prompt ready, like an idle one.
      (st.state === "idle" || st.state === "waiting") &&
      !this.typing.has(agentId) &&
      Date.now() - (this.lastHook.get(agentId) ?? 0) >= QUIET_MS
    );
  }

  private whyNot(agentId: string): string {
    const st = this.hub.status(agentId);
    return JSON.stringify({ up: this.sessionUp.has(agentId), session: st?.session.state, state: st?.state, note: st?.note, typing: this.typing.has(agentId), quietMs: Date.now() - (this.lastHook.get(agentId) ?? 0) });
  }

  /** Types queued items into an idle agent. Safe to call any time. */
  async tryType(agentId: string) {
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (!this.canType(agentId)) {
      if (process.env.HQ_DEBUG) log.info(`inbox ${agentId}: holding ${q.length} — ${this.whyNot(agentId)}`);
      return;
    }
    const items = q.splice(0);
    this.typing.add(agentId);
    const typedAt = Date.now();
    try {
      if (!(await this.keys.type(agentId, this.format(items)))) {
        log.warn(`could not type into ${agentId}; keeping ${items.length} message(s) queued`);
        this.queues.set(agentId, [...items, ...(this.queues.get(agentId) ?? [])]);
        return;
      }
      // If the prompt didn't submit (Enter swallowed), press it once more.
      await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
      const after = this.hub.status(agentId)?.state;
      if ((this.lastSubmit.get(agentId) ?? 0) < typedAt && (after === "idle" || after === "waiting")) {
        log.warn(`${agentId}: no prompt submit after typing; pressing Enter again`);
        await this.keys.enter(agentId);
      }
    } finally {
      this.typing.delete(agentId);
    }
  }

  private format(items: InboxItem[]): string {
    const lines = items.map((i) =>
      i.kind === "message" ? `[HQ] Message from ${this.hub.name(i.fromId)}: ${i.text}` : `[HQ] ${i.text}`,
    );
    const fromAgent = items.some((i) => i.kind === "message" && i.fromId !== "you");
    // Claude Code submits on newline, so everything goes on one line.
    return (lines.join("  ·  ") + (fromAgent ? "  (Reply with the hq send_message tool only if a reply is needed.)" : "")).replace(/\s*\n\s*/g, " ");
  }
}
