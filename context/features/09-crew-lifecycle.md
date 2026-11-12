# Crew Lifecycle

## Status

In Progress

## Goal

Robot characters are a persistent visual crew. Pathfinder execution sessions are disposable. The
kitchen shows truthfully who is working, waiting, needing the human, or relaxing. Settings → Team
in Pathfinder mode stops listing every past session as an editable agent.

## Context

### Findings, from inspecting this repository (2026-11-12)

**Roles and agents.**
- `roles/` has `developer`, `tester`, `orchestrator`, `planner` and `integrator`.
- There is no `adversary` role, no adversary stage or `ticket adversary` action, and no `.claude/agents/`
  definitions.
- Workers run as Claude Code Agent-tool subagents (`general-purpose`) of the coordinator.

**Stage routing.**
- The `static` policy (`skills/orchestrate/engine/policies/static.mjs:19`) is the default, because
  `context/execution-mode.md` has no routing-policy line. It maps `review` sessions to `tester` and
  everything else to `developer`: `implementation`, `resume`, `rebase-and-reverify`, `resolve-conflict`.
- The registry refuses a role without `roles/<role>.md` (`policies/registry.mjs:105`).
- `planner` runs in human-led sessions (to-specs, to-tickets). `integrator` runs inside the coordinator
  session (`/orchestrate integrate`), not as a dispatched worker.
- Other subagents the coordinator starts are tracked as helpers (`pendingHelpers` in `server/pathfinder.ts`).

**Concurrency.**
- `orchestrate plan --workers N` (default 3) caps the claims live at once (`engine/plan.mjs:85`).
  Tickets that are `serialize` against a live or planned ticket wait (`plan.mjs:100`).
- There is one session per claim at a time (`actions/resume.md`), but stages alternate:
  implementation → review → repair.
- So N tickets can be in any mix of implementation and review together. Several testers run at once
  when several tickets are in review, and several developers likewise. The number of role files is not a
  limit.
- An adversary has no stage here, so parallel adversaries can only be shown with fixtures. Tin & Thyme
  already knows the `adversary` session and the Pinch character from other Pathfinder versions
  (`server/pathfinder.ts` `addWorker`, `src/data/crew.ts:40`).

**How sessions are identified.**
- `parseBrief` reads the brief header (`Session:`, `Role:`, the key and the worktree).
- `hqId` = `w-<key>-<session>-<subagent id>`.
- The coordinator is `COORDINATOR_ID`.

### Root cause of the repeated Team rows

`addWorker` (`server/pathfinder.ts` ~L462–L482) pushes a new `AgentConfig` into
`hub.snap.config.team` for every session. That includes finished sessions restored from transcripts, so
history is shown as configured agents.

`assignCharacter` (`src/data/crew.ts:49`) avoids only the characters of live sessions. Each new
developer session therefore gets "Pepper" again, and each tester gets "Dash" again.

The live kitchen showed:
- Basil (the coordinator);
- 4 × Pepper rows, the developer implementation and resume sessions of 05.1, outcome `handed-off`;
- 4 × Dash rows, the tester review sessions, outcome `interrupted`. Feature 06 covers that mislabel.

Each row is a distinct session id. No configured agent is duplicated. `TeamSettings.tsx` renders
`config.team`, so in Pathfinder mode historical sessions look like editable agents, and editing them
affects nothing.

Relevant area: `server/pathfinder.ts`, `src/data/crew.ts`, `src/data/types.ts`, `src/galley/*`,
`src/ui/settings/TeamSettings.tsx`, `src/ui/hud/CrewPanel.tsx`, `src/ui/hud/telemetry.ts`,
`src/ui/drawers/CrewHeader.tsx`, `src/audio/*`, `src/data/fixture/*`.

Avoid: Pathfinder's own files; Feature 05/07 scope; the run policy.

## Requirements

### Four identities, kept apart
- **Role** (agent definition or role contract): read-only here, and owned by Feature 07.
- **Crew character:** persistent and visual. Its name and colour can be customized; it has a variant.
- **Execution session:** one per task or stage, always fresh. Reusing a character never resumes a
  conversation.
- **Ticket:** durable, and passes through sessions.

A character represents at most one live session.

### Allocation
- Reuse an available character whose role family matches first.
- Concurrent sessions of any role get distinct characters.
- Parallel roles get recognizable variants: a distinct name, accessory and palette accent in both art
  styles. No duplicate names and no "Dash 2".
- Identities stay stable across polls, reconnects and restarts. Persist them in `~/.controlroom/<key>/`.
- The visible crew is bounded. Overflow sits in a compact crew list or off-floor without losing history.
  There is never a cap on approved real concurrency.
- The orchestrator stays distinctive, in its office.

### Migration
- Existing per-session crew data and `config.team` rows become crew characters plus session history.
- Keep all ids, outcomes, ticket links and transcript paths.
- Back up first. The migration is idempotent and can be recovered.
- Never deduplicate by display name.

### Settings → Team, Pathfinder mode
- **Roles:** read-only, with source and evidence per Feature 07.
- **Crew:** visual customization only, clearly not execution configuration.
- **Current sessions.**
- **History:** finished sessions.
- Renaming a robot never implies a role change. Native-team mode is unchanged.

### Lifecycle states, from observed session data only
- **Available:** no session. The character goes to the lounge, café or stools along walk paths, with no
  tokens.
- **Assigned / starting:** walks to the workstation for its role. Keeps a starting badge until state
  confirms progress.
- **Working:**
  - developers cook at pods;
  - testers and adversaries scan or inspect at review spots;
  - the orchestrator types, checks the board or signals at its office;
  - helpers and others go to suitable spots.
- **Waiting** for workers, tools or dependencies: a waiting badge and a restrained pose, never "Needs you".
- **Needs you:** a compact pink badge, only for a real unresolved gate, permission request or question.
  It names the reason and the session or ticket, and takes priority while others run. The Feature 06 logic
  decides it.
- **Unknown:** shown as unknown, never as idle or working.
- **Finished:** the real outcome is recorded (success, interrupted, failed or human-gate kept distinct).
  After a short handoff it walks to a social area. Never restart a session for animation.

### Transporter
- Arrivals come through it, and so do departures on retire, removal, or an off-floor overflow.
- A session ending does not beam the robot out.
- Animations never delay real assignment or handoff.

### Parallel readability
- There are enough stations, or a clear overflow, that robots, ticket badges and nameplates don't overlap.
- Circulation paths, the café, the lounge and the belt stay readable.
- Labels are short; details go in drawers. Both art styles support the full lifecycle.

### Telemetry
- Context, model, effort and token or cost belong to the session, not the character.
- On becoming available, the current readings clear and earlier ones go to History.
- Unavailable data is shown as unavailable.
- Activity cues follow observed tool activity, and decoration never claims progress.
- Reduced motion uses static poses, icons and badges.
- Idle characters make no continuous sound, the audio toggle is followed, and no cue replays after a
  reconnect.

## Out of Scope

- Adding an adversary stage or role to Pathfinder.
- Changing role contracts or skill loading (Feature 07), the run policy (Feature 05) or attention logic
  beyond Feature 06.

## Acceptance Criteria

- **Fixtures** cover 2 developers + 2 testers + 2 adversaries together, and:
  - finish → relax → a fresh session on the same character, with no stale ticket or readings;
  - a human gate while others run;
  - a coordinator waiting with no false badge;
  - interrupted and failed sessions;
  - rapid handoffs and overlapping arrivals;
  - more sessions than stations or seats;
  - both art styles, reduced motion, and sound on and off.
- **Live, in an isolated Pathfinder repo:** two concurrent developers and two concurrent testers, a
  character reused for a fresh session, and a restart or reconnect with no duplicate crew, replayed
  arrivals, lost history or session launch. Adversaries are fixture-only, and that is stated.
- Settings → Team in this kitchen shows roles, crew, current sessions and history, with no repeated
  editable rows.
- Live, fixture and mock evidence are reported separately.

## Notes / Decisions

- Human direction, 2026-11-12: product direction approved. Inspect, plan, then approval → normal
  delivery. Keep it separate from 05.1 and 07.1 and respect their overlaps.
- Reuses Feature 06 (attention state) and Feature 07 (role source and evidence) instead of duplicating them.

### Storyboard (to be previewed in a ticket; ASCII here)

```
t0  lounge: Pepper(couch)  Dash(café)  Sprig(stool)          office: Basil ▣ typing
t1  07.2 claimed → Pepper walks to pod A  [starting]          Basil: "assigning"
t2  Pepper cooks @A [07.2 · working]   08.1 → Sprig walks to pod B [starting]
t3  07.2 → review: Pepper ✓handoff → walks to café; Dash walks to scan spot 1 [07.2 · review]
t4  08.1 → review while Dash is busy → Dot (tester variant) scans @2 [08.1 · review]
t5  Dash finishes (FINDINGS) → café; new repair session → Pepper (fresh context) → pod A
t6  gate on 08.1 → Dot ⏸, pink "Needs you · 08.1 gate" on the ticket; Pepper keeps cooking
t7  Basil waits for workers → ⧗ waiting badge, no pink
```
