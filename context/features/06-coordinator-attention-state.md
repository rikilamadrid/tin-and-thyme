# Coordinator Attention State

## Status

In Progress

## Goal

The kitchen marks the coordinator "Needs you" only when it is actually waiting on a human decision,
not whenever its turn ends while background workers it dispatched are still running.

## Context

- Read: `server/pathfinder.ts`
  - The coordinator `Stop` hook (~L447–L449 at `7b3eda3`) sets `needs-input` on every coordinator Stop
    ("A coordinator that ends its turn mid-run is asking the human").
  - The transcript poll (~L640–L656) sets `needs-input` whenever `awaitingHuman` is true.
- Read: `server/transcripts.ts` `awaitingHuman` (~L107–L113): true when the last non-sidechain record is
  an assistant message with `stop_reason: "end_turn"`.
- Read: `server/pathfinder.ts` gate → action-item sync (~L896–L925): `gate-<key>` items open on a
  `human-gate` row and close when it leaves.
- Relevant area: `server/pathfinder.ts`, `server/transcripts.ts`, `src/ui/hud/CrewPanel.tsx`.
- Avoid: the run policy (Feature 05).

## Requirements

- While at least one dispatched worker is live and no `human-gate` row or open `gate-*` action item
  exists, a coordinator whose turn ended is shown as waiting on workers, not as "Needs you".
- A real ask still shows "Needs you", without lag:
  - an open gate;
  - the run-approval question;
  - a question with no live workers.
- Restart recovery (the transcript poll path) follows the same rule.
- A review session that ends with a PASS/FINDINGS/GATE report is not shown as "Interrupted — stopped
  without recording a handoff". Only the implementation brief records `done` in the state file today; a
  tester session reports, but does not set `done`.

## Out of Scope

- Pathfinder engine or skill changes; ticket 05.1.

## Acceptance Criteria

- Reproduction: dispatch a background worker, then end the coordinator turn. Before the fix the
  coordinator shows "Needs you"; after it, "waiting on workers". An open gate still shows "Needs you".
- A tester session that reported is not labelled Interrupted.
- `pnpm typecheck` passes.

## Notes / Decisions

- Observed 2026-11-12 in this kitchen (pid 83794, build `7b3eda3`), read-only:
  - `gate-05.1` was already `done` (closed 08:51:42Z), and there were no open action items.
  - The coordinator showed "Needs you" after its turn ended while the 05.1 developer worker was
    `working`.
  - Both 05.1 review sessions (`w-05-1-review-*`) showed "Interrupted — stopped without recording a
    handoff" after reporting FINDINGS.
- Recorded as a follow-up only. It needs `to-tickets` and human approval before any work.
- Observed 2026-11-12 (human report, from the coordinator session). A possible defect with gate
  dismissal: dismissing ticket 02.1's human gate in Tin & Thyme without answering it sent the same
  message to the coordinator again each time, "Human dismissed the 02.1 gate in Tin & Thyme without an
  answer; leave it open". It arrived three times for one open gate. It looks like a dismissal re-sends
  the notice rather than staying dismissed. A dismissal is not an answer, so the gate correctly stayed
  open. Not reproduced or diagnosed. Recorded under this Feature's attention-state follow-up, not as a
  separate ticket. Like the rest of this follow-up, it needs `to-tickets` and human approval before any
  work. It is not in ticket 06.1's current scope.
- Observed 2026-11-12 (orchestrator, read-only, then a records-only correction). Session outcomes are
  attributed to the wrong worker. `endWorker` (`server/pathfinder.ts` ~L510-L530 at `7b3eda3`) settles a
  stopped worker from its ticket's state file at the moment it stops, so concurrent and back-to-back
  sessions on different tickets got each other's results in `sessions.json`. For example:
  - 09.1's repair session was recorded with 01.1's text;
  - 09.1's final PASS review was recorded as "Interrupted" with the previous developer's DONE line;
  - a planning session was recorded with 02.1's gate.
  The orchestrator corrected only 09.1's three entries, against the engine record and each session's own
  report. The previous values are kept in each entry's `previous` field, and the file was backed up first.
  This is the same follow-up as the review-session "Interrupted" labelling above. Fix it under this
  Feature, which needs `to-tickets` and human approval, not as a new ticket.
- Root cause found 2026-11-12, by reading the code at `7b3eda3`, for wrong worker identities, such as
  "Roux repairing 02.1" while Roux is really the 10.1 developer and nothing is working on 02.1.
  - `server/pathfinder.ts:395` queues every brief on the coordinator's `PreToolUse(Agent)`.
  - `:410` adds the worker by its real id on `PostToolUse(Agent)`, but never removes that brief from
    `pendingBriefs`.
  - `workerHook` `:636-638` then hands the OLDEST pending brief to the next `SubagentStart` of any unknown
    id, helpers included.
  - So whenever `PostToolUse` arrives before `SubagentStart`, one brief is left in the queue, and every
    later subagent inherits a stale ticket, stage and gate.
  - `crew.json` and `sessions.json` then persist the wrong identity, and the attribution defect above
    follows from it.
  - Fix: match briefs by agent id or prompt, never FIFO. Drop a brief when its worker is added through
    either path. Never give a brief to a helper.
  - The live kitchen keeps the wrong in-memory roster until it restarts into a build with the fix.
- Stacked-branch exception (human, 2026-11-12): 06.2 builds on the independently reviewed 06.1 commit before 06.1 merges. It is recorded in 06.2's Notes, and no completion state is falsified.
