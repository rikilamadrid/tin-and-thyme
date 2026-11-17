# Master Prompter

## Status

In Progress

## Goal

The kitchen has a visiting alien, the Master Prompter: a special agent who
knows the project's context and helps the human write strong prompts for the
task at hand. An agent's summary can be sent straight to it.

## Context

- Read: `src/data/crew.ts` (`CharacterId`, characters), `src/galley/robots.ts`
  (sprite format), `src/galley/scene.ts` (stations, `SPOTS`, `HANGOUTS`),
  `src/galley/model.ts` (`crewIdentity`, `buildGalley` places),
  `src/galley/RobotPortrait.tsx`, `server/commands.ts` (add agent ~L85–L95),
  `server/agentFiles.ts` (ROLE.md assembly), `src/ui/settings/TeamSettings.tsx`,
  and Feature 03's summary panel once it lands.
- Relevant area: `src/galley/`, `src/data/`, `server/commands.ts`,
  `server/agentFiles.ts`.

## Requirements

- A new character `alien` with its own silhouette. It is visibly not a robot
  but uses the same pixel style and palette.
- At most one prompter per kitchen. It is added from Settings → Team ("Add the
  Master Prompter") and removed like any agent. It doesn't take tickets and the
  lead never assigns it work.
- It has its own spot in the kitchen (a small station or table) with the same
  states as other crew (off / idle / working / needs you), and its portrait in
  the roster.
- Its ROLE.md makes it a prompt-crafting coach. On each request it reads only
  the project context it needs (`CLAUDE.md`/`AGENTS.md`,
  `context/project-overview.md` if present, `context/current-ticket.md`, the
  relevant feature/ticket, `context/handoff.md`), then returns a ready-to-paste
  prompt plus a short note on why. It never edits files.
- "Send to prompter" on an agent's summary types "Help me write the next prompt
  for this agent:" plus the summary into the prompter's terminal and opens its
  drawer. Disabled if there is no prompter or it isn't idle.

## Out of Scope

- The prompter sending prompts to other agents itself.
- Generating summaries; that is Feature 03.

## Acceptance Criteria

- Adding the prompter shows the alien at its spot. A second add is refused.
- Asking it "help me prompt the next step for ticket X" returns a prompt that
  cites the right ticket and files.
- Send to prompter delivers a summary into its terminal in one click.
- `pnpm typecheck` passes.

## Notes / Decisions

- Human decision (2026-11-11): the prompter is an alien.

- Human decision (2026-11-13): the Master Prompter must work in Pathfinder-mode kitchens. Ticket 04.1 follows 09.3 and reuses its persistent crew/session allocation; native-team-only support is insufficient.
