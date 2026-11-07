/**
 * The 3D board's scene: decoded piece models, and actors that follow a Chess
 * game. New moves animate (hop, capture topple, castling, promotion,
 * checkmate finale); anything else rebuilds the board. Rendering lives in
 * raster.ts; this file only knows where things are at time t.
 */
import type { Chess, Color, PieceType } from "../../../engine/src/chess.ts";
import { CLIP_NAMES, MODEL_DATA, MODEL_FPS, MODEL_INFO } from "./models.ts";

// ---------------------------------------------------------------- models

export interface Model {
  readonly count: number;
  readonly pos: Float32Array;
  readonly nor: Float32Array;
  readonly j0: Uint8Array;
  readonly j1: Uint8Array;
  readonly w0: Float32Array;
  readonly idx: Uint16Array;
  readonly bodyTris: number;
  readonly feltTris: number;
  /** Per clip: frames * 3 bones * 12 (3x4 column-major skin matrices). */
  readonly clips: Float32Array[];
  readonly frames: number[];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  let length = text.length;
  while (length > 0 && text.charAt(length - 1) === "=") length--;
  const out = new Uint8Array(Math.floor(length * 3 / 4));
  let bits = 0, value = 0, o = 0;
  for (let i = 0; i < length; i++) {
    value = ((value << 6) | (lookup[text.charCodeAt(i)] ?? 0)) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (value >> bits) & 255; }
  }
  return out;
}

function decodeModel(text: string): Model {
  const bytes = decodeBase64(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u16 = (): number => { const v = view.getUint16(at, true); at += 2; return v; };
  const count = u16(), bodyTris = u16(), feltTris = u16(), clipCount = u16();
  const scale = view.getFloat32(at, true); at += 4;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) { pos[i] = view.getInt16(at, true) * scale; at += 2; }
  const nor = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) { nor[i] = view.getInt8(at) / 127; at += 1; }
  const j0 = bytes.slice(at, at + count); at += count;
  const j1 = bytes.slice(at, at + count); at += count;
  const w0 = new Float32Array(count);
  for (let i = 0; i < count; i++) w0[i] = (bytes[at + i] ?? 0) / 255;
  at += count;
  const idx = new Uint16Array((bodyTris + feltTris) * 3);
  for (let i = 0; i < idx.length; i++) idx[i] = u16();
  const clips: Float32Array[] = [], frames: number[] = [];
  for (let c = 0; c < clipCount; c++) {
    const n = u16();
    const data = new Float32Array(n * 36);
    for (let i = 0; i < data.length; i++) { data[i] = view.getInt16(at, true) / 16384; at += 2; }
    clips.push(data);
    frames.push(n);
  }
  return { count, pos, nor, j0, j1, w0, idx, bodyTris, feltTris, clips, frames };
}

let models: Record<string, Model> | null = null;
export function model(type: PieceType): Model {
  if (models === null) {
    models = {};
    for (const name of Object.keys(MODEL_DATA)) models[name] = decodeModel(MODEL_DATA[name] ?? "");
  }
  const m = models[type];
  if (m === undefined) throw new Error("No 3D model for " + type);
  return m;
}

const CLIP = { select: 0, hop: 1, captured: 2, celebrate: 3 } as const;
if (CLIP_NAMES.join() !== "select,hop,captured,celebrate") throw new Error("models.ts clip order changed");
const HOP = MODEL_INFO.hop;
const CAPTURED = MODEL_INFO.captured;
export function baseRadius(type: PieceType): number {
  return (MODEL_INFO as unknown as Record<string, { baseRadius?: number }>)[type]?.baseRadius ?? 0.22;
}

// ---------------------------------------------------------------- actors

interface Hop { fx: number; fz: number; tx: number; tz: number; start: number; takeoff: number; land: number; end: number; height: number; speed: number }

export interface Actor {
  type: PieceType;
  color: Color;
  x: number;
  z: number;
  yaw: number;
  clip: number;             // -1: rest pose
  clipStart: number;        // ms
  clipSpeed: number;
  clipLoop: boolean;
  clipHold: boolean;        // stay on the last frame
  /** Queued hops, oldest first; each starts where the previous one lands. */
  hops: Hop[];
  /** Where the piece stands once its queued hops are done. */
  homeX: number;
  homeZ: number;
  slide: { fx: number; fz: number; tx: number; tz: number; start: number; duration: number } | null;
  grow: { start: number; duration: number; from: number; to: number } | null;
  removeAt: number;         // ms; Infinity = stays
  lift: number;             // animated selection lift
  /** Board square index (file + 8 * rank) for picking; -1 while leaving the board. */
  square: number;
}

/** Where an actor is and how it is deformed at one moment. */
export interface Pose {
  /** Column-major 3x4 object matrix (yaw, travel tilt, scale, position). */
  readonly object: Float64Array;
  /** Three 3x4 skin matrices, one per bone. */
  readonly skin: Float32Array;
  /** Height above the board, for shadows. */
  readonly lift: number;
  readonly scale: number;
}

function activeHop(a: Actor, t: number): Hop | null {
  const h = a.hops[0];
  return h !== undefined && t >= h.start ? h : null;
}

export const square = (file: number, rank: number): string => "abcdefgh".charAt(file) + String(rank + 1);
const fileOf = (sq: string): number => sq.charCodeAt(0) - 97;
const rankOf = (sq: string): number => sq.charCodeAt(1) - 49;
const indexOf = (sq: string): number => fileOf(sq) + 8 * rankOf(sq);
const sqX = (sq: string): number => fileOf(sq) - 3.5;
const sqZ = (sq: string): number => 3.5 - rankOf(sq);
const ease = (k: number): number => k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) * (-2 * k + 2) / 2;
const clamp01 = (k: number): number => k < 0 ? 0 : k > 1 ? 1 : k;

function facing(type: PieceType, color: Color): number {
  // glTF front is +Z: white faces black (-Z), black faces white; knights show their profile.
  if (type === "knight") return color === "white" ? -Math.PI / 2 : Math.PI / 2;
  return color === "white" ? Math.PI : 0;
}

export interface Marks {
  readonly cursor: string;
  readonly selected: string;
  readonly targets: readonly string[];
  readonly flipped: boolean;
}

// Board loops run 0..63 instead of nested 8x8: Perry fully unrolls literal-bound
// loops of up to eight iterations (Perry #13649), which bloated these methods ~250 KB each.
export class Scene {
  actors: Actor[] = [];
  private board = new Map<string, Actor>();
  private known: string[] = [];
  private fen = "";
  private queueEnd = 0;
  private finale = "";
  /** Time source; tests can replace it. */
  now: () => number = () => Date.now();

  /** True while something moves, so the caller keeps redrawing. */
  animating(): boolean {
    const t = this.now();
    if (t < this.queueEnd) return true;
    for (const a of this.actors) {
      if (a.removeAt !== Infinity || a.hops.length > 0) return true;
      if (a.lift > 0.001) return true;
      if (a.clip >= 0 && !a.clipHold && (a.clipLoop || t < a.clipStart + this.clipMs(a))) return true;
    }
    return false;
  }

  /** Moves are still landing: the engine should wait before answering. */
  busy(): boolean { return this.now() < this.queueEnd; }

  private clipMs(a: Actor): number {
    const m = model(a.type);
    return ((m.frames[a.clip] ?? 1) - 1) / MODEL_FPS * 1000 / a.clipSpeed;
  }

  private spawn(type: PieceType, color: Color, sq: string): Actor {
    const a: Actor = {
      type, color, x: sqX(sq), z: sqZ(sq), yaw: facing(type, color), clip: -1, clipStart: 0, clipSpeed: 1,
      clipLoop: false, clipHold: false, hops: [], homeX: sqX(sq), homeZ: sqZ(sq), slide: null, grow: null,
      removeAt: Infinity, lift: 0, square: indexOf(sq),
    };
    this.actors.push(a);
    this.board.set(sq, a);
    return a;
  }

  private play(a: Actor, clip: number, start: number, options: { speed?: number; loop?: boolean; hold?: boolean } = {}): void {
    a.clip = clip;
    a.clipStart = start;
    a.clipSpeed = options.speed ?? 1;
    a.clipLoop = options.loop ?? false;
    a.clipHold = options.hold ?? false;
  }

  private rebuild(game: Chess): void {
    this.actors = [];
    this.board.clear();
    for (let i = 0; i < 64; i++) {
      const sq = square(i & 7, i >> 3);
      const p = game.pieceAt(sq);
      if (p !== null) this.spawn(p.type, p.color, sq);
    }
    this.queueEnd = 0;
    this.finale = "";
  }

  /** Follow the game: animate moves that were added since the last call, else rebuild. */
  sync(game: Chess): void {
    const history = game.history();
    const fen = game.fen();
    let added = this.fen !== "" && history.length > this.known.length;
    for (let i = 0; added && i < this.known.length; i++) if (history[i] !== this.known[i]) added = false;
    if (added) {
      for (let i = this.known.length; i < history.length; i++) this.animateMove(history[i] ?? "", Math.max(this.now(), this.queueEnd));
      // anything the move list does not explain: show the real position
      if (!this.matches(game)) this.rebuild(game);
    } else if (fen !== this.fen || history.length !== this.known.length) {
      this.rebuild(game);                 // new game, load, undo, or a different online game
    }
    this.known = history.slice();
    this.fen = fen;
    this.checkFinale(game);
  }

  private matches(game: Chess): boolean {
    let count = 0;
    for (let i = 0; i < 64; i++) {
      const sq = square(i & 7, i >> 3);
      const p = game.pieceAt(sq);
      const a = this.board.get(sq);
      if ((p === null) !== (a === undefined)) return false;
      if (p !== null && a !== undefined && (p.type !== a.type || p.color !== a.color)) {
        // a promotion swaps the model when the pawn lands
        if (!(a.type === "pawn" && p.color === a.color)) return false;
      }
      if (p !== null) count++;
    }
    return count === this.board.size;
  }

  private animateMove(uci: string, start: number): void {
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const actor = this.board.get(from);
    if (actor === undefined) return;
    let victimSq = to;
    if (actor.type === "pawn" && fileOf(from) !== fileOf(to) && !this.board.has(to)) victimSq = to.charAt(0) + from.charAt(1);
    const victim = this.board.get(victimSq);
    this.board.delete(from);
    if (victim !== undefined) { this.board.delete(victimSq); victim.square = -1; }
    this.board.set(to, actor);
    actor.square = indexOf(to);
    const end = this.hop(actor, to, start, actor.type === "knight");
    let finish = end;
    if (victim !== undefined) {
      const s = start + 100;
      this.play(victim, CLIP.captured, s, { hold: true });
      const back = victim.color === "white" ? 0.62 : -0.62;
      victim.slide = { fx: victim.homeX, fz: victim.homeZ, tx: victim.homeX, tz: victim.homeZ + back, start: s, duration: 750 };
      victim.removeAt = s + CAPTURED.duration * 1000 + 350;
      finish = Math.max(finish, victim.removeAt);
    }
    if (actor.type === "king" && Math.abs(fileOf(to) - fileOf(from)) === 2) {
      const rank = from.charAt(1);
      const rf = (fileOf(to) === 6 ? "h" : "a") + rank, rt = (fileOf(to) === 6 ? "f" : "d") + rank;
      const rook = this.board.get(rf);
      if (rook !== undefined) {
        this.board.delete(rf);
        this.board.set(rt, rook);
        rook.square = indexOf(rt);
        finish = Math.max(finish, this.hop(rook, rt, start + 180, false));
      }
    }
    const promo = uci.charAt(4);
    if (promo !== "") {
      const type: PieceType = promo === "q" ? "queen" : promo === "r" ? "rook" : promo === "b" ? "bishop" : "knight";
      const promoted: Actor = {
        ...actor, type, x: sqX(to), z: sqZ(to), yaw: facing(type, actor.color), clip: -1, hops: [],
        grow: { start: end, duration: 400, from: 0, to: 1 },
      };
      actor.removeAt = end + 150;
      actor.square = -1;
      this.actors.push(promoted);
      this.board.set(to, promoted);
      this.play(promoted, CLIP.celebrate, end + 300);
      finish = Math.max(finish, end + 300 + 1600);
    }
    this.queueEnd = Math.max(this.queueEnd, finish - (victim !== undefined ? 700 : 0));
  }

  /** Hop `a` to `to`; returns when it lands (ms). */
  private hop(a: Actor, to: string, start: number, high: boolean): number {
    const tx = sqX(to), tz = sqZ(to);
    const dist = Math.hypot(tx - a.homeX, tz - a.homeZ);
    const air = HOP.land - HOP.takeoff;
    const speed = Math.min(1.6, Math.max(0.55, air / (0.3 + 0.07 * dist)));
    const s = start;
    const end = s + HOP.duration / speed * 1000;
    a.hops.push({
      fx: a.homeX, fz: a.homeZ, tx, tz, start: s, end, speed,
      takeoff: s + HOP.takeoff / speed * 1000, land: s + HOP.land / speed * 1000,
      height: (high ? 0.75 : 0.3) + 0.09 * dist,
    });
    a.homeX = tx; a.homeZ = tz;
    return end;
  }

  private checkFinale(game: Chess): void {
    const st = game.status();
    const key = st.state === "checkmate" ? this.fen : "";
    if (key === this.finale) return;
    this.finale = key;
    if (key === "") return;
    const start = Math.max(this.now(), this.queueEnd);
    for (const a of this.board.values()) {
      if (a.type !== "king") continue;
      if (a.color === st.winner) this.play(a, CLIP.celebrate, start);
      else this.play(a, CLIP.captured, start, { hold: true });
    }
  }

  /** Advance positions, selection and clip state to time t. */
  update(t: number, marks: Marks): void {
    const keep: Actor[] = [];
    for (const a of this.actors) {
      if (t >= a.removeAt) continue;
      keep.push(a);
      while (a.hops.length > 0 && t >= (a.hops[0]?.end ?? 0)) {
        const done = a.hops.shift();
        if (done !== undefined) { a.x = done.tx; a.z = done.tz; }
      }
      const h = activeHop(a, t);
      if (h !== null) {
        const e = ease(clamp01((t - h.takeoff) / (h.land - h.takeoff)));
        a.x = h.fx + (h.tx - h.fx) * e;
        a.z = h.fz + (h.tz - h.fz) * e;
      }
      if (a.slide !== null) {
        const s = a.slide;
        const e = ease(clamp01((t - s.start) / s.duration));
        a.x = s.fx + (s.tx - s.fx) * e;
        a.z = s.fz + (s.tz - s.fz) * e;
      }
      // selection: lift and wobble the selected piece while nothing else plays
      const selected = marks.selected !== "" && this.board.get(marks.selected) === a && a.hops.length === 0;
      const target = selected ? 0.14 : 0;
      a.lift += (target - a.lift) * 0.35;
      if (Math.abs(a.lift - target) < 0.002) a.lift = target;
      if (selected && (a.clip < 0 || (!a.clipLoop && t > a.clipStart + this.clipMs(a)))) this.play(a, CLIP.select, t, { loop: true });
      if (!selected && a.clip === CLIP.select) a.clip = -1;
      if (a.clip >= 0 && !a.clipLoop && !a.clipHold && t > a.clipStart + this.clipMs(a)) a.clip = -1;
    }
    this.actors = keep;
  }

  /** The actor's transform and skin at time t; null while it is invisible. */
  pose(a: Actor, t: number): Pose | null {
    let scale = 1;
    if (a.grow !== null) {
      const k = clamp01((t - a.grow.start) / a.grow.duration);
      scale = a.grow.from + (a.grow.to - a.grow.from) * ease(k) * (1 + Math.sin(k * Math.PI) * 0.15 * (1 - k));
      if (k >= 1) a.grow = null;
    }
    if (a.removeAt !== Infinity && t > a.removeAt - 250 && a.grow === null) scale = Math.max(0.001, (a.removeAt - t) / 250);
    if (scale < 0.002) return null;
    let y = a.lift, tiltX = 0, tiltZ = 0, tilt = 0;
    const h = activeHop(a, t);
    if (h !== null) {
      const k = clamp01((t - h.takeoff) / (h.land - h.takeoff));
      y = 4 * k * (1 - k) * h.height;
      tilt = Math.sin(Math.PI * k) * 0.16;
      const dx = h.tx - h.fx, dz = h.tz - h.fz, l = Math.hypot(dx, dz) || 1;
      tiltX = dz / l; tiltZ = -dx / l;            // axis perpendicular to travel
    }
    return { object: objectMatrix(a.x, y, a.z, a.yaw, tiltX, tiltZ, tilt, scale), skin: this.skin(a, t), lift: y, scale };
  }

  private skin(a: Actor, t: number): Float32Array {
    const m = model(a.type);
    const out = new Float32Array(36);
    const h = activeHop(a, t);
    const clip = h !== null ? CLIP.hop : a.clip, start = h !== null ? h.start : a.clipStart;
    const speed = h !== null ? h.speed : a.clipSpeed, loop = h === null && a.clipLoop;
    if (clip < 0 || t < start) {
      for (let b = 0; b < 3; b++) { out[b * 12] = 1; out[b * 12 + 4] = 1; out[b * 12 + 8] = 1; }
      return out;
    }
    const frames = m.frames[clip] ?? 1;
    const data = m.clips[clip] ?? new Float32Array(36);
    let f = (t - start) / 1000 * speed * MODEL_FPS;
    if (loop) f = f % (frames - 1);
    if (f > frames - 1) f = frames - 1;
    const f0 = Math.floor(f), f1 = Math.min(frames - 1, f0 + 1), k = f - f0;
    for (let i = 0; i < 36; i++) out[i] = (data[f0 * 36 + i] ?? 0) * (1 - k) + (data[f1 * 36 + i] ?? 0) * k;
    return out;
  }
}

/** Column-major 3x4 object matrix: T(x,y,z) * R(axis tilt) * R_y(yaw) * S. */
function objectMatrix(x: number, y: number, z: number, yaw: number, ax: number, az: number, tilt: number, s: number): Float64Array {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  let m = [cy * s, 0, -sy * s, 0, s, 0, sy * s, 0, cy * s];
  if (tilt !== 0) {
    // rotation about (ax, 0, az) by tilt (Rodrigues)
    const c = Math.cos(tilt), sn = Math.sin(tilt), t = 1 - c;
    const r = [t * ax * ax + c, sn * az, t * ax * az, -sn * az, c, sn * ax, t * ax * az, -sn * ax, t * az * az + c];
    const out = new Array<number>(9);
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) {
      out[col * 3 + row] = (r[row] ?? 0) * (m[col * 3] ?? 0) + (r[3 + row] ?? 0) * (m[col * 3 + 1] ?? 0) + (r[6 + row] ?? 0) * (m[col * 3 + 2] ?? 0);
    }
    m = out;
  }
  const o = new Float64Array(12);
  for (let i = 0; i < 9; i++) o[i] = m[i] ?? 0;
  o[9] = x; o[10] = y; o[11] = z;
  return o;
}

/** a * b for column-major 3x4 affine matrices (implicit last row 0 0 0 1). */
export function mul34(a: Float64Array, b: Float32Array): Float64Array {
  const o = new Float64Array(12);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 3] ?? 0, b1 = b[c * 3 + 1] ?? 0, b2 = b[c * 3 + 2] ?? 0;
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = (a[r] ?? 0) * b0 + (a[3 + r] ?? 0) * b1 + (a[6 + r] ?? 0) * b2 + (c === 3 ? (a[9 + r] ?? 0) : 0);
    }
  }
  return o;
}
