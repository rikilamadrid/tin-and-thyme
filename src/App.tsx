import { useEffect } from "react";
import { cueLog, startCues } from "./audio/cues";
import { beamLog } from "./galley/GalleyCanvas";
import { FIXTURE_LABEL } from "./data/fixture/busyFixture";
import { GalleyCanvas } from "./galley/GalleyCanvas";
import { connectOffice, useOffice } from "./store/office";
import { ui, useUi } from "./store/ui";
import { DebugPanel } from "./ui/DebugPanel";
import { DrawerHost } from "./ui/drawers/Drawer";
import { ActivityFeed } from "./ui/hud/ActivityFeed";
import { ConnectionBanner } from "./ui/hud/ConnectionBanner";
import { SetupChecklist } from "./ui/setup/SetupChecklist";
import { WelcomeModal } from "./ui/setup/WelcomeModal";
import { CREW_W, CrewPanel } from "./ui/hud/CrewPanel";
import { useDrawerLayout } from "./ui/drawers/dock";
import { Tooltip } from "./ui/hud/Tooltip";
import { TopBar } from "./ui/hud/TopBar";
import { SettingsModal } from "./ui/settings/SettingsModal";

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keys from inputs or the terminal.
      if (el && (el.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.key === "Escape" && el.closest(".xterm")) el.blur();
        return;
      }
      const { settings, drawer, setupOpen } = useUi.getState();
      if (e.key === "Escape") {
        if (setupOpen) ui.closeSetup();
        else if (settings) ui.closeSettings();
        else if (drawer) ui.closeDrawer();
        return;
      }
      if (settings || setupOpen) return;
      let handled = true;
      if (e.key === "d" || e.key === "D") ui.toggleDebug();
      else if (e.key === "+" || e.key === "=") ui.zoom(1);
      else if (e.key === "-") ui.zoom(-1);
      else if (/^[1-9]$/.test(e.key)) {
        const team = useOffice.getState().snap?.config.team ?? [];
        const agent = team[Number(e.key) - 1];
        if (agent) ui.openAgent(agent.id);
      } else handled = false;
      // The drawer focuses its terminal; don't let this key land in it too.
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** On a real HQ, open the setup checklist once (after the welcome) if anything needed is missing. */
function useSetupPrompt() {
  useEffect(() => {
    let shown = false;
    return useOffice.subscribe((s) => {
      if (shown || !s.live || !s.snap || s.snap.welcome) return;
      // A workflow project runs its agents in Local mode: sandbox checks are not setup it needs.
      if (s.snap.workflow) return;
      shown = true;
      const needed = s.snap.setup.checks.some((c) => c.status !== "ok" && c.neededFor !== "github" && c.neededFor !== "local");
      if (needed) ui.openSetup();
    });
  }, []);
}

export function App() {
  const dock = useDrawerLayout();
  useEffect(() => {
    startCues(); // before connecting, so the first snapshot is the silent baseline
    // Fixtures expose the chosen cues so a check can confirm what played and what stayed silent.
    const fixture = useOffice.getState().fixture;
    if (fixture) {
      (window as unknown as { __thepassCues: typeof cueLog }).__thepassCues = cueLog;
      (window as unknown as { __thepassBeams: typeof beamLog }).__thepassBeams = beamLog;
      document.title = `Tin & Thyme · Fixture: ${FIXTURE_LABEL[fixture]}`;
    }
    return connectOffice();
  }, []);
  useKeyboard();
  useSetupPrompt();
  const ready = useOffice((s) => s.snap !== null);
  const setupOpen = useUi((s) => s.setupOpen);
  const welcome = useOffice((s) => s.live && !!s.snap?.welcome);

  return (
    <>
      <GalleyCanvas left={16 + CREW_W + 16} right={dock.docked ? dock.width + 32 : 16} />
      <ConnectionBanner />
      {ready && (
        <>
          <TopBar />
          <CrewPanel />
          <ActivityFeed />
          <DrawerHost />
          <DebugPanel />
          <SettingsModal />
          {welcome ? <WelcomeModal /> : setupOpen && <SetupChecklist />}
          <Tooltip />
        </>
      )}
    </>
  );
}
