/**
 * Apple TV for the chess app, through @bloomengine/web's tv hooks: in a
 * menu or the promotion dialog the remote moves the focus among its buttons
 * (the runtime does that); in a game it moves a cursor from square to square
 * (to the neighbor in that direction on screen, so it follows the camera)
 * and on to the top bar's buttons, and Select taps the square the way a
 * finger would (the app's own raycast picks it). Menu leaves the app on the
 * title screen, as Apple requires.
 */
import { TV, clickAt, document, type Element, type TvHooks } from "@bloomengine/web";

let square = "";

type Api = Record<string, (...args: unknown[]) => unknown>;
const api = (): Api | undefined => (globalThis as Record<string, unknown>)["web3d"] as Api | undefined;
const screenOf = (sq: string): [number, number] | undefined => api()?.["screenOf"]?.(sq) as [number, number] | undefined;
const shown = (e: Element | null): e is Element => {
  if (e === null) return false;
  for (let p: Element | null = e; p !== null; p = p.parentElement) if (p.hidden) return false;
  return true;
};

/** A focused button in the top bar (the cursor is on it, not on a square). */
function hudButton(): Element | null {
  const f = document._focused, hud = document.getElementById("hud");
  return f !== null && hud !== null && hud.contains(f) ? f : null;
}

/** The board cursor's square on screen: its center and the size of a square there (CSS pixels). */
export function tvCursor(): { x: number; y: number; size: number } | null {
  if (!TV || square === "" || hudButton() !== null) return null;
  const p = screenOf(square);
  if (p === undefined) return null;
  const file = square.charCodeAt(0), rank = square.charAt(1);
  const q = screenOf(String.fromCharCode(file === 104 ? 103 : file + 1) + rank);   // a neighbor on the same rank
  return { x: p[0], y: p[1], size: q === undefined ? 40 : Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

export const tv: TvHooks = {
  overlay(): Element | null {
    const menu = document.getElementById("menu");
    if (shown(menu)) return menu;
    const promo = document.getElementById("promo");
    return shown(promo) ? promo : null;
  },
  menuExits(): boolean {
    const menu = document.getElementById("menu");
    return shown(menu) && menu.classList.contains("title") && shown(document.getElementById("screen-title"));
  },
  navigate(dx: number, dy: number, select: boolean): boolean {
    const state = api()?.["state"]?.() as { mode?: string; human?: string } | undefined;
    if (state?.mode !== "game") return false;
    if (square === "") square = state.human === "black" ? "e7" : "e2";
    if (dx !== 0 || dy !== 0) {
      const on = hudButton()?._box ?? null;
      const from: [number, number] | undefined = on !== null ? [on.x + on.w / 2, on.y + on.h / 2] : screenOf(square);
      if (from === undefined) return false;
      // the squares and the top bar's buttons, as points on screen
      const targets: { x: number; y: number; sq: string; el: Element | null }[] = [];
      for (let i = 0; i < 64; i++) {
        const sq = String.fromCharCode(97 + i % 8) + String(1 + Math.floor(i / 8));
        const p = screenOf(sq);
        if (p !== undefined) targets.push({ x: p[0], y: p[1], sq, el: null });
      }
      const hud = document.getElementById("hud");
      if (shown(hud)) for (const b of hud.querySelectorAll("button")) if (shown(b) && b._box !== null) targets.push({ x: b._box.x + b._box.w / 2, y: b._box.y + b._box.h / 2, sq: "", el: b });
      let best: (typeof targets)[number] | null = null, score = Infinity;
      for (const t of targets) {
        const ox = t.x - from[0], oy = t.y - from[1];
        const along = ox * dx + oy * dy;
        if (along <= 1) continue;
        const s = along + 2 * Math.abs(ox * dy - oy * dx);
        if (s < score) { score = s; best = t; }
      }
      if (best !== null) {
        if (best.el !== null) best.el.focus({ focusVisible: true });
        else { document._focused?.blur(); square = best.sq; }
      }
      return true;
    }
    if (select) {
      // a focused top-bar button was pressed by Enter already
      if (hudButton() !== null) return true;
      const p = screenOf(square);
      if (p !== undefined) clickAt(p[0], p[1]);
      return true;
    }
    return false;
  },
};
