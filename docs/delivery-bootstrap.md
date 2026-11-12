# Delivery bootstrap: a preview beside the running kitchen

The running kitchen serves `main`'s code and has no restart control. In-app delivery
(Feature 10) is new code, so it has to be served by something other than that kitchen
before it can deliver anything, including itself. A **preview** is that something: a
second Tin & Thyme server, started from a reviewed build in a ticket's worktree, that
runs beside the kitchen without touching it.

**Verdict: feasible, with no change to `bin/`, `server/kitchen.ts` or
`server/pathfinder.ts`.** A preview is a separate mode of the same server entry
(`--preview`), and it shares nothing with the running kitchen that it binds or attaches
to. The one place it writes is `~/.controlroom/<key>/deliveries/` (see below), which the
running (old) kitchen never reads or writes.

## Running one

```sh
# In the worktree that holds the reviewed head (clean, committed):
pnpm install --frozen-lockfile
pnpm build:preview

# Then serve it, naming the reviewed commit and the repository it serves:
node dist-server/main.mjs --preview --port 7520 \
  --reviewed <40-hex sha of the reviewed head> \
  --repo /path/to/the/main/checkout
```

Stop it with Ctrl-C (or SIGTERM to that process only). Stopping it leaves nothing behind
except the delivery state it recorded in `~/.controlroom/<key>/deliveries/`.

| Command | What it does |
| --- | --- |
| `pnpm build:preview` (`scripts/preview-build.ts`) | Refuses a dirty checkout, and refuses to build in a repository any kitchen record names (that checkout's `dist/` may be what a running kitchen serves). Runs `pnpm build`, checks HEAD and the tree did not move, then writes `dist-server/preview-identity.json`: commit SHA, tree, build time and a SHA-256 digest of every built file. |
| `main.mjs --preview` (`server/preview/server.ts`) | Refuses to serve unless it runs from that checkout's `dist-server/main.mjs`, the identity file is there, the checkout is clean and still at that commit and tree, the built files match the digest, and `--reviewed` names that exact commit. Refuses a missing port, a port in the kitchens' range (7420-7499) and any port a kitchen record names. |

The identity checks' `git` calls run with `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`
(`PREVIEW_GIT_ENV`), so checking a build never refreshes its checkout's index and never
waits on a prompt.

## Build identity

The preview shows the commit SHA, tree and build time:

- **In the UI**: a banner at the bottom of the page (`src/ui/hud/PreviewBanner.tsx`),
  `PREVIEW · commit <12> · tree <12> · built <time> · delivery only, no agent sessions`;
  the full values are in its tooltip. It comes from the snapshot's `preview` field, which
  only a preview sets.
- **Through `GET /api/health`**:
  `{"ok":true,"app":"tin-and-thyme-preview","repoKey":"…","instance":"…","sha":"…","tree":"…","builtAt":"…"}`.

"Reviewed" is the human's statement: `--reviewed` must be the full SHA the review
covered, taken from the review evidence. It vouches for the preview's own build only:
every delivery operation still checks each ticket's engine-recorded reviewed head (its
claim's `Last: review PASS on <sha>` line) itself.

The stamp detects drift (a build that is not the reviewed one: another commit, a dirty
tree, rebuilt files), not tampering. A process running as the same user can rewrite the
build and its identity file together; that is the same-user risk Feature 10's Notes accept.

## Shared resources, and how each is isolated

| Resource | The kitchen's | The preview |
| --- | --- | --- |
| Kitchen key (from the repo's canonical path) | `<folder>-<8 hex>`; names its record, lock, state folders and tmux sessions | Computed to display it (`repoKey`) and to name the one folder the preview writes, `~/.controlroom/<key>/deliveries/`. The preview's own slug is `<key>-preview`, and nothing derives a path or a session name from it, because nothing that would is constructed. |
| Instance record `~/.controlroom/kitchens/<key>.json` | Written by the kitchen started with `--kitchen` | Never written or cleared (no `--kitchen`, no `writeRecord`/`clearRecord`). The records directory is only read, to refuse a recorded port and to refuse building in a kitchen's repository. |
| Lock `~/.controlroom/kitchens/<key>.lock` | Taken by `tin-and-thyme open` | Never taken: a preview is not started through `bin/`. |
| Port | 7420-7499, chosen by `tin-and-thyme open` | Explicit `--port` outside that range, never a recorded port; a busy port is refused, never taken over. The preview never connects to the kitchen's port. |
| Browser token | Random per start, in the kitchen's memory and its record's URL | Its own random token, in memory only. |
| Hook (agent) token `~/.jsmhq/<key>/agent-token` | Read or created by the kitchen; in the coordinator's hook settings | Never read or created (`agentToken()` is not called). The preview's hook token is random, in memory, and handed to nobody, so no hook can reach it. |
| Health endpoint | `app: tin-and-thyme`, key, instance | `app: tin-and-thyme-preview`. `tin-and-thyme open` reuses only `app: tin-and-thyme` with the right key and instance, and treats only an app-less answer as a legacy instance, so it can never adopt a preview. |
| Run state `~/.controlroom/<key>/` | Coordinator note, crew, sessions, plan, settings, hook settings, guard, `repo.json` | Nothing but `deliveries/`: no `claimStateDir`, no `adoptLegacyState`, no Pathfinder run. |
| Delivery state `~/.controlroom/<key>/deliveries/` | Used by a kitchen that runs Feature 10's code; the running (old) kitchen never reads or writes it | Each ticket's delivery state (`<ticket>.json`) and its lock files (`<ticket>.lock`, `merge.lock`), owner-only. The delivery core's cross-process locks guard it if a kitchen with the same code ever uses it too. |
| `~/.jsmhq/<key>/` | Hook token, agent folders | Nothing (`projectHome()` is never reached). |
| Coordinator hook settings `~/.controlroom/<key>/coordinator-settings.json` and its guard | Written when the coordinator starts; its hooks post to the kitchen's port | Never written or read. Hooks keep going to the kitchen's port only. |
| tmux sessions `hq-<key>-<agent>` | The coordinator's session | The preview constructs no session backend: no `has-session`, no attach, no kill, no typing. Its roster is empty. |
| Pathfinder engine and worker state files | Polled every 5 s by the kitchen's Pathfinder run | No Pathfinder run. Delivery reads the engine read-only (`orchestrate status --json` every 15 s, and `owner <key> --json`) to list the tickets ready to deliver; the operations run only on the human's explicit action. |
| Built UI and server (`dist/`, `dist-server/`) | The kitchen serves its install's files (here, the main checkout's) | Serves its own checkout's files. `pnpm build:preview` refuses to build in a repository a kitchen record names, so it cannot rewrite what a kitchen serves. |
| Repository `.jsmhq/config.json` | Not used in a Pathfinder kitchen | Read only; the preview's hub never persists. |
| Docker sandboxes, GitHub sync | Polled by the kitchen | Not constructed. |
| Logs | `~/.controlroom/kitchens/<key>.log` | Standard output only, including the browser URL with its token. |

What a preview still shares, by design: the OS user, its `gh` login and the repository's
Git objects. Feature 10's Notes accept that residual risk for now; the human's click is a
safeguard against mistakes, not a security boundary.

## Evidence

The isolation was checked against a throwaway repository and a disposable build (a clone
of the ticket commit in a scratch folder, built with `pnpm build:preview`), never against
the live kitchen. A read-only snapshot of the live kitchen's record hash, lock, port
listener, pid, tmux session list and the hashes of `~/.controlroom/<key>/` and
`~/.jsmhq/<key>/` was taken before and after the preview ran.

First run, 2026-11-12, build `4961670d3ee95a63a2453f3479156b1cde26dd21` on port 7520:

- the live kitchen's snapshot before and after the preview run was byte-identical
  (record hash, no lock, the same pid listening on its port, the same tmux sessions with
  the same creation times, and every file hash in both state folders);
- the preview had no child processes, no open file under `~/.controlroom`, `~/.jsmhq` or a
  tmux socket, and listened only on 127.0.0.1:7520;
- run again with an empty `HOME`, it left that `HOME` empty;
- `/api/health` and the WebSocket snapshot reported the commit, tree and build time, the
  UI showed the banner, the roster was empty, and `startAgent`, `stopAgent`,
  `sendMessage` and `resolveActionItem` were refused as unknown commands;
- it refused a missing or wrong `--reviewed`, a missing port, ports 7420 and 7455, an
  untracked file in the build checkout, running from `server/main.ts` instead of the
  stamped bundle, and (`pnpm build:preview`) building in a repository a kitchen record
  names.

`npx tsx scripts/preview-test.ts` checks the refusals (no
identity, dirty or untracked files, moved HEAD, changed tree, rebuilt files, missing or
wrong reviewed SHA, and every port refusal) against a throwaway repository and a fake
home.

## Activation

Activating a preview for real deliveries is the human's explicit step. It starts one new
process and affects no existing one:

- **Which process:** a new `node <worktree>/dist-server/main.mjs --preview …` that you
  start. The running kitchen (its pid and port are in `~/.controlroom/kitchens/<key>.json`),
  its coordinator's tmux session and its workers are not stopped, restarted or signalled.
- **Which command:** the two under *Running one*, in the worktree whose head was
  reviewed, with `--repo` set to the main checkout.
- **What is preserved:** everything the kitchen owns: its record, lock, port, browser and
  hook tokens, `~/.controlroom/<key>/`, `~/.jsmhq/<key>/`, the coordinator hook settings
  and the tmux sessions.

The preview accepts no plain browser commands (`PREVIEW_COMMANDS` is empty, with a null
prototype). Delivery reaches it only as the `delivery` request
(`server/delivery/preview.ts` `attachDelivery`), which refuses a client without a browser
Origin and runs each operation only on the human's click in the drawer.
