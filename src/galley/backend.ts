// The Pass · two art backends behind one drawing API.
//
// The scene is drawn in logical units (the approved concept's 640×360 grid).
// "pixel" snaps every shape to whole logical pixels at a whole-number device
// scale, with 1px ink outlines drawn as a separate pass; "cel" draws the same
// calls as antialiased vector shapes with an ink stroke and one flat shadow.
// Switching styles swaps the backend only: layout and data are shared.

export type ArtStyle = "pixel" | "cel";

export const INK = "#141a2e";
export const UIF = "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

export interface BoxOpts {
  r?: number;
  ink?: boolean;
  inkOnly?: boolean;
  shade?: boolean;
  hi?: boolean;
}

export interface Backend {
  kind: ArtStyle;
  rect(x: number, y: number, w: number, h: number, c: string, a?: number): void;
  box(x: number, y: number, w: number, h: number, c: string, o?: BoxOpts): void;
  ell(cx: number, cy: number, rx: number, ry: number, c: string, o?: BoxOpts): void;
  line(x1: number, y1: number, x2: number, y2: number, c: string, w?: number): void;
  glow(cx: number, cy: number, r: number, c: string, a?: number): void;
  /** SVG path data in logical units (cel only; pixel ignores it). */
  path(d: string, fill: string, o?: { stroke?: string; width?: number }): void;
  text(x: number, y: number, t: string, c: string, size: number, weight?: number, o?: { anchor?: "start" | "middle" | "end" }): void;
  tw(t: string, size: number, weight?: number): number;
  clip(x: number, y: number, w: number, h: number, fn: () => void): void;
  alpha(a: number, fn: () => void): void;
  /**
   * The scale a sprite really gets for a wanted scale `k`. Pixel art rounds it so a
   * sprite pixel is a whole number of device pixels (a robot never has uneven pixels).
   */
  spriteK(k: number): number;
  /** Draws `fn` in its own units, scaled by `k`, with its origin at (x, y). Alpha and clips carry over. */
  sprite(x: number, y: number, k: number, fn: (Z: Backend) => void): void;
}

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round((n >> 16) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(t: string, size: number, weight: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return t.length * size * 0.55;
  measureCtx.font = `${weight} ${size * 10}px ${UIF}`;
  return (measureCtx.measureText(t).width / 10) * 1.04;
}

/**
 * Whole-pixel backend. `s` = device pixels per logical unit, (vx, vy) = top-left in logical units.
 * Every edge lands on a device pixel: with a whole-number `s` all pixels are equal; a fractional
 * `s` (used only when a whole one would waste much of the window) varies them by one device pixel.
 */
export function pixelBackend(ctx: CanvasRenderingContext2D, s: number, vx = 0, vy = 0): Backend {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  let mul = 1;
  const D = (v: number, o: number) => Math.round((Math.round(v) - o) * s);
  const R = (x: number, y: number, w: number, h: number, c: string, a?: number) => {
    if (!c || c === "none" || w <= 0 || h <= 0) return;
    ctx.globalAlpha = (a ?? 1) * mul;
    ctx.fillStyle = c;
    const x0 = D(x, vx);
    const y0 = D(y, vy);
    ctx.fillRect(x0, y0, D(Math.round(x) + Math.round(w), vx) - x0, D(Math.round(y) + Math.round(h), vy) - y0);
    ctx.globalAlpha = mul;
  };
  const rowsOfEll = (cx: number, cy: number, rx: number, ry: number) => {
    const out: [number, number, number][] = [];
    for (let yy = Math.ceil(cy - ry); yy < cy + ry; yy++) {
      const t = (yy + 0.5 - cy) / ry;
      const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
      if (hw > 0) out.push([Math.round(cx - hw), yy, hw * 2]);
    }
    return out;
  };
  const B: Backend = {
    kind: "pixel",
    rect: R,
    box(x, y, w, h, c, o = {}) {
      x = Math.round(x);
      y = Math.round(y);
      w = Math.round(w);
      h = Math.round(h);
      const r = o.r ?? 0;
      if (o.ink) {
        if (r) {
          R(x, y - 1, w, h + 2, INK);
          R(x - 1, y, w + 2, h, INK);
        } else R(x - 1, y - 1, w + 2, h + 2, INK);
      }
      if (o.inkOnly) return;
      if (r) {
        R(x + 1, y, w - 2, h, c);
        R(x, y + 1, w, h - 2, c);
      } else R(x, y, w, h, c);
      if (o.shade) {
        const sw = Math.max(1, Math.round(w * 0.3));
        R(x + w - sw, y + (r ? 1 : 0), sw - (r ? 1 : 0), h - (r ? 2 : 0), shade(c, 0.78));
      }
      if (o.hi) R(x + (r ? 1 : 0), y, w - (r ? 2 : 0), 1, shade(c, 1.18));
    },
    ell(cx, cy, rx, ry, c, o = {}) {
      if (o.ink) rowsOfEll(cx, cy, rx + 1, ry + 1).forEach(([x, yy, w]) => R(x, yy, w, 1, INK));
      if (o.inkOnly) return;
      const rows = rowsOfEll(cx, cy, rx, ry);
      rows.forEach(([x, yy, w]) => R(x, yy, w, 1, c));
      if (o.shade) rows.forEach(([x, yy, w]) => R(x + Math.round(w * 0.68), yy, w - Math.round(w * 0.68), 1, shade(c, 0.78)));
    },
    line(x1, y1, x2, y2, c, w = 1) {
      const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) || 1;
      for (let i = 0; i <= n; i++) R(Math.round(x1 + ((x2 - x1) * i) / n), Math.round(y1 + ((y2 - y1) * i) / n), w, w, c);
    },
    glow(cx, cy, r, c, a = 0.18) {
      for (let k = 3; k >= 1; k--) {
        const rr = (r * k) / 3;
        rowsOfEll(cx, cy, rr, rr * 0.7).forEach(([x, yy, w]) => {
          for (let i = 0; i < w; i++) if ((x + i + yy) % 2 === 0) R(x + i, yy, 1, 1, c, a);
        });
      }
    },
    path() {
      /* the pixel style has no free curves */
    },
    text(x, y, t, c, size, weight = 600, o = {}) {
      ctx.font = `${weight} ${size * s}px ${UIF}`;
      ctx.fillStyle = c;
      ctx.textBaseline = "top";
      ctx.textAlign = o.anchor === "middle" ? "center" : o.anchor === "end" ? "right" : "left";
      ctx.fillText(t, Math.round((x - vx) * s), Math.round((y - vy) * s + size * s * 0.05));
      ctx.textAlign = "left";
    },
    tw: measure,
    clip(x, y, w, h, fn) {
      ctx.save();
      ctx.beginPath();
      const x0 = D(x, vx);
      const y0 = D(y, vy);
      ctx.rect(x0, y0, D(Math.round(x) + Math.round(w), vx) - x0, D(Math.round(y) + Math.round(h), vy) - y0);
      ctx.clip();
      fn();
      ctx.restore();
    },
    alpha(a, fn) {
      const prev = mul;
      mul = prev * a;
      ctx.globalAlpha = mul;
      try {
        fn();
      } finally {
        mul = prev;
        ctx.globalAlpha = prev;
      }
    },
    spriteK(k) {
      const p = Math.round(s * k);
      return Math.max(1, p / s > k * 1.15 ? Math.floor(s * k) : p) / s;
    },
    sprite(x, y, k, fn) {
      const p = Math.round(this.spriteK(k) * s); // whole device pixels per sprite pixel
      const dx = Math.round((x - vx) * s);
      const dy = Math.round((y - vy) * s);
      ctx.save();
      const Z = pixelBackend(ctx, p, -dx / p, -dy / p);
      Z.alpha(mul, () => fn(Z));
      ctx.restore();
    },
  };
  return B;
}

/** Vector backend: the same calls as inked, flat-shaded shapes. Any positive scale. */
export function celBackend(ctx: CanvasRenderingContext2D, s: number, vx = 0, vy = 0): Backend {
  ctx.setTransform(s, 0, 0, s, -vx * s, -vy * s);
  ctx.imageSmoothingEnabled = true;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const SW = 1.05;
  let mul = 1;
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  };
  const fill = (c: string) => {
    if (c && c !== "none") {
      ctx.fillStyle = c;
      ctx.fill();
    }
  };
  const B: Backend = {
    kind: "cel",
    rect(x, y, w, h, c, a) {
      if (!c || c === "none") return;
      ctx.globalAlpha = (a ?? 1) * mul;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = mul;
    },
    box(x, y, w, h, c, o = {}) {
      if (o.inkOnly) return;
      const r = Math.min(Math.min(w, h) / 2, Math.max((o.r ?? 0) * 1.7, o.ink ? 1.2 : 0));
      rr(x, y, w, h, r);
      fill(c);
      if (o.shade) {
        ctx.save();
        rr(x, y, w, h, r);
        ctx.clip();
        ctx.fillStyle = shade(c, 0.78);
        ctx.fill(new Path2D(`M${x + w * 0.66} ${y - 1} q${-w * 0.08} ${h * 0.5} ${w * 0.02} ${h + 2} H${x + w + 1} V${y - 1}z`));
        ctx.restore();
      }
      if (o.hi && w > 5 && h > 4) {
        ctx.save();
        ctx.globalAlpha = 0.85 * mul;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 0.7;
        ctx.stroke(new Path2D(`M${x + Math.min(2.2, w * 0.2)} ${y + h * 0.62} V${y + Math.min(2.2, h * 0.25)} h${Math.min(w * 0.35, 5)}`));
        ctx.restore();
      }
      if (o.ink) {
        rr(x, y, w, h, r);
        ctx.strokeStyle = INK;
        ctx.lineWidth = SW;
        ctx.stroke();
      }
    },
    ell(cx, cy, rx, ry, c, o = {}) {
      if (o.inkOnly) return;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
      fill(c);
      if (o.shade) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = shade(c, 0.78);
        ctx.fill(new Path2D(`M${cx + rx * 0.3} ${cy - ry - 1} q${-rx * 0.25} ${ry} ${rx * 0.05} ${ry * 2 + 2} H${cx + rx + 1} V${cy - ry - 1}z`));
        ctx.restore();
      }
      if (o.ink) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = INK;
        ctx.lineWidth = SW;
        ctx.stroke();
      }
    },
    line(x1, y1, x2, y2, c, w = 1) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.stroke();
    },
    glow(cx, cy, r, c, a = 0.12) {
      ctx.save();
      ctx.globalAlpha = a * mul;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.restore();
    },
    path(d, fillColor, o = {}) {
      const p = new Path2D(d);
      if (fillColor && fillColor !== "none") {
        ctx.fillStyle = fillColor;
        ctx.fill(p);
      }
      if (o.stroke) {
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = o.width ?? 1;
        ctx.stroke(p);
      }
    },
    text(x, y, t, c, size, weight = 600, o = {}) {
      ctx.font = `${weight} ${size}px ${UIF}`;
      ctx.fillStyle = c;
      ctx.textBaseline = "top";
      ctx.textAlign = o.anchor === "middle" ? "center" : o.anchor === "end" ? "right" : "left";
      ctx.fillText(t, x, y + size * 0.05);
      ctx.textAlign = "left";
    },
    tw: (t, size, weight = 600) => measure(t, size, weight) * 1.01,
    clip(x, y, w, h, fn) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      fn();
      ctx.restore();
    },
    alpha(a, fn) {
      const prev = mul;
      mul = prev * a;
      ctx.globalAlpha = mul;
      try {
        fn();
      } finally {
        mul = prev;
        ctx.globalAlpha = prev;
      }
    },
    spriteK: (k) => k,
    sprite(x, y, k, fn) {
      ctx.save();
      const Z = celBackend(ctx, s * k, -(x - vx) / k, -(y - vy) / k);
      Z.alpha(mul, () => fn(Z));
      ctx.restore();
    },
  };
  return B;
}

export function makeBackend(style: ArtStyle, ctx: CanvasRenderingContext2D, s: number, vx = 0, vy = 0): Backend {
  return style === "pixel" ? pixelBackend(ctx, s, vx, vy) : celBackend(ctx, s, vx, vy);
}
