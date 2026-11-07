// Player settings and the game in progress, kept in localStorage so a
// reload (or the next launch of the native build) picks up where you were.
import type { Color, Level } from "@plain-chess/engine";

export type Speed = "slow" | "normal" | "fast";

export interface Settings {
  /** Side for the next new game. */
  color: Color | "random";
  level: Level;
  hints: boolean;
  lastMove: boolean;
  shadows: boolean;
  speed: Speed;
}

export interface SavedGame {
  startFen: string;
  moves: string[];
  human: Color;
  level: Level;
}

const SETTINGS_KEY = "tuichess3d.settings";
const GAME_KEY = "tuichess3d.game";

export const DEFAULT_SETTINGS: Settings = { color: "white", level: 4, hints: true, lastMove: true, shadows: true, speed: "normal" };

/** Animation time scale for each speed setting. */
export const SPEED_SCALE: Record<Speed, number> = { slow: 0.7, normal: 1, fast: 1.6 };

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or disabled: settings just don't persist
  }
}

export function loadSettings(): Settings {
  const stored = read(SETTINGS_KEY) as Partial<Settings> | null;
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (stored !== null && typeof stored === "object") {
    if (stored.color === "white" || stored.color === "black" || stored.color === "random") s.color = stored.color;
    const level = Number(stored.level);
    if (Number.isInteger(level) && level >= 1 && level <= 10) s.level = level as Level;
    for (const k of ["hints", "lastMove", "shadows"] as const) if (typeof stored[k] === "boolean") s[k] = stored[k];
    if (typeof stored.speed === "string" && stored.speed in SPEED_SCALE) s.speed = stored.speed;
  }
  return s;
}

export function saveSettings(s: Settings): void { write(SETTINGS_KEY, s); }

export function loadGame(): SavedGame | null {
  const g = read(GAME_KEY) as SavedGame | null;
  if (g === null || typeof g.startFen !== "string" || !Array.isArray(g.moves)) return null;
  return g;
}

export function saveGame(g: SavedGame | null): void { write(GAME_KEY, g); }
