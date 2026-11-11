# Security Policy

## Scope — read this first

Tin & Thyme runs a local web server for each repository you open, and can start a
Claude Code session (Pathfinder's coordinator) in tmux when you ask it to. It binds to
`127.0.0.1`, and its browser connection and hook endpoint each require their own token.

In scope:

- anything that lets a web page, another user on the machine, or a process without
  the token read from or control a kitchen (its HTTP server, WebSocket or hook
  endpoint);
- a kitchen reaching, reusing or stopping a process, port or repository it should not
  (instance reuse is meant to require proof of identity, and Tin & Thyme never stops a
  process it did not start);
- the local-only run policy failing to refuse a push, pull request, GitHub API call,
  deploy or publish from the coordinator or its workers;
- tokens, transcripts or other local state leaking into a repository, a log anyone else
  can read, or the npm package.

Out of scope: vulnerabilities in Claude Code, Pathfinder, tmux, your browser or the stack
of the repository you open. Report those to their maintainers.

## Reporting

Report privately. Do not open a public issue for a security problem.

- **Preferred:** GitHub's private vulnerability reporting — **Report a vulnerability**
  under this repository's Security tab, once the repository is public.
- **Email:** riki.lamadrid@gmail.com

Useful details: the Tin & Thyme version (`tin-and-thyme --version`), your OS and Node.js
version, and the steps that trigger it.

## What to expect

This is a small project maintained by one person. Reports are read and taken seriously,
but there is no guaranteed response time and no bug bounty. A valid report's fix is
recorded in `CHANGELOG.md`, with credit unless you ask otherwise.

## Supported versions

Only the latest release is supported. Fixes land on `main` and go out in the next release.

Tin & Thyme began as a fork of JSM HQ. A vulnerability in code both projects still share
may also affect JSM HQ; please report it to JavaScript Mastery as well.
