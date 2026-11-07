/**
 * Turning the rasterized frame into terminal output:
 *  - blocks: truecolor half-block cells ("▀", two pixels per cell), works in any truecolor terminal
 *  - kitty:  the kitty graphics protocol (kitty, Ghostty, WezTerm, Konsole): real pixels, zlib-compressed
 *  - iterm:  iTerm2 inline images (PNG)
 */
import { deflateSync } from "node:zlib";
import type { Raster } from "./raster.ts";

export type Graphics = "blocks" | "kitty" | "iterm";

/** Pick the best output the terminal is known to support; TUICHESS_GRAPHICS overrides. */
export function detectGraphics(env: Record<string, string | undefined>): Graphics {
  const forced = env["TUICHESS_GRAPHICS"];
  if (forced === "blocks" || forced === "kitty" || forced === "iterm") return forced;
  if (env["TMUX"] !== undefined || (env["TERM"] ?? "").startsWith("screen")) return "blocks";
  const program = env["TERM_PROGRAM"] ?? "";
  const term = env["TERM"] ?? "";
  if (program === "iTerm.app") return "iterm";
  if (program === "ghostty" || program === "WezTerm" || env["KITTY_WINDOW_ID"] !== undefined ||
    term === "xterm-kitty" || term === "xterm-ghostty" || env["KONSOLE_VERSION"] !== undefined) return "kitty";
  return "blocks";
}

/**
 * Linear light (0..2) to 8-bit sRGB, with a soft shoulder so highlights roll
 * off instead of clipping: one table lookup per channel.
 */
const TONE = new Uint8Array(8192);
for (let i = 0; i < 8192; i++) {
  const v = i / 4096;
  const t = v > 0.8 ? 0.8 + (v - 0.8) / (1 + (v - 0.8) * 2.5) : v;
  TONE[i] = Math.round(Math.pow(Math.min(1, t), 1 / 2.2) * 255);
}

/** Average ss x ss samples into 8-bit sRGB. */
export function toRgb(r: Raster, ss: number): { data: Uint8Array; width: number; height: number } {
  const width = Math.floor(r.W / ss), height = Math.floor(r.H / ss);
  const data = new Uint8Array(width * height * 3);
  const color = r.color, W = r.W, tone = TONE;
  if (ss === 1) {
    // straight copy (pixel output): one plain loop, no per-pixel calls
    const n = width * height * 3;
    for (let i = 0; i < n; i++) {
      let k = Math.floor((color[i] ?? 0) * 4096);
      if (k < 0) k = 0; else if (k > 8191) k = 8191;
      data[i] = tone[k] ?? 0;
    }
    return { data, width, height };
  }
  const d = 4096 / (ss * ss);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cr = 0, cg = 0, cb = 0;
      for (let dy = 0; dy < ss; dy++) {
        let k = ((y * ss + dy) * W + x * ss) * 3;
        for (let dx = 0; dx < ss; dx++) { cr += color[k] ?? 0; cg += color[k + 1] ?? 0; cb += color[k + 2] ?? 0; k += 3; }
      }
      const o = (y * width + x) * 3;
      let ir = Math.floor(cr * d), ig = Math.floor(cg * d), ib = Math.floor(cb * d);
      if (ir < 0) ir = 0; else if (ir > 8191) ir = 8191;
      if (ig < 0) ig = 0; else if (ig > 8191) ig = 8191;
      if (ib < 0) ib = 0; else if (ib > 8191) ib = 8191;
      data[o] = tone[ir] ?? 0; data[o + 1] = tone[ig] ?? 0; data[o + 2] = tone[ib] ?? 0;
    }
  }
  return { data, width, height };
}

/**
 * Half-block cells: the top pixel is the foreground of "▀", the bottom pixel
 * its background. Colors are only sent when they change; equal halves are a space.
 * `labels` maps cell index to a character drawn over the board (coordinates).
 */
export function blocks(r: Raster, ss: number, cols: number, rows: number, labels: ReadonlyMap<number, string>): string[] {
  const img = toRgb(r, ss);
  const px = img.data, w = img.width;
  // 32 levels per channel: no visible banding at cell size, and neighbouring
  // cells match far more often, so fewer color codes go to the terminal
  const n = px.length;
  for (let i = 0; i < n; i++) px[i] = ((px[i] ?? 0) & 0xf8) | 4;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "", fg = "", bg = "";
    for (let col = 0; col < cols; col++) {
      const t = ((row * 2) * w + col) * 3, b = ((row * 2 + 1) * w + col) * 3;
      const b2 = "48;2;" + String(px[b]) + ";" + String(px[b + 1]) + ";" + String(px[b + 2]);
      const label = labels.get(row * cols + col);
      if (label !== undefined) {
        line += "\u001b[1;38;2;182;162;131;" + b2 + "m" + label + "\u001b[22m";
        fg = ""; bg = b2;
        continue;
      }
      if (px[t] === px[b] && px[t + 1] === px[b + 1] && px[t + 2] === px[b + 2]) {
        if (b2 !== bg) { line += "\u001b[" + b2 + "m"; bg = b2; }
        line += " ";
        continue;
      }
      const f2 = "38;2;" + String(px[t]) + ";" + String(px[t + 1]) + ";" + String(px[t + 2]);
      let codes = "";
      if (f2 !== fg) { codes += f2; fg = f2; }
      if (b2 !== bg) { codes += (codes === "" ? "" : ";") + b2; bg = b2; }
      line += (codes === "" ? "" : "\u001b[" + codes + "m") + "▀";
    }
    lines.push(line + "\u001b[0m");
  }
  return lines;
}

const IMAGE_ID = 7;

/** One frame for the kitty graphics protocol, scaled by the terminal to cols x rows cells; replaces the previous frame. */
export function kitty(img: { data: Uint8Array; width: number; height: number }, cols: number, rows: number): string {
  const z = deflateSync(img.data, { level: 1 });
  const payload = Buffer.from(z).toString("base64");
  const head = "a=T,f=24,o=z,s=" + String(img.width) + ",v=" + String(img.height) + ",i=" + String(IMAGE_ID) +
    ",p=1,c=" + String(cols) + ",r=" + String(rows) + ",C=1,q=2";
  let out = "";
  const chunk = 4096;
  for (let at = 0; at < payload.length; at += chunk) {
    const more = at + chunk < payload.length ? 1 : 0;
    out += "\u001b_G" + (at === 0 ? head + "," : "") + "m=" + String(more) + ";" + payload.slice(at, at + chunk) + "\u001b\\";
  }
  return out;
}

/** Remove the kitty image (leaving the 3D board, or exiting). */
export function kittyDelete(): string { return "\u001b_Ga=d,d=I,i=" + String(IMAGE_ID) + ",q=2\u001b\\"; }

/** One frame as an iTerm2 inline image (PNG), drawn without moving the cursor. */
export function iterm(img: { data: Uint8Array; width: number; height: number }, cols: number, rows: number): string {
  const png = encodePng(img.data, img.width, img.height);
  const payload = Buffer.from(png).toString("base64");
  return "\u001b7\u001b]1337;File=inline=1;size=" + String(png.length) + ";width=" + String(cols) + ";height=" + String(rows) +
    ";preserveAspectRatio=0;doNotMoveCursor=1:" + payload + "\u0007\u001b8";
}

// ---------------------------------------------------------------- PNG

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC[(c ^ (bytes[i] ?? 0)) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 1 }));
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunks: [string, Uint8Array][] = [["IHDR", ihdr], ["IDAT", idat], ["IEND", new Uint8Array(0)]];
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
