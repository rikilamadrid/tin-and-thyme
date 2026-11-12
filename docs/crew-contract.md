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
No name repeats, and no name ends in a number.

Parallel families need at least 3 characters each: developer, tester, adversary, helper and
unknown. Orchestrator, planner and integrator never run in parallel and have one character
each.

### Family of a session (`familyFor(role, stage)`)

1. A stage of `adversary` or `helper` wins, as `addWorker` does today.
2. Then the brief's `Role:` (with the aliases dev, engineer, qa, reviewer, lead, coordinator).
3. Then the stage (`STAGE_FAMILY`).
4. Otherwise `unknown`.

The coordinator's sessions are `coordinate`, or `integrate` while it integrates. Both are
orchestrator.

## Sessions

The `CrewSession` id rules are below. A session record is never re-keyed or deleted.

- **Worker or helper:** the Claude Code subagent id. This is the key crew.json and sessions.json use
  today.
- **Coordinator:** `coordinator:<transcript file name without .jsonl>`. Until its transcript is
  known, Basil shows `unknown` and no session record is written.
- `hqId` keeps today's snapshot id: `w-<key>-<session>-<id10>`, `coordinator`, or the helper's id.
- `stage` and `role` are verbatim. Stages that are not known are kept as written.
- `end` reuses `SessionEnd`. Its `outcome` is `handed-off` (success), `gate`, `failed` or
  `interrupted`, and the four stay distinct. A session that ended with no recorded outcome has
  `phase: "ended"` and `end: null`, and shows as "outcome unknown".
- `report` holds a review or adversary verdict (`pass`, `findings`, `gate`) when one was read.
  06.1 classifies it: a review that reported is not `interrupted`.
- `telemetry` (`CrewTelemetry`) belongs to the session. It holds context, model and effort, tokens,
  cost and tool count. A value that is not available is `null`, never 0. The readings freeze when
  the session ends and stay in History. A character that is available shows no readings.

## Lifecycle states (`CrewState`)

States come from observed data only. `deriveCrewState(session, observation, now)` applies these
rules in order:

1. **available**: there is no session, or the session ended more than `FINISHED_LINGER_MS`
   (6 s) ago. The character goes to the lounge, café or stools.
2. **finished**: the session ended less than 6 s ago (the handoff pose).
3. **unknown**: no observation, an observation older than `OBSERVATION_STALE_MS` (2 min), or
   a live session whose process is stopped or failed. It is never shown as idle or working.
4. **needs-you**: Feature 06 attention says there is a real gate, permission request or question.
   The badge names the reason and the ticket.
5. **waiting**: Feature 06 says waiting (workers, tools or dependencies).
6. **assigned**: the process is starting, or running with no tool call yet. The starting badge stays.
7. **working**: running, with the agent working.
8. Anything else while live is **waiting**. That includes `needs-input` that Feature 06 has not
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

Only `available` has no session. Retiring a character (transporter departure) is a flag on the
record, not a state. A session that ends never beams the robot out.

## Allocation invariants (`allocateCharacter(book, family, ticket)`)

1. A character holds at most one live session (`record.sessionId`).
2. Allocation runs **once per new session id**. The result is stored in `CrewSession.characterId`.
   Polls, reconnects and restarts read the stored value and never allocate again, so identity
   stays stable.
3. The orchestrator always gets `basil`. Basil is reserved and is never given to another session.
4. The candidates are the family's own pool, minus characters that are retired or that hold a live
   session. Families never borrow characters from each other.
5. Prefer the candidate whose last session was on the same ticket, so a repair after review goes
   back to the cook who built it. Otherwise take the first candidate in pool order.
6. If there is no candidate, the session is **overflow**: `characterId: null`. It is listed in
   `CrewSnapshot.overflow` and in the compact crew list. There is no numbered copy and no cap on
   real sessions. The pool size is the family's floor bound. 09.5 gives every pool member a work
   spot, or shows the extra ones in the overflow layout.
7. Concurrent sessions always get distinct characters, from 1 and 4 together.
8. Custom names (`crewNameProblem`) must be 1–24 characters, must be unique (trimmed,
   case-insensitive) against every catalogue name and every other custom name, and must not end
   in a number. Renaming changes only the label, never the family or role.

## Crew book (persisted)

The file is `~/.controlroom/<key>/crew-book.json`, the `CrewBook` type, with schema
`tin-and-thyme.crew-book` and **version 1**.

```
{ schema, version: 1, kitchen, updatedAt,
  characters: { <CrewCharacterId>: { id, family, name|null, color|null, sessionId|null,
                                     lastSessionId|null, availableSince|null, firstSeen, retired } },
  sessions:   { <session id>: CrewSession },
  migrations: [ { from, fromVersion, at, backup, imported[], filled[], conflicts[] } ] }
```

- `characters` holds only characters that have held a session or been customized. Basil is
  always present.
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

Rules:

1. **Back up first.** Before the first write of a migration, copy `crew.json`, `sessions.json`,
   `coordinator.json` and any existing `crew-book.json` to `backups/crew-<ISO stamp>/`. Record
   the path in `migrations[].backup`.
2. **Never modify or delete the legacy files.** Deleting `crew-book.json` restarts the migration
   from them.
3. **Key by subagent id only. Never deduplicate by display name.** Each crew.json entry becomes
   one `CrewSession` with:
   - `id` set to the subagent id;
   - `characterId` set to the legacy `id` unchanged ("Pepper 2" becomes `pepper`);
   - `legacy` set to `{ name, job, character }` verbatim;
   - `end` taken from sessions.json, and `phase: "ended"`;
   - `family` set to the legacy character's family, or `unknown` for `unit`.

   Four "Pepper" sessions stay four sessions on the character Pepper.
4. **sessions.json entries with no crew.json entry** become sessions with `characterId: null`.
   They stay in history with the outcome kept.
5. **Fill links on restore.** When the transcript restore (today's `addWorker(…, finished)`)
   sees a session already in the book, it fills only **null** fields: hqId, role, stage, ticket,
   title, worktree, transcript, startedAt and endedAt. It never changes the character. Sessions
   whose transcript is gone keep their record with null links.
6. **Idempotent.** A subagent id already in `sessions` is never imported again. Only its null
   fields may be filled, and those ids are listed in `filled`. Running the migration twice
   leaves the book unchanged apart from `updatedAt`. Until 09.3 stops writing crew.json, every
   start merges any new subagent ids in the same way.
7. **Live conflicts.** If two restored sessions are live on the same legacy character, the one that
   started earlier keeps it. The later one is allocated again under the invariants, gets
   `reassignedFrom` set, and is listed in `conflicts`.
8. The coordinator row (`coordinator`, Basil) becomes `characters.basil`. A coordinator session
   is recorded only once `coordinator.json` names its transcript.
9. Helpers were never persisted, so there is nothing to migrate for them.

## Snapshot the UI reads (`CrewSnapshot`)

09.3 publishes it as `OfficeSnapshot.workflow.crew` (add `crew?: CrewSnapshot` to `WorkflowInfo`).

- `characters: CrewCharacterView[]`: Basil plus every recorded character, in pool order. Each view
  has:
  - `id`, `family`, `name` (the custom name, else the catalogue name), `job`, `look`;
  - `accent` (the custom colour, else the variant accent, else null), `customized`, `retired`;
  - `state` and `stateSince`;
  - `badge` (`starting`, `waiting`, `needs-you` or `unknown`, with a short reason and the ticket);
  - `sessionId`, `ticket`, `stage`, `role`;
  - `telemetry` (the session's own readings, or null);
  - `lastOutcome`.
- `current: CrewSessionView[]`: live sessions, overflow included, oldest first.
- `history: CrewSessionView[]`: ended sessions, newest first. This is what Settings → History
  shows instead of `config.team` rows.
- `overflow: string[]`: ids of live sessions that have no character.

A `CrewSessionView` is a `CrewSession` plus `characterName` and `state`.

## Not decided here

- Station coordinates, poses and the overflow layout belong to 09.5. Sprites belong to 09.2.
- What counts as a real gate, permission request or question belongs to Feature 06 (06.1).
- Role source and evidence belong to Feature 07.
