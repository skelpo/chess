/**
 * Software rasterizer for the 3D board. Draws into a linear-light float
 * color buffer with depth and a per-pixel square id (for mouse picking):
 *
 *   1. reflections: the pieces mirrored under the board (optional)
 *   2. board: squares with wood grain and a view-dependent sheen, frame, slab sides
 *   3. shadows: every piece projected onto the board along the light (planar
 *      shadows, exact for a flat board) plus a soft contact blob
 *   4. pieces: per-pixel lighting (diffuse, sky/ground ambient, glossy
 *      highlight, rim), two-bone skinning done once per actor per frame
 *
 * Plain typed-array code: it also has to be fast compiled by Perry.
 */
import type { Chess, Color } from "../../../engine/src/chess.ts";
import { baseRadius, model, mul34, square } from "./scene.ts";
import type { Actor, Marks, Pose } from "./scene.ts";

// key light (unit vector toward the light) and colors
const LX = 0.44, LY = 0.82, LZ = 0.37;
const SHADOW = 0.5;        // how dark a full shadow is (fraction removed)

interface Material { r: number; g: number; b: number; spec: number; squarings: number; rim: number }
const IVORY: Material = { r: 0.84, g: 0.75, b: 0.58, spec: 0.55, squarings: 5, rim: 0.22 };
const EBONY: Material = { r: 0.026, g: 0.019, b: 0.014, spec: 0.8, squarings: 6, rim: 0.28 };
const FELT: Material = { r: 0.012, g: 0.04, b: 0.016, spec: 0, squarings: 1, rim: 0 };

export interface CameraState { yaw: number; pitch: number; zoom: number }

// 5x7 glyphs for the coordinate labels in pixel output (rows top to bottom, '#' = ink)
const GLYPHS: Record<string, string> = {
  "a": "...........###.....#.#####...#.####",
  "b": "#....#....####.#...##...##...#####.",
  "c": "...........#####....#....#.....####",
  "d": "....#....#.#####...##...##...#.####",
  "e": "...........###.#...#######.....####",
  "f": "..##..#...####..#....#....#....#...",
  "g": "......#####...##...#.####....#.###.",
  "h": "#....#....####.#...##...##...##...#",
  "1": "..#...##....#....#....#....#...###.",
  "2": ".###.#...#....#...#...#...#...#####",
  "3": "####.....#....#.###.....#....#####.",
  "4": "...#...##..#.#.#..#.#####...#....#.",
  "5": "######....####.....#....##...#.###.",
  "6": ".###.#....#....####.#...##...#.###.",
  "7": "#####....#...#...#...#....#....#...",
  "8": ".###.#...##...#.###.#...##...#.###.",
};

/** What the board shows besides the cursor: the last move and a king in check. */
function boardState(game: Chess): { last: string; check: string } {
  const history = game.history();
  const last = history[history.length - 1] ?? "";
  let check = "";
  if (game.inCheck()) {
    for (let i = 0; i < 64; i++) {
      const sq = square(i & 7, i >> 3);
      const p = game.pieceAt(sq);
      if (p !== null && p.type === "king" && p.color === game.turn()) check = sq;
    }
  }
  return { last, check };
}

export class Raster {
  W = 0;
  H = 0;
  color = new Float32Array(0);
  depth = new Float32Array(0);
  /**
   * Buffers use zero for "nothing drawn": a fresh zeroed array costs almost
   * nothing, while clearing with fill()/set() is slow under Perry. Depth is
   * stored reversed (2 - z, larger is nearer); ids hold square + 1 (0..63 ->
   * 1..64), 65 for the frame.
   */
  ids = new Int8Array(0);
  // shadow coverage at half resolution (bilinear when applied: soft edges, a quarter of the work)
  private mask = new Float32Array(0);
  private maskW = 0;
  private maskH = 0;
  // reflections: own color, depth and coverage, blended over the board afterwards
  private refl = new Uint8Array(0);
  private reflColor = new Float32Array(0);
  private reflDepth = new Float32Array(0);
  private reflMinX = 0;
  private reflMaxX = -1;
  private reflMinY = 0;
  private reflMaxY = -1;
  // background gradient
  private clearColor = new Float32Array(0);
  // The board only changes with the camera or the highlights: it is drawn once
  // and every frame starts from a copy (slice() is a native copy, also in Perry).
  private cacheKey = "";
  private cacheColor = new Float32Array(0);
  private cacheDepth = new Float32Array(0);
  private cacheIds = new Int8Array(0);
  // area the shadow mask touched this frame (mask pixels)
  private maskMinX = 0;
  private maskMaxX = -1;
  private maskMinY = 0;
  private maskMaxY = -1;
  private vp = new Float64Array(16);
  private ex = 0;
  private ey = 0;
  private ez = 0;
  // per-vertex scratch: screen position/depth, world normal, board uv / mask value
  private sx = new Float32Array(4096);
  private sy = new Float32Array(4096);
  private sz = new Float32Array(4096);
  private nx = new Float32Array(4096);
  private ny = new Float32Array(4096);
  private nz = new Float32Array(4096);
  private va = new Float32Array(4096);
  private vb = new Float32Array(4096);
  // world-space vertices per actor for this frame
  private world = new Map<Actor, Float32Array>();
  private grain = new Float32Array(4096);
  private wobble = new Float32Array(1024);
  /** Draw mirrored pieces under the glossy board. */
  reflections = true;
  /** Wood grain strength: full for pixel output; low for half-blocks, where it is too fine to see and costs output bytes. */
  grainAmount = 1;

  constructor() {
    // wood: fine stripes with slow variation, looked up instead of computed per pixel
    let seed = 12345;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let a = 0;
    for (let i = 0; i < 4096; i++) {
      a = a * 0.86 + (rand() - 0.5) * 0.9;
      this.grain[i] = 0.9 + 0.07 * Math.sin(i * 0.21 + a * 2.2) + 0.03 * a;
    }
    for (let i = 0; i < 1024; i++) this.wobble[i] = Math.sin(i * 0.0123) * 18 + Math.sin(i * 0.071) * 4;
  }

  resize(W: number, H: number): void {
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    this.color = new Float32Array(W * H * 3);
    this.depth = new Float32Array(W * H);
    this.ids = new Int8Array(W * H);
    this.maskW = (W + 1) >> 1; this.maskH = (H + 1) >> 1;
    this.mask = new Float32Array(this.maskW * this.maskH);
    this.refl = new Uint8Array(W * H);
    this.cacheKey = "";
    this.clearColor = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = 0.006 + 0.012 * t, g = 0.0055 + 0.0105 * t, b = 0.006 + 0.008 * t;
      for (let x = 0; x < W; x++) {
        const dx = x / W - 0.5;
        const v = 1 - dx * dx * 1.2;
        const k = (y * W + x) * 3;
        this.clearColor[k] = r * v; this.clearColor[k + 1] = g * v; this.clearColor[k + 2] = b * v;
      }
    }
  }

  private ensure(n: number): void {
    if (this.sx.length >= n) return;
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.sz = new Float32Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n); this.nz = new Float32Array(n);
    this.va = new Float32Array(n); this.vb = new Float32Array(n);
  }

  // -------------------------------------------------------------- camera

  setCamera(cam: CameraState, flipped: boolean): void {
    const aspect = this.W / this.H;
    const fov = 34 * Math.PI / 180;
    const f = 1 / Math.tan(fov / 2);
    // fit the board frame: 4.2 board half-widths at zoom 1
    const dist = Math.max(4.2 * f, 4.2 * f / aspect) * cam.zoom;
    const yaw = cam.yaw + (flipped ? Math.PI : 0);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cx = Math.sin(yaw) * 0.35, cy = 0, cz = Math.cos(yaw) * 0.35;
    const ex = Math.sin(yaw) * cp * dist, ey = sp * dist, ez = Math.cos(yaw) * cp * dist;
    this.ex = ex; this.ey = ey; this.ez = ez;
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = zz, xy = 0, xz = -zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const near = 0.5, far = 80;
    const p0 = f / aspect, p5 = f, p10 = (far + near) / (near - far), p14 = 2 * far * near / (near - far);
    const v = [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1];
    const m = this.vp;
    for (let c = 0; c < 4; c++) {
      const a = v[c * 4] ?? 0, b = v[c * 4 + 1] ?? 0, cc = v[c * 4 + 2] ?? 0, d = v[c * 4 + 3] ?? 0;
      m[c * 4] = p0 * a;
      m[c * 4 + 1] = p5 * b;
      m[c * 4 + 2] = p10 * cc + p14 * d;
      m[c * 4 + 3] = -cc;
    }
  }

  /** Screen position (pixels) of a world point, written to scratch slot i. */
  project(x: number, y: number, z: number, i: number): void {
    const m = this.vp;
    const cx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
    const cy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
    const cz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
    const cw = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
    this.sx[i] = (cx / cw * 0.5 + 0.5) * this.W;
    this.sy[i] = (0.5 - cy / cw * 0.5) * this.H;
    this.sz[i] = cz / cw;
  }

  screenX(i: number): number { return this.sx[i] ?? 0; }
  screenY(i: number): number { return this.sy[i] ?? 0; }

  // -------------------------------------------------------------- frame

  /** Draw a whole frame. */
  draw(game: Chess, marks: Marks, actors: readonly Actor[], poses: ReadonlyMap<Actor, Pose>): void {
    const t0 = Date.now();
    const n = this.W * this.H;
    const state = boardState(game);
    const key = String(this.W) + "x" + String(this.H) + "|" + this.ex.toFixed(4) + "," + this.ey.toFixed(4) + "," + this.ez.toFixed(4) +
      "|" + marks.cursor + "|" + marks.selected + "|" + marks.targets.join(",") + "|" + state.last + "|" + state.check + "|" + String(this.grainAmount);
    if (key !== this.cacheKey) {
      this.color = this.clearColor.slice();
      this.depth = new Float32Array(n);
      this.ids = new Int8Array(n);
      this.drawBoard(state, marks);
      this.cacheColor = this.color.slice(); this.cacheDepth = this.depth.slice(); this.cacheIds = this.ids.slice();
      this.cacheKey = key;
    } else {
      this.color = this.cacheColor.slice(); this.depth = this.cacheDepth.slice(); this.ids = this.cacheIds.slice();
    }
    const t1 = Date.now();
    this.world.clear();
    for (const a of actors) { const p = poses.get(a); if (p !== undefined) this.skinActor(a, p); }
    const t2 = Date.now();
    if (this.reflections) {
      this.reflColor = new Float32Array(n * 3);
      this.reflDepth = new Float32Array(n);
      this.refl = new Uint8Array(n);
      this.reflMinX = this.W; this.reflMaxX = -1; this.reflMinY = this.H; this.reflMaxY = -1;
      for (const a of actors) this.drawActor(a, true);
      this.blendReflections();
    }
    const t3 = Date.now();
    this.drawShadows(actors, poses);
    const t4 = Date.now();
    for (const a of actors) this.drawActor(a, false);
    this.passes = { board: t1 - t0, skin: t2 - t1, reflections: t3 - t2, shadows: t4 - t3, pieces: Date.now() - t4 };
  }
  /** Milliseconds per pass in the last frame. */
  passes = { board: 0, skin: 0, reflections: 0, shadows: 0, pieces: 0 };

  /** Mirror images show faintly in the lacquered squares and frame (not on the slab sides). */
  private blendReflections(): void {
    const W = this.W, color = this.color, rc = this.reflColor, refl = this.refl, ids = this.ids;
    const x0 = Math.max(0, this.reflMinX), x1 = Math.min(W - 1, this.reflMaxX);
    const y0 = Math.max(0, this.reflMinY), y1 = Math.min(this.H - 1, this.reflMaxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        if (refl[k] !== 1) continue;
        const id = ids[k] ?? 0;
        if (id < 1 || id > 65) continue;
        const c = k * 3;
        color[c] = (color[c] ?? 0) * 0.8 + (rc[c] ?? 0) * 0.35;
        color[c + 1] = (color[c + 1] ?? 0) * 0.8 + (rc[c + 1] ?? 0) * 0.35;
        color[c + 2] = (color[c + 2] ?? 0) * 0.8 + (rc[c + 2] ?? 0) * 0.35;
      }
    }
  }

  // -------------------------------------------------------------- board

  private quadBoard(x0: number, z0: number, x1: number, z1: number, r: number, g: number, b: number, id: number, grainAlongX: boolean): void {
    this.project(x0, 0, z0, 0); this.project(x1, 0, z0, 1); this.project(x1, 0, z1, 2); this.project(x0, 0, z1, 3);
    this.va[0] = x0; this.va[1] = x1; this.va[2] = x1; this.va[3] = x0;
    this.vb[0] = z0; this.vb[1] = z0; this.vb[2] = z1; this.vb[3] = z1;
    this.triBoard(0, 2, 1, r, g, b, id, grainAlongX);
    this.triBoard(0, 3, 2, r, g, b, id, grainAlongX);
  }

  private drawBoard(state: { last: string; check: string }, marks: Marks): void {
    const last = state.last, check = state.check;
    // frame top (4 strips around the squares) and slab sides
    const fr = 0.05, fg = 0.028, fb = 0.016;
    this.quadBoard(-4.5, -4.5, 4.5, -4, fr, fg, fb, 64, true);
    this.quadBoard(-4.5, 4, 4.5, 4.5, fr, fg, fb, 64, true);
    this.quadBoard(-4.5, -4, -4, 4, fr, fg, fb, 64, false);
    this.quadBoard(4, -4, 4.5, 4, fr, fg, fb, 64, false);
    this.slab();
    for (let i = 0; i < 64; i++) {
      const f = i & 7, r = i >> 3;
      const sq = square(f, r);
      const light = (f + r) % 2 === 1;
      // linear-light colors of the web3d board (#c9a878 / #8a6a43)
      let cr = light ? 0.58 : 0.25, cg = light ? 0.40 : 0.145, cb = light ? 0.19 : 0.056;
      if (sq === last.slice(0, 2) || sq === last.slice(2, 4)) { cr = cr * 0.72 + 0.2; cg = cg * 0.72 + 0.17; cb = cb * 0.6; }
      if (marks.targets.includes(sq)) { cr = cr * 0.5 + 0.04; cg = cg * 0.5 + 0.22; cb = cb * 0.5 + 0.06; }
      if (sq === marks.selected) { cr = 0.78; cg = 0.52; cb = 0.06; }
      if (sq === check) { cr = 0.8; cg = 0.07; cb = 0.04; }
      if (sq === marks.cursor) { cr = 0.12; cg = 0.42; cb = 0.52; }
      this.quadBoard(f - 4, 4 - r - 1, f - 3, 4 - r, cr, cg, cb, i, light);
    }
  }

  /** The four vertical sides of the board slab, shaded by which way they face. */
  private slab(): void {
    const top = 0, bottom = -0.26, e = 4.5;
    const sides: number[][] = [[-e, e, e, e, 0, 1], [e, -e, -e, -e, 0, -1], [e, e, e, -e, 1, 0], [-e, -e, -e, e, -1, 0]];
    for (const s of sides) {
      const x0 = s[0] ?? 0, z0 = s[1] ?? 0, x1 = s[2] ?? 0, z1 = s[3] ?? 0, nx = s[4] ?? 0, nz = s[5] ?? 0;
      const lit = 0.25 + 0.75 * Math.max(0, nx * LX + nz * LZ);
      this.project(x0, top, z0, 0); this.project(x1, top, z1, 1); this.project(x1, bottom, z1, 2); this.project(x0, bottom, z0, 3);
      for (let i = 0; i < 4; i++) { this.va[i] = (i === 0 || i === 3 ? x0 + z0 : x1 + z1) * 3; this.vb[i] = i < 2 ? 0 : 1; }
      const r = 0.03 * lit, g = 0.017 * lit, b = 0.01 * lit;
      this.triFlat(0, 1, 2, r, g, b);
      this.triFlat(0, 2, 3, r, g, b);
      this.triFlat(0, 2, 1, r, g, b);
      this.triFlat(0, 3, 2, r, g, b);
    }
  }

  private triFlat(i0: number, i1: number, i2: number, r: number, g: number, b: number): void {
    const sx = this.sx, sy = this.sy, sz = this.sz;
    const x0 = sx[i0] ?? 0, y0 = sy[i0] ?? 0, x1 = sx[i1] ?? 0, y1 = sy[i1] ?? 0, x2 = sx[i2] ?? 0, y2 = sy[i2] ?? 0;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area >= 0) return;
    const W = this.W, H = this.H;
    let minX = Math.floor(Math.min(Math.min(x0, x1), x2)), maxX = Math.ceil(Math.max(Math.max(x0, x1), x2));
    let minY = Math.floor(Math.min(Math.min(y0, y1), y2)), maxY = Math.ceil(Math.max(Math.max(y0, y1), y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    const inv = 1 / area;
    const z0 = sz[i0] ?? 0, z1 = sz[i1] ?? 0, z2 = sz[i2] ?? 0;
    const v0 = this.vb[i0] ?? 0, v1 = this.vb[i1] ?? 0, v2 = this.vb[i2] ?? 0;
    const color = this.color, depth = this.depth, ids = this.ids;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const k = y * W + x;
        const z = 2 - (w0 * z0 + w1 * z1 + w2 * z2);
        if (z <= (depth[k] ?? 0)) continue;
        depth[k] = z;
        ids[k] = 66;
        // darker toward the bottom edge
        const s = 1 - 0.45 * (w0 * v0 + w1 * v1 + w2 * v2);
        const c = k * 3;
        color[c] = r * s; color[c + 1] = g * s; color[c + 2] = b * s;
      }
    }
  }

  private triBoard(i0: number, i1: number, i2: number, r: number, g: number, b: number, id: number, alongX: boolean): void {
    const sx = this.sx, sy = this.sy, sz = this.sz;
    const x0 = sx[i0] ?? 0, y0 = sy[i0] ?? 0, x1 = sx[i1] ?? 0, y1 = sy[i1] ?? 0, x2 = sx[i2] ?? 0, y2 = sy[i2] ?? 0;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area >= 0) return;
    const W = this.W, H = this.H;
    let minX = Math.floor(Math.min(Math.min(x0, x1), x2)), maxX = Math.ceil(Math.max(Math.max(x0, x1), x2));
    let minY = Math.floor(Math.min(Math.min(y0, y1), y2)), maxY = Math.ceil(Math.max(Math.max(y0, y1), y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    const z0 = sz[i0] ?? 0, z1 = sz[i1] ?? 0, z2 = sz[i2] ?? 0;
    const u0 = this.va[i0] ?? 0, u1 = this.va[i1] ?? 0, u2 = this.va[i2] ?? 0;
    const v0 = this.vb[i0] ?? 0, v1 = this.vb[i1] ?? 0, v2 = this.vb[i2] ?? 0;
    const color = this.color, depth = this.depth, ids = this.ids, grain = this.grain, wobble = this.wobble;
    const ex = this.ex, ey = this.ey, ez = this.ez, amount = this.grainAmount;
    // lit by the key light from above plus ambient
    const lit = 0.3 + 0.95 * LY;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const k = y * W + x;
        const z = 2 - (w0 * z0 + w1 * z1 + w2 * z2);
        if (z <= (depth[k] ?? 0)) continue;
        depth[k] = z;
        ids[k] = id + 1;
        const wx = w0 * u0 + w1 * u1 + w2 * u2, wz = w0 * v0 + w1 * v1 + w2 * v2;
        // wood grain: stripes along x or z, wobbling slowly across
        const along = alongX ? wz : wx, across = alongX ? wx : wz;
        const gi = Math.floor(along * 170 + (wobble[Math.floor((across + 8) * 60) & 1023] ?? 0)) & 4095;
        const gr = 1 - amount * (1 - (grain[gi] ?? 1));
        // sheen: Blinn-Phong with the view vector of this point (board normal is +Y)
        let vx = ex - wx, vy = ey, vz = ez - wz;
        const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        vx *= vl; vy *= vl; vz *= vl;
        const hx = LX + vx, hz = LZ + vz;
        let hy = LY + vy;
        hy /= Math.sqrt(hx * hx + hy * hy + hz * hz);
        let s = hy * hy; s = s * s; s = s * s; s = s * s; s = s * s; // ^32
        const sheen = s * 0.22 + (1 - vy) * (1 - vy) * 0.05;
        const c = k * 3;
        color[c] = r * gr * lit + sheen; color[c + 1] = g * gr * lit + sheen * 0.95; color[c + 2] = b * gr * lit + sheen * 0.85;
      }
    }
  }

  // -------------------------------------------------------------- pieces

  /** World-space positions and normals of an actor's vertices (two-bone skinning). */
  private skinActor(a: Actor, pose: Pose): void {
    const m = model(a.type);
    const n = m.count;
    const out = new Float32Array(n * 6);
    const bones = new Float64Array(36);
    for (let b = 0; b < 3; b++) {
      const os = mul34(pose.object, pose.skin.subarray(b * 12, b * 12 + 12));
      for (let i = 0; i < 12; i++) bones[b * 12 + i] = os[i] ?? 0;
    }
    const P = m.pos, N = m.nor, J0 = m.j0, J1 = m.j1, W0 = m.w0;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] ?? 0, y = P[i * 3 + 1] ?? 0, z = P[i * 3 + 2] ?? 0;
      const nx = N[i * 3] ?? 0, ny = N[i * 3 + 1] ?? 0, nz = N[i * 3 + 2] ?? 0;
      const w = W0[i] ?? 1, w1 = 1 - w;
      const a0 = (J0[i] ?? 0) * 12, b0 = (J1[i] ?? 0) * 12;
      const o = i * 6;
      out[o] = w * ((bones[a0] ?? 0) * x + (bones[a0 + 3] ?? 0) * y + (bones[a0 + 6] ?? 0) * z + (bones[a0 + 9] ?? 0))
        + w1 * ((bones[b0] ?? 0) * x + (bones[b0 + 3] ?? 0) * y + (bones[b0 + 6] ?? 0) * z + (bones[b0 + 9] ?? 0));
      out[o + 1] = w * ((bones[a0 + 1] ?? 0) * x + (bones[a0 + 4] ?? 0) * y + (bones[a0 + 7] ?? 0) * z + (bones[a0 + 10] ?? 0))
        + w1 * ((bones[b0 + 1] ?? 0) * x + (bones[b0 + 4] ?? 0) * y + (bones[b0 + 7] ?? 0) * z + (bones[b0 + 10] ?? 0));
      out[o + 2] = w * ((bones[a0 + 2] ?? 0) * x + (bones[a0 + 5] ?? 0) * y + (bones[a0 + 8] ?? 0) * z + (bones[a0 + 11] ?? 0))
        + w1 * ((bones[b0 + 2] ?? 0) * x + (bones[b0 + 5] ?? 0) * y + (bones[b0 + 8] ?? 0) * z + (bones[b0 + 11] ?? 0));
      out[o + 3] = w * ((bones[a0] ?? 0) * nx + (bones[a0 + 3] ?? 0) * ny + (bones[a0 + 6] ?? 0) * nz)
        + w1 * ((bones[b0] ?? 0) * nx + (bones[b0 + 3] ?? 0) * ny + (bones[b0 + 6] ?? 0) * nz);
      out[o + 4] = w * ((bones[a0 + 1] ?? 0) * nx + (bones[a0 + 4] ?? 0) * ny + (bones[a0 + 7] ?? 0) * nz)
        + w1 * ((bones[b0 + 1] ?? 0) * nx + (bones[b0 + 4] ?? 0) * ny + (bones[b0 + 7] ?? 0) * nz);
      out[o + 5] = w * ((bones[a0 + 2] ?? 0) * nx + (bones[a0 + 5] ?? 0) * ny + (bones[a0 + 8] ?? 0) * nz)
        + w1 * ((bones[b0 + 2] ?? 0) * nx + (bones[b0 + 5] ?? 0) * ny + (bones[b0 + 8] ?? 0) * nz);
    }
    this.world.set(a, out);
  }

  private drawActor(a: Actor, mirror: boolean): void {
    const world = this.world.get(a);
    if (world === undefined) return;
    const m = model(a.type);
    const n = m.count;
    this.ensure(n);
    const sign = mirror ? -1 : 1;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const x = world[o] ?? 0, y = (world[o + 1] ?? 0) * sign, z = world[o + 2] ?? 0;
      this.project(x, y, z, i);
      this.nx[i] = world[o + 3] ?? 0; this.ny[i] = (world[o + 4] ?? 0) * sign; this.nz[i] = world[o + 5] ?? 0;
      cx += x; cy += y; cz += z;
    }
    // view direction toward the camera from the piece (constant per piece)
    let vx = this.ex - cx / n, vy = this.ey - cy / n, vz = this.ez - cz / n;
    const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
    vx *= vl; vy *= vl; vz *= vl;
    const mat = a.color === "white" ? IVORY : EBONY;
    const idx = m.idx, bodyEnd = m.bodyTris * 3, total = idx.length;
    const id = mirror ? -2 : a.square;
    for (let k = 0; k < total; k += 3) {
      this.triPiece(idx[k] ?? 0, idx[k + 1] ?? 0, idx[k + 2] ?? 0, k < bodyEnd ? mat : FELT, id, mirror, vx, vy, vz);
    }
  }

  private triPiece(i0: number, i1: number, i2: number, mat: Material, id: number, mirror: boolean, vx: number, vy: number, vz: number): void {
    const sx = this.sx, sy = this.sy, sz = this.sz;
    const x0 = sx[i0] ?? 0, y0 = sy[i0] ?? 0, x1 = sx[i1] ?? 0, y1 = sy[i1] ?? 0, x2 = sx[i2] ?? 0, y2 = sy[i2] ?? 0;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (mirror ? area <= 0 : area >= 0) return;    // back face (mirroring flips winding)
    const W = this.W, H = this.H;
    let minX = Math.floor(Math.min(Math.min(x0, x1), x2)), maxX = Math.ceil(Math.max(Math.max(x0, x1), x2));
    let minY = Math.floor(Math.min(Math.min(y0, y1), y2)), maxY = Math.ceil(Math.max(Math.max(y0, y1), y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    const z0 = sz[i0] ?? 0, z1 = sz[i1] ?? 0, z2 = sz[i2] ?? 0;
    const n0x = this.nx[i0] ?? 0, n0y = this.ny[i0] ?? 0, n0z = this.nz[i0] ?? 0;
    const n1x = this.nx[i1] ?? 0, n1y = this.ny[i1] ?? 0, n1z = this.nz[i1] ?? 0;
    const n2x = this.nx[i2] ?? 0, n2y = this.ny[i2] ?? 0, n2z = this.nz[i2] ?? 0;
    // mirror images go to their own buffers and are blended over the board later
    const color = mirror ? this.reflColor : this.color, depth = mirror ? this.reflDepth : this.depth;
    const ids = this.ids, refl = this.refl;
    if (mirror) {
      if (minX < this.reflMinX) this.reflMinX = minX;
      if (maxX > this.reflMaxX) this.reflMaxX = maxX;
      if (minY < this.reflMinY) this.reflMinY = minY;
      if (maxY > this.reflMaxY) this.reflMaxY = maxY;
    }
    // half vector for the glossy highlight (view direction constant per piece)
    let hx = LX + vx, hy = LY + vy, hz = LZ + vz;
    const hl = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
    hx *= hl; hy *= hl; hz *= hl;
    const mr = mat.r, mg = mat.g, mb = mat.b, spec = mat.spec, squarings = mat.squarings, rimK = mat.rim;
    const dim = mirror ? 0.55 : 1;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const k = y * W + x;
        const z = 2 - (w0 * z0 + w1 * z1 + w2 * z2);
        if (z <= (depth[k] ?? 0)) continue;
        depth[k] = z;
        let nx = w0 * n0x + w1 * n1x + w2 * n2x, ny = w0 * n0y + w1 * n1y + w2 * n2y, nz = w0 * n0z + w1 * n1z + w2 * n2z;
        const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= nl; ny *= nl; nz *= nl;
        const ndl = nx * LX + ny * LY + nz * LZ;
        const diffuse = ndl > 0 ? ndl : 0;
        // sky from above, warm bounce from the board below
        const up = ny * 0.5 + 0.5;
        const ambR = 0.1 + 0.2 * up, ambG = 0.09 + 0.2 * up, ambB = 0.07 + 0.24 * up;
        let s = nx * hx + ny * hy + nz * hz;
        s = s > 0 ? s : 0;
        for (let q = 0; q < squarings; q++) s = s * s;
        let rim = 1 - (nx * vx + ny * vy + nz * vz);
        rim = rim > 0 ? rim * rim * rim * rimK : 0;
        const c = k * 3;
        color[c] = (mr * (ambR + diffuse * 1.05) + s * spec + rim * 0.5) * dim;
        color[c + 1] = (mg * (ambG + diffuse * 1.0) + s * spec + rim * 0.52) * dim;
        color[c + 2] = (mb * (ambB + diffuse * 0.92) + s * spec + rim * 0.6) * dim;
        if (mirror) refl[k] = 1; else ids[k] = id + 1;
      }
    }
  }

  // -------------------------------------------------------------- shadows

  private drawShadows(actors: readonly Actor[], poses: ReadonlyMap<Actor, Pose>): void {
    this.mask = new Float32Array(this.maskW * this.maskH);
    this.maskMinX = this.maskW; this.maskMaxX = -1; this.maskMinY = this.maskH; this.maskMaxY = -1;
    for (const a of actors) {
      const pose = poses.get(a);
      const world = this.world.get(a);
      if (pose === undefined || world === undefined) continue;
      // contact blob: dark in the middle, fading out; weaker while the piece is up in the air
      const r = baseRadius(a.type) * pose.scale * (1.3 + pose.lift * 0.8);
      const strength = 0.75 / (1 + pose.lift * 4);
      const segs = 16;
      this.project(a.x, 0.001, a.z, 0);
      this.va[0] = strength;
      for (let i = 0; i < segs; i++) {
        const ang = i / segs * Math.PI * 2;
        this.project(a.x + Math.cos(ang) * r, 0.001, a.z + Math.sin(ang) * r, i + 1);
        this.va[i + 1] = 0;
      }
      for (let i = 0; i < segs; i++) this.triMask(0, i + 1, (i + 1) % segs + 1);
      // cast shadow: the piece flattened onto the board along the light
      const m = model(a.type);
      const n = m.count;
      this.ensure(n);
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        const x = world[o] ?? 0, y = world[o + 1] ?? 0, z = world[o + 2] ?? 0;
        this.project(x - LX * y / LY, 0.001, z - LZ * y / LY, i);
        this.va[i] = 1;
      }
      const idx = m.idx, end = m.bodyTris * 3;
      for (let k = 0; k < end; k += 3) this.triMask(idx[k] ?? 0, idx[k + 1] ?? 0, idx[k + 2] ?? 0);
    }
    // darken board pixels by the bilinearly sampled half-resolution mask (soft edges for free)
    const W = this.W, H = this.H, MW = this.maskW, MH = this.maskH, mask = this.mask, color = this.color, ids = this.ids;
    const y0 = Math.max(0, this.maskMinY * 2 - 1), y1 = Math.min(H - 1, this.maskMaxY * 2 + 2);
    const x0 = Math.max(0, this.maskMinX * 2 - 1), x1 = Math.min(W - 1, this.maskMaxX * 2 + 2);
    for (let y = y0; y <= y1; y++) {
      const fy = y * 0.5 - 0.25;
      let iy = Math.floor(fy);
      const ty = fy - iy;
      if (iy < 0) iy = 0;
      const iy1 = iy + 1 < MH ? iy + 1 : iy;
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        const id = ids[k] ?? 0;
        if (id < 1 || id > 65) continue;
        const fx = x * 0.5 - 0.25;
        let ix = Math.floor(fx);
        const tx = fx - ix;
        if (ix < 0) ix = 0;
        const ix1 = ix + 1 < MW ? ix + 1 : ix;
        const top = (mask[iy * MW + ix] ?? 0) * (1 - tx) + (mask[iy * MW + ix1] ?? 0) * tx;
        const bottom = (mask[iy1 * MW + ix] ?? 0) * (1 - tx) + (mask[iy1 * MW + ix1] ?? 0) * tx;
        const v = top * (1 - ty) + bottom * ty;
        if (v <= 0.001) continue;
        const d = 1 - SHADOW * (v > 1 ? 1 : v);
        const c = k * 3;
        color[c] = (color[c] ?? 0) * d; color[c + 1] = (color[c + 1] ?? 0) * d; color[c + 2] = (color[c + 2] ?? 0) * d;
      }
    }
  }

  /** Accumulate shadow coverage (max of per-vertex values) into the half-resolution mask; both windings. */
  private triMask(i0: number, i1: number, i2: number): void {
    const sx = this.sx, sy = this.sy;
    const x0 = (sx[i0] ?? 0) * 0.5, y0 = (sy[i0] ?? 0) * 0.5, x1 = (sx[i1] ?? 0) * 0.5, y1 = (sy[i1] ?? 0) * 0.5;
    const x2 = (sx[i2] ?? 0) * 0.5, y2 = (sy[i2] ?? 0) * 0.5;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return;
    const MW = this.maskW, MH = this.maskH;
    let minX = Math.floor(Math.min(Math.min(x0, x1), x2)), maxX = Math.ceil(Math.max(Math.max(x0, x1), x2));
    let minY = Math.floor(Math.min(Math.min(y0, y1), y2)), maxY = Math.ceil(Math.max(Math.max(y0, y1), y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > MW - 1) maxX = MW - 1;
    if (maxY > MH - 1) maxY = MH - 1;
    if (minX > maxX || minY > maxY) return;
    if (minX < this.maskMinX) this.maskMinX = minX;
    if (maxX > this.maskMaxX) this.maskMaxX = maxX;
    if (minY < this.maskMinY) this.maskMinY = minY;
    if (maxY > this.maskMaxY) this.maskMaxY = maxY;
    const inv = 1 / area;
    const a0 = this.va[i0] ?? 0, a1 = this.va[i1] ?? 0, a2 = this.va[i2] ?? 0;
    const mask = this.mask;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const k = y * MW + x;
        const v = w0 * a0 + w1 * a1 + w2 * a2;
        if (v > (mask[k] ?? 0)) mask[k] = v;
      }
    }
  }

  // -------------------------------------------------------------- labels (pixel output)

  /** Coordinate letters drawn into the image, upright for the side that is playing. */
  drawLabels(flipped: boolean): void {
    const side = flipped ? -1 : 1;
    const scale = Math.max(1, Math.round(this.H / 260));
    for (let i = 0; i < 8; i++) {
      this.project(i - 3.5, 0, side * 4.25, 0);
      this.glyph("abcdefgh".charAt(i), this.sx[0] ?? 0, this.sy[0] ?? 0, scale);
      this.project(-side * 4.25, 0, 3.5 - i, 0);
      this.glyph(String(i + 1), this.sx[0] ?? 0, this.sy[0] ?? 0, scale);
    }
  }

  private glyph(ch: string, cx: number, cy: number, scale: number): void {
    const g = GLYPHS[ch];
    if (g === undefined) return;
    const W = this.W, H = this.H, color = this.color;
    const left = Math.round(cx - 2.5 * scale), top = Math.round(cy - 3.5 * scale);
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (g.charAt(row * 5 + col) !== "#") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = left + col * scale + dx, y = top + row * scale + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = (y * W + x) * 3;
        color[k] = 0.46; color[k + 1] = 0.36; color[k + 2] = 0.22;
      }
    }
  }

  /** The square (0..63) under a pixel, or -1. */
  pick(x: number, y: number): number {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.W || py >= this.H) return -1;
    const id = (this.ids[py * this.W + px] ?? 0) - 1;
    return id >= 0 && id < 64 ? id : -1;
  }
}

export type { Color };
