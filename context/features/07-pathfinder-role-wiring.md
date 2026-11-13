# Pathfinder Role Wiring

## Status

Complete

## Goal

Every Pathfinder-managed session that Tin & Thyme starts or observes receives its real role contract
from the connected repository, through a supported instruction mechanism. Settings shows truthfully
which contract applies, where it comes from, and whether there is evidence the session loaded it.

## Context

Orchestrator inspection, 2026-11-12, at `7b3eda3`:
- **Coordinator launch:** `server/pathfinder.ts` `startCoordinator` (~L376) runs
  `claude --settings <coordinator-settings.json> /orchestrate start`. No role contract is passed. It
  reads `roles/orchestrator.md` only because `skills/orchestrate/actions/start.md` "Assumed role" tells
  it to.
- **Workers:** they are Claude Code Agent-tool subagents started by the coordinator with the engine's brief
  (`skills/orchestrate/engine/brief.mjs`, translation `claude-code`: a background subagent, with
  `role`/`prompt`/optional `model`). The role is read only because `skills/ticket/actions/start.md:8`
  and `review.md:8` tell the session to read `roles/developer.md` / `roles/tester.md`.
- **Settings → Team ROLE.md in Pathfinder mode** is a descriptive sentence and is used for nothing:
  - `server/pathfinder.ts:265` is the coordinator's, "Pathfinder orchestrator (roles/orchestrator.md in the project)".
  - `:477` is each worker's, "Pathfinder <session> session, role <role>, for <key>".
- **The real ROLE.md path is native-team only:**
  - `server/agentFiles.ts` (`ROLE_FILE` = `.jsmhq-role.md`, `roleMd()` ~L105, the SessionStart hook
    that prints it, ~L200, written ~L220);
  - for Codex, `server/adapters.ts:51` `developer_instructions`;
  - edited in `src/ui/settings/TeamSettings.tsx` (ROLE.md field).
- **The worker's role and session** come from the brief header, parsed by `parseBrief`
  (`server/pathfinder.ts` ~L120): `Session:` and `Role:` lines. The engine's `Role:` line is the recorded
  dispatch/stage mapping.
- **Roles in this repo:** `roles/{developer,integrator,orchestrator,planner,tester}.md`. There is no
  `roles/adversary.md` and no `ticket adversary` action.
- **No `.claude/agents/` named subagent definitions** exist in this repo.
- **Coordinator hooks** already include `SessionStart` and `SubagentStart` (`hookSettingsFile`).

Relevant area: `server/pathfinder.ts`, `server/agentFiles.ts`, `server/transcripts.ts`,
`src/ui/settings/TeamSettings.tsx`, `src/ui/drawers/CrewHeader.tsx`, `src/data/types.ts`.

Avoid: Feature 05 / ticket 05.1 and its branch; the run policy; the ticket store; the connected
repository's `roles/` and `skills/` (read-only).

## Requirements

- **One source of truth.** The role contract is the connected repository's `roles/<role>.md`, read at
  session start. Its path is resolved against:
  - the coordinator's checkout, for the coordinator;
  - the worker's worktree, for a worker (falling back to the main checkout only when the worktree has no
    copy, as the brief protocol already does for untracked context, and saying which one was used).
- **The role is derived** from Pathfinder's recorded mapping (the brief's `Role:` and `Session:`, the
  orchestrator for the coordinator), never from the robot's name, character or kitchen job.
- **The contract is loaded through a supported instruction mechanism.** The full contract text must reach
  the session's context, not a sentence naming the file. Candidate mechanisms, to verify against current
  Claude Code: a coordinator `--append-system-prompt`/file flag or `SessionStart` additionalContext; for
  subagents, `SubagentStart` additionalContext, or a named agent definition. Do not create independently
  editable copies of a contract: generated or derived content must be regenerated from the source on
  every start and marked as generated.
- **Keep the brief and skills unchanged.** The generated ticket brief and the existing skill-loading rules
  (skills on demand) stay as they are. Do not preload skills.
- **Named subagent definitions.** Respect existing `.claude/agents/*` definitions where they are
  configured. Detect a conflict between a definition and the resolved role, and report it instead of
  overriding it silently.
- **Missing contract.** If the role file doesn't exist (e.g. `adversary` here), the session gets a clear,
  visible error. There is no fabricated fallback contract.
- **The connected repository's role and skill files stay unchanged.**
- **UI, Pathfinder mode:**
  - Show the resolved role and source path. Derived content is read-only, and the contract can be
    inspected.
  - Separate "configured" from "loaded". Only show "loaded" with session evidence (a hook record or a
    transcript entry showing the injected contract). Configuration alone is not evidence.
- **UI, native-team mode:** the editable ROLE.md works as today.

## Out of Scope

- Changing Pathfinder (roles, skills, engine).
- Feature 05; the run policy; ticket migration.
- Push, PR, merge, publish, or activating this in the live kitchen.
- Restarting existing workers.

## Acceptance Criteria

- **Live, in an isolated Pathfinder test repository** (not this repo, not the live kitchen), with harmless,
  distinct markers in each role contract:
  - a coordinator and a developer start through the supported flow;
  - the ticket goes to a fresh reviewer through its configured stage.
- **Session evidence** (transcripts and hook records) shows, for each session:
  - the correct contract was received (its marker);
  - the session followed a role constraint relevant to its role;
  - it used the expected ticket skill or brief.
- **Also shown:** worktree path resolution, missing-role handling, no leak of one role's marker into another
  session, and a Settings display that matches the real sessions.
- **Fixture or mock coverage** is reported separately from the live evidence.
- `pnpm typecheck` and `pnpm build` pass, and the tests pass.

## Notes / Decisions

- Human direction (2026-11-12): orchestrated delivery, with a developer worker and a fresh independent
  reviewer. Separate from 05.1. Local commit only; no activation.
