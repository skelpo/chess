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

/** The online game the board shows, so the agent can read it. Moves and hints are refused while it is live. */
export type OnlineRecord = {
  /** The opencode process showing it; a record from a process that is gone is stale. */
  readonly pid: number;
  readonly server: string;
  readonly white: string;
  readonly black: string;
  readonly you: "white" | "black";
  readonly start: string;
  readonly moves: readonly string[];
  readonly result: "white" | "black" | "draw" | null;
  /** The board's verdict line once the game is over, e.g. "You won by checkmate." */
  readonly verdict: string;
};

export type Saved = {
  readonly version: 1;
  readonly snapshot: Snapshot;
  /** Set while the board shows an online game. */
  readonly online?: OnlineRecord | null;
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
    const online = value.online;
    return {
      version: 1, snapshot,
      online: online !== null && typeof online === "object" && Array.isArray(online.moves) && typeof online.start === "string" ? online : null,
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
export function save(session: ChessSession, by: Saved["by"], note: string, path: string = statePath(), online: OnlineRecord | null = null): string {
  const saved: Saved = { version: 1, snapshot: session.snapshot(), online, by, note, at: Date.now() };
  const text = JSON.stringify(saved) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + String(process.pid) + ".tmp";
  writeFileSync(temporary, text);
  renameSync(temporary, path);
  return text;
}

/** The online game from the file, unless the opencode process that wrote it has gone. */
export function liveOnline(saved: Saved | null): OnlineRecord | null {
  const online = saved?.online ?? null;
  if (online === null) return null;
  try { process.kill(online.pid, 0); } catch (error) {
    if ((error as { code?: string }).code !== "EPERM") return null;
  }
  return online;
}
