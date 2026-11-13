# Kitchen Polish

## Status

Complete

## Goal

The kitchen uses the screen's height and gives its stations room, and the
colour picked for an agent in Settings → Team visibly changes that agent in the
kitchen and the roster.

## Context

- Read: `src/galley/scene.ts` (`VIEW`, station/pod/hatch constants, name tags),
  `src/galley/GalleyCanvas.tsx` (fit and `bounds`, ~L70–L195),
  `src/galley/robots.ts` (`ROBOTS`, parts/details), `src/galley/model.ts`
  (`crewIdentity`, `buildGalley`), `src/ui/hud/CrewPanel.tsx`,
  `src/galley/RobotPortrait.tsx`, `src/ui/settings/TeamSettings.tsx` (L96–L108).
- Relevant area: `src/galley/`, `src/ui/hud/`.
- Avoid: server code; the colour already persists (`server/commands.ts:110`).

## Requirements

- Layout: the scene's logical view is taller, so less starfield shows above and
  below the kitchen on a typical 16:9 / 16:10 window. Stations, pods, the pass,
  the belt and the hatch get more spacing between them. Nothing overlaps or
  clips at any window size the fit already supports.
- Colour: `AgentConfig.color` drives (a) one accent part of that agent's robot
  (apron/band/trim, chosen per character), (b) its kitchen name tag, (c) its
  roster chip in the crew panel, and (d) its portrait in Settings → Team.
  Changing it in Settings updates all four live, without a restart.
- The robots still match the approved designs apart from that one accent part,
  and the alert pink-red (`ALERT`) is never used as an agent colour.

## Out of Scope

- New characters (Feature 04), new palette colours, theme changes.

## Acceptance Criteria

- With 5 agents in a 1440×900 window, the kitchen fills most of the height
  between the top bar and the bottom edge; before/after screenshots show it.
- Picking a colour for an agent changes that robot's accent, tag, roster chip
  and portrait within a second. The choice survives a kitchen restart.
- `pnpm typecheck` passes.

## Notes / Decisions

- Human decision (2026-11-11): colour = robot accent + name tag + roster.
