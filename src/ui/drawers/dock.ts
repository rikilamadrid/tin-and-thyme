import { useSyncExternalStore } from "react";
import { useUi } from "../../store/ui";
import { CREW_W } from "../hud/CrewPanel";

/** The galley's minimum width beside a docked drawer: below this the café, scanner and MAIN get cramped. */
export const GALLEY_MIN = 560;
const GAP = 16;

const subscribe = (fn: () => void) => {
  window.addEventListener("resize", fn);
  return () => window.removeEventListener("resize", fn);
};
const useWindowWidth = () => useSyncExternalStore(subscribe, () => window.innerWidth);

/**
 * Where the side drawer goes. With room for the crew rail, a GALLEY_MIN galley and the drawer, it docks
 * on the right in its own column and the galley fits the centre. Otherwise (or maximized) it overlays.
 */
export function useDrawerLayout(): { open: boolean; docked: boolean; width: number } {
  const drawer = useUi((s) => s.drawer);
  const maximized = useUi((s) => s.drawerMaximized);
  const wanted = useUi((s) => s.drawerWidth);
  const ww = useWindowWidth();
  const open = !!drawer && drawer.kind !== "boards";
  const width = Math.min(wanted, ww - 2 * GAP);
  const centre = ww - (GAP + CREW_W + GAP) - (width + GAP) - GAP;
  return { open, docked: open && !maximized && centre >= GALLEY_MIN, width };
}
