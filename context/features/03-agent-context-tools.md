# Agent Context Tools

## Status

Complete

## Goal

From any agent's drawer the human can (1) get a short summary written by the
agent of what it is doing, ready to copy, and (2) safely refresh the agent's
context: it writes an optimal handoff, its context is cleared, and it orients
from that handoff so it is ready for the next request.

## Context

- Read: `server/hooks.ts` (Stop / UserPromptSubmit / needs-input handling),
  `server/inbox.ts` (`takeForStop`), `server/sessions.ts` (`write`, L360–L367),
  `server/handoff.ts` (the existing worker "Checkpoint & start fresh"),
  `server/agentFiles.ts` (`ROLE_FILE`, `.git/info/exclude` handling),
  `src/ui/drawers/AgentDrawer.tsx`, `src/ui/drawers/CrewHeader.tsx` (L93–L125),
  `skills/handoff/SKILL.md`.
- Relevant area: `server/`, `src/ui/drawers/`.

## Requirements

- Both actions run only when the agent is running and idle: not working, not
  waiting on the human. Otherwise the button is disabled and says why.
- Both type a single marked prompt into the agent's terminal, then use the
  hooks to wait for that turn's Stop. They time out with a visible error and
  never send a second prompt by themselves.
- Summary: the agent writes at most ~150 words (goal, ticket/branch, done,
  in progress, next, open questions) to `.jsmhq-summary.md` in its folder. That
  file is excluded from git like `ROLE_FILE`. The drawer shows it with Copy
  (clipboard) and its timestamp.
- Fresh context, in three visible steps:
  1. Handoff: the agent writes a handoff to `.jsmhq-handoff.md` (also excluded)
     following `skills/handoff/SKILL.md`. The step passes only if the file
     exists and is newer than the request.
  2. Clear: sends the harness's clear command (`/clear` for Claude, `/new` for
     Codex).
  3. Orient: types "Read .jsmhq-handoff.md, orient, and reply READY with a
     3-line status", and waits for Stop.
  If any step fails, the later steps don't run.
- Pathfinder workflow worker sessions (`config.crew.session`) keep the existing
  Checkpoint & start fresh. Fresh context is for team agents and the lead.

## Out of Scope

- Summaries built by Tin & Thyme without the agent (rejected for now).
- Interrupting a working agent; changing Pathfinder's handoff skill.

## Acceptance Criteria

- On an idle Claude agent: Summarise → summary shown → Copy puts it on the
  clipboard.
- Fresh context on an idle agent: the handoff file appears, the context is
  cleared, and the agent replies READY with a status that matches the handoff.
- Both buttons are disabled while the agent is working or asking the human.
- `pnpm typecheck` passes.

## Notes / Decisions

- Human decision (2026-11-11): the agent writes the summary itself.
