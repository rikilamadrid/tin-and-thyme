import type { CharacterId } from "../../data/crew";
import { RobotPortrait } from "../../galley/RobotPortrait";
import { ART_STYLES, prefs, usePrefs } from "../../store/prefs";

const PREVIEW: CharacterId[] = ["basil", "pepper", "roux", "dash", "pinch"];

/** Settings → Appearance. Saved in this browser only; the running session is untouched. */
export function AppearanceSettings() {
  const style = usePrefs((s) => s.artStyle);
  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div>
        <h3 className="m-0 text-[18px] font-bold">Art style</h3>
        <p className="m-0 mt-1 text-[13px] text-muted">
          Redraws the same galley and crew right away. The layout, the controls and the workflow state are the same in both. Saved in this browser.
        </p>
      </div>
      <div role="radiogroup" aria-label="Art style" className="flex flex-col gap-2">
        {ART_STYLES.map((s) => (
          <label key={s.id} className={`flex cursor-pointer items-center gap-3 border-[3px] px-3 py-2 ${style === s.id ? "border-[#ffc93a] bg-[#1a2448]" : "border-line bg-cream"}`}>
            <input type="radio" name="art-style" value={s.id} checked={style === s.id} onChange={() => prefs.setArtStyle(s.id)} className="h-4 w-4" />
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold">
                {s.label}
                {s.id === "pixel" && <span className="ml-2 text-[12px] font-normal text-muted">default</span>}
              </div>
              <div className="text-[12px] text-muted">{s.hint}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="flex gap-2 rounded-[6px] bg-[#0c1226] p-2" aria-label="Preview">
        {PREVIEW.map((c) => (
          <RobotPortrait key={c} character={c} size={56} />
        ))}
      </div>
    </div>
  );
}
