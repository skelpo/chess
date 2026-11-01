import { Chess, START_FEN, levelSettings, parseLevel } from "../engine/src/chess.ts";
import { ChessApp, KeyDecoder } from "../tui/src/app.ts";

let passed = 0;
let fingerprint = "";
function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error("FAIL: " + label);
  passed++;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  assert(actual === expected, label + " (expected " + String(expected) + ", got " + String(actual) + ")");
}
function rejects(action: () => void, label: string): void {
  let threw = false;
  try { action(); } catch { threw = true; }
  assert(threw, label);
}
function play(game: Chess, moves: string): void {
  for (const move of moves.split(" ")) assert(game.play(move) !== null, "play " + move);
}
function hasMove(game: Chess, uci: string): boolean {
  for (const move of game.legalMoves()) if (move.uci === uci) return true;
  return false;
}

// Independent reference counts: https://www.chessprogramming.org/Perft_Results
const positions = [
  START_FEN,
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
];
const counts = [[20, 400, 8902, 197281], [48, 2039, 97862], [14, 191, 2812, 43238], [6, 264, 9467], [44, 1486, 62379], [46, 2079, 89890]];
for (let i = 0; i < positions.length; i++) {
  const fen = positions[i] ?? START_FEN;
  const game = new Chess(fen);
  const expected = counts[i] ?? [];
  for (let d = 0; d < expected.length; d++) equal(game.perft(d + 1), expected[d] ?? -1, "perft position " + String(i + 1) + " depth " + String(d + 1));
  equal(game.fen(), fen, "perft restores FEN");
  equal(game.history().length, 0, "perft restores history");
}
console.log("ok · six reference perft positions");

const start = new Chess();
equal(start.fen(), START_FEN, "initial FEN");
equal(start.perft(0), 1, "perft zero");
equal(start.pieceAt("e1")?.type ?? "", "king", "piece accessor");
equal(start.pieceAt("e4"), null, "empty square");
equal(start.play("e2e5"), null, "illegal move rejected");
equal(start.play("e2e4q"), null, "spurious promotion rejected");
play(start, "e2e4 e7e5 g1f3 b8c6 f1b5");
for (let i = 0; i < 5; i++) assert(start.undo() !== null, "undo opening");
equal(start.fen(), START_FEN, "undo restores counters and rights");
equal(start.undo(), null, "empty undo");
rejects((): void => { start.pieceAt("i1"); }, "invalid square rejected");
rejects((): void => { start.perft(-1); }, "invalid perft rejected");

const invalidFens = [
  "", "8/8/8/8/8/8/8/8 w - - 0 1", "8/8/8/8/8/8/4k3/4K3 w - - 0 1",
  "4k3/8/8/8/8/8/8/4K3 x - - 0 1", "4k3/8/8/8/8/8/8/4K3 w K - 0 1",
  "4k3/8/8/8/8/8/8/4K3 w - e6 0 1", "P3k3/8/8/8/8/8/8/4K3 w - - 0 1",
  "4k3/8/8/8/8/8/8/4K3 w - - 1.5 1", "4k3/8/8/8/8/8/8/4K3 w - - 0 0",
  "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", "4k3/8/8/8/8/8/8/4K3 w - - 0 1 extra",
];
for (const fen of invalidFens) {
  rejects((): void => { start.load(fen); }, "invalid FEN rejected");
  equal(start.fen(), START_FEN, "invalid load is atomic");
}

const castle = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
const castleFen = castle.fen();
assert(hasMove(castle, "e1g1") && hasMove(castle, "e1c1"), "both castling directions");
play(castle, "e1g1 e8c8");
equal(castle.pieceAt("f1")?.type ?? "", "rook", "white castled rook");
equal(castle.pieceAt("d8")?.type ?? "", "rook", "black castled rook");
castle.undo(); castle.undo();
equal(castle.fen(), castleFen, "castling undo");
play(castle, "h1h8");
assert(!castle.fen().includes("kq"), "rook capture removes castling right");
const throughCheck = new Chess("r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1");
assert(!hasMove(throughCheck, "e1g1"), "cannot castle through check");
assert(hasMove(throughCheck, "e1c1"), "other castle still allowed");

const ep = new Chess();
play(ep, "e2e4 a7a6 e4e5 d7d5");
const epFen = ep.fen();
const epMove = ep.play("e5d6");
assert(epMove !== null && epMove.enPassant && epMove.capture, "en passant move flags");
equal(ep.pieceAt("d5"), null, "en passant removes pawn");
ep.undo(); equal(ep.fen(), epFen, "en passant undo");
play(ep, "g1f3 a6a5");
assert(!hasMove(ep, "e5d6"), "en passant expires");
const pinnedEp = new Chess("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
assert(!hasMove(pinnedEp, "e5d6"), "en passant cannot expose own king");
const horizontalEp = new Chess("8/8/8/r4pPK/8/8/8/k7 w - f6 0 1");
assert(!hasMove(horizontalEp, "g5f6"), "horizontal en passant discovered check");

for (const promotion of ["q", "r", "b", "n"]) {
  const game = new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  const fen = game.fen();
  assert(hasMove(game, "a7a8" + promotion), "promotion option " + promotion);
  equal(game.play("a7a8"), null, "promotion suffix required");
  play(game, "a7a8" + promotion);
  equal(game.pieceAt("a8")?.color ?? "", "white", "promoted piece color");
  game.undo(); equal(game.fen(), fen, "promotion undo");
}
const blackPromotion = new Chess("4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1");
const blackPromotionFen = blackPromotion.fen();
play(blackPromotion, "a2b1n");
equal(blackPromotion.pieceAt("b1")?.type ?? "", "knight", "black capture underpromotion");
blackPromotion.undo(); equal(blackPromotion.fen(), blackPromotionFen, "capture promotion undo");

const mate = new Chess();
play(mate, "f2f3 e7e5 g2g4 d8h4");
equal(mate.status().state, "checkmate", "fool's mate");
equal(mate.status().winner, "black", "mate winner");
equal(mate.play("e2e4"), null, "no moves after mate");
equal(mate.search().move, null, "no search move after mate");
equal(new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").status().drawReason, "stalemate", "stalemate");
for (const fen of ["4k3/8/8/8/8/8/8/4K3 w - - 0 1", "4k3/8/8/8/8/8/8/2B1K3 w - - 0 1", "4k3/8/8/8/8/8/8/2N1K3 w - - 0 1", "4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1"]) {
  equal(new Chess(fen).status().drawReason, "insufficient-material", "dead material");
}
equal(new Chess("4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1").status().state, "playing", "two knights not a dead position");
equal(new Chess("2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1").status().state, "playing", "opposite-color bishops not dead");

const repetition = new Chess();
play(repetition, "g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1");
const beforeClaim = repetition.fen();
assert(repetition.claimDraw("f6g8"), "claim with intended repetition move");
equal(repetition.fen(), beforeClaim, "intended claim does not play move");
equal(repetition.status().drawReason, "threefold-repetition", "claimed repetition");
repetition.undo();
equal(repetition.status().state, "playing", "undo clears claim");
play(repetition, "f3g1 f6g8");
assert(repetition.status().canClaimThreefold, "threefold claim available");
equal(repetition.status().state, "playing", "threefold requires claim");
const historyBeforeSearch = repetition.history().join(" ");
repetition.search({ level: 3 });
equal(repetition.history().join(" "), historyBeforeSearch, "search preserves repetition history");
assert(repetition.status().canClaimThreefold, "search preserves claim");
play(repetition, "g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8");
equal(repetition.status().drawReason, "fivefold-repetition", "automatic fivefold");

// A non-capturable EP square must not distinguish otherwise identical positions.
const ignoredEp = new Chess();
play(ignoredEp, "a2a4 g8f6 g1f3 f6g8 f3g1 g8f6 g1f3 f6g8 f3g1");
assert(ignoredEp.status().canClaimThreefold, "irrelevant EP omitted from repetition key");
const fifty = new Chess("4k3/8/8/8/8/8/8/R3K3 w - - 99 1");
assert(fifty.claimDraw("a1a2"), "fifty-move intended claim");
equal(fifty.status().drawReason, "fifty-move", "fifty-move claim reason");
const seventyFive = new Chess("4k3/8/8/8/8/8/8/R3K3 w - - 149 1");
play(seventyFive, "a1a2");
equal(seventyFive.status().drawReason, "seventy-five-move", "automatic seventy-five-move");
const matePriority = new Chess("7k/8/5KQ1/8/8/8/8/8 w - - 149 1");
play(matePriority, "g6g7");
equal(matePriority.status().state, "checkmate", "mate precedes seventy-five-move draw");
console.log("ok · legality, FEN, undo, promotion, en passant, castling and draw rules");

const tactic = new Chess("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
const tacticFen = tactic.fen();
const solution = tactic.search({ level: 10, maxNodes: 10000, maxDepth: 3 });
assert(solution.move !== null, "search produces move");
assert(solution.score > 29000, "search finds mate");
equal(tactic.fen(), tacticFen, "search preserves FEN");
if (solution.move !== null) play(tactic, solution.move.uci);
equal(tactic.status().state, "checkmate", "search move actually mates");
const deterministic = new Chess();
const first = deterministic.search({ level: 5, maxNodes: 10000 });
fingerprint += (first.move?.uci ?? "-") + ":" + String(first.score) + ":" + String(first.nodes);
const second = deterministic.search({ level: 5, maxNodes: 10000 });
equal(first.move?.uci ?? "", second.move?.uci ?? "", "deterministic move");
equal(first.score, second.score, "deterministic score");
equal(first.nodes, second.nodes, "deterministic nodes");
const pvGame = new Chess();
for (const move of first.principalVariation) play(pvGame, move);
const bounded = deterministic.search({ level: 10, maxNodes: 1 });
equal(bounded.nodes, 1, "hard node limit");
equal(bounded.depth, 0, "incomplete iteration not reported");
assert(bounded.move !== null && hasMove(deterministic, bounded.move.uci), "legal fallback under tiny budget");
equal(deterministic.fen(), START_FEN, "interrupted search restores position");
for (let level = 1; level <= 10; level++) {
  const settings = levelSettings(parseLevel(level));
  const result = deterministic.search({ level: settings.level, maxNodes: 1000 });
  assert(result.move !== null && hasMove(deterministic, result.move.uci), "legal move at level " + String(level));
  assert(result.nodes <= 1000, "budget level " + String(level));
  fingerprint += "|" + (result.move?.uci ?? "-") + ":" + String(result.score) + ":" + String(result.nodes);
}
rejects((): void => { parseLevel(0); }, "invalid level");
rejects((): void => { parseLevel(1.5); }, "fractional level");
rejects((): void => { deterministic.search({ maxDepth: 0 }); }, "invalid depth");
rejects((): void => { deterministic.search({ maxNodes: NaN }); }, "invalid budget");

// Deterministic varied playout exercises state restoration beyond handpicked positions.
const randomGame = new Chess();
const snapshots: string[] = [];
let seed = 1234567;
for (let ply = 0; ply < 160 && randomGame.status().state === "playing"; ply++) {
  snapshots.push(randomGame.fen());
  const moves = randomGame.legalMoves();
  seed = (seed * 48271) % 2147483647;
  const move = moves[seed % moves.length];
  assert(move !== undefined, "playout selects a move");
  if (move !== undefined) play(randomGame, move.uci);
  equal(new Chess(randomGame.fen()).fen(), randomGame.fen(), "playout FEN roundtrip");
}
fingerprint += "|" + randomGame.fen();
for (let i = snapshots.length - 1; i >= 0; i--) {
  randomGame.undo(); equal(randomGame.fen(), snapshots[i] ?? "", "playout undo");
}
console.log("ok · mate search, all ten levels, budgets, determinism and state restoration");

const app = new ChessApp({ level: 2, human: "white", fen: START_FEN, color: false, unicode: false });
app.command("e2e4");
assert(app.computerTurn(), "AI turn after user move");
app.advanceComputer();
equal(app.game.turn(), "white", "AI replies");
app.command("undo"); equal(app.game.fen(), START_FEN, "TUI undo takes back pair");
app.command("level 10"); equal(app.level, 10, "TUI level");
app.command("level 0"); equal(app.level, 10, "invalid level leaves setting intact");
app.command("load invalid"); equal(app.game.fen(), START_FEN, "invalid load retains game");
app.command("side both");
app.key(" "); app.key("up"); app.key("up"); app.key("\r");
equal(app.game.history()[0] ?? "", "e2e4", "cursor move");
app.command("undo"); equal(app.game.fen(), START_FEN, "local undo single move");
app.command("flip"); assert(app.flipped, "flip board");
app.command("help"); assert(app.render(80).includes("load <FEN>"), "help rendered");
assert(!app.render(50).includes("\u001b["), "plain mode has no ANSI");
const promoteApp = new ChessApp({ level: 1, human: "both", fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", color: true, unicode: false });
promoteApp.cursorFile = 0; promoteApp.cursorRank = 6;
promoteApp.key(" "); promoteApp.key("up"); promoteApp.key(" ");
equal(promoteApp.promotion, "a7a8", "promotion chooser");
promoteApp.key("n"); equal(promoteApp.game.pieceAt("a8")?.type ?? "", "knight", "TUI underpromotion");
assert(promoteApp.render(80).includes("\u001b["), "ANSI render");
const decoder = new KeyDecoder();
equal(decoder.feed("\u001b").length, 0, "split escape prefix");
equal(decoder.feed("[").length, 0, "split escape bracket");
equal(decoder.feed("A")[0] ?? "", "up", "split arrow decoded");
equal(decoder.feed("e2e4\r").join(""), "e2e4\r", "typed move decoded");
decoder.feed("\u001b"); equal(decoder.flushEscape()[0] ?? "", "escape", "lone escape");
app.command("quit"); assert(!app.running, "quit");
console.log("ok · TUI commands, selection, promotion and streaming keyboard decoder");
console.log("fingerprint · " + fingerprint);
console.log("PASS · " + String(passed) + " assertions");
