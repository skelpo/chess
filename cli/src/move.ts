/** One engine move as JSON: the protocol behind `chess-engine move`. Pure: imports only the engine. */
import { Chess, parseLevel } from "../../engine/src/chess.ts";
import type { Level } from "../../engine/src/chess.ts";

/** The request: a starting FEN, the moves played since, and a level 1..10. */
export interface MoveRequest {
  readonly start: string;
  readonly moves: readonly string[];
  readonly level: Level;
}

function fail(message: string): string { return JSON.stringify({ error: message }); }

export function parseRequest(text: string): MoveRequest | string {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return "Request is not JSON."; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "Request must be an object.";
  const record = value as Readonly<Record<string, unknown>>;
  const start = record["start"];
  const moves = record["moves"];
  const level = record["level"];
  if (typeof start !== "string") return "'start' must be a FEN string.";
  if (!Array.isArray(moves) || !moves.every((move) => typeof move === "string")) return "'moves' must be an array of coordinate moves.";
  if (typeof level !== "number") return "'level' must be an integer 1..10.";
  try { return { start, moves: moves as string[], level: parseLevel(level) }; } catch { return "'level' must be an integer 1..10."; }
}

/** Searches the position and answers one JSON line; `elapsed` reports milliseconds spent so far. */
export function answer(text: string, elapsed: () => number): string {
  const request = parseRequest(text);
  if (typeof request === "string") return fail(request);
  let game: Chess;
  try { game = new Chess(request.start); } catch (error) { return fail(error instanceof Error ? error.message : "Invalid FEN."); }
  for (const move of request.moves) if (game.play(move) === null) return fail("Illegal move in history: " + move);
  if (game.status().state !== "playing") return fail("The game is over.");
  const result = game.search({ level: request.level });
  return JSON.stringify({
    move: result.move === null ? null : result.move.uci,
    claimDraw: result.claimDraw,
    score: result.score,
    depth: result.depth,
    nodes: result.nodes,
    line: result.principalVariation,
    completed: result.completed,
    ms: elapsed(),
  });
}
