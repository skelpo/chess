// Runs the tuichess engine off the main thread so the board keeps animating
// while it thinks. Replays the game from the start so repetition rules hold.
import { Chess, START_FEN, type Level } from "@plain-chess/engine";

interface Request { id: number; fen: string; moves: string[]; level: Level }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, fen, moves, level } = event.data;
  const chess = new Chess(fen || START_FEN);
  for (const uci of moves) chess.play(uci);
  const result = chess.search({ level });
  postMessage({ id, uci: result.move?.uci ?? null, claimDraw: result.claimDraw, score: result.score });
};
