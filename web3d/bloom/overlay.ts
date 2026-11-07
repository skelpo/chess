/**
 * What the page doesn't draw: the Apple TV board cursor (tv.ts), a rounded ring over the square,
 * drawn after the page.
 */
import { drawRect } from "@bloomengine/engine/shapes";
import { onAfterFrame, pixelRatio } from "@bloomengine/web";
import { tvCursor } from "./tv.ts";

type Rgba = { r: number; g: number; b: number; a: number };

/** A rounded ring, row by row in device pixels. */
function ring(x: number, y: number, size: number, radius: number, t: number, c: Rgba): void {
  const inset = (i: number, h: number, r: number): number => {
    const d = i < r ? r - i - 0.5 : i >= h - r ? i - (h - r) + 0.5 : -1;
    return d < 0 ? 0 : r - Math.sqrt(Math.max(0, r * r - d * d));
  };
  for (let i = 0; i < size; i++) {
    const outer = Math.round(inset(i, size, radius));
    const j = i - t;
    if (j < 0 || j >= size - 2 * t) { drawRect(x + outer, y + i, size - 2 * outer, 1, c); continue; }
    const inner = t + Math.round(inset(j, size - 2 * t, Math.max(0, radius - t)));
    drawRect(x + outer, y + i, inner - outer, 1, c);
    drawRect(x + size - inner, y + i, inner - outer, 1, c);
  }
}

onAfterFrame(() => {
  const cursor = tvCursor();
  if (cursor === null) return;
  const S = pixelRatio();
  const d = Math.round(cursor.size * 0.92 * S), t = Math.max(3, Math.round(cursor.size * 0.07 * S));
  const x = Math.round(cursor.x * S - d / 2), y = Math.round(cursor.y * S - d / 2);
  ring(x - 1, y - 1, d + 2, Math.round(d * 0.16) + 1, t + 2, { r: 0, g: 0, b: 0, a: 120 });
  ring(x, y, d, Math.round(d * 0.16), t, { r: 111, g: 191, b: 115, a: 255 });
});
