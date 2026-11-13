import { lstatSync } from "node:fs";
import { freshContextDisabledReason } from "../src/data/agentFreshContext";
import type { AgentStatus } from "../src/data/types";
import { excludeContextFile, HANDOFF_FILE } from "./agentFiles";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { agentPath, agentRead } from "./lib/agentFs";

type Refresh = NonNullable<AgentStatus["contextRefresh"]>;
type Step = keyof Refresh["steps"];

/** Interactive agents only. Pathfinder workers retain their existing checkpoint flow. */
export class AgentFreshContext {
  constructor(private hub: Hub, private inbox: Inbox, private timeoutMs = 120_000) {}

  async start(id: string) {
    const agent = this.hub.cfg(id);
    const status = this.hub.status(id);
    if (!agent || !status || status.contextRefresh?.state === "running") return;
    const refresh: Refresh = {
      state: "running",
      steps: { handoff: { state: "pending" }, clear: { state: "pending" }, orient: { state: "pending" } },
    };
    let step: Step = "handoff";
    const publish = () => this.hub.setStatus(id, { contextRefresh: structuredClone(refresh) });
    const begin = (next: Step) => { step = next; refresh.steps[step] = { state: "running" }; publish(); };
    const ok = (detail: string) => { refresh.steps[step] = { state: "ok", detail }; publish(); };
    try {
      const reason = freshContextDisabledReason(agent, status);
      if (reason) throw new Error(reason);
      const dir = status.session.workspace!;
      const command = agent.cli === "codex" ? "/new" : "/clear";
      begin("handoff");
      await excludeContextFile(dir, HANDOFF_FILE);
      if (this.hub.status(id)?.session.workspace !== dir) throw new Error("The agent's folder changed before fresh context could start.");
      await this.inbox.withContextSequence(id, async (sequence) => {
        let requestedAt = 0;
        const marker = await sequence.requestTurn((request) => {
          requestedAt = Date.now();
          return `Write a factual, short handoff to ${HANDOFF_FILE} in your working folder, overwriting the previous contents. ` +
            `Follow skills/handoff/SKILL.md if present, with this explicit destination instead of context/handoff.md. ` +
            `Use these fields: Feature, Done, Verified, Open, Next, Read next. Include your current ticket and branch when relevant. ` +
            `Describe only the current work and actual verification; include no private reasoning or conversation transcripts. ` +
            `The first line must be exactly <!-- ${request} -->. This file is excluded from Git; do not commit it. ` +
            `Make no other changes and finish this turn after writing it.`;
        }, this.timeoutMs);
        if (this.hub.status(id)?.session.workspace !== dir) throw new Error("The agent's folder changed during the handoff.");
        const stat = lstatSync(agentPath(dir, HANDOFF_FILE));
        if (!stat.isFile() || stat.size > 32_000) throw new Error("The handoff must be a regular text file smaller than 32 KB. Context was not cleared.");
        if (stat.mtimeMs <= requestedAt) throw new Error("The handoff is not newer than this request. Context was not cleared.");
        const text = agentRead(dir, HANDOFF_FILE);
        const header = `<!-- ${marker} -->`;
        if ((!text?.startsWith(`${header}\n`) && !text?.startsWith(`${header}\r\n`)) || !text.slice(header.length).trim())
          throw new Error("The agent did not write a handoff for this request. Context was not cleared.");
        ok(`${HANDOFF_FILE} saved and verified.`);
        begin("clear");
        await sequence.clear(command, this.timeoutMs);
        ok(`${command} confirmed by the new session hook.`);
        begin("orient");
        let ready = "";
        await sequence.requestTurn((request) => `Read ${HANDOFF_FILE}, orient from its current work and next action, and reply READY with a 3-line status. ` +
          `Use exactly four lines: first line READY [${request}], then Done: <what was done>, Open: <open items or none>, Next: <next action>. ` +
          `Base all three status lines on the handoff. Do not resume implementation or change files. Finish this turn after reporting your status.`, this.timeoutMs,
          (reply, request) => {
            const lines = reply?.trim().split(/\r?\n/);
            if (!lines || lines[0] !== `READY [${request}]` || lines.length !== 4 ||
              !/^Done: \S/.test(lines[1]) || !/^Open: \S/.test(lines[2]) || !/^Next: \S/.test(lines[3]))
              throw new Error("The orientation ended without a verified READY response and three-line status for this request. Check the terminal; no prompt was resent.");
            ready = ["READY", ...lines.slice(1)].join("\n");
          });
        ok(ready);
      });
      refresh.state = "ready";
      refresh.at = new Date().toISOString();
      publish();
    } catch (error) {
      const message = error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "The agent finished without writing its handoff file. Context was not cleared."
        : error instanceof Error ? error.message : "Fresh context failed.";
      refresh.state = "error";
      refresh.error = message;
      refresh.steps[step] = { state: "failed", detail: message };
      publish();
    }
  }
}
