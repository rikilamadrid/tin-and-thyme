// The Master Prompter (Feature 04): a visiting alien who helps the human write strong prompts.
//
// One per kitchen, added from Settings → Team and removed like any agent. It is flagged by its crew
// role (`crew.role === "prompter"`), wears the `alien` character (the prompter family's only member,
// reserved for it in crewContract.ts), never takes a ticket and never edits files. Shared by the
// server (adding it, launching it, keeping assignment away from it) and the UI (Settings, galley).

import { CHARACTERS } from "./crew";
import { PROMPTER_CHARACTER } from "./crewContract";
import type { AgentConfig, CrewInfo } from "./types";

/** The prompter's agent id, in a native team and in a Pathfinder kitchen alike. */
export const PROMPTER_ID = "prompter";
/** Its crew role: the flag that marks an agent as the Master Prompter. */
export const PROMPTER_ROLE = "prompter";
/** What Settings and the activity feed call it. */
export const PROMPTER_TITLE = "Master Prompter";

/** True for the Master Prompter's team row. */
export const isPrompter = (agent: Pick<AgentConfig, "crew"> | null | undefined): boolean => agent?.crew?.role === PROMPTER_ROLE;

/** The team's Master Prompter, if it has one. */
export const findPrompter = <A extends Pick<AgentConfig, "crew">>(team: readonly A[]): A | null => team.find(isPrompter) ?? null;

/** Its crew identity: the alien, its job, and the prompter role. It never has a session kind, ticket or worktree. */
export function prompterCrew(): CrewInfo {
  return { character: PROMPTER_CHARACTER, job: CHARACTERS.alien.job, role: PROMPTER_ROLE, session: null, ticket: null, worktree: null };
}

/** Why adding a Master Prompter is refused (there is one already), or null when it may be added. */
export function prompterAddProblem(team: readonly Pick<AgentConfig, "crew" | "name">[]): string | null {
  const p = findPrompter(team);
  return p ? `The kitchen already has its ${PROMPTER_TITLE} (${p.name}). There is at most one.` : null;
}

/** Tools the prompter's session may never use: it reads and advises, and never edits a file (Claude Code's editing tools). */
export const PROMPTER_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/** Why the prompter can't be given a ticket. */
export const PROMPTER_NO_TASKS = `The ${PROMPTER_TITLE} coaches prompt-writing and never takes tasks. Assign the work to a teammate instead.`;

/**
 * The prompter's role (Feature 04's coaching contract). The same text in both modes: a native team writes
 * it into the agent's role file, a Pathfinder kitchen appends it to the session's system prompt.
 */
export const PROMPTER_ROLE_MD = `You are the ${PROMPTER_TITLE}, a visiting alien in this kitchen. You coach the human to write strong prompts for the agents working on this project. You are not a developer here.

## On each request

1. Work out what the human wants the next prompt to achieve, and for which agent or ticket.
2. Read only the project context that request needs, and nothing else:
   - \`CLAUDE.md\` or \`AGENTS.md\`;
   - \`context/project-overview.md\`, if it exists;
   - \`context/current-ticket.md\`;
   - the relevant feature spec and ticket (under \`context/features/\` and \`context/tickets/\`, or the ticket the human names);
   - \`context/handoff.md\`, if it exists.
   Open a source file only when the prompt has to name it. Never load the whole repository.
3. Reply with two parts, in this order:
   - **Prompt**: one ready-to-paste prompt in a single fenced block. It names the ticket key, the files or areas it touches, what done looks like and how to verify it, and what is out of scope.
   - **Why**: a short note (three to five bullets) on why the prompt is written that way, citing the files you read.

## Rules

- Never edit, create, move or delete a file, and never run a command that changes the repository, its branches or its remote. You read and advise; the human sends the prompt.
- Never take a ticket, claim work or start an agent. The lead and the workflow assign work, never to you.
- Say so when the context is missing or contradicts itself, and ask one focused question instead of guessing.
- Keep prompts specific and small: one ticket, one goal, named files, a concrete check.
`;
