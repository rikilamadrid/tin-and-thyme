# Crew contract

Feature 09 (crew lifecycle), ticket 09.1. The types and constants are in
`src/data/crewContract.ts`; names and jobs are in `src/data/crew.ts`. Run
`npx tsx scripts/crew-contract-test.ts` to check the catalogue and the rules.
Tickets 09.2–09.8, 06.1 and the Settings views build against this document. If
this document and the code disagree, fix one of them. Neither one wins by default.

## Four identities

| Identity | What it is | Owner |
| --- | --- | --- |
| Role | The Pathfinder role contract (`roles/<role>.md`). Read-only here. | Feature 07 |
| Crew character | A persistent robot (`CrewCharacterId`). Its name and colour can be customized. | this contract |
| Execution session | One Pathfinder session (`CrewSession`). Always fresh, never resumed. | Pathfinder |
| Ticket | Durable. Passes through many sessions. | Pathfinder |

- A character holds **at most one live session**.
- A session wears **one character for its whole life**, or none when it is overflow.
- A ticket has many sessions. Each session names at most one ticket. The coordinator and
  helpers may name none.
- Reusing a character for a new session starts a new conversation. Nothing carries over except the
  look.

## Characters and families

All ten existing ids stay valid, in the families they had before. `assignCharacter`'s mapping
already put them there.

| Family | Pool, in allocation order | Here (installed kit) |
| --- | --- | --- |
| developer | pepper, roux, ember, sprig, crumb, mochi | live: implementation, resume, rebase-and-reverify, resolve-conflict (repair from other versions) |
| tester | dash, **dot**, **blip**, **zest** | live: review |
| adversary | pinch, **tang**, **nib**, **brine** | **fixture-only**. This kit has no adversary role or stage. The family is kept for fixtures and for other Pathfinder versions. |
| orchestrator | basil | live: the coordinator. It also runs `/orchestrate integrate`. |
| helper | **whisk**, **ladle**, **scoop**, **tongs** | live: non-brief subagents of the coordinator or a worker (`pendingHelpers`) |
| planner | **sage** | human-led (to-specs, to-tickets). Not seen in the kitchen today. |
| integrator | **clove** | integrate runs inside the coordinator, so it is shown on Basil. Clove is only for a kit that dispatches an integrator worker. |
| unknown | unit, **bolt**, **cog** | any role or stage that is not recognized |

New ids are in bold. Each variant has a distinct name, a job, a `base` silhouette (dash, pinch
or unit), an `accessory` and an `accent` (`CREW_VARIANTS`), which together form 09.2's art brief.
No name repeats, and no name ends in a digit.

Accents (checked by `crewContractProblems`):

- Variants that share a base have distinct accents, so two box bots never look alike. The unknown
  family is told apart that way too: `unit` is drawn plain in the unknown grey `#c2c3c7`, Bolt is
  `#ffccaa`, Cog is `#fff1e8`.
- No variant uses a needs-you pink (`RESERVED_ACCENTS`: `#ff77a8`, `#ff4f7b`), and no `unit`-based
  variant uses the unknown grey.

### Colours (decision for 09.3, 09.4, 09.5)

A character is drawn in `crewColor(id, record)`: its custom colour, else its variant accent, else
its family's role colour, `FAMILY_COLOR`. So `CrewCharacterView.accent` is always a colour, never
null.

- `FAMILY_COLOR` is the public role-colour map. It has the same values as the server's private
  `ROLE_COLOR` for the roles that map knows. Helper and unknown take its `#c2c3c7` fallback.
  **09.3** replaces `ROLE_COLOR` with `FAMILY_COLOR`.
- Orchestrator stays `#ff77a8`, so Basil's body is the one built-in pink. This keeps the coordinator
  distinctive (Feature 09) and keeps the look 0.1.0 shipped. Needs-you is never shown by body colour:
  09.5 draws it as the compact badge and the `#ff4f7b` outline, for Basil too.
- A custom colour (`crewColorProblem`) must be `#rrggbb`. It is stored lower-case. It is never a
  needs-you pink, and never the unknown grey except on `unit`, where grey is the default. **09.4** offers
  `agentPalette` minus what `crewColorProblem` refuses, which drops its first entry, `#ff77a8`.

### Customization and retirement: the write path (decision for 09.3, 09.4)

`customizeCharacter(book, id, { name?, color? }, now)` and `retireCharacter(book, id, retired, now)`
are the only writers of `name`, `color` and `retired`. Settings → Crew (09.4) calls them through a
09.3 endpoint, and 09.3 then writes the book atomically.

- `customizeCharacter` checks both values (`crewNameProblem`, `crewColorProblem`). When either is
  refused, it changes nothing and returns the reason.
- `null` resets a value to the catalogue one. Saving the catalogue name also stores `null`.
- Neither function touches the family, the role or any session.
- A retired character is never allocated again. A session that holds it keeps it until the session
  ends, and then the robot departs (see Transporter). Un-retiring brings it back as an arrival.
- Basil can't be retired.

### Widening `CharacterId` (decision for 09.2, 09.3, 09.5)

`CharacterId` (the ten base ids) is not widened in this ticket. `CrewInfo.character`,
`AgentConfig.crew`, `src/galley/robots.ts` and `src/galley/model.ts` stay typed `CharacterId`
until their owners change them:

- **09.3** widens `CrewInfo.character` (and so `AgentConfig.crew.character`) to `CrewCharacterId`
  when it publishes allocated characters.
- Every galley path still keyed by `CharacterId` (`ROBOTS`, `drawRobot`, `RobotPortrait`,
  `scene.ts`, `model.ts`) calls `spriteBase(id)`, which maps a variant to its `base`, until 09.2
  draws the variants. **09.2** then widens `ROBOTS` to `CrewCharacterId` and `spriteBase` becomes the
  identity for every drawn id.
- **09.5** reads `CrewCharacterId` from the snapshot. A variant without a sprite yet is drawn as its
  base, never as `unit`.

**Variants per family (decision).** The ticket asks for "at least 3 distinct variants for every
supported role family". This contract reads that as every family that can run sessions in parallel:
developer, tester, adversary, helper and unknown (`PARALLEL_FAMILIES`). Feature 09 asks for variants
for "parallel roles" only. Orchestrator, planner and integrator keep one character each:

- Basil, because Feature 09 says the orchestrator stays distinctive, so a second orchestrator robot
  would contradict it.
- Sage (planner) and Clove (integrator), because neither runs as a parallel session in this kit
  (`FAMILY_PRESENCE`). A second concurrent session in one of them is overflow (rule 6).

### Family of a session (`familyFor(role, stage)`)

1. A stage of `adversary` or `helper` wins, as `addWorker` does today.
2. Then the brief's `Role:` (with the aliases dev, engineer, qa, reviewer, lead, coordinator).
3. Then the stage (`STAGE_FAMILY`).
4. Otherwise `unknown`.

The coordinator's sessions are `coordinate`, or `integrate` while it integrates. Both are
orchestrator.

Only the coordinator session (`kind: "coordinator"`) wears Basil. A worker or helper that lands in
the orchestrator family is **overflow** (`characterId: null`, family kept as orchestrator): a
brief with `Role: lead`, `orchestrator` or `coordinator`, or `Session: integrate` with no Role.
The orchestrator pool is Basil alone, and families never borrow, so it gets no robot.

## Sessions

The `CrewSession` id rules are below. A session record is never re-keyed or deleted.

- **Worker or helper:** the Claude Code subagent id. This is the key crew.json and sessions.json use
  today.
- **Coordinator:** `coordinator:<transcript file name without .jsonl>`. Until its transcript is
  known, Basil shows `unknown` and no session record is written.
- `hqId` keeps today's snapshot id: `w-<key>-<session>-<id10>`, `coordinator`, or the helper's id.
- `stage` and `role` are verbatim. Stages that are not known are kept as written. Both are `null`
  for a migrated session until the restore fills them.
- `family` is `familyFor(role, stage)` once either is known. A migrated session with neither
  takes its legacy character's family, and for `unit` it takes `familyFor(legacy job)`, the role
  `assignCharacter` wrote there. Only a legacy session's family may differ from its character's
  family. The character is never changed to match.
- `seq` is the book-wide creation order: 0, 1, 2 and so on. Migrated sessions take crew.json key
  order, which is start order, because `addWorker` appends at session start. It breaks ties of age.
- `phase` only goes `live` → `ended`. Nothing moves a session back to `live`.
- `endedAt` is set once, when the session goes `live` → `ended` (or filled when it was null), and
  is never moved afterwards. If reconcile ended a session with `end: null` and a sessions.json
  ending arrives later, that ending fills `end`, and its own time stays in `end.at`. `endedAt`
  keeps the time the kitchen recorded, so the finished linger and `availableSince` never jump
  backwards.
- `end` reuses `SessionEnd`. Its `outcome` is `handed-off` (success), `gate`, `failed` or
  `interrupted`, and the four stay distinct. A session that ended with no recorded outcome has
  `phase: "ended"` and `end: null`, and shows as "outcome unknown".
- `report` holds a review or adversary verdict (`pass`, `findings`, `gate`) when one was read.
  06.1 classifies it: a review that reported is not `interrupted`.
- `telemetry` (`CrewTelemetry`) belongs to the session. It holds context, model and effort, tokens,
  cost and tool count. A value that is not available is `null`, never 0. This includes `tools`, which
is `null` for a restored session whose count was never read. The readings freeze when
  the session ends and stay in History. A character that is available shows no readings.

## Lifecycle states (`CrewState`)

States come from observed data only. `deriveCrewState(session, observation, now)` applies these
rules in order:

1. **available**: there is no session, or the session ended more than `FINISHED_LINGER_MS`
   (6 s) ago. The character goes to the lounge, café or stools. Basil is the exception: with no
   coordinator session recorded, he is **unknown** (pass `character` to `deriveCrewState`).
2. **finished**: the session ended less than 6 s ago (the handoff pose).
3. **unknown**: no observation, a reading older than `OBSERVATION_STALE_MS` (2 min) or with an
   unparseable `at`. It is never shown as idle or working. `CrewObservation.at` is **when the server took the reading**, stamped on every
   poll. It is not the time of the agent's last action. A gate left unanswered for an hour, a
   coordinator waiting on workers, or a long tool call all stay fresh, because each poll reads them
   again. Staleness means the server has lost sight of the session, and then even a needs-you
   reading shows as unknown.
4. **needs-you**: Feature 06 attention says there is a real gate, permission request or question.
   The badge names the reason and the ticket.
5. **waiting**: Feature 06 says waiting (workers, tools or dependencies).
6. **assigned**: the process is starting, or running with no tool call yet. The starting badge stays.
7. **unknown**: a live session whose process is stopped or failed. This comes after needs-you and
   waiting on purpose: a worker that stopped at a real gate is still a gate, and shows needs-you.
8. **working**: running, with the agent working.
9. Anything else while live is **waiting**. That includes `needs-input` that Feature 06 has not
   confirmed, so it never turns pink.

Allowed transitions (`CREW_TRANSITIONS`; staying in the same state is always allowed):

```
available → assigned
assigned  → working | waiting | needs-you | unknown | finished
working   → waiting | needs-you | unknown | finished
waiting   → working | needs-you | unknown | finished
needs-you → working | waiting | unknown | finished
unknown   → working | waiting | needs-you | finished
finished  → available | assigned        (a fresh session can take it at once)
```

`deriveCrewState` is the truth, and `CREW_TRANSITIONS` only says which changes animate
(`crewTransitionKind`). Any other jump, such as `available → working` after a restart, **snaps**
straight to the new state's pose with no animation. 09.5 never rejects or delays such a jump.

Only `available` has no session. Retiring a character (transporter departure) is a flag on the
record, not a state (`retireCharacter`). A session that ends never beams the robot out.

## Allocation invariants (`allocateCharacter(book, family, ticket)`)

1. A character holds at most one live session. Allocation reads the live sessions themselves.
   `record.sessionId` is a cache kept by `refreshCharacters`, so a stale cache can't free a
   character.
2. Allocation runs **once per new session id**. The result is stored in `CrewSession.characterId`.
   Polls, reconnects and restarts read the stored value and never allocate again, so identity
   stays stable.
3. The coordinator session (`kind: "coordinator"`) always gets `basil`. Basil is reserved: no
   other session wears him, whatever its family. Any other orchestrator-family session is
   overflow (`allocateCharacter(book, family, ticket, kind)`; `kind` defaults to `worker`).
4. The candidates are the family's own pool, minus characters that are retired or that hold a live
   session. Families never borrow characters from each other. A character whose session just ended
   is a candidate at once. The 6 s linger is only an animation (`finished → assigned`).
5. Prefer the candidate whose last session was on the same ticket, so a repair after review goes
   back to the cook who built it. Otherwise take the first candidate in pool order.
6. If there is no candidate, the session is **overflow**: `characterId: null`. It is listed in
   `CrewSnapshot.overflow` and in the compact crew list. There is no numbered copy and no cap on
   real sessions. The pool size is the family's floor bound. 09.5 gives every pool member a work
   spot, or shows the extra ones in the overflow layout. **An overflow session keeps no robot for
   its whole lifetime.** It is not given a character that frees up later, because a session wears
   one look for its whole life. The user sees it only in the crew list until it ends. A session is
   overflow only when the allocation that ran for it found no free character. The startup restore
   never decides that early (rule 7). Overflow is a session with no robot, never a robot off the
   floor, so 09.5 has no off-floor overflow and no overflow transporter case.
7. Concurrent sessions always get distinct characters, from 1 and 4 together.
8. Custom names (`crewNameProblem`) must be 1–24 characters after trimming. They must be unique
   (case-insensitive) against every catalogue name and every other custom name. They must not end
   in a digit, so "Dash 2", "Dash2", "Dash-2" and "R2D2" are all refused. Renaming changes only the
   label, never the family or role.
9. The registry changes sessions only through `startSession` (allocates once, and returns an id
   that already exists unchanged), `endSession`, `restoreSession` and `reconcileAfterRestore`. It
   changes characters only through `customizeCharacter` and `retireCharacter`. A new
   coordinator session ends any other live coordinator session, and moves any live
   non-coordinator session still on Basil (a legacy worker) to overflow with `reassignedFrom:
   "basil"`, recorded in the latest migration's `conflicts`. So at most one session, the
   coordinator, is ever live on Basil.
10. **Nothing is allocated while the restore pass is open** (`book.restorePass`, from `migrateLegacy`
    or `beginRestore` until `reconcileAfterRestore`). A new non-coordinator session recorded then,
    by `restoreSession` or by `startSession` from a hook, gets `characterId: null` for now, and
    `reconcileAfterRestore` allocates it. This has three consequences:
    - Restore order can't decide who gets a character.
    - A session the restore has not seen yet, or not yet confirmed ended, keeps its character.
    - Only a confirmed ending frees a character during the pass: `restoreSession` with `phase:
      "ended"`, `endSession`, or a sessions.json ending.

    A new coordinator session still takes Basil at once, because Basil is reserved and nobody
    competes for him. If it is older than a live coordinator session (`compareSessionAge`), it is
    recorded ended, so the newest coordinator wins whatever the order.

## Crew book (persisted)

The file is `~/.controlroom/<key>/crew-book.json`, the `CrewBook` type, with schema
`tin-and-thyme.crew-book` and **version 1**.

```
{ schema, version: 1, kitchen, updatedAt,
  characters: { <CrewCharacterId>: { id, family, name|null, color|null, sessionId|null,
                                     lastSessionId|null, availableSince|null, firstSeen, retired } },
  sessions:   { <session id>: CrewSession },
  migrations: [ { from, fromVersion, at, backup, imported[], filled[], conflicts[] } ],
  restorePass: { firstSeq } | null }
```

`restorePass` is open only between startup steps 1 and 4 below. It is `null` on disk, because the
book is written after reconcile. A file without the field reads as `null`.

- `characters` holds only characters that have held a session or been customized. Basil is
  always present, including in `emptyCrewBook`.
- A record's `sessionId`, `lastSessionId` and `availableSince` are derived from the sessions by
  `refreshCharacters`:
  - `sessionId` is the oldest live session wearing the character;
  - `lastSessionId` is its session with the highest `seq`;
  - `availableSince` is `null` while the character is held, and otherwise its latest session end.
  `firstSeen` is set once, when the record is created. For migrated characters that is the
  migration time, because the legacy files carry no first-seen time. Names, colours and `retired`
  are never derived.
- Write the file atomically: write a temp file, then rename it.
- A file with an unknown higher `version` is read-only. Never downgrade it; report it instead.
- A corrupt file is never overwritten. Rename it to `backups/crew-book.corrupt-<stamp>.json`
  and migrate again from the legacy files. Custom names can be restored by hand from backups.

## Migration from today's data

These are the sources in `~/.controlroom/<key>/`:

- `crew.json` is `LegacyCrewJson`: subagent id → `{ id, name, job }`, one entry per session. The
  names include numbered ones such as "Pepper 2" and "Reviewer bot 2".
- `sessions.json` is `LegacySessionsJson`: subagent id → `SessionEnd`.
- `coordinator.json` holds the coordinator's transcript path.
- `config.team` rows are **not persisted** in Pathfinder mode (`hub.persist = false`). They are
  rebuilt every start from the coordinator transcript, crew.json and sessions.json. So there are
  no custom names or colours to migrate. Their facts are the hqId, the ticket, the session kind,
  the role, the worktree and the transcript path. They are recovered when the restore re-observes
  each session, below.

Rules. Rules 3–7 are executable: `migrateLegacy`, `restoreSession` and `reconcileAfterRestore`
in `crewContract.ts`, tested against data shaped like the live files. The functions are pure.
`migrateLegacy` returns a new book. The other two mutate the book they are given. Rules 1 and 2 and
the disk writes belong to the caller.

1. **Back up before a migration write, and only then.** The caller picks the path
   `backups/crew-<ISO stamp>/` and passes it to `migrateLegacy` as `backup` (recorded in
   `migrations[].backup`). `migrateLegacy` writes nothing. If it appended a migration entry, the
   caller copies `crew.json`, `sessions.json`, `coordinator.json` and any existing `crew-book.json`
   to that path before it writes the book. A start that appends no migration entry writes no
   backup.
2. **Never modify or delete the legacy files.** Deleting `crew-book.json` restarts the migration
   from them.

   **Decision for 09.3:** 09.3 **stops writing `crew.json` and `sessions.json`** when it adopts the
   book. The book holds characters (`startSession`) and endings (`endSession` with the `SessionEnd`
   that `settle` builds today), and it replaces `crewBook()` and `endBook()` in
   `server/pathfinder.ts`.
   - From then on the legacy files are frozen read-only migration inputs. That satisfies this rule
     and rule 6 together.
   - The first start migrates everything they hold. Every later start imports and fills nothing, so
     it appends no migration entry and writes no backup.
   - Deleting the book still recovers the pre-Feature-09 history from them. Later history is
     recovered from `backups/`.
3. **Key by subagent id only. Never deduplicate by display name.** Each crew.json entry becomes
   one `CrewSession` with:
   - `id` set to the subagent id, and `seq` set to its position in crew.json;
   - `characterId` set to the legacy `id` unchanged ("Pepper 2" becomes `pepper`). An id that is not
     a crew character becomes `null`;
   - `legacy` set to `{ name, job, character }` verbatim;
   - `family` as in Sessions above;
   - **with a sessions.json ending:** `phase: "ended"`, `end` set to that ending, `endedAt` set to its `at`;
   - **without one (crew-only):** `phase: "live"` and `end: null`. sessions.json is written only when a
     session ends, so a crew-only entry is a session that was running at migration time, or one
     that died while nothing was watching. Rule 7 decides which. Until then it holds its character,
     and allocation will not hand that character to anyone else.

   Four "Pepper" sessions stay four sessions on the character Pepper.
4. **sessions.json entries with no crew.json entry** become sessions with `characterId: null`.
   They stay in history with the outcome kept.
5. **Fill links on restore (`restoreSession`).** The transcript restore (today's
   `addWorker(…, finished)`) reports each session it sees as `live` or `ended`, with its links. For a
   session already in the book it:
   - fills only **null** fields: hqId, role, stage, ticket, title, worktree, parent,
     transcript, startedAt, endedAt and end;
   - never changes `kind`. Every session in the book has a known kind. crew.json and sessions.json
     are written only for brief workers (`addWorker` needs `parseBrief`, and `settle` runs only for
     workers), so a migrated session is always `worker`. Helpers and the coordinator were never in
     them (rules 8 and 9). A brief whose `Role:` is `helper` is still a worker. Its *family* is
     `helper`, which the restore fills through role and stage;
   - recomputes `family` when it filled role or stage;
   - may move the session **live → ended** (`end` stays null when no outcome was recorded), but
     **never ended → live**;
   - never changes the character.

   An id not in the book is recorded:
   - A live one, while the pass is open, gets no character yet (rule 10). It also gets no
     `startedAt` unless the facts give one: pass the transcript's start time.
   - A live one after the pass goes through `startSession`.
   - An ended one gets no character.

   Sessions whose transcript is gone keep their record with null links.
6. **Idempotent (`migrateLegacy(crew, sessions, existing, …)`).** A subagent id already in
   `sessions` is never imported again. Only its null fields (`end`, `endedAt`, `legacy`) may be
   filled. A sessions.json ending may also move it live → ended, never back. Those ids are listed
   in `filled`. A run that imports and fills nothing appends no migration entry and leaves the
   book unchanged apart from `updatedAt` and the open restore pass. Until 09.3 stops writing crew.json, every start merges
   any new subagent ids in the same way. Under the rule 2 decision that is only the first start after
   09.3 ships. `migrateLegacy` resolves no conflicts. It opens the restore pass after its imports.
7. **Once the restore pass is complete (`reconcileAfterRestore(book, runningIds, now)`).** The pass
   is complete when every transcript has been read and every session's liveness is decided. A
   session still inside the reattach window is not decided: today that is an unfinished subagent
   while the coordinator is not yet running, during the server's first 15 s. Never run it before
   then. `runningIds` is every session confirmed running, including sessions the pass recorded and
   hook-started ones. Reconcile closes the pass and runs these steps in order:
   1. Canonical order. A live session the pass recorded with no `startedAt` takes `now`. The pass's
      sessions are renumbered (their `seq`) by `startedAt` and then id, so the order the restore saw
      them in leaves no trace in the book.
   2. Every live session not in `runningIds` is ended with `end: null` ("outcome unknown") and
      `endedAt` = now. That covers a crew-only legacy entry that died unobserved, a session from the
      last run that ended while the kitchen was down, and one whose transcript is gone. This is the
      first point at which an unseen session frees its character, because only now are all
      observations in.
   3. Of several live coordinator sessions, the newest keeps Basil and the others end.
   4. A live non-coordinator session on Basil (old `characterForRole` gave orchestrator-role workers
      Basil) moves to overflow with `reassignedFrom: "basil"` and is listed in `conflicts`.
   5. A character still worn by two or more live sessions (legacy "Pepper" and "Pepper 2") stays with
      the **oldest** (`compareSessionAge`, a total order):
      1. a session with no `startedAt` is older than one with it. After reconcile, only sessions
         the book did not see start lack one: legacy entries and sessions restored already ended.
         They predate every session the book started itself;
      2. if both are known, the earlier `startedAt` is older;
      3. otherwise the lower `seq` is older (crew.json start order, or the canonical order above).

      A pairwise rule like "seq unless both have `startedAt`" is not transitive. Each later session
      loses the character (`reassignedFrom`, listed in the latest migration's `conflicts`) and joins
      the queue.
   6. The queue is those sessions plus every live session the pass recorded with no character. It
      is allocated oldest first against the reconciled book. A session gets a free character of its
      family when there is one, and otherwise it is overflow.

   The result is the same allocation for every restore order. No live session is left without a
   character while its family has a free one. The exception is a session that was already overflow
   before the restart: it stays overflow (allocation rule 6). A second run finds nothing to do.
8. The coordinator row (`coordinator`, Basil) becomes `characters.basil`. A coordinator session
   is recorded only once `coordinator.json` names its transcript, through `startSession` with
   `kind: "coordinator"`. Until then Basil shows unknown.
9. Helpers were never persisted, so there is nothing to migrate for them.

The startup order for 09.3:

1. read the book, and `migrateLegacy` into it (or into a new one when there is none). This opens
   the restore pass. A caller that skips it must call `beginRestore`, or restore order decides
   allocation again;
2. back up, only if step 1 appended a migration entry (rule 1);
3. `restoreSession` each transcript, with its start time, on as many refreshes as the reattach
   window needs. A session a hook starts meanwhile goes through `startSession` and waits for its
   character too (rule 10);
4. `reconcileAfterRestore`, once the pass is complete (rule 7);
5. write the book atomically. Publish no `CrewSnapshot` before this, so no client sees a session
   without the character it is about to get;
6. then `startSession` for new sessions as they appear. A transcript found later goes through
   `startSession` if it is live and `restoreSession` if it has ended.

## Snapshot the UI reads (`CrewSnapshot`)

09.3 publishes it as `OfficeSnapshot.workflow.crew` (add `crew?: CrewSnapshot` to `WorkflowInfo`).

- `characters: CrewCharacterView[]`: Basil plus every recorded character, in pool order. Each view
  has:
  - `id`, `family`, `name` (the custom name, else the catalogue name), `job`, `look`;
  - `accent` (`crewColor`: the custom colour, else the variant accent, else `FAMILY_COLOR`; never
    null), `customized`, `retired`;
  - `state` and `stateSince`. `stateSince` is server time: the poll on which `deriveCrewState`
    first returned this state for this character. 09.3 keeps it in memory and does not persist it.
    After a restart it is the record's `availableSince` (else `firstSeen`) for `available`, the
    session's `endedAt` for `finished`, and the first poll for every other state;
  - `badge`, from `CREW_STATE_BADGE`: `assigned` → `starting`, `waiting` → `waiting`, `needs-you` →
    `needs-you`, `unknown` → `unknown`, and no badge for `available`, `working` or `finished`. The
    reason is the Feature 06 attention reason when there is one, else null. The badge also carries
    the ticket;
  - `sessionId`, `ticket`, `stage`, `role`;
  - `telemetry` (the session's own readings, or null);
  - `lastOutcome`.
- `current: CrewSessionView[]`: live sessions, overflow included, oldest first.
- `history: CrewSessionView[]`: ended sessions, newest first. This is what Settings → History
  shows instead of `config.team` rows.
- `overflow: string[]`: ids of live sessions that have no character.

A `CrewSessionView` is a `CrewSession` plus `characterName` and `state`.

### Transporter (decision for 09.5)

`crewFloorChanges(prev, next)` is the arrival and departure trigger. It is the same rule for both art
styles and for sound.

- A character is on the floor (`crewOnFloor`) when it is listed and not retired. A retired one stays
  on the floor while it still holds, or has just finished, a session.
- An **arrival** is a character that comes on the floor between two snapshots of one connection.
  That happens when its first session creates its record, or when it is un-retired.
- A **departure** is one that leaves the floor, which means it is retired and its session has
  finished. "Removal" in Feature 09 is retirement: records are never deleted.
- `prev` is the snapshot the client last drew. It is `null` for the first snapshot after a connect,
  reconnect or server restart, and that gives nothing. So no arrival or cue is ever replayed, and
  characters recorded by migration or the restore pass simply appear in place.
- A session ending never beams a robot out. Basil never uses the transporter.
- Overflow sessions have no robot (rule 6), so they never arrive or depart.

## Not decided here

- Station coordinates, poses and the overflow layout belong to 09.5. Sprites belong to 09.2.
- What counts as a real gate, permission request or question belongs to Feature 06 (06.1).
- Role source and evidence belong to Feature 07.
