# Upstream parity checklist

Baseline: **JSM HQ** (`jsmastery-pro/jsm-hq`, MIT, © 2026 JavaScript Mastery)

- Upstream commit: `1d0ecdba0224f3bb2850a6a2d0971543ce97cc66` (2026-11-09, "Merge pull request #32 from jsmastery-pro/move-build-context"), package `@therealjsmastery/jsm-hq` 0.7.5
- Evidence: this list comes from reading the upstream source, `README.md`, `docs/how-it-works.md`, and `docs/getting-started.md` at that commit. **Nothing has been run yet.** Each row is still "read, not run" until the disposable baseline run (below) verifies it.
- Reference clone: a read-only scratch copy outside the repo. Controlroom contains no upstream code yet (see Gap G0).

Legend for **Plan**: `Keep` = carry over unchanged apart from the rebrand · `Adapt` = keep the capability and change how it gets its data in Pathfinder mode · `Gap` = no answer yet.

## Onboarding

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| O1 | CLI launch `--repo --port --no-open --version --help` | `bin/jsm-hq.mjs`, README §Options | Keep (rename binary) | Same |
| O2 | First-run Welcome: project name, lead + workers, CLI per agent, review tool, optional stack | `src/ui/setup/WelcomeModal.tsx`, `WelcomeInput` | Adapt | **Skipped.** The roster and board come from the project (zero setup) |
| O3 | Setup checklist: os, sbx, sbx-login, sbx-policy, tmux, gh, gh-remote, github-secret, claude, codex, openai-secret, each with a copyable or runnable fix | `server/setup.ts`, `SetupCheckId` | Keep | Add checks: Pathfinder kit present, `/.pathfinder/` ignored, engine runnable |
| O4 | Re-check / "Run in terminal" for a fix | `recheckSetup`, `runSetupFix` | Keep | Same |
| O5 | Config persisted in the repo (`.jsmhq/config.json`, `.jsmhq/plan.json`) and on the machine (`~/.jsmhq/<project>/`) | `server/store.ts`, `server/paths.ts` | Adapt (rename dirs) | The plan is **not** written. Pathfinder's store is the board |

## Team and task management

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| T1 | Lead + workers roster; add, rename, remove; CLI (Claude Code/Codex), model, Sandbox/Local mode, colour, ROLE.md | `TeamSettings.tsx`, `AgentConfig`, `commands.ts` addAgent/updateAgent/removeAgent | Keep | Roles come from `roles/*.md`, read-only. Running agents come from claims. Per-agent CLI/model still applies at launch |
| T2 | Remove agent with workspace inspection (uncommitted, unpushed, sandbox) | `RemoveAgentDialog.tsx`, `WorkspaceInfo` | Keep | A worktree is Pathfinder's. Removal is offered only through Pathfinder's `scratch`/release commands |
| T3 | Boards (phases) and tasks: id, title, owner, status, needs, files, doneWhen, PR | `server/planner.ts`, `BoardsDrawer.tsx`, `BoardsSettings.tsx` | Keep (native) | Feature → board, ticket → card, `## Blocked by` → needs, read from `orchestrate.mjs board/status --json` |
| T4 | Assign task to agent from the UI | `assignTask` | Adapt | Becomes **Run ticket**: Controlroom calls Pathfinder's own `claim`, then launches the worker. Pathfinder makes the state change |
| T5 | Agent live state: idle / working / needs-input / in-review / review-passed, via CLI hooks | `server/hooks.ts`, `AgentState` | Adapt | Shown as Pathfinder's closed vocabulary (ready … integrated), with hooks as a liveness signal only |
| T6 | Export plan to `docs/plan.md` | `server/planExport.ts` | Keep (native only) | N/A. Pathfinder already keeps the plan in Markdown or Issues |
| T7 | Activity feed (task, PR, review, session, config events) | `ActivityFeed.tsx`, `ActivityType` | Keep | Events derived from successive Pathfinder snapshots |
| T8 | Team MCP `hq` tools: list_workers, get_status, list_tasks, create_board, create_task, update_task, assign_task, get_my_task, set_my_status, ask_user, plus messaging/access tools | `server/mcp.ts` | Adapt | Board-writing tools are **off** in Pathfinder mode, so there is never a second board. The message, ask_user and request_access tools stay |

## Terminals and shells

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| S1 | Live agent terminal in its drawer (xterm, resize) | `TerminalView.tsx`, `server/sessions.ts` | Keep | Same session, started in the ticket's worktree |
| S2 | Persistent sessions in tmux `hq-<project>-<agent>`, which survive closing HQ; Windows falls back to an in-process pty | `server/backends/tmux.ts`, `pty.ts` | Keep | Required. Liveness depends on Controlroom owning the session (Gap G3) |
| S3 | Shell tab inside the agent's sandbox or folder | `openShell` | Keep | Same |
| S4 | Host terminal (top bar) in the repo, an agent folder, or any folder | `HOST_TERMINAL`, `openHostShell` | Keep | Same |
| S5 | Clickable wrapped links; copy link if the popup is blocked | `TerminalView.tsx` | Keep | Same |
| S6 | Resizable or maximized drawers with remembered width | `Drawer.tsx` | Keep | Same, plus the mobile layout (new) |

## Messaging

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| M1 | Agent↔agent and you→agent messages, delivered typed / on-stop / queued | `server/inbox.ts`, `AgentMessage` | Keep | Roles never call one another (Pathfinder rule). Agent↔agent messaging is **off**; you→agent stays |
| M2 | Messages tab in the agent drawer | `AgentDrawer.tsx` | Keep | Same |

## Human action items

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| H1 | `ask_user` requests with steps, naming the variable but never the secret | `server/actionItems.ts`, `ActionItem` | Keep | Same |
| H2 | Agents waiting in their terminal | `needs-input` state | Keep | Same |
| H3 | Access requests and blocked requests | `access.ts`, `SbxApproval` | Keep | Same |
| H4 | PRs ready to merge | `githubSync.ts` | Keep | Same, plus tickets `done` and awaiting `integrate` |
| H5 | Done (with note) / Dismiss notifies the agent | `resolveActionItem` | Keep | **New:** a Pathfinder `human-gate` becomes an action item whose answer goes back through Pathfinder (`resume` / `stage --guidance`). Controlroom never interprets it |

## PR and review tracking

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| P1 | Poll PRs, checks and reviews via `gh` about every 20s | `server/github.ts`, `githubSync.ts` | Keep | Same |
| P2 | Match PR → task by `[TASK-ID]` title prefix | `githubSync.ts` | Adapt | Match by branch `ticket/<key>-<slug>` instead |
| P3 | Review comments go to the author; passed → lead; merged → done; conflict → author | `githubSync.ts` | Adapt | Review evidence is Pathfinder's (state-file `Review:` / findings). Merge → `Complete` stays the integrator's and the human's |
| P4 | Review tool: CodeRabbit / Greptile / Copilot / human / custom | `WorkflowSettings.tsx`, `ReviewTool` | Keep (native) | Pathfinder's review policy lives in `project-overview.md`. Shown read-only |
| P5 | PR drawer, plus the PR belt and review gate in the office | `PrDrawer.tsx`, `layout.ts` belt/gate | Adapt (new art) | Review bench and merge dock (scene study) |
| P6 | HQ never merges | README | Keep | Same. Human-only |
| P7 | Deploy: instacloud/vercel/custom, per-agent environments | `WorkflowConfig.deploy`, `EnvironmentDrawer.tsx` | Keep | Same |

## Sandbox and network controls

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| N1 | Per-agent Docker Sandbox (`sbx`) or Local mode | `server/sbx.ts` | Keep | **Risk G5:** the worktree `.git` file points at the main repo, which may not be visible inside the VM |
| N2 | Base policy read-only; HQ adds only its own reach-HQ rule | `sbx.ts` | Keep | Same |
| N3 | `request_access` with Allow agent / Allow everyone / Deny | `access.ts` | Keep | Same |
| N4 | Blocked-request queue with Allow / Dismiss, "N blocked" badge | `SbxApproval`, `answerApproval` | Keep | Same |
| N5 | CPU/memory per sandbox; Recreate sandbox | `SandboxSettings.tsx`, `recreateSandbox` | Keep | Same |
| N6 | Service keys via the sbx secret store (never in the VM); app variables as session env | `setSecret`, `openEnvFile` | Keep | Same |
| N7 | Proxy setting | `setProxy` | Keep | Same |

## Port forwarding

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| F1 | Detect `localhost:<port>` in the Shell tab and offer Forward port | `src/store/ports.ts`, `Ports.tsx` | Keep | Same |
| F2 | Forward or stop any port in the Sandbox tab | `forwardPort`, `unforwardPort` | Keep | Same |
| F3 | Sandbox opens your browser if the site is allowed | docs §Terminals | Keep | Same |

## Integrations and settings

| # | Capability | Upstream evidence | Plan | Pathfinder mode |
|---|---|---|---|---|
| I1 | Settings tabs: Team, Workflow, Stack, MCP, Sandbox, Boards, Project | `SettingsModal.tsx` | Keep | Team and Boards are read-only views of Pathfinder; the others stay unchanged |
| I2 | Stack picker; installs official agent skills; one-click docs allow-list | `src/data/stack.ts`, `server/skills.ts` | Keep | Skills install must not collide with the Pathfinder `skills/` tree (it writes to `.claude/skills` and `.agents/skills`, which Pathfinder adapters also use). **Gap G7** |
| I3 | MCP servers: add (URL/key or local command), sign in, tick per agent, live attach | `McpSettings.tsx`, `server/sbxMcp.ts` | Keep | Same |
| I4 | Office name sign, font Pixel/Clean/Mono | `ProjectSettings.tsx` | Keep | Default sign "Controlroom" |
| I5 | Keyboard: 1–9 open agent, Esc, +/- zoom, D debug; drag/scroll the office | docs §Keyboard | Keep | Plus touch: tap and pinch (mobile-first) |
| I6 | Codex adapter (config.toml, hooks, trust prompt left to the human) | `server/adapters.ts` | Keep | Same |
| I7 | Mock data source with presets, speed, simulated access request | `src/data/mock/*`, `DevControls` | Keep | Add a **labelled** Pathfinder replay preset |
| I8 | Connection banner and reconnect; token auth (`unauthorized`) | `ConnectionBanner.tsx`, `wsSource.ts` | Keep | Same |
| I9 | Cross-platform (macOS, Linux; Windows experimental) | plan 008, docs §Windows | Keep | Same |

## Visual

| # | Capability | Upstream evidence | Plan |
|---|---|---|---|
| V1 | Pixel office: back wall (plan board, sign, shelf, clock, window), lead corner, lounge, desk grid, review column, PR belt + gate, server room | `src/office/layout/layout.ts`, `draw/*` | **Replace art.** Keep the readable-zone idea and draw all sprites and scenery new (see `scene-study.html`) |
| V2 | Recoloured hover-robot sprites, lead wears a crown | `src/office/draw/robots.ts` | **Replace.** Role silhouettes instead (see the scene study) |
| V3 | Team names from *The Office* (Michael, Dwight…) | docs §The team, `src/data/names.ts` | **Replace** with Controlroom's own name list |
| V4 | Pixi.js renderer, camera, A* paths, desktop layout | `src/office/engine/*` | Keep the engine; add a mobile portrait layout |

## Gaps recorded

| ID | Gap | Effect |
|---|---|---|
| G0 | **There is no upstream copy in Controlroom.** The repo has no commits, no remotes, and only the Pathfinder kit. The brief assumed a copy already existed. | Decision D1 picks how the upstream gets imported |
| G1 | No baseline run yet; every row is "read, not run". | Needs a disposable run (sbx, tmux, gh, claude) before parity is signed off |
| G2 | "Fold-out Outpost" is not in upstream at `1d0ecdb` or in Controlroom (no match for `outpost`). | Nothing to set aside unless you point me at it |
| G3–G9 | Pathfinder-interface gaps | See `brief.md` §Pathfinder interfaces |
| G7 | Stack skill installs and Pathfinder harness adapters share `.claude/skills` and `.agents/skills` | Needs a collision rule before the stack feature runs in Pathfinder mode |

## Disposable baseline run (proposed, not done)

1. `mkdir` a throwaway git repo with a throwaway GitHub remote, **outside** Controlroom and outside the Pathfinder checkout.
2. Run upstream at `1d0ecdb` from the reference clone (`pnpm install`, then `pnpm hq --repo <throwaway>`). This installs dependencies and launches agents, so it **needs your approval**.
3. Tick each row and record anything that differs from the docs.
