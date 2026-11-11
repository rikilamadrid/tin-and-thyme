# What has been verified, and how

Tin & Thyme keeps evidence from a labelled sample scene apart from evidence from live
runs. The README's screenshots all come from the sample scene.

- **The labelled sample scene.** The transporter, ticket handoffs, the human gate,
  the interrupted session, both art styles, reduced motion and refresh without
  replay are checked in `?fixture=handoff` in headless Chrome. The screenshots in
  the README come from it.
- **Live kitchens.** `tin-and-thyme open` has loaded real Pathfinder repositories
  (local Markdown and GitHub Issues stores, including an existing claim), reused
  them on a second open, kept two same-named repositories apart and recovered from
  a stale record. A live coordinator view reconnected after a server restart
  without replaying anything.
- **Not yet observed live:** a real worker session beaming in and out, end to end.
  That event handling is checked against real-shaped hook events, not a recorded
  run.
- **The package.** `scripts/smoke-test.mjs` installs the packed tarball, runs the
  installed `tin-and-thyme`, opens a kitchen, loads its board, reuses it and checks
  the missing-kit message.

The release candidate's own checks (build, tests, the packed tarball, CI per platform)
are recorded in its pull request and in [`RELEASING.md`](../RELEASING.md).
