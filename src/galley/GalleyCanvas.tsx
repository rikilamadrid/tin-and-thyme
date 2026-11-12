import { useEffect, useRef, useState } from "react";
import type { OfficeSnapshot } from "../data/types";
import { usePrefs } from "../store/prefs";
import { useOffice } from "../store/office";
import { ui, useUi } from "../store/ui";
import { makeBackend } from "./backend";
import { buildGalley, type GalleyModel } from "./model";
import { MarkIcon } from "../ui/hud/CrewPanel";
import { ALERT, BEAM_BUSY_MS, BEAM_MS, drawGalley, HANGOUTS, route, sceneAnimating, SPOTS, targetFor, VIEW, type Actor, type Delivery, type Hit } from "./scene";

const SPEED = 70; // logical units per second
const FRAME_MS = 50;
/** Zoom steps relative to the Fit view. */
const ZOOMS = [1, 1.5, 2, 3];
/** The smallest Fit, in device pixels per logical unit: below it the room clips instead of shrinking further. */
const MIN_FIT = 0.4;
/** Decorative only: how often an off-shift robot wanders to another free hangout. */
const ROAM_MIN_MS = 7000;
const ROAM_SPREAD_MS = 8000;

/** Every beam the transporter ran (or queued), newest last. Read by the fixture checks; never replayed. */
export const beamLog: { at: number; id: string; kind: "in" | "out" }[] = [];

/** The tickets the workflow reports as delivered (integrated / done). */
const deliveredSet = (snap: OfficeSnapshot) => new Set(snap.tasks.filter((t) => (t.pf ? t.pf.state === "integrated" : t.status === "done")).map((t) => t.id));

interface ZoomApi {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

/**
 * Mounts the galley. The art style only picks the backend: the model, the actors
 * (positions, who is walking where), the selection, the zoom and the deliveries
 * live here and survive a style switch untouched. The canvas keeps the Fit size;
 * zooming changes what part of the room it shows, never the page layout.
 */
export function GalleyCanvas({ left, right }: { left: number; right: number }) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<ZoomApi | null>(null);
  const [zoomIdx, setZoomIdx] = useState(0);

  useEffect(() => {
    const el = host.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!el || !canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let model: GalleyModel | null = null;
    let epoch = -1;
    let delivered: Set<string> | null = null;
    /** Each cook's pod, kept so a departure never shuffles the rest of the line. */
    const podOf = new Map<string, number>();
    /** When the transporter is next free: beams queue up, one at a time, and run shorter when they do. */
    let tubeFree = 0;
    const slot = (now: number, kind: "in" | "out", id: string) => {
      beamLog.push({ at: Date.now(), id, kind });
      if (beamLog.length > 100) beamLog.shift();
      const t0 = Math.max(now, tubeFree);
      const dur = t0 > now ? BEAM_BUSY_MS : BEAM_MS;
      tubeFree = t0 + dur;
      return { kind, t0, dur };
    };
    const actors = new Map<string, Actor>();
    const spotOf = new Map<string, number>();
    const deliveries: Delivery[] = [];
    let hits: Hit[] = [];
    let scale = 1; // canvas pixels per logical unit in the Fit view
    let zi = 0;
    /** Fit's logical rectangle: VIEW, extended to the canvas's shape (centred across, a little high). */
    let bounds = { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h };
    /** Centre of the shown rectangle, in logical units. Kept across refits (drawer opening, window resize). */
    let cx = VIEW.x + VIEW.w / 2;
    let cy = VIEW.y + VIEW.h / 2;
    let dirty = true;
    let last = performance.now();
    let lastDraw = 0;
    let raf = 0;
    let hoverId: string | null = null;
    let nextRoam = performance.now() + ROAM_MIN_MS;

    const style = () => usePrefs.getState().artStyle;
    /** The scale actually drawn at, and the logical rectangle shown. */
    const view = () => {
      const z = ZOOMS[zi];
      const s = z === 1 ? scale : style() === "pixel" ? Math.max(Math.ceil(scale), Math.round(scale * z)) : scale * z;
      const w = canvas.width / s;
      const h = canvas.height / s;
      return { s, x: cx - w / 2, y: cy - h / 2, w, h };
    };
    /** Zoomed in, the view stays inside what Fit shows; at Fit it is exactly that. */
    const clampPan = () => {
      if (zi === 0) {
        cx = bounds.x + bounds.w / 2;
        cy = bounds.y + bounds.h / 2;
        return;
      }
      const v = view();
      cx = Math.min(Math.max(cx, bounds.x + v.w / 2), bounds.x + bounds.w - v.w / 2);
      cy = Math.min(Math.max(cy, bounds.y + v.h / 2), bounds.y + bounds.h - v.h / 2);
    };
    const setZoom = (next: number) => {
      zi = Math.min(ZOOMS.length - 1, Math.max(0, next));
      clampPan();
      setZoomIdx(zi);
      canvas.style.cursor = zi ? "grab" : "default";
      dirty = true;
    };
    api.current = { zoomIn: () => setZoom(zi + 1), zoomOut: () => setZoom(zi - 1), fit: () => setZoom(0) };

    /** Off-shift crew keep their hangout; newcomers take the first free one (couch, then stools, then floor). */
    const assignSpots = (m: GalleyModel) => {
      const lounge = new Set(m.lounge.map((c) => c.id));
      for (const id of [...spotOf.keys()]) if (!lounge.has(id)) spotOf.delete(id);
      const taken = new Set(spotOf.values());
      for (const c of m.lounge) {
        if (spotOf.has(c.id)) continue;
        const free = HANGOUTS.findIndex((_, i) => !taken.has(i));
        if (free < 0) break; // more crew than hangouts: counted on the lounge sign
        spotOf.set(c.id, free);
        taken.add(free);
      }
    };

    const sync = (snap: OfficeSnapshot | null) => {
      if (!snap) return;
      // A first paint or a fresh snapshot (refresh, reconnect) shows the crew where it is: nothing replays.
      const ep = useOffice.getState().epoch;
      const first = model === null || ep !== epoch;
      epoch = ep;
      const before = model;
      model = buildGalley(snap, podOf);
      podOf.clear();
      model.pods.forEach((p, i) => p.kind === "cook" && podOf.set(p.member.id, i));
      assignSpots(model);
      const now = performance.now();
      const seen = new Set<string>();
      for (const c of model.crew) {
        const t = targetFor(model, c, spotOf);
        const a = actors.get(c.id);
        const workflow = !!c.config.crew?.session;
        if (!a) {
          // A finished session we never saw on the floor stays in its ticket's history only.
          if (c.place === "gone") continue;
          seen.add(c.id);
          const wasHere = before?.crew.some((x) => x.id === c.id && x.running);
          if (first || reduce || t.x < 0 || c.isLead || wasHere) {
            actors.set(c.id, { x: t.x, y: t.y, moving: false, seated: t.seated, alpha: c.running || c.place === "lounge" ? 1 : 0.45 });
          } else if (workflow && c.running) {
            // An observed session start: it beams in through the transporter, then walks to its station.
            actors.set(c.id, { x: SPOTS.tube.x, y: SPOTS.tube.y, moving: false, seated: false, alpha: 1, beam: slot(now, "in", c.id) });
          } else {
            actors.set(c.id, { x: SPOTS.door.x, y: SPOTS.door.y, moving: false, seated: false, alpha: 1 });
          }
          continue;
        }
        seen.add(c.id);
        if (c.place === "gone" && (first || reduce)) {
          // Ended while we weren't watching, or reduced motion: it simply isn't on the floor any more.
          actors.delete(c.id);
          continue;
        }
        a.alpha = c.isLead && !c.running ? 0.45 : 1;
      }
      for (const id of [...actors.keys()]) if (!seen.has(id)) actors.delete(id);
      // Deliveries into MAIN: only a ticket the workflow newly reports as integrated, never the history.
      const done = deliveredSet(snap);
      if (delivered && !first) for (const id of done) if (!delivered.has(id)) deliveries.push({ ticket: id, t0: performance.now() });
      delivered = done;
      dirty = true;
    };

    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      const cw = Math.max(1, Math.round(r.width * dpr));
      const ch = Math.max(1, Math.round(r.height * dpr));
      const fitScale = Math.min(cw / VIEW.w, ch / VIEW.h);
      const pixel = style() === "pixel";
      // Pixel art never draws below one device pixel per logical unit: whole rows of art would drop out and
      // sprites would round up past their neighbours. When the window is smaller than that, it draws at 1 on
      // a larger canvas, and the browser scales the whole picture down smoothly to fit.
      const shrink = pixel && fitScale < 1 ? Math.max(MIN_FIT, fitScale) : 1;
      // Otherwise pixel art prefers a whole-number scale (every pixel equal); when that would leave more
      // than a tenth of the space empty, it takes the exact fit and snaps each edge to a device pixel.
      const whole = Math.floor(fitScale);
      scale = pixel ? (shrink < 1 ? 1 : whole >= 1 && fitScale / whole <= 1.1 ? whole : fitScale) : Math.max(MIN_FIT, fitScale);
      canvas.width = Math.round(cw / shrink);
      canvas.height = Math.round(ch / shrink);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      canvas.style.imageRendering = pixel && shrink === 1 ? "pixelated" : "auto";
      // Spare room goes evenly left and right, and mostly below, so the kitchen sits close to the toolbar.
      const bw = canvas.width / scale;
      const bh = canvas.height / scale;
      bounds = { x: VIEW.x - (bw - VIEW.w) / 2, y: VIEW.y - (bh - VIEW.h) * 0.25, w: bw, h: bh };
      clampPan();
      dirty = true;
    };

    /** Decoration: now and then one parked off-shift robot rolls to another free hangout. Never with reduced motion. */
    const roam = (now: number) => {
      if (reduce || !model || now < nextRoam) return;
      nextRoam = now + ROAM_MIN_MS + Math.random() * ROAM_SPREAD_MS;
      const parked = model.lounge.filter((c) => spotOf.has(c.id) && !actors.get(c.id)?.moving);
      const taken = new Set(spotOf.values());
      const free = HANGOUTS.map((_, i) => i).filter((i) => !taken.has(i));
      if (!parked.length || !free.length) return;
      const who = parked[Math.floor(Math.random() * parked.length)];
      spotOf.set(who.id, free[Math.floor(Math.random() * free.length)]);
    };

    const step = (dt: number, now: number) => {
      if (!model) return false;
      let moving = false;
      for (const c of model.crew) {
        const a = actors.get(c.id);
        if (!a) continue;
        if (a.beam) {
          if (now < a.beam.t0 + a.beam.dur) {
            moving = true; // keep drawing at full rate while a beam runs or waits its turn
            continue;
          }
          if (a.beam.kind === "out") {
            actors.delete(c.id);
            dirty = true;
            continue;
          }
          a.beam = null;
        }
        const t = targetFor(model, c, spotOf);
        if (t.x < 0) {
          a.x = -1;
          a.y = -1;
          a.moving = false;
          a.seated = false;
          continue;
        }
        if (a.x < 0) {
          a.x = SPOTS.door.x;
          a.y = SPOTS.door.y;
        }
        const goal = `${t.x},${t.y}`;
        if (a.goal !== goal) {
          a.goal = goal;
          a.path = reduce ? [{ x: t.x, y: t.y }] : route(a, t);
        }
        const next = a.path?.[0] ?? t;
        const dx = next.x - a.x;
        const dy = next.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.5 || reduce) {
          a.x = next.x;
          a.y = next.y;
          a.path?.shift();
          if (a.path?.length) {
            a.moving = true;
            moving = true;
            continue;
          }
          a.moving = false;
          a.seated = t.seated;
          // A finished session that reached the tube beams out (with reduced motion it just leaves).
          if (c.place === "gone") {
            if (reduce) actors.delete(c.id);
            else a.beam = slot(now, "out", c.id);
            moving = true;
          }
        } else {
          const k = Math.min(1, (SPEED * dt) / d);
          a.x += dx * k;
          a.y += dy * k;
          a.moving = true;
          a.seated = false;
          moving = true;
        }
      }
      return moving;
    };

    const draw = (now: number) => {
      if (!model) return;
      const v = view();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const B = makeBackend(style(), ctx, v.s, v.x, v.y);
      const drawer = useUi.getState().drawer;
      const selected = drawer?.kind === "agent" ? drawer.id : null;
      while (deliveries.length && now - deliveries[0].t0 > 7000) deliveries.shift();
      hits = drawGalley(B, model, { now, actors, selected, hover: hoverId, deliveries, spotOf, reduce, view: { x: v.x, y: v.y, w: v.w, h: v.h } });
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      roam(now);
      const moving = step(dt, now);
      // Busy scenes (walking, a delivery, a live scan) run at full rate; idle ones tick slowly.
      const busy = moving || deliveries.length > 0 || (!reduce && !!model && sceneAnimating(model));
      const wantMs = busy ? FRAME_MS : reduce ? 1000 : 250;
      if (dirty || now - lastDraw >= wantMs) {
        draw(now);
        lastDraw = now;
        dirty = false;
      }
    };

    const toLogical = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      const v = view();
      return { x: v.x + ((e.clientX - r.left) / r.width) * v.w, y: v.y + ((e.clientY - r.top) / r.height) * v.h };
    };
    const hitAt = (e: MouseEvent) => {
      const p = toLogical(e);
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return h;
      }
      return null;
    };

    // Drag to pan when zoomed in. A drag never counts as a click.
    let press: { x: number; y: number; cx: number; cy: number } | null = null;
    let dragged = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || zi === 0) return;
      press = { x: e.clientX, y: e.clientY, cx, cy };
      dragged = false;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (press) {
        const dx = e.clientX - press.x;
        const dy = e.clientY - press.y;
        if (!dragged && Math.hypot(dx, dy) > 4) {
          dragged = true;
          canvas.style.cursor = "grabbing";
          ui.setHover(null);
        }
        if (dragged) {
          const r = canvas.getBoundingClientRect();
          const v = view();
          cx = press.cx - (dx / r.width) * v.w;
          cy = press.cy - (dy / r.height) * v.h;
          clampPan();
          dirty = true;
          return;
        }
      }
      const h = hitAt(e);
      canvas.style.cursor = h && h.kind !== "main" && h.kind !== "helper" ? "pointer" : zi ? "grab" : "default";
      hoverId = h?.id ?? null;
      ui.setHover(h ? { title: h.title, sub: h.sub, x: e.clientX, y: e.clientY } : null);
    };
    const onUp = () => {
      press = null;
      if (dragged) canvas.style.cursor = "grab";
    };
    const onLeave = () => ui.setHover(null);
    const onClick = (e: MouseEvent) => {
      if (dragged) {
        dragged = false;
        return;
      }
      const h = hitAt(e);
      if (!h) return;
      if (h.kind === "agent" && h.id) ui.openAgent(h.id);
      else if (h.kind === "board") ui.openBoards();
      else if (h.kind === "needs") ui.openActions();
      else if (h.kind === "pass") ui.openBoards();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    sync(useOffice.getState().snap);
    const unsubOffice = useOffice.subscribe((s, prev) => s.snap !== prev.snap && sync(s.snap));
    const unsubPrefs = usePrefs.subscribe((s, prev) => s.artStyle !== prev.artStyle && fit());
    const unsubUi = useUi.subscribe((s, prev) => {
      if (s.drawer !== prev.drawer) dirty = true;
    });
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubOffice();
      unsubPrefs();
      unsubUi();
      api.current = null;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  const style = usePrefs((s) => s.artStyle);
  const project = useOffice((s) => s.snap?.config.project.name ?? "");
  const look = style === "pixel" ? "rounded-[3px] shadow-[0_2px_0_#05070f]" : "rounded-[8px] shadow-[0_1px_6px_rgba(0,0,0,0.35)]";
  const btn = `grid h-[26px] min-w-[28px] cursor-pointer place-items-center bg-[#141d3a] px-2 font-[system-ui] text-[13px] font-extrabold text-[#eef6ff] ring-1 ring-[#26335c] hover:bg-[#1a2448] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffc93a] ${look}`;
  return (
    <div className="fixed bottom-4 top-[74px] flex flex-col gap-1.5 font-[system-ui]" style={{ left, right }}>
      <div className="flex h-[28px] shrink-0 items-center gap-2 px-1 text-[#eef6ff]">
        <b className="text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">Space Galley</b>
        {project && <span className="truncate text-[12px] font-semibold text-[#7f8bb5]">· {project}</span>}
        <div className="flex-1" />
        <div role="group" aria-label="Galley zoom" className="flex items-center gap-1">
          <button type="button" className={btn} aria-label="Zoom out" title="Zoom out" disabled={zoomIdx === 0} onClick={() => api.current?.zoomOut()}>
            −
          </button>
          <span className="min-w-[36px] text-center text-[12px] font-extrabold tabular-nums text-[#a8b8d8]" aria-live="polite">
            {zoomIdx === 0 ? "" : `${ZOOMS[zoomIdx]}×`}
          </span>
          <button type="button" className={btn} aria-label="Zoom in" title="Zoom in (drag to pan)" disabled={zoomIdx === ZOOMS.length - 1} onClick={() => api.current?.zoomIn()}>
            +
          </button>
          <button type="button" className={btn} aria-label="Fit the galley to the window" title="Fit" aria-pressed={zoomIdx === 0} onClick={() => api.current?.fit()}>
            Fit
          </button>
        </div>
      </div>
      <div ref={host} className={`relative min-h-0 flex-1 overflow-hidden bg-[#05070f] ring-1 ring-[#1a2340] ${style === "pixel" ? "rounded-[4px]" : "rounded-[10px]"}`}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block"
          role="img"
          aria-label={`Tin & Thyme — Space Galley (${style === "pixel" ? "detailed pixel art" : "cel-shaded"}). The crew roster lists the same agents as text.`}
        />
      </div>
      <GalleyLegend />
    </div>
  );
}

/** What the marks in the room mean, right under it. */
function GalleyLegend() {
  const items: [Parameters<typeof MarkIcon>[0]["k"], string, string][] = [
    ["needs", ALERT, "Needs you"],
    ["work", "#eef6ff", "Cooking"],
    ["review", "#eef6ff", "At the scanner"],
    ["wait", "#a8b8d8", "Waiting for its next session"],
    ["idle", "#a8b8d8", "No live session"],
  ];
  return (
    <footer aria-label="Legend" className="flex h-[22px] shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 overflow-hidden px-1 text-[11px] font-semibold text-[#a8b8d8]">
      {items.map(([k, color, label]) => (
        <span key={label} className="flex items-center gap-1">
          <MarkIcon k={k} color={color} /> {label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <i className="inline-block h-[10px] w-[6px] rounded-[2px] bg-[#38d9c9]" aria-hidden /> Transporter: sessions beam in and out
      </span>
      <span className="text-[#7f8bb5]">· Drag to pan when zoomed in</span>
    </footer>
  );
}
