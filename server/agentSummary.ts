import { lstatSync } from "node:fs";
import { summaryDisabledReason } from "../src/data/agentSummary";
import { excludeSummaryFile, SUMMARY_FILE } from "./agentFiles";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { agentPath, agentRead } from "./lib/agentFs";

/** An on-demand summary; the agent authors every word. The snapshot survives drawer reconnects. */
export class AgentSummaries {
  constructor(private hub: Hub, private inbox: Inbox, private timeoutMs = 120_000) {}

  async start(id: string) {
    const agent = this.hub.cfg(id);
    const status = this.hub.status(id);
    if (!agent || !status || status.summary?.state === "requesting") return;
    const previous = { text: status.summary?.text, at: status.summary?.at };
    const fail = (message: string) => this.hub.setStatus(id, { summary: { ...previous, state: "error", error: message } });
    const reason = summaryDisabledReason(agent, status);
    if (reason) return fail(reason);
    const dir = status.session.workspace!;
    this.hub.setStatus(id, { summary: { ...previous, state: "requesting" } });
    try {
      await excludeSummaryFile(dir);
      if (this.hub.status(id)?.session.workspace !== dir) throw new Error("The agent's folder changed before the request could be sent.");
      const marker = await this.inbox.requestTurn(id, (request) =>
        `Summarise your current work in at most 150 words: goal, ticket/branch, done, in progress, next, and open questions. ` +
        `Write the summary to ${SUMMARY_FILE} in your working folder, overwriting its previous contents. ` +
        `The first line must be exactly <!-- ${request} -->, followed by the summary. ` +
        `This file is excluded from Git. Do not commit it. Make no other changes and finish this turn after writing it.`, this.timeoutMs);
      if (this.hub.status(id)?.session.workspace !== dir) throw new Error("The agent's folder changed during the request.");
      const path = agentPath(dir, SUMMARY_FILE);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 32_000) throw new Error("The summary must be a regular text file smaller than 32 KB.");
      const text = agentRead(dir, SUMMARY_FILE);
      const header = `<!-- ${marker} -->`;
      if (!text?.startsWith(`${header}\n`) && !text?.startsWith(`${header}\r\n`))
        throw new Error("The agent did not write a summary for this request. The previous summary was kept.");
      const summary = text.slice(header.length).trim();
      if (!summary) throw new Error("The agent wrote an empty summary.");
      this.hub.setStatus(id, { summary: { state: "ready", text: summary, at: new Date().toISOString() } });
    } catch (error) {
      fail(error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "The agent finished without writing its summary file."
        : error instanceof Error ? error.message : "Could not request the summary.");
    }
  }
}
