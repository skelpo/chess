import { ChessApp, KeyDecoder, defaultOptions } from "./app.ts";
import { detectGraphics } from "./view3d/view3d.ts";
import { DEFAULT_SERVER, OnlineClient } from "./online.ts";
import { VERSION } from "./version.ts";
import type { Network } from "./online.ts";
import { fileStore } from "./accounts.ts";
import { parseLevel } from "../../engine/src/chess.ts";
import type { Color } from "../../engine/src/chess.ts";
import { serve } from "../../mcp/src/serve.ts";
import { answer } from "../../cli/src/move.ts";

const USAGE = `Usage: tuichess [options]
       tuichess mcp     serve the chess tools to an AI agent (Model Context Protocol, stdio)

  --level 1..10          Difficulty (default: 5)
  --side white|black|both  Your side, or local two-player (default: white)
  --fen "<FEN>"          Initial position
  --plain               Line-based terminal mode, also selected for pipes
  --no-color            Disable ANSI colors
  --unicode             Use chess symbols instead of ASCII letters
  --3d                  3D board (truecolor terminal; also: type 3d in the game).
                        Real pixels in kitty, Ghostty, WezTerm and iTerm2; set
                        TUICHESS_GRAPHICS=blocks|kitty|iterm to choose
  --online              Start in online play (also: type online in the game)
  --server <url>        Online server (default: ${DEFAULT_SERVER}, or $TUICHESS_SERVER)
  --help                Show this help

Move with arrows and Space/Enter, or type e2e4 and press Enter.
Type help in the game for commands. Ctrl-C or quit exits.
Level names describe search presets, not measured Elo ratings.
`;

// Use the host's global process binding. Perry 0.5.1663 loses the native stdin
// intrinsic for an imported process binding inside callbacks; the global form
// works consistently in Node, Bun and Perry without runtime detection.
function setTerminalRawMode(enabled: boolean): void {
  process.stdin.setRawMode(enabled);
}

const network: Network = {
  async request(method, url, headers, body) {
    const response = await fetch(url, body === null ? { method, headers } : { method, headers, body });
    return { status: response.status, text: await response.text() };
  },
  later(ms, then) { setTimeout(then, ms); },
};

function readStdin(done: (text: string) => void): void {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { text += chunk; });
  process.stdin.on("end", () => { done(text); });
  process.stdin.resume();
}

function run(): void {
  const mode = process.argv[2] ?? "";
  if (mode === "mcp") { serve(); return; }
  if (mode === "move") {
    readStdin((text) => {
      const started = Date.now();
      process.stdout.write(answer(text, () => Date.now() - started) + "\n");
    });
    return;
  }
  const defaults = defaultOptions();
  let level = defaults.level;
  let human: Color | "both" = defaults.human;
  let fen = defaults.fen;
  let plain = !process.stdin.isTTY || !process.stdout.isTTY || process.env["TERM"] === "dumb";
  let color = process.env["NO_COLOR"] === undefined;
  let unicode = false;
  let threeD = false;
  let startOnline = false;
  let server = process.env["TUICHESS_SERVER"] ?? DEFAULT_SERVER;
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i] ?? "";
    if (argument === "--help" || argument === "-h") { process.stdout.write(USAGE); return; }
    if (argument === "--plain") { plain = true; continue; }
    if (argument === "--no-color") { color = false; continue; }
    if (argument === "--unicode") { unicode = true; continue; }
    if (argument === "--3d") { threeD = true; continue; }
    if (argument === "--online") { startOnline = true; continue; }
    if (argument === "--version" || argument === "-v") { process.stdout.write("tuichess " + VERSION + "\n"); return; }
    if (argument === "--server") {
      const value = process.argv[++i];
      if (value === undefined || !/^https?:\/\//.test(value)) throw new Error("--server needs an http(s) URL.");
      server = value;
      continue;
    }
    if (argument === "--level" || argument === "--side" || argument === "--fen") {
      const value = process.argv[++i];
      if (value === undefined) throw new Error("Missing value for " + argument);
      if (argument === "--level") level = parseLevel(Number(value));
      else if (argument === "--fen") fen = value;
      else {
        if (value !== "white" && value !== "black" && value !== "both") throw new Error("Side must be white, black, or both.");
        human = value;
      }
      continue;
    }
    throw new Error("Unknown option: " + argument);
  }
  const app = new ChessApp({ level, human, fen, color: color && !plain, unicode, threeD, graphics: detectGraphics(process.env) });
  const client = new OnlineClient(server, network, fileStore());
  app.online = client;
  let usedNetwork = false;
  const decoder = new KeyDecoder();
  let pending = "";
  let closed = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  // Online answers arrive between keypresses; several in a row draw once.
  let drawQueued = false;
  // Online clocks: redraw in place (no full clear, so no flicker) whenever a shown time changes.
  let ticker: ReturnType<typeof setInterval> | null = null;
  let shownClock = "";
  function tick(): void {
    if (closed || plain || !app.clockRunning()) return;
    const key = app.clockKey();
    if (key === shownClock) return;
    shownClock = key;
    redraw();
  }
  /** Repaint in place (no clear, so no flicker): clocks and 3D animation frames. */
  function redraw(): void {
    const frame = app.render(process.stdout.columns || 80, process.stdout.rows || 24);
    process.stdout.write("\u001b[H" + frame.replace(/\n/g, "\u001b[K\r\n") + "\u001b[J" + app.overlay() + terminalModes());
  }
  // The 3D board wants mouse reports (click, drag, scroll) and, for pixel
  // output, the size of a cell in pixels; the classic board wants neither.
  let modes3d = false;
  let shownImage = "";
  function terminalModes(): string {
    const on = !closed && app.view3d !== null;
    let out = "";
    if (on !== modes3d) {
      modes3d = on;
      out += on ? "\u001b[?1000h\u001b[?1002h\u001b[?1006h\u001b[16t" : "\u001b[?1000l\u001b[?1002l\u001b[?1006l";
    }
    const clear = app.view3d !== null ? app.view3d.clearImage() : "";
    if (!on && shownImage !== "") out += shownImage;
    shownImage = on ? clear : "";
    return out;
  }
  // 3D board: about 30 frames a second while pieces move, nothing otherwise.
  let animation: ReturnType<typeof setInterval> | null = null;
  function animate(): void {
    if (animation !== null || closed || plain || !app.animating()) return;
    animation = setInterval(() => {
      if (closed) return;
      redraw();
      if (!app.animating() && animation !== null) { clearInterval(animation); animation = null; }
    }, 33);
  }
  function drawSoon(): void {
    usedNetwork = true;
    if (ticker === null && !plain) ticker = setInterval(tick, 100);
    if (drawQueued || closed) return;
    drawQueued = true;
    setTimeout(() => { drawQueued = false; draw(); }, 10);
  }
  client.onChange = drawSoon;
  app.onAsync = drawSoon;
  function draw(): void {
    if (closed) return;
    if (!plain && app.view3d !== null) { redraw(); animate(); return; }
    const frame = app.render(process.stdout.columns || 80, process.stdout.rows || 24);
    // Raw mode can disable the terminal's LF -> CRLF translation (Perry does).
    // Return to column one explicitly rather than relying on host TTY settings.
    process.stdout.write(plain ? frame : terminalModes() + "\u001b[H\u001b[2J" + frame.replace(/\n/g, "\r\n"));
  }
  function restore(): void {
    if (closed) return;
    closed = true;
    if (escapeTimer !== null) clearTimeout(escapeTimer);
    if (ticker !== null) clearInterval(ticker);
    if (animation !== null) clearInterval(animation);
    if (!plain) {
      process.stdout.write((modes3d ? "\u001b[?1000l\u001b[?1002l\u001b[?1006l" : "") + shownImage);
      setTerminalRawMode(false);
      process.stdout.write("\u001b[0m\u001b[?25h\u001b[?1049l");
    }
    process.removeListener("SIGINT", finish);
    process.removeListener("SIGTERM", finish);
    process.stdout.removeListener("resize", draw);
    process.stdin.removeListener("data", receive);
    process.stdin.removeListener("end", onEnd);
    process.stdin.pause();
  }
  function finish(): void {
    restore();
    client.stop();
    process.stdout.write("Thanks for playing.\n");
    // A held long poll would keep the process alive for up to 25 s.
    if (usedNetwork) setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  }
  // The engine answers once the player's move has landed on the 3D board.
  let advanceQueued = false;
  function advance(): void {
    if (!app.running) { finish(); return; }
    if (app.computerTurn() && app.waiting()) {
      if (animation === null) draw();      // otherwise the animation timer is already painting
      if (!advanceQueued) { advanceQueued = true; setTimeout(() => { advanceQueued = false; if (!closed) advance(); }, 40); }
      return;
    }
    if (app.computerTurn()) {
      app.message = "Thinking at level " + String(app.level) + "…";
      draw();
      app.advanceComputer();
    }
    draw();
  }
  function receive(chunk: string): void {
    if (closed) return;
    if (plain) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !closed) {
        const command = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        app.command(command);
        advance();
        newline = pending.indexOf("\n");
      }
      if (pending.length > 4096) { pending = ""; app.message = "Input line is too long."; draw(); }
    } else {
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      for (const key of decoder.feed(chunk)) {
        app.key(key);
        if (!app.running) break;
        // Process each completed command before a pasted subsequent command.
        if (app.computerTurn() && !app.waiting()) {
          app.message = "Thinking at level " + String(app.level) + "…";
          draw();
          app.advanceComputer();
        }
      }
      advance();
      if (!closed) escapeTimer = setTimeout((): void => {
        const keys = decoder.flushEscape();
        for (const key of keys) app.key(key);
        if (keys.length > 0) draw();
      }, 40);
    }
  }
  function onEnd(): void {
    if (closed) return;
    if (plain && pending.trim() !== "") { app.command(pending); advance(); }
    if (!closed) finish();
  }
  function onError(error: Error): void {
    restore();
    if (error.message.includes("EPIPE")) return;
    process.stderr.write("chess: " + error.message + "\n");
    process.exitCode = 1;
  }

  process.on("exit", restore);
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
  process.stdout.on("resize", draw);
  process.stdout.on("error", onError);
  process.stdin.on("error", onError);
  process.stdin.setEncoding("utf8");
  if (!plain) {
    setTerminalRawMode(true);
    process.stdout.write("\u001b[?1049h\u001b[?25l");
  }
  process.stdin.on("data", receive);
  process.stdin.on("end", onEnd);
  process.stdin.resume();
  if (startOnline) app.goOnline();
  advance();
}

try { run(); }
catch (error: unknown) {
  process.stderr.write("chess: " + (error instanceof Error ? error.message : "Startup failed.") + "\n");
  process.exitCode = 1;
}
