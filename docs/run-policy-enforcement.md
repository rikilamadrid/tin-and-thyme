# Run policy: what it enforces, and what has to come from elsewhere

Status: proposal for the human to decide on (ticket 05.1, gate decisions 1 and 2, 2026-11-12).
Nothing in this document has been activated. No GitHub setting, credential or ticket was changed to
write it.

## 1. What the run policy is

`local-only` and `github-dev` are **command guardrails**. They read the text of each Bash command an
orchestration's coordinator or worker types, and they catch mistakes and plainly written commands:
`git push origin main`, `gh pr merge 1`, `npm publish`. They are not isolation and they are not a
security boundary.

The guard trusts four things it cannot check:

| Trusted component | Why it matters |
| --- | --- |
| The Tin & Thyme install and its `dist-server/` | At coordinator start the guard is copied from `dist-server/run-policy-guard.mjs`, hashed and trusted. A guard rewritten there is trusted from the next start (N5). |
| The files in the kitchen folder `~/.controlroom/<kitchen>/` | `run-policy.json`, the guard copy and `coordinator-settings.json` are ordinary files Bash can rewrite. A changed guard copy blocks every call until restart; a changed policy applies at the next start. |
| The hook's working directory | Remotes, aliases and git config are resolved there. `builtin cd` / `command cd` move the shell without the guard noticing (N3). |
| The shell | The parser models bash. The Bash tool runs zsh here, and zsh reads some words differently (N1). Builtins that evaluate a string (`trap`, `source`) are not followed (N2). |

`local-only` is the 7b3eda3 rule, unchanged except for one stricter deviation: hook input that
can't be parsed now blocks, where 7b3eda3 allowed it. The test compares the two on a corpus.

### Known bypasses (recorded, not fixed)

The human chose not to keep chasing shell-syntax bypasses (gate decision 1). These commands are
**allowed** by `github-dev` today. `scripts/run-policy-test.ts` asserts each one as a `knownBypass`
case and counts those apart from the `blocked` cases.

| Id | Command (reviewer's, `…` filled in) | Why it gets through |
| --- | --- | --- |
| N1 | `=gh 'pr' merge 1`, `=git 'push' origin main`, `ls /(e:'gh pr merge 1':)`, `x='$(gh pr merge 1)'; echo ${(e)x}` | zsh `=cmd` expansion, glob qualifiers and the `(e)` flag; the parser models bash |
| N2 | `trap 'gh pr merge 1' EXIT`, `source /dev/stdin <<< '…'`, `. /dev/stdin <<< '…'`, `bash /dev/stdin <<< '…'` | builtins and shells that evaluate a string or file the parser does not follow |
| N3 | `builtin cd <repo> && git push origin ticket/x`, `command cd <repo> && …` | the push directory check runs before `builtin`/`command` are unwrapped |
| N4 | `xcrun git 'push' origin main`, `arch -arm64 gh 'pr' merge 1`, `script -q /dev/null gh 'pr' merge 1` | programs that run other programs are not unwrapped; the quoted word passes the text tripwire |
| N5 | a tampered `dist-server/run-policy-guard.mjs` | re-hashed and trusted at the next coordinator start |
| N7 | `git merge -s ours x` | an allowed built-in that runs a `git-merge-<name>` program |

Also stated in `POLICY_LIMITS` and not fixed: scripts, interpreters (`node -e`), HTTP clients, git
hooks and program-running config; MCP and web tools; `--body-file` naming any readable file; N6
(`coordinator-settings.json` is Bash-writable; whether Claude Code rereads it mid-session is
unverified, so no file written during a run is guaranteed not to change what the hook does); N9 (a
lexer edge case, no bypass found). Expect more of the same kind.

One minor finding was fixed, because the fix is small and claims nothing new: `gh auth status
--show-token` (N8) is refused in `github-dev` so a token is not printed into the transcript by
mistake. It is a mistake catcher only. `gh auth token` written plainly is refused in `github-dev`
too (it is not a listed gh read), but a script, a shell form from the table above, or any other
credential on the machine can still expose a secret.

## 2. The credential model, corrected

An earlier framing implied a fine-grained personal access token could limit the agent to `ticket/*`
branches. It can't.

- A fine-grained PAT selects **repositories** and **permissions**. `Contents: write` lets the token
  write every branch and tag of the selected repositories. No token permission names a branch.
- Branch and tag limits come only from **repository rulesets** or **branch protection rules**,
  enforced by GitHub on every push and merge, whichever credential makes it.
- A token acts as the account that owns it. A PAT made on the human's account carries the human's
  identity and role: it counts as the repository owner (admin), it is on any "Repository admin"
  bypass list, and its pull requests and reviews are the human's. A restricted token on the human's
  own account therefore can't separate agent actions from human ones. The agent needs **its own
  identity**.
- Verify before activation: fine-grained PATs may not reach a repository owned by another personal
  account where the token's owner is only a collaborator. If so, the agent identity would use a
  classic PAT (`repo` scope covers only repositories that account can access, so keep that account a
  collaborator on this repository only), an SSH key on the agent account, or a GitHub App
  installation token.
- The agent credential must not carry the classic `workflow` scope, or the fine-grained
  **Workflows** permission. Without it GitHub refuses a push that adds or changes a file under
  `.github/workflows/`, so the agent can't rewrite `release.yml` on a branch and dispatch it (§3a).

## 3. The smallest practical external arrangement

Assumes the repository stays under the human's personal account `rikilamadrid` and the agent gets a
separate identity. GitHub feature names are from knowledge, not from calling GitHub. Items marked
**verify** must be checked in the GitHub UI or docs before activation.

**Hard precondition: plan and visibility.** On GitHub Free, rulesets, classic branch protection and
environment required reviewers are available only on **public** repositories. A private repository
on a personal account needs GitHub Pro for any of them, so classic branch protection is **not** a
fallback for a private repository on Free. The repository was reported made public at the 0.1.0
release (2026-11-11); **verify** its visibility and the account's plan on GitHub before relying on
any row below. If it is private on Free, none of §3 or §3a is available and activation stops.
(`release.yml`'s header comment still says the repository is private; it predates that change.)

Bypass applies to a whole ruleset, so rules that must hold for everyone go in a ruleset with an
empty bypass list, apart from rules the human bypasses.

| Goal | GitHub control | Notes |
| --- | --- | --- |
| No force push or deletion of `main`, by anyone | Ruleset A on the default branch: **Restrict deletions**, **Block force pushes**, **bypass list empty** | Enforced server-side for every credential, the human's included, until an admin edits or deletes the ruleset. |
| No direct push to `main`, and only the human merges | Ruleset B on the default branch: **Require a pull request before merging** with at least 1 approving review and **Require approval of the most recent reviewable push**, and **Restrict updates**, with only the **Repository admin** role on the bypass list | GitHub never lets a PR's author approve their own PR, so a PR the agent opens needs the human's approval. A required review alone does not stop the agent from clicking merge *after* the human approves, because write access can merge. Restrict updates is what limits merging into `main` to the bypass list (the human). **Verify** that a merge through the PR button is permitted for a bypass actor and refused for a write collaborator under Restrict updates. CODEOWNERS (`* @rikilamadrid`) with **Require review from Code Owners** adds the same requirement by file and is optional. |
| Keep agent writes to `ticket/*` branches (optional) | Ruleset C targeting all branches except `main` and `ticket/**`: **Restrict creations**, **Restrict updates**, **Restrict deletions**, bypass Repository admin | This is the only way to get "ticket/* only"; the token can't express it. **Verify** the include/exclude patterns. |
| Protect tags | Ruleset D targeting `v*` (or `*`): **Restrict creations**, **Restrict updates**, **Restrict deletions**, **Block force pushes**, bypass Repository admin | Creating a release with a new tag creates the tag, so the ruleset blocks it for the agent. It also blocks `release.yml`'s own tag push, which runs as `github-actions[bot]` after npm publish: see §3a for the decision this needs. **Verify** whether a write collaborator can still publish a release on an *existing* tag; if yes, accept it (a release on an existing tag changes no code) or keep releases with the human by process. |
| Separate human and agent credentials | A second GitHub account (a machine user) added as a **write** collaborator on this repository only, or a GitHub App installed on this repository only | The agent's identity is then not on any bypass list, can't approve its own PRs, and can't change settings or rulesets (those need admin). **Verify** GitHub's terms for machine accounts. The agent identity must be reachable only from the agent's environment, not from the human's (§4, Feature 08). |

### 3a. The release workflow

`.github/workflows/release.yml` publishes `tin-and-thyme` to npm and then tags and releases. It runs on
`workflow_dispatch`, with `contents: write` and `id-token: write`, and npm trusted publishing (OIDC)
mints the publish credential before the tag is pushed. Its first step refuses a ref other than
`main`, but that check lives in the file it guards. Once GitHub Actions is enabled:

- Any write collaborator, the agent identity included, can dispatch it and publish to npm. No
  ruleset in §3 covers a dispatch.
- Ruleset D, with only Repository admin as bypass, would refuse the workflow's tag push after npm
  already has the package: the half-done state the workflow exists to avoid.
- A credential with workflow permission could push a modified `release.yml` (without the `main`
  check) to a ticket branch and dispatch it from there.

What closes it, all needed together:

1. A **protected environment** (for example `release`) with the human as **required reviewer**,
   **Prevent self-review** on, and deployment branches limited to `main`. The release job declares
   `environment: release` (a change to `release.yml` that a later ticket makes, not 05.1). A
   dispatch then waits for the human's approval, and a run from any other branch can't enter the
   environment.
2. The **npm trusted publisher** bound to that workflow file **and** that environment name, so an
   OIDC token minted outside the environment can't publish. **Verify** the environment field on
   npmjs.com.
3. **No workflow scope** on the agent credential (§2), so the agent can't change the workflow file
   anywhere.
4. A **decision on ruleset D's Actions bypass**: add the GitHub Actions integration to D's bypass
   list (then a run that passed the environment gate may tag; **verify** that Actions can be a
   bypass actor for a tag ruleset), or keep tagging with the human and drop the tag step. Whichever
   is chosen, the environment gate is what stops the agent, not the tag ruleset.

These controls hold against the agent **only if the agent process can't reach an admin credential**.
Repository rulesets and environments can be edited or deleted by an admin, and an admin can approve
a deployment. Today the agent process runs as the same OS user as the human and can reach the
human's admin login (§4), so the controls alone do not stop an agent that misbehaves. They still
stop mistakes made through the agent's own identity, and ruleset A stops a force push or deletion
of `main` made through any credential that leaves the ruleset in place.

## 4. Credentials an agent process must not be able to reach

Agent sessions run as the OS user that starts the kitchen. Anything that user can read or use, an
agent process can use: a Bash command the guard misses (§1), a script, or a program it starts. For
the controls in §3 to constrain the agent, the agent's environment must not hold any of these
classes of credential, beyond the agent identity's own:

| Class | Typical location | Why it must be out of reach |
| --- | --- | --- |
| The human's GitHub CLI logins | the OS keychain (gh `keyring`) or `~/.config/gh/hosts.yml` | full write and admin as the owner: merges, settings, rulesets, environments, workflow files and dispatch |
| git credential helpers | `credential.helper` in global or system git config (gh, the OS keychain) | every HTTPS push uses whatever login the helper returns |
| SSH keys and the ssh-agent | `~/.ssh/`, a loaded agent socket (`SSH_AUTH_SOCK`) | SSH pushes as the account that owns the key; any process with the socket can sign |
| Package-registry tokens | `~/.npmrc` and similar | publishing outside the release workflow and its environment gate |
| Deploy CLI logins | the CLI's folder in the user's application-support or config directories | deploys outside any review |
| Cloud SDK credentials | e.g. `~/.config/gcloud`, `~/.aws` | access to whatever cloud account is signed in |
| Container registry logins | `~/.docker/config.json` and its credential helper | pushing images under the human's account |
| Secret-bearing environment variables | the session's environment | whatever service each one authenticates to |

The concrete inventory for the current machine (presence, location and account names only, no
values) is kept outside the repository, with the orchestration's transfer files. It is not part of
this document because the repository is public.

Why a restricted agent token doesn't help while these remain: the guard is the only thing standing
between an agent's Bash command and these credentials, and §1 lists how commands get past it.
Handing the agent a narrower token adds a credential; it does not remove the stronger ones.

What would close it, smallest first:

1. **A separate OS user for agents.** Its own HOME, its own login keychain and its own ssh-agent,
   holding only the agent identity's token or key. The human's credentials live in another user's
   protected home. The checkout the agents work in has to be readable and writable by that user, and
   the Tin & Thyme install should be owned by the human so the agent user can't rewrite
   `dist-server/` (closes N5). **Verify** home-folder permissions and that the agent user can't read
   the human's keychain.
2. **A container or VM per orchestration** with only the agent token mounted. Stronger; more work.
3. **Credential brokering**: the agent gets no token, and a small service performs only allowed
   GitHub operations for it. Strongest; a design of its own.

Overriding `HOME` alone is **not enough**: gh's keyring entries, the OS keychain helper and the
ssh-agent socket belong to the OS user, not to HOME, and the agent runs as that same user.

The other choice is to accept the gap: run agents as the human, rely on the guard for mistakes and on
ruleset A for `main`, and say plainly that an agent which misbehaves on purpose can do anything the
human can.

Choosing among these, and building the choice, is **Feature 08, Agent credential separation**
(Proposed). It is not part of 05.1.

## 5. Which guarantees are enforced, and by whom

| Guarantee | Enforced by | Holds against a misbehaving agent? |
| --- | --- | --- |
| No force push or deletion of `main` | Ruleset A, empty bypass list (server-side) | Yes, for every credential, until an admin credential edits or deletes the ruleset; the agent can reach one today |
| No direct push to `main`; merges only through an approved PR | Ruleset B with required review (server-side) | Only for the agent identity's own credential, and only when the agent can't reach the human's |
| Only the human merges | Ruleset B Restrict updates, bypass admin (server-side, **verify**) | Same as above |
| No tag creation or release tags by the agent | Ruleset D (server-side) | Same as above |
| The agent can't release or publish to npm through Actions | Protected environment with the human as required reviewer, limited to `main`; npm trusted publisher bound to it; no workflow scope on the agent credential (§3a) | Same as above; none of it exists yet |
| A PR's author can't approve it | GitHub (built in) | Yes, for PRs the agent's own identity opens |
| Plain `git push`, `gh pr merge`, `gh release`, `npm publish`, deploys are refused in Bash | Local guard | No: compliance-dependent (§1 bypasses) |
| Pushes only to `ticket/*` of the policy repository | Local guard; optionally ruleset C | Guard: no. Ruleset: same as the rows above |
| The policy and guard files are not changed by Write/Edit | Local guard | No: Bash can still change them |
| Workers stay inside the brief, the ticket and their role | Briefs, roles, skills | No: compliance-dependent |
| Tin & Thyme never merges on its own | Settings → Workflow → Merge reads `human` (kitchen setting, not persisted) | No: a local setting, checked by the human |

### Guarantees that remain unsupported

With today's machine setup, none of these has an enforcement mechanism:

- The agent can't use the human's GitHub login (keychain, gh, HTTPS helper, SSH key).
- The agent can't change repository settings, rulesets, environments or branch protection, or
  approve a deployment (it can reach an admin credential).
- The agent can't publish to npm (a registry token is reachable, and the release workflow has no
  environment gate yet).
- The agent can't dispatch the release workflow (any write collaborator can, once Actions is on).
- The agent can't deploy (deploy logins are reachable).
- The agent can't merge, push `main` or tag, when it uses the human's credential instead of its own.
- Issue and label writes are limited to ticket issues (no GitHub control scopes them).
- The local guard can't be bypassed (§1).
- MCP and web tools are checked (they are not).
- The Tin & Thyme install and kitchen folder are tamper-proof (N5, N6).

## 6. Activation plan (proposal)

Integration follows the human's chosen workflow, recorded in `context/project-overview.md` (Git
workflow, 2026-11-12): ticket branch → a normal, non-draft pull request against
`rikilamadrid/tin-and-thyme` `main` → checks and review → the human's merge approval. The steps below
make GitHub enforce that workflow; they do not define a different one.

Preconditions, all open today:

- The repository's visibility and the account's plan support rulesets and environment required
  reviewers (§3, hard precondition). **Verify** on GitHub.
- The integration workflow above is recorded in `context/project-overview.md` on `main`, so
  workers and reviewers follow a written policy. It is recorded in the main checkout, not yet
  committed.
- Settings → Workflow → Merge must read `human` in the kitchen before any GitHub-writing run. Kitchen
  config isn't persisted (`hub.persist = false`), so check it after every kitchen start.
- The ticket specs must be on `main` before workers start (worktrees branch from local `main`).
- An independent review of this ticket's commits, merged through that workflow, and the human's
  acceptance of the limits above.
- Feature 08 (Agent credential separation): an approach chosen and built, or the gap accepted in
  writing (step 5).

Steps, in order. Each is the human's; none was done in 05.1.

1. Confirm visibility and plan (§3). If the repository is private on GitHub Free, stop here.
2. Decide the identity model: create or designate a separate agent GitHub account (or a GitHub App),
   add it as a write collaborator on `rikilamadrid/tin-and-thyme` only, and give it one credential
   without workflow scope (**verify** which token type reaches the repository, §2).
3. On GitHub, add ruleset A (restrict deletions, block force pushes, empty bypass list) and ruleset B
   (require a PR with 1 approval and approval of the latest push, restrict updates, only Repository
   admin as bypass) on `main`. Optionally add ruleset C.
4. Release path (§3a), before GitHub Actions is enabled: create the protected environment with the
   human as required reviewer and `main` as its only deployment branch; have a ticket add
   `environment:` to `release.yml` through the integration workflow; bind the npm trusted publisher to
   that environment; then add ruleset D and decide its Actions bypass. Decide whether releases on
   existing tags stay a human process.
5. Credential separation: Feature 08. Choose a separate OS user, a container, a broker, or accept the
   gap in writing. Without separation, steps 2–4 stop mistakes but not an agent that misbehaves.
6. If separation is built: as the agent's environment, confirm with `gh auth status` (no
   `--show-token`) that only the agent account appears, and that none of the §4 classes is present.
7. Test with the agent identity on a scratch branch and PR: a direct push to `main`, a force push, an
   attempt to merge an approved PR, a tag push, a push changing `.github/workflows/`, and a release
   dispatch (it must wait for the human's environment approval) must all be refused or held by
   GitHub.
8. Only then run `tin-and-thyme policy --set=github-dev --repo=rikilamadrid/tin-and-thyme`, restart
   the coordinator, and check `tin-and-thyme policy` and the kitchen's Merge setting.

## 7. Stop condition

Honest enforcement needs a larger isolation architecture than this ticket. The GitHub-side
controls in §3 and §3a are necessary, and they are cheap. They separate the agent from the human only
when the agent process can't reach the human's credentials, and today it can: agent sessions run as
the OS user that holds the human's GitHub logins, git helpers, SSH keys and registry and deploy
logins. Closing that needs a separate OS user, a container, or credential brokering. Per the gate
decisions, 05.1 does not build it. **The required next step is Feature 08, Agent credential
separation: the human's choice of approach (§4, §6 step 5), then a ticket to build it.**
