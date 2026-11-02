/** Runs engine searches off the TUI thread, so the board keeps drawing while the engine thinks. */
import { parentPort } from "node:worker_threads";
import { Chess, parseLevel } from "./lib/chess.ts";

export type SearchRequest = { readonly id: number; readonly start: string; readonly moves: readonly string[]; readonly level: number };
export type SearchReply = {
  readonly id: number;
  readonly move: string | null;
  readonly claimDraw: boolean;
  readonly score: number;
  readonly depth: number;
  readonly nodes: number;
  readonly line: readonly string[];
  readonly error?: string;
};

export function searchPosition(request: SearchRequest): SearchReply {
  try {
    const game = new Chess(request.start);
    for (const move of request.moves) if (game.play(move) === null) throw new Error("illegal move " + move);
    const result = game.search({ level: parseLevel(request.level) });
    return {
      id: request.id, move: result.move?.uci ?? null, claimDraw: result.claimDraw,
      score: result.score, depth: result.depth, nodes: result.nodes, line: result.principalVariation,
    };
  } catch (error) {
    return { id: request.id, move: null, claimDraw: false, score: 0, depth: 0, nodes: 0, line: [], error: String(error) };
  }
}

parentPort?.on("message", (request: SearchRequest) => {
  parentPort?.postMessage(searchPosition(request));
});
