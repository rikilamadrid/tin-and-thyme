# Contributing to Tin & Thyme

## Run it from source

Needs Node.js 20+ and pnpm 10 or 11 (`corepack enable` gets you pnpm).

```sh
git clone https://github.com/rikilamadrid/tin-and-thyme && cd tin-and-thyme
pnpm install
pnpm dev                                         # the UI alone, with sample data
open "http://localhost:5173/?fixture=handoff"    # the labelled Crew Transporter scene
HQ_REPO=~/Workspace/some-pathfinder-repo pnpm dev:hq   # a real kitchen + UI, with hot reload
```

| Command | Does |
| --- | --- |
| `pnpm dev` | The UI with sample data at http://localhost:5173 (no server) |
| `pnpm dev:hq` | A real kitchen server for `HQ_REPO` plus the UI, with hot reload |
| `pnpm build` | Type-checks, builds the UI to `dist/` and the server to `dist-server/` |
| `pnpm typecheck` | Type-check only |
| `node bin/tin-and-thyme.mjs open <repo>` | The built command, from this checkout |

Labelled sample scenes, for checking the kitchen without a live run: `?fixture=busy`
(every place in use), `?fixture=sounds` (the sound cues) and `?fixture=handoff` (the
Crew Transporter script; it keeps its start time in the URL, so a refresh resumes it).

## Where things are

```
bin/tin-and-thyme.mjs   The command: open, url, list
server/                 The local server: kitchen identity (kitchen.ts), the Pathfinder
                        adapter (pathfinder.ts), sessions, hooks, terminals, HTTP
src/galley/             The kitchen: model, scene, both art styles
src/ui/                 Top bar, roster and ticket cards, drawers, settings
src/audio/              Sound cues
src/data/fixture/       The labelled sample scenes
docs/                   Guides
skills/, roles/, ...    The Pathfinder kit this repository itself is run with
```

## Tests

```sh
pnpm typecheck
pnpm build
npx tsx scripts/session-backend-test.ts      # tmux and pty session backends
npx tsx scripts/workspace-test.ts            # line endings in agent clones
npm pack --pack-destination /tmp/tt-pack
node scripts/smoke-test.mjs /tmp/tt-pack/tin-and-thyme-*.tgz
```

The smoke test installs the packed tarball into an empty folder, runs the installed
`tin-and-thyme` against a throwaway Pathfinder-shaped repository (a stub engine), checks
the built UI, the board, reuse, `url` and the missing-kit message, and keeps all kitchen
state in a temporary HOME.

## Git

`main` is the release line. Work on a branch and merge by pull request. The original
project stays reachable as the fetch-only `upstream` remote
(`https://github.com/jsmastery-pro/jsm-hq`); nothing is pushed there.

## Releasing

See [`RELEASING.md`](RELEASING.md): the version comes from `CHANGELOG.md`, the first
publication is a one-time human step from a verified tarball, and every later release is
a manual dispatch of `.github/workflows/release.yml`, publishing through npm trusted
publishing. Never force-push, never move or delete a published tag, and never rewrite
released history.
