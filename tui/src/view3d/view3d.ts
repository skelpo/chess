/**
 * Terminal 3D board: ties the scene (scene.ts), the software rasterizer
 * (raster.ts) and the terminal output (output.ts) together.
 *
 * In any truecolor terminal it draws half-block cells. Where a graphics
 * protocol is available (kitty, Ghostty, WezTerm, iTerm2) it draws real
 * pixels instead, scaling its resolution to hold the frame rate.
 */
import type { Chess } from "../../../engine/src/chess.ts";
import { Raster } from "./raster.ts";
import type { CameraState } from "./raster.ts";
import { Scene, square } from "./scene.ts";
import type { Actor, Marks, Pose } from "./scene.ts";
import { blocks, iterm, kitty, kittyDelete, toRgb } from "./output.ts";
import type { Graphics } from "./output.ts";

export type { Marks } from "./scene.ts";
export type { Graphics } from "./output.ts";
export { detectGraphics } from "./output.ts";

const HOME: CameraState = { yaw: 0, pitch: 0.93, zoom: 1 };

export class View3D {
  readonly scene = new Scene();
  readonly raster = new Raster();
  /** How frames reach the terminal. */
  graphics: Graphics;
  camera: CameraState = { ...HOME };
  /** Half-block supersampling: 1 is faster, 2 smoother. */
  supersample = 2;
  /** Wood grain strength in half-block output (0..1). */
  grain = 0.25;
  /** Pixel size of one terminal cell, when the terminal has told us (pixel output). */
  cellWidth = 9;
  cellHeight = 18;
  /** Resolution factor for pixel output; lowered automatically when frames are slow. */
  pixelScale = 1;
  /** Milliseconds the last frame took (render and encode). */
  lastFrameMs = 0;
  /** Where the last frame's time went: scene, draw, convert, encode (ms). */
  timings = { scene: 0, draw: 0, convert: 0, encode: 0 };
  private image = "";
  private cols = 0;
  private rows = 0;

  constructor(graphics: Graphics = "blocks") { this.graphics = graphics; }

  get now(): () => number { return this.scene.now; }
  set now(fn: () => number) { this.scene.now = fn; }

  animating(): boolean { return this.scene.animating(); }
  busy(): boolean { return this.scene.busy(); }
  sync(game: Chess): void { this.scene.sync(game); }

  /** Graphics escape sequence for the last frame (pixel output), to write at the viewport's top-left cell. */
  overlay(): string { return this.image; }

  /** Escape sequence that removes the pixel frame from the screen. */
  clearImage(): string { return this.graphics === "kitty" ? kittyDelete() : ""; }

  orbit(yaw: number, pitch: number): void {
    this.camera.yaw += yaw;
    this.camera.pitch = Math.min(1.45, Math.max(0.3, this.camera.pitch + pitch));
  }
  zoom(factor: number): void { this.camera.zoom = Math.min(1.8, Math.max(0.55, this.camera.zoom * factor)); }
  resetCamera(): void { this.camera = { ...HOME }; }

  /**
   * Render `cols` x `rows` cells. Returns one string per row: half-block
   * cells, or blank cells under the pixel image (see overlay()).
   */
  render(game: Chess, marks: Marks, cols: number, rows: number): string[] {
    const started = Date.now();
    this.scene.sync(game);
    const t = this.scene.now();
    this.scene.update(t, marks);
    const poses = new Map<Actor, Pose>();
    for (const a of this.scene.actors) { const p = this.scene.pose(a, t); if (p !== null) poses.set(a, p); }
    this.cols = cols; this.rows = rows;
    const t1 = Date.now();
    const pixels = this.graphics !== "blocks";
    const ss = pixels ? 1 : this.supersample;
    const W = pixels ? Math.max(64, Math.round(cols * this.cellWidth * this.pixelScale)) : cols * ss;
    const H = pixels ? Math.max(32, Math.round(rows * this.cellHeight * this.pixelScale)) : rows * 2 * ss;
    const r = this.raster;
    r.resize(W, H);
    r.reflections = pixels;            // too faint to see in half-block cells
    r.grainAmount = pixels ? 1 : this.grain;
    r.setCamera(this.camera, marks.flipped);
    r.draw(game, marks, this.scene.actors, poses);
    const t2 = Date.now();
    let t3 = t2;
    let lines: string[];
    if (pixels) {
      r.drawLabels(marks.flipped);
      const img = toRgb(r, 1);
      t3 = Date.now();
      this.image = this.graphics === "kitty" ? kitty(img, cols, rows) : iterm(img, cols, rows);
      lines = [];
      const blank = " ".repeat(cols);
      for (let i = 0; i < rows; i++) lines.push(blank);
    } else {
      this.image = "";
      lines = blocks(r, ss, cols, rows, this.labels(cols, rows, marks.flipped));
    }
    this.lastFrameMs = Date.now() - started;
    this.timings = { scene: t1 - started, draw: t2 - t1, convert: t3 - t2, encode: Date.now() - t3 };
    if (pixels) {
      // hold about 25 frames a second: trade resolution for speed and back
      if (this.lastFrameMs > 45) this.pixelScale = Math.max(0.35, this.pixelScale * 0.85);
      else if (this.lastFrameMs < 25) this.pixelScale = Math.min(1, this.pixelScale * 1.06);
    }
    return lines;
  }

  /** Coordinate letters as text cells on the frame (half-block output). */
  private labels(cols: number, rows: number, flipped: boolean): Map<number, string> {
    const r = this.raster;
    const cw = r.W / cols, ch = r.H / rows;
    const labels = new Map<number, string>();
    const side = flipped ? -1 : 1;
    const put = (text: string): void => {
      const c = Math.floor(r.screenX(0) / cw), row = Math.floor(r.screenY(0) / ch);
      if (c >= 0 && c < cols && row >= 0 && row < rows) labels.set(row * cols + c, text);
    };
    for (let i = 0; i < 8; i++) {
      r.project(i - 3.5, 0, side * 4.27, 0); put("abcdefgh".charAt(i));
      r.project(-side * 4.27, 0, 3.5 - i, 0); put(String(i + 1));
    }
    return labels;
  }

  /** The square under a viewport cell (0-based), from the last frame. */
  pick(col: number, row: number): string | null {
    if (this.cols === 0 || col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    const r = this.raster;
    const id = r.pick((col + 0.5) / this.cols * r.W, (row + 0.5) / this.rows * r.H);
    return id < 0 ? null : square(id & 7, id >> 3);
  }
}
