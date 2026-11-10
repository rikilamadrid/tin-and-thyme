# Controlroom: Kickstarter checkpoint

Status: **proposal for human review.** Nothing here is approved. No product code, dependencies, remotes, or project context were written.

Companion files: [`parity-checklist.md`](parity-checklist.md) · [`scene-study.html`](scene-study.html) (open it in a browser, phone width).

## 1. Product brief

**Controlroom** is a local app that runs a team of AI coding agents on your repo and shows them as a pixel-art office you can read at a glance. It is based on JSM HQ (MIT, © JavaScript Mastery). The name, logo, sprites and scenery are Controlroom's own, per upstream `TRADEMARKS.md`.

- **Audience:** a developer (you first) who runs several agents and needs to know, from a phone-sized glance, who is working, who is idle, what is in review, and what is waiting on them.
- **Promise:** every user-facing JSM HQ capability ([parity checklist](parity-checklist.md)), plus **workflow adapters**. Opening a Pathfinder project shows its roles, running agents, tickets, review evidence and pending decisions, with no roster or board setup.
- **Ownership line:** the workflow owns its state. Controlroom reads that state and calls the workflow's own commands. It never writes ticket status, state files, or claims itself.
- **Adapters:** `native` (JSM HQ's board, team and Team MCP, unchanged) and `pathfinder` (new). The seam leaves room for others later.
- **First success signal:** the acceptance demo (§4) passes on a real Pathfinder project with zero setup.
- **Explicitly out:** hosted or multi-user service, any auto-merge, editing Pathfinder from Controlroom, the "fold-out Outpost" (not found in upstream; see parity G2), publishing or packaging under any JSM name.

### Requirements / preferences / constraints

| Kind | Item |
|---|---|
| Requirement | Full upstream parity, with gaps recorded explicitly |
| Requirement | Pathfinder discovery with zero duplicate setup; Pathfinder owns state changes |
| Requirement | Native workflow stays available; the adapter seam allows more adapters |
| Requirement | Mobile-first scene; states readable through labels and shapes, without relying on colour or motion |
| Requirement | Upstream attribution preserved (MIT LICENSE kept, "based on JSM HQ" stated) |
| Preference | Office setting; readable pixel-art zones like upstream, with all-new art |
| Constraint | Pathfinder checkout stays read-only; any run that writes files or launches agents uses a disposable project |
| Constraint | Local only; stop before remotes, issues, PRs, publishing, deploy |
| Fact | Controlroom's `context/execution-mode.md` = **orchestrator** (read from the marker) |

## 2. What I found

- **Controlroom repo:** branch `main` with **no commits and no remotes**. It contains only the Pathfinder kit (`skills/`, `roles/`, `context/`, `templates/`, `lib/`, adapters). **There is no JSM HQ copy to work from** (parity G0).
- **Upstream:** public, `main` at `1d0ecdb` (2026-11-09), v0.7.5. Stack: Node ≥20, TypeScript, React 18 + Vite + Tailwind 4 + Zustand + Pixi.js 8 (UI); `tsx` server with `ws`, `@modelcontextprotocol/sdk`, `node-pty`, `@xterm/headless`, zod (backend); tmux, `gh`, Docker Sandboxes `sbx`.
- **Upstream seams the adapter can hang on:**
  - Client: `OfficeDataSource` (`src/data/source.ts`) is already pluggable (mock vs. WebSocket), and the UI consumes only `OfficeSnapshot` + `OfficeEvent`.
  - Server: the board lives in `server/planner.ts` + `store.ts` (`.jsmhq/plan.json`) and the team in `config.json`. Those two are where a `WorkflowSource` replaces native data.
  - `AgentConfig.workspacePath` already supports "run this agent in an existing folder", which is exactly what a Pathfinder worktree needs.
- **Pathfinder checkout** (`../pathfinder`, read only, HEAD `1746059`, 2026-10-21): the kit installed in Controlroom **differs from the checkout**. The checkout engine has `adversary`/`repair` states and `checkpoint-write.mjs`; Controlroom's kit has five claim states. The interface is versioned in practice.

## 3. Pathfinder interfaces: what the adapter can use, and what's missing

### Usable today (read-only)

| Need | Interface | Notes |
|---|---|---|
| Is this a Pathfinder project? | `context/execution-mode.md` marker `<!-- pathfinder:execution-mode … -->`, `skills/ticket/SKILL.md` | Mode = `human-in-the-loop` or `orchestrator` |
| Configured roles | `roles/*.md` frontmatter `name`, `description` | planner, developer, tester, orchestrator, integrator |
| Ticket store | `context/tracker.md` marker `pathfinder:ticket-store …`; default local `context/tickets/` | GitHub Issues stores read via `gh` |
| Board + tickets | `node skills/orchestrate/engine/bin/orchestrate.mjs board --json` / `status --json` | Verified: `status --json` runs read-only on Controlroom → `{ok, mode, store, rows:[]}`. A row has worker, key, lifecycle, state, where, gate, last, title |
| Running workers | Git worktrees `.pathfinder/worktrees/<key>`, branch `ticket/<key>-<slug>`, ref `refs/pathfinder/claims/<key>` | "A worker is a worktree" |
| Worker state | worktree `context/current-ticket.md` lines `- State/Gate/Last/Next/Updated/Review/…:` + `## Execution` yaml profile | Parsed by the engine's `readStateFile` |
| Pending human decisions | `human-gate` rows + `Gate:` line | Single-line question |
| Review evidence | `Review:`, `Adversary:`, `Resolved findings:` lines; PR via branch | Plus `gh` for PR checks |
| Lifecycle | ticket `## Status`: Proposed → Ready → In Progress → Complete (+ Cancelled, Superseded) | Never rewritten by status |

**Rule for the adapter:** always run **the target project's own** engine (`<project>/skills/orchestrate/engine/bin/orchestrate.mjs`), never one bundled with Controlroom, and show unknown state words as "unknown" instead of guessing. The version skew above is why.

### Missing or weak (recorded gaps)

| ID | Gap | Effect | Smallest workaround (no Pathfinder change) |
|---|---|---|---|
| G3 | **Liveness is declared, never detected.** `--live` must name the sessions this caller started. | Controlroom can't know about "actual running agents" it didn't launch; those show `stale` | Controlroom launches the worker sessions it shows (tmux), and passes them as `--live` |
| G4 | **No external-dispatcher hook in `orchestrate start`.** The orchestrator dispatches workers through its own harness. | If a Pathfinder orchestrator session dispatches, Controlroom doesn't own those sessions (G3) | Slice uses engine commands `claim` → `brief` → Controlroom launch. A dispatcher hook would be a Pathfinder proposal (your call, via `reflect`) |
| G5 | Worktree `.git` points at the main repo; may not resolve inside a Docker Sandbox VM | Sandbox mode may break git in a worker | Slice uses **Local** mode; sandbox verified later |
| G6 | No change stream or events; state is files + git + optional `gh` | Need polling and fs-watch | Watch `context/tickets/`, `.pathfinder/worktrees/*/context/current-ticket.md`, `refs/pathfinder/`; poll `status --json` |
| G8 | Human-in-the-loop mode has no claims or worktrees; the store's "In Progress" shows as `working` with no worker | One anonymous worker, the root `context/current-ticket.md` | Show it as "you (HITL session)" |
| G9 | Durable review evidence is a one-line field; the full report lives in the session or the PR | Evidence panel is thin | Show the field, the PR checks, and a link to the session transcript |
| G10 | Answering a gate has no single command form for a UI | | Route it to a `resume` session with the human's text verbatim; never interpret it |
| G11 | Whether the `## Execution` profile carries a role per worker is **unverified** | Role-to-sprite mapping | Verify against the checkout's `profile.mjs` in the slice |

## 4. Smallest implementation slice ("Pathfinder adapter v0")

Proves: **zero-setup discovery + one real ticket + agent / card / evidence-or-gate moving from one workflow.**

Prerequisite: D1 (bring the upstream in) and a rebrand-only commit that keeps parity.

1. **`WorkflowSource` seam (server):** `detect(root)`, `snapshot()` → `{roster, boards, tasks, gates, evidence}`, `watch(onChange)`, `actions` (`runTicket`, `answerGate`). `native` wraps the existing Planner + config unchanged.
2. **`pathfinder` source, read path:** detect via the mode marker; roles from `roles/*.md`; board + rows from the project's `orchestrate.mjs status --json`; fs-watch + 5 s poll; map `OfficeSnapshot` (Feature → board, ticket → task, claim → agent, `human-gate` → action item, `Review:` → evidence). Team MCP board-writing tools disabled in this mode.
3. **One action, `Run ticket`, on a Ready card:** a confirmation sheet, then the project's engine `claim <key>`, then `brief <key> --harness claude-code --approval "<your confirm text>"`, then Controlroom launches Claude Code in tmux, in **Local** mode, in `.pathfinder/worktrees/<key>`, and passes the session to `status --live`.
4. **Gate answer:** an action item shows the gate text verbatim. Your answer opens a `resume` session carrying that text. Controlroom writes nothing itself.
5. **Scene:** mobile portrait layout with the four state marks from the scene study, plus a **labelled** replay preset in the mock source.

**Acceptance demo** (in a disposable project, never Controlroom or the Pathfinder checkout):

1. Create `/tmp/…/pf-demo`: git repo + Pathfinder kit (copied from the read-only checkout), orchestrator mode, local Markdown store, one tiny Feature, one `Ready` ticket (e.g. "add `hello()` + test").
2. `controlroom --repo pf-demo` opens straight to the office: **no welcome, no roster, no board setup**. The roles and the Ready card are visible.
3. Run ticket → the developer sprite sits at a desk tagged `WORKING · 01.01`; the card moves to Doing.
4. The worker reaches review → the card shows `IN REVIEW` and the `Review:` evidence line; **or** it stops at a gate → the decision counter shows `NEEDS YOU` with the gate's question.
5. Restart Controlroom → the same state is rebuilt from files alone (the claim shows `stale` until resumed).
6. Diff check: Controlroom wrote nothing under `context/` or `.pathfinder/` in pf-demo; every write came from Pathfinder's commands or its worker.

Verification: unit tests for the snapshot mapping against recorded `status --json` fixtures (from both kit versions), plus the demo above recorded as evidence.

Out of the slice: sandbox mode for Pathfinder workers, Codex workers, GitHub Issues stores, an orchestrator "lead" session, integrate/merge, art beyond the four state marks.

## 5. Decisions for you

| ID | Decision | Recommendation |
|---|---|---|
| D1 | How to bring upstream into Controlroom | `git remote add upstream https://github.com/jsmastery-pro/jsm-hq` and merge its history at `1d0ecdb` into `main`, so attribution lives in history and later upstream merges stay possible. Alternative: a snapshot import plus `NOTICE`, which is cleaner but loses history |
| D2 | Stack | Inherit upstream unchanged (no new dependencies for the slice) |
| D3 | Names | CLI `controlroom`, dirs `.controlroom/` and `~/.controlroom/`; npm scope **TBD** (only needed if you ever publish) |
| D4 | Pathfinder workers: Local or Sandbox first | Local first (G5) |
| D5 | Gap G4 (dispatcher hook) | Live with the engine-command path for now; raise a Pathfinder improvement only after the demo |
| D6 | Controlroom's own Git workflow, review, CI, release | **TBD.** Not invented here; needed for `project-overview.md` |
| D7 | Baseline run of upstream in a disposable repo (installs dependencies, launches agents) | Do it before signing off parity |

## 6. After approval

1. Write `context/project-overview.md` (from the template), update `ai-interaction.md`, `CLAUDE.md`, and `AGENTS.md` with the approved choices, and add `/.pathfinder/` to `.gitignore`.
2. Recommended next skill: **`to-specs`** for two Features: (a) "Rebrand at parity" and (b) "Pathfinder adapter v0". Optionally run **`prototype`** first on the mobile scene, if the study raises questions.
