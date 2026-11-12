# In-App Ticket Delivery

## Status

In Progress

## Goal

The human delivers a reviewed ticket entirely inside the kitchen, with no Terminal and no copied commands. They:
- inspect the ticket's repository, branch, exact head, diff and review evidence;
- let the app push that branch and create or reuse a normal PR;
- see the actual checks and mergeability;
- approve the merge of that exact head.

The app then verifies the merge, completes Pathfinder's records and refreshes the dispatch plan.

## Context

Investigation 2026-11-12, read-only, at `7b3eda3`:
- **Reuse.**
  - `server/github.ts:12-108`: a read-only GraphQL query through `gh`, with `mergeable`, `reviewDecision`, checks and rate limits, and `reviewOf` at `:129`.
  - `server/lib/exec.ts` `run()`: `execFile`, no shell.
  - The WebSocket command path: `server/http.ts:114-141`, `server/commands.ts`, and the Pathfinder overrides at `server/main.ts:104-124`.
  - `PathfinderRun.answerGate` / `sessions.typeInto` (`server/pathfinder.ts:901`).
  - The setup check for `gh` (`server/setup.ts:138-149`) and `Sessions.runFix` (`server/sessions.ts:545`).
  - The UI: `src/ui/drawers/PrDrawer.tsx`, `ActionItemsDrawer.tsx`, `src/data/ws/wsSource.ts` (reconnect at `:18-53`) and `ConnectionBanner`.
  - Engine: `skills/orchestrate/engine/integration.mjs` (`checkIntegration`, `releaseClaim`), and `orchestrate status|plan|check --json`.
- **Missing.** Push, PR create/reuse, merge, merge verification, per-ticket delivery state, approval records, and command replies (WebSocket commands are fire-and-forget).
- **Specification of the operations and checks**, not code to run: `~/.controlroom/tin-and-thyme-c6df7995/transfer/github-delivery-05.sh` and `github-delivery-05.md`.
- **Avoid:**
  - `server/pathfinder.ts`, `server/kitchen.ts`, `bin/`, `scripts/build-server.mjs`. 05.1 changes these and is undelivered.
  - Activating or changing the run policy (Feature 05).

## Requirements

- **Explicit operations only.** Every operation is a named, typed app-side function with validated parameters: inspect, push, ensure-PR, status, merge, verify, complete/handback. No arbitrary shell, script or command string from the browser or from an agent. Process calls use `execFile` with fixed argument vectors.
- **The agent guard is untouched.** The coordinator's hook is unchanged. The `github-dev` policy is not activated. The kitchen server's own operations run only on the human's explicit action in the UI.
- **Validation before every write:**
  - repository: origin resolves to the configured `owner/name`;
  - branch: `ticket/<key>-*`, owned by the engine claim;
  - the head commit to deliver: equal to the engine-recorded reviewed head, or to that head plus commits that change only the ticket's own record;
  - a clean worktree;
  - no denylisted commits in the ancestry;
  - a secret scan of the diff;
  - the current integration base: fetched `origin/main` and the expected merge tree.
- **Approval is exact.** It records `{key, head, base, expected tree}`. Any change to the head or base invalidates it, and the UI shows why.
- **Idempotent, honest retries:**
  - An already-pushed identical head is accepted.
  - A remote branch with a different head is refused, never overwritten.
  - An existing open PR is reused.
  - An already-merged PR is verified rather than merged again.
  - Each step's state is kept, so the UI shows exactly which steps succeeded.
- **Pushes:** only `<sha>:refs/heads/<ticket branch>`, without `--force`, `--all`, `--mirror` or `--tags`. `refs/backup/*` and `refs/pathfinder/*` are never pushed.
- **Checks are shown as they are.** "No checks reported" is never shown as passing. With no checks, merging needs an explicit human acknowledgement and shows the local verification evidence recorded for the ticket. Failed or pending checks block the merge.
- **Merges:**
  - Squash merge pinned to the approved head (`--match-head-commit`).
  - The new `main` must have the expected parent and tree.
  - Remote ticket branches are kept.
  - Local branches, worktrees and claims are never deleted by the forge.
- **Credentials:** the human's existing `gh` login, used only by the kitchen server process. Tokens never appear in agent prompts, browser payloads, logs, activity text or delivery state; token-shaped text is redacted. Sign-in failures show an actionable in-app fix (`gh auth login --web` through the existing setup fix).
- **Delivery-changing operations** refuse WebSocket clients that send no browser Origin. This is a hardening step, not a security boundary (see Notes).
- **After a verified merge:**
  - The main checkout is reconciled on the human's click. Colliding untracked or modified files are moved to a timestamped backup, never deleted. Unrelated changes are preserved.
  - Then `main` is fast-forwarded.
  - The coordinator is asked once, with a marker, to run `/ticket complete <key>` and `orchestrate release <key>`.
  - The plan is refreshed.
- **State survives reconnects and kitchen restarts:** it is stored in `~/.controlroom/<kitchen>/deliveries/<key>.json`.

## Out of Scope

- npm publication, releases, deployment, and enabling GitHub Actions.
- Activating the run policy, and credential separation (Feature 08).
- Changing the coordinator hook.

## Acceptance Criteria

- The human delivers a reviewed test ticket through the kitchen, including merge confirmation and the updated board state, without opening Terminal or copying commands.
- Tests cover:
  - stale approvals (head or base moved);
  - failed checks and no checks;
  - retries (branch already pushed, PR already exists, already merged);
  - authentication failures;
  - reconnects (the snapshot restores the delivery state);
  - redaction;
  - refs that must never be pushed.
- The first production deliveries are 05.1 → 05.2 → 09.1 → 01.1, in that order. Each is revalidated against its current head, its review evidence and the actual integration base at the time.

## Notes / Decisions

- Approved for implementation by the human, 2026-11-12. The existing conditional merge authorization covers the production deliveries. Publication, deployment and `github-dev` activation stay unauthorized.
- Defaults adopted from the investigation (the human said to use them where they fit the constraints):
  - accept the shared-login risk for now, with the Origin hardening;
  - with no checks, merge only after acknowledgement plus local evidence;
  - squash merges, keeping the remote branches;
  - reconcile the main checkout by moving files to a backup.
- **Residual risk, accepted for now.** Agents run as the same OS user with the same `gh` login, and a same-user agent can already drive the kitchen: the kitchen record holds the browser token, and a WebSocket without an Origin is accepted. The human click is a safeguard against mistakes, not a security boundary. Real enforcement is Feature 08 plus the GitHub rulesets in 05.1's `docs/run-policy-enforcement.md`.
- **Still undefined, for the human (surfaced 2026-11-12): where completion records live once ticket files are tracked on `main`.** `/ticket complete` edits the ticket and Feature files, which then makes `main` dirty, and the next integration needs a clean `main`. Two options:
  - (a) a small records PR delivered through this same flow (the proposed default);
  - (b) the completion edit is committed on the ticket branch before merging, as "complete on merge".
  
  Ticket 10.3 implements (a) unless the human chooses otherwise.
- **Bootstrap (ticket 10.4).** The running kitchen (see `~/.controlroom/kitchens/` for its pid and port) runs `main`'s code and has no restart control. Before 10.4 starts, its first step checks whether a reviewed local build can be served separately while the current coordinator and worker sessions stay intact. If that isn't feasible, it reports the exact blocker and the minimum one-time activation.
