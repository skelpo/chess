import { ChessApp, KeyDecoder, defaultOptions } from "./app.ts";
import { parseLevel } from "../../engine/src/chess.ts";
import type { Color } from "../../engine/src/chess.ts";

const USAGE = `Usage: chess [options]

  --level 1..10          Difficulty (default: 5)
  --side white|black|both  Your side, or local two-player (default: white)
  --fen "<FEN>"          Initial position
  --plain               Line-based terminal mode, also selected for pipes
  --no-color            Disable ANSI colors
  --unicode             Use chess symbols instead of ASCII letters
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

function run(): void {
  const defaults = defaultOptions();
  let level = defaults.level;
  let human: Color | "both" = defaults.human;
  let fen = defaults.fen;
  let plain = !process.stdin.isTTY || !process.stdout.isTTY || process.env["TERM"] === "dumb";
  let color = process.env["NO_COLOR"] === undefined;
  let unicode = false;
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i] ?? "";
    if (argument === "--help" || argument === "-h") { process.stdout.write(USAGE); return; }
    if (argument === "--plain") { plain = true; continue; }
    if (argument === "--no-color") { color = false; continue; }
    if (argument === "--unicode") { unicode = true; continue; }
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
  const app = new ChessApp({ level, human, fen, color: color && !plain, unicode });
  const decoder = new KeyDecoder();
  let pending = "";
  let closed = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  function draw(): void {
    if (closed) return;
    const frame = app.render(process.stdout.columns || 80);
    // Raw mode can disable the terminal's LF -> CRLF translation (Perry does).
    // Return to column one explicitly rather than relying on host TTY settings.
    process.stdout.write(plain ? frame : "\u001b[H\u001b[2J" + frame.replace(/\n/g, "\r\n"));
  }
  function restore(): void {
    if (closed) return;
    closed = true;
    if (escapeTimer !== null) clearTimeout(escapeTimer);
    if (!plain) {
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
    process.stdout.write("Thanks for playing.\n");
  }
  function advance(): void {
    if (!app.running) { finish(); return; }
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
        if (app.computerTurn()) {
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
  advance();
}

try { run(); }
catch (error: unknown) {
  process.stderr.write("chess: " + (error instanceof Error ? error.message : "Startup failed.") + "\n");
  process.exitCode = 1;
}
