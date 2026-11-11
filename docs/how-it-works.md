# How Tin & Thyme works

## What starts, what is reused, and what closing the browser does

| When | What happens |
| --- | --- |
| `tin-and-thyme open` | Resolves the repository to its canonical path. If a kitchen answers on its recorded port **and** proves it is that exact instance for that exact repository, it is reused. Otherwise one starts: a background Node server on the first free port from 7420, bound to `127.0.0.1`. |
| Two `open`s at once | One starts the kitchen; the other waits on a per-repository lock and reuses it. |
| A busy port or a stale record | The port is skipped. Tin & Thyme never stops a process it did not start. |
| The kitchen opens | It reads Pathfinder's engine (`orchestrate.mjs status`) and the session data already on disk. No session starts. |
| **Start team** | Launches the coordinator in tmux under a local-only run policy: pushes, pull requests, issues, GitHub API calls, deploys and `npm publish` are refused and become a human gate. |
| You close the browser | Nothing else happens. The kitchen keeps running; `tin-and-thyme open` or `tin-and-thyme url` brings you back. |
| You stop a kitchen | `kill <pid>` (`open` prints it). Coordinator and worker sessions keep running in tmux. |

What Tin & Thyme keeps lives in your home folder, keyed by the repository's
canonical path, so two repositories with the same folder name never share it:
`~/.controlroom/<repo>-<hash>/` (run state), `~/.controlroom/kitchens/` (instance
records and logs) and `~/.jsmhq/<repo>-<hash>/` (the hook token). Those folder
names predate the project's current name; they are kept so existing kitchens keep
their state.

## Supported integrations

| | |
| --- | --- |
| **Pathfinder** | The repository's own kit and engine, at the version it carries. Ticket stores: local Markdown and GitHub Issues. |
| **Claude Code** | The coordinator and its worker sessions: hooks for live events, transcripts for context, model and effort. |
| **Wonder Wagon** | The family's naming and CLI conventions. Tin & Thyme has no Wonder Wagon theme or serial yet; its kitchen palette is its own. |

The server still carries features of the project it was forked from (Docker
Sandboxes, a native multi-agent team, GitHub review loops). `tin-and-thyme open`
does not use them, and these docs do not describe them.

## The command and the kitchen

`tin-and-thyme open [path]` (`bin/tin-and-thyme.mjs`, with the shared logic in
`server/kitchen.ts`):

1. Resolves the path to the repository's **canonical root**: its Git top level, with
   symlinks resolved.
2. Derives the **kitchen key** `<folder>-<8 hex>`, where the hex is the start of the
   SHA-256 of that root. Two repositories with the same folder name get different keys.
3. Checks the Pathfinder kit (`context/execution-mode.md` with its marker, and
   `skills/orchestrate/engine/bin/orchestrate.mjs`). If either is missing, it explains
   and exits; it never writes into the repository.
4. Reads the instance record `~/.controlroom/kitchens/<key>.json`. The kitchen is reused
   only if `GET /api/health` on its port reports `app: tin-and-thyme`, this key and the
   record's random instance id.
5. Otherwise, under the lock `~/.controlroom/kitchens/<key>.lock`, it starts the server
   (`dist-server/main.mjs --repo <root> --port <p> --kitchen`) detached, on the first
   free port from 7420, and waits until that server proves its identity. A busy port is
   skipped; nothing is ever stopped.

A kitchen started by hand before this command existed (with `HQ_REPO`) is recognised
from its saved hook settings, and `open` points you to it instead of starting a second
kitchen for the same repository.

## The server

One Node process per repository, bound to `127.0.0.1`:

| Route | Who uses it | Guarded by |
| --- | --- | --- |
| `GET /` and assets | your browser: the built UI from `dist/` | nothing secret is served |
| `GET /ws?token=…` | the UI's live connection | the browser token (new on every start) |
| `POST /hook/coordinator/<event>` | Claude Code hooks of the coordinator and its workers | the hook token |
| `GET /api/health` | `tin-and-thyme`, to verify a kitchen | reports identity only |

## The Pathfinder adapter (`server/pathfinder.ts`)

Pathfinder owns every state change. The adapter reads:

- **The engine.** `node skills/orchestrate/engine/bin/orchestrate.mjs status --json`,
  run from the repository with its own kit, every few seconds and after relevant hooks.
  It gives the board, each claim's state, and the gates.
- **Each claim's checkpoint**, `.pathfinder/worktrees/<key>/context/current-ticket.md`
  (State, Gate, Last, Next and the stage fields), read only.
- **Claude Code hooks** from the coordinator's session tree. `PreToolUse(Agent)` carries
  a worker's Pathfinder brief (ticket, session kind, role, worktree); `SubagentStart` and
  `SubagentStop` mark a worker live and finished; each tool call updates its terminal.
  A claim or a worktree alone never puts a robot on the floor.
- **Transcripts** under `~/.claude/projects/`, for each session's context, model and
  effort, and to rebuild the roster after a restart.
- **The coordinator's own `orchestrate plan` output**, which is the only source of
  "Ready for next round". Tin & Thyme never computes a plan itself.

When a worker stops, its outcome is read from the checkpoint at that moment: a recorded
next stage (or done) is a **handoff**, `human-gate` is a **gate**, `failed` is a
**failure**, and a session that leaves its own stage in place was **interrupted**.

**Start team** launches the coordinator as `claude --settings <hook settings>
"/orchestrate start"` in the tmux session `hq-<key>-coordinator`. The settings add the
hooks and a guard that refuses pushes, PR, issue and API calls, deploys and publishing
for the coordinator and every worker.

## In the browser

Every view is drawn from the same snapshot: the roster and ticket cards, the kitchen in
either art style, the board, Activity and sound. A full snapshot (first load, refresh,
reconnect) is a baseline: beams and sounds play only for changes seen while connected,
keyed by session and ticket, so nothing replays.

## What is kept where

Nothing is written into the repository you open.

| Path | What |
| --- | --- |
| `~/.controlroom/kitchens/<key>.json` | the running kitchen's record (port, pid, instance, URL), mode 0600 |
| `~/.controlroom/kitchens/<key>.log` | its server log |
| `~/.controlroom/<key>/` | run state: the coordinator's transcript note, robot assignments, session outcomes, the last plan seen, context settings, hook settings, `repo.json` naming the repository |
| `~/.jsmhq/<key>/agent-token` | the hook token |

The `.controlroom` and `.jsmhq` names predate Tin & Thyme's name and are kept so existing
kitchens keep their state. State from before kitchens were keyed by path
(`~/.controlroom/<folder>`) is copied into the keyed folder, never moved, and only when
its saved coordinator transcript proves it belongs to that repository.
