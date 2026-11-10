import { CUES, playCue, unlockAudio } from "../../audio/sfx";
import { prefs, usePrefs } from "../../store/prefs";

/** Settings → Audio. Off by default; saved in this browser only. Every cue also has a visual signal. */
export function AudioSettings() {
  const on = usePrefs((s) => s.sound);
  const toggle = () => {
    const next = !on;
    prefs.setSound(next);
    // The browser starts audio only from a user action: this click is it.
    if (next) unlockAudio();
  };
  return (
    <div className="flex max-w-[680px] flex-col gap-4">
      <div>
        <h3 className="m-0 text-[18px] font-bold">Sound effects</h3>
        <p className="m-0 mt-1 text-[13px] text-muted">
          Short sounds for real workflow events, synthesized in this browser. Loading the page, reconnecting and switching art styles stay silent. Saved in this browser; off by
          default. Everything a sound announces is also shown in the galley, the roster and Activity.
        </p>
      </div>
      <label className={`flex cursor-pointer items-center gap-3 border-[3px] px-3 py-2.5 ${on ? "border-[#ffc93a] bg-[#1a2448]" : "border-line bg-cream"}`}>
        <input type="checkbox" role="switch" checked={on} onChange={toggle} className="h-4 w-4" aria-describedby="sfx-hint" />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">Sound effects {on ? <span className="text-[#ffc93a]">on</span> : <span className="text-muted">off</span>}</div>
          <div id="sfx-hint" className="text-[12px] text-muted">
            One cue per event. When several arrive together, only the most specific plays.
          </div>
        </div>
      </label>
      <div>
        <h4 className="m-0 mb-2 text-[13px] font-extrabold uppercase tracking-[0.08em] text-muted">Cues</h4>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {CUES.map((c) => (
            <li key={c.id} className="flex items-center gap-3 border-[3px] border-line bg-card px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold">{c.label}</div>
                <div className="text-[12px] text-muted">{c.when}</div>
              </div>
              <button
                type="button"
                className="btn px-2.5 text-[13px]"
                disabled={!on}
                title={on ? `Play “${c.label}”` : "Turn sound effects on to hear the cues"}
                onClick={() => playCue(c.id)}
              >
                ▶ Play
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
