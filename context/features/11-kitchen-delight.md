# Kitchen Delight

## Status

In Progress

## Goal

A focused product-quality pass on the kitchen. Finished work reads as finished at a glance. Working agents look alive. The scene has more charm (MAIN hatch, head chef, a transport pod, rare ambient surprises). The crew panel can collapse so the kitchen gets more of the screen. This is polish, not a redesign.

## Context

- Human request, 2026-11-17: one urgent UI polish initiative, practical and cohesive, single ticket unless a real delivery-risk boundary appears.
- Current scene, from a `?fixture=busy` capture on main `0e6dd35`:
  - The fridge and water cooler sit in the top band between the office and the lounge. The transporter tube stands below them on the upper aisle.
  - Basil, the head chef, stands still in the office.
  - Cooks stand still at their pods.
  - MAIN is a plain service hatch with a shutter.
  - ORDERS "Served" slips look like the other slips.
  - The crew panel is a fixed column (`CREW_W`).
- Feature 09 rules this work must keep (`09-crew-lifecycle.md` §Transporter, §Telemetry):
  - Arrivals and departures go through the transporter, and a session ending does not beam the robot out.
  - Activity cues follow observed state, and decoration never claims progress.
  - Reduced motion uses static poses, icons and badges.
  - Animations never delay real state.
- Relevant code: `src/galley/scene.ts` (`kitchen`, `headChef`, `hatch`, `orders`, `window`/`space`, `TUBE`/beam), `src/galley/GalleyCanvas.tsx`, `src/ui/hud/CrewPanel.tsx`, `src/App.tsx`, `src/ui/drawers/Drawer.tsx`, `src/ui/drawers/dock.ts`, `src/ui/drawers/BoardsDrawer.tsx`, `src/store/ui.ts`.

## Requirements

1. **Done cue.**
   - A board whose status is Done shows a calm completion mark in the Boards drawer tabs: a green dot or check plus muted text.
   - Served slips on the ORDERS rail read as completed: a check or a muted green treatment.
   - It should be polished, not noisy, and never mistakable for "needs you".
2. **Working cues.**
   - A character whose observed state is working gets a subtle live cue at its station, for example a gentle bob, steam or sparks at the pod, or a blinking console light.
   - The cue is driven only by the existing state; there is no cue for idle, waiting, unknown or finished characters.
   - It never runs constantly when nothing is working, and it is static under reduced motion.
3. **MAIN hatch charm.**
   - More personality while keeping its meaning: for example a marquee or neon "MAIN" sign, small running lights, and a happy flourish when a confirmed merge goes through.
   - The flourish plays only on a real delivery.
4. **Collapsible crew panel.**
   - A clear toggle collapses the crew panel to a slim rail and expands it again.
   - The galley canvas, drawer scrim and dock widen to use the freed space.
   - Keyboard accessible with an accessible label. The choice is remembered per browser with a guarded `localStorage`.
5. **Ambient surprises.**
   - Rare, random, harmless objects drift past the windows or through space: for example a rubber duck, a floating toaster, a comet, or a tiny satellite.
   - At most one at a time, with long random gaps (on the order of minutes) and a short pass.
   - Purely decorative: no hit target, no label, never in front of crew, badges or the belt.
   - Off under reduced motion.
6. **Head chef presence.**
   - Basil gets a relaxed idle: slight sway or breathing, an occasional glance or sip, and a chair or stool at the console so the office reads as a workplace.
   - Needs-you and not-running badges keep priority and positions.
   - Static under reduced motion.
7. **Transport pod.**
   - The fridge and water cooler are removed. The transporter pod moves into that top-band spot and becomes clearly the arrival and departure point: pad, ring and soft glow, with existing beam timing and rules unchanged.
   - The freed aisle spot is left clean.
   - Existing transporter behaviour (who beams, when, queueing) is unchanged; only its place and look change.

## Out of Scope

- Lifecycle placement, stations, lounge rules, overflow and transporter rules: that is 09.5.
- Telemetry, audio cues and the full reduced-motion pass: that is 09.6.
- Server changes, data contract changes, new dependencies, new art styles.
- Re-laying out the office, kitchen or belt; role clarity changes.

## Acceptance Criteria

- Each of the seven outcomes is visible in both art styles at the default fit and at a narrow window, with no overlap of robots, badges or nameplates.
- Every new motion is tied to real state, except the ambient objects and the chef idle, which are decorative.
- Everything is static or off under `prefers-reduced-motion`, and no motion runs continuously when nothing is working.
- No measurable frame-time regression in the busy fixture.
- No regression in existing checks.

## Notes / Decisions

- 2026-11-17: Proposed as one ticket (11.1). It overlaps 09.3 (in review) and 09.5/06.2 (queued) on `src/galley/scene.ts`, `src/galley/model.ts` and `src/ui/hud/CrewPanel.tsx`, so it is sequenced after 09.3 lands rather than run in parallel.
