// Shared production projection. Fixtures use this same projection; only their observations are synthetic.
import { CREW_CHARACTERS } from "./crew";
import { compareSessionAge, CREW_STATE_BADGE, crewColor, crewName, deriveCrewState, FAMILY_POOLS, type CrewBook, type CrewCharacterId, type CrewCharacterView, type CrewObservation, type CrewSession, type CrewSessionView, type CrewSnapshot, type CrewState } from "./crewContract";

export function crewSnapshot(book: CrewBook, observations: Record<string, CrewObservation>, now: number, states: Map<CrewCharacterId, { state: CrewState; since: string }> = new Map()): CrewSnapshot {
  const sessions = Object.values(book.sessions);
  const view = (s: CrewSession): CrewSessionView => ({
    ...s,
    characterName: s.characterId ? crewName(s.characterId, book.characters[s.characterId]) : null,
    state: deriveCrewState(s, observations[s.id] ?? null, now),
  });
  const characters = Object.values(FAMILY_POOLS).flat().flatMap((id): CrewCharacterView[] => {
    const rec = book.characters[id];
    if (!rec) return [];
    const session = (rec.sessionId ? book.sessions[rec.sessionId] : null) ?? (rec.lastSessionId ? book.sessions[rec.lastSessionId] : null) ?? null;
    const obs = session ? observations[session.id] ?? null : null;
    const state = deriveCrewState(session, obs, now, id);
    const shown = state === "available" ? null : session;
    const badge = CREW_STATE_BADGE[state];
    const lastEnded = sessions.filter((s) => s.characterId === id && s.phase === "ended").sort((a, b) => b.seq - a.seq)[0] ?? null;
    const previous = states.get(id);
    const since = previous?.state === state ? previous.since : state === "available" ? rec.availableSince ?? rec.firstSeen : state === "finished" && session?.endedAt ? session.endedAt : new Date(now).toISOString();
    states.set(id, { state, since });
    return [{
      id,
      family: rec.family,
      name: crewName(id, rec),
      job: CREW_CHARACTERS[id].job,
      look: CREW_CHARACTERS[id].look,
      accent: crewColor(id, rec),
      customized: rec.name !== null || rec.color !== null,
      retired: rec.retired,
      state,
      stateSince: since,
      badge: badge ? { kind: badge, reason: obs?.attention?.reason ?? null, ticket: shown?.ticket ?? null } : null,
      sessionId: shown?.id ?? null,
      ticket: shown?.ticket ?? null,
      stage: shown?.stage ?? null,
      role: shown?.role ?? null,
      telemetry: shown?.telemetry ?? null,
      lastOutcome: lastEnded?.end?.outcome ?? null,
    }];
  });
  const current = sessions.filter((s) => s.phase === "live").sort(compareSessionAge).map(view);
  const history = sessions
    .filter((s) => s.phase === "ended")
    .sort((a, b) => (Date.parse(b.endedAt ?? "") || 0) - (Date.parse(a.endedAt ?? "") || 0) || b.seq - a.seq)
    .map(view);
  return { version: book.version, characters, current, history, overflow: current.filter((s) => s.characterId === null).map((s) => s.id) };
}

