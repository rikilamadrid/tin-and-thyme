import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CREW_W } from "../hud/CrewPanel";
import { useDrawerLayout } from "./dock";
import { DRAWER_DEFAULT, ui, useUi } from "../../store/ui";
import { AgentDrawer } from "./AgentDrawer";
import { BoardsDrawer } from "./BoardsDrawer";
import { EnvironmentDrawer } from "./EnvironmentDrawer";
import { PrDrawer } from "./PrDrawer";
import { ActionItemsDrawer } from "./ActionItemsDrawer";
import { TerminalDrawer } from "./TerminalDrawer";
import { DeliveryDrawer } from "./DeliveryDrawer";

export function DrawerHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b-[3px] border-line px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      <MaximizeButton />
      <button className="btn px-2.5" aria-label="Close" onClick={() => ui.closeDrawer()}>
        ✕
      </button>
    </div>
  );
}

function MaximizeButton() {
  const max = useUi((s) => s.drawerMaximized);
  const label = max ? "Restore size" : "Maximize";
  return (
    <button className="btn grid h-[30px] w-[34px] place-items-center px-0" aria-label={label} title={label} aria-pressed={max} onClick={() => ui.toggleDrawerMaximized()}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        {max ? (
          <>
            <rect x="1" y="4" width="9" height="9" />
            <path d="M4 4V1h9v9h-3" />
          </>
        ) : (
          <rect x="1" y="1" width="12" height="12" />
        )}
      </svg>
    </button>
  );
}

/**
 * The drawer's left edge: drag to resize (the width is remembered in this browser), double-click
 * for the default width. Pointer capture keeps the drag going over the terminal's canvas.
 */
function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width: aside.getBoundingClientRect().width };
    document.body.style.userSelect = "none";
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current) ui.setDrawerWidth(start.current.width + (start.current.x - e.clientX));
  };
  const up = () => {
    start.current = null;
    document.body.style.userSelect = "";
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize. Double-click to reset."
      className="group absolute -left-[9px] top-0 z-10 flex h-full w-[12px] cursor-col-resize justify-center"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => ui.setDrawerWidth(DRAWER_DEFAULT)}
    >
      <div className="my-auto h-12 w-[4px] bg-ink opacity-0 transition-opacity group-hover:opacity-60" />
    </div>
  );
}

export function DrawerHost() {
  const drawer = useUi((s) => s.drawer);
  const reduce = useReducedMotion();
  const width = useUi((s) => s.drawerWidth);
  const maximized = useUi((s) => s.drawerMaximized);
  const { docked } = useDrawerLayout();
  // Escape closes an overlay drawer, except while typing in a terminal or a field (Escape belongs to them).
  useEffect(() => {
    if (!drawer || docked || drawer.kind === "boards") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest(".xterm, input, textarea, select, [contenteditable]")) return;
      ui.closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, docked]);
  const key = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind === "env" ? `env:${drawer.name}` : drawer.kind === "delivery" ? `delivery:${drawer.key}` : drawer.kind) : null;

  // The task board needs room for its columns: it opens as a large centered modal, not a side drawer.
  if (drawer?.kind === "boards")
    return (
      <div
        className="fixed inset-0 z-30 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Boards"
        onMouseDown={(e) => e.target === e.currentTarget && ui.closeDrawer()}
      >
        <motion.div
          initial={reduce ? false : { y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="panel flex h-[90vh] w-[90vw] flex-col"
        >
          <BoardsDrawer initialBoardId={drawer.boardId} />
        </motion.div>
      </div>
    );

  return (
    <>
      {/* Overlay mode (narrow window or maximized): a dim backdrop over the scene; click it or press Escape to close. */}
      {drawer && !docked && (
        <div className="fixed bottom-0 right-0 top-[66px] z-[15] bg-[rgba(5,7,15,0.55)]" style={{ left: 16 + CREW_W }} aria-hidden onMouseDown={() => ui.closeDrawer()} />
      )}
    <AnimatePresence mode="wait">
      {drawer && (
        <motion.aside
          key={key}
          initial={reduce ? false : { x: "110%" }}
          animate={{ x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: "110%" }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.3, 0, 0.2, 1] }}
          className={`panel fixed bottom-4 right-4 top-[74px] z-20 flex flex-col ${maximized ? "left-4" : ""}`}
          style={maximized ? undefined : { width: `min(${width}px, calc(100vw - 32px))` }}
          aria-label="Details"
        >
          {!maximized && <ResizeHandle />}
          {drawer.kind === "agent" && <AgentDrawer id={drawer.id} initialTab={drawer.tab} />}
          {drawer.kind === "prs" && <PrDrawer />}
          {drawer.kind === "actions" && <ActionItemsDrawer />}
          {drawer.kind === "env" && <EnvironmentDrawer name={drawer.name} />}
          {drawer.kind === "terminal" && <TerminalDrawer />}
          {drawer.kind === "delivery" && <DeliveryDrawer deliveryKey={drawer.key} />}
        </motion.aside>
      )}
    </AnimatePresence>
    </>
  );
}
