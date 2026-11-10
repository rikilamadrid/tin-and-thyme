import { useUi } from "../../store/ui";

export function Tooltip() {
  const hover = useUi((s) => s.hover);
  if (!hover) return null;
  return (
    <div
      className="pointer-events-none fixed z-30 max-w-[340px] border-2 border-line bg-cream px-2 py-0.5 text-[14px] shadow-[0_3px_0_rgba(36,26,46,0.45)]"
      style={{ left: hover.x + 14, top: hover.y + 16 }}
    >
      <div className="font-semibold">{hover.title}</div>
      {hover.sub && <div className="truncate text-[13px] text-muted">{hover.sub}</div>}
    </div>
  );
}
