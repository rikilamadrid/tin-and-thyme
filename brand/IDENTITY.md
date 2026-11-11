# Tin & Thyme identity

## The idea in one line

A galley porthole with the Head Chef looking out: a robot kitchen in space, watched
through glass.

## Where it comes from

Tin & Thyme already had a look before it had a logo: the kitchen itself, in
**Detailed pixel art**. The identity is cut from that, not drawn beside it.

- **The robots are the real ones.** The mark and the banner do not redraw anyone.
  `scripts/brand/render-brand.ts` paints the app's own sprites
  (`src/galley/robots.ts`) through the app's own pixel renderer
  (`src/galley/backend.ts`) into a recording canvas, and every filled pixel becomes
  an SVG rect. Change a robot in the app and `pnpm brand` changes it here.
- **Lettering is pixel lettering, drawn as rects.** No typeface, no web font and no
  `<text>` element, so the banner reads the same on every machine and in every
  renderer, GitHub and npm included.

## The mark

`brand/logo/mark.svg` (dark grounds) and `brand/logo/mark-day.svg` (light grounds):
48 × 48 pixels at 4×.

A copper porthole with four steel rivets, a star-flecked navy window, and Basil, the
Head Chef, looking out of it, cut off at the chest by the glass. A thyme sprig grows
along the lower-right rim. The porthole is the galley's; the sprig is the "thyme";
the robot is the "tin".

## The wordmark

**TIN & THYME** in doubled 5 × 7 capitals (two-pixel stems), copper with a lit top
edge and a shaded foot, a one-pixel ink outline, and a one-pixel ink drop to the lower
right. The ampersand alone is cyan. Always set in capitals; never re-typed in a font.

## The banner

`brand/readme/header-night.svg` and `brand/readme/header-day.svg`, 1200 × 240, the
same size as Lorekeeper's README header. From left to right: the mark, the wordmark
over the line *Pathfinder runs the round; Tin & Thyme lets you watch the kitchen.*,
and three of the crew (Pepper, Pinch, Dash) on a galley counter. Bottom right, the
plate: **A WONDER WAGON TOOL · BY LAMADRID LABS**. The README shows the night banner
to readers in dark mode and the day banner otherwise.

## Palette

Drawn from the kitchen's own colours. Restrained: navy carries the ground, copper the
name, cyan the accents.

| Role | Name | Hex |
| --- | --- | --- |
| Ground (night) | Midnight navy | `#0c1226` |
| Window glass | Deep navy | `#13204a` |
| Ink, outlines | Ink | `#141a2e` |
| The name | Copper | `#e0773a` (lit `#ffa25a`, shade `#a8532a`) |
| Accents, the ampersand, thyme | Cyan | `#38d9c9` (lit `#9fe7ff`, shade `#1c8f86`) |
| Metal | Steel | `#55607e`, `#8f9cb2` |
| Ground (day) | Galley paper | `#f4efe6` |
| Text on day | Navy text | `#1d2748` |
| Muted text | Night `#a8b8d8` · Day `#4b5a7a` |
| **Attention only** | Alert pink | `#ff4f7b` |

**Pink is reserved for states that need a person** (a human gate, an agent asking). It
never appears in the mark, the wordmark, the banner or any decoration, so that when it
appears in the product it means something.

### Measured contrast (WCAG 2.x)

| Pairing | Ratio |
| --- | --- |
| Tagline, cyan lit on navy | 13.58 : 1 |
| Plate, muted on navy | 9.30 : 1 |
| Copper on navy | 6.08 : 1 |
| Tagline, navy text on paper | 12.77 : 1 |
| Plate, muted on paper | 6.03 : 1 |
| Ink outline on paper | 15.07 : 1 |
| Copper on paper | 2.67 : 1 |

Copper on paper is too weak for text on its own, which is why the wordmark always
carries its ink outline and copper is never used for small text on a light ground.

## In the Wonder Wagon family

Tin & Thyme is a Wonder Wagon tool, shelved beside Pathfinder (blaze orange, a trail
blaze), Lorekeeper (indigo and gilt, a star in a ring) and Forge (iron and bronze). It
shares their habits: an SVG README header in day and night variants, a mark and a
wordmark drawn rather than typed, a measured palette, and the plate in the corner.

It does **not** have a Wonder Wagon serial or a registered theme in
`@wonder-wagon/themes`. Those are assigned by the family, not claimed here, so no
`XX-047` appears anywhere in this identity.

## Regenerating

```sh
pnpm brand
```

The files under `brand/logo/` and `brand/readme/` are generated; edit
`scripts/brand/render-brand.ts`, never the SVGs.
