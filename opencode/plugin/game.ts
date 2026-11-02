/**
 * The one game shared by the board (TUI plugin) and the agent's chess_board tool (server plugin).
 * They run in different processes, so the game lives in a small JSON file both sides read and write;
 * the board watches the file and redraws when the agent moves.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ChessSession } from "./lib/session.ts";
import type { SessionOptions, Snapshot } from "./lib/session.ts";

export type Saved = {
  readonly version: 1;
  readonly snapshot: Snapshot;
  /** Who changed the game last. */
  readonly by: "board" | "agent";
  /** A short line about the last change, shown on the board. */
  readonly note: string;
  readonly at: number;
};

/** `TUICHESS_BOARD_FILE` overrides the location, for tests. */
export function statePath(): string {
  const override = process.env["TUICHESS_BOARD_FILE"];
  if (override !== undefined && override !== "") return override;
  const state = process.env["XDG_STATE_HOME"];
  return join(state !== undefined && state !== "" ? state : join(homedir(), ".local", "state"), "tuichess", "opencode-board.json");
}

export function readText(path: string = statePath()): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function parseSaved(text: string | null): Saved | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Saved> | null;
    const snapshot = value?.snapshot;
    if (value?.version !== 1 || snapshot === undefined || typeof snapshot.start !== "string" || !Array.isArray(snapshot.moves)) return null;
    return {
      version: 1, snapshot,
      by: value.by === "agent" ? "agent" : "board",
      note: typeof value.note === "string" ? value.note : "",
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return null;
  }
}

/** The saved game, or a fresh one when there is none or it cannot be replayed. */
export function restore(saved: Saved | null, options: SessionOptions): ChessSession {
  if (saved !== null) {
    try { return ChessSession.restore(saved.snapshot, options); } catch { /* fall through to a new game */ }
  }
  return new ChessSession(options);
}

/** Writes atomically and returns the text written, so the writer can recognize its own change. */
export function save(session: ChessSession, by: Saved["by"], note: string, path: string = statePath()): string {
  const saved: Saved = { version: 1, snapshot: session.snapshot(), by, note, at: Date.now() };
  const text = JSON.stringify(saved) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + String(process.pid) + ".tmp";
  writeFileSync(temporary, text);
  renameSync(temporary, path);
  return text;
}
