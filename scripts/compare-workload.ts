import { Chess } from "../engine/src/chess.ts";

// One unchanged engine and workload for all four runtimes. The internal timer
// excludes process startup, setup, warmup and JSON serialization.
const mode = process.argv[2] ?? "search";
const amount = Number(process.argv[3] ?? "250000");
if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Expected a positive integer");
const game = new Chess();
const original = game.fen();
let checksum = 0;
let detail = "";

if (mode === "search") game.search({ level: 10, maxNodes: 10000 });
else if (mode === "perft") game.perft(3);
else if (mode === "evaluate") { for (let i = 0; i < 1000; i++) checksum += game.evaluate(); }
else if (mode === "legal") { for (let i = 0; i < 100; i++) checksum += game.legalMoves().length; }
else throw new Error("Expected search, perft, evaluate or legal");

checksum = 0;
const started = performance.now();
if (mode === "search") {
  const result = game.search({ level: 10, maxNodes: amount });
  checksum = result.nodes;
  detail = (result.move?.uci ?? "-") + ":" + String(result.score) + ":" + String(result.depth) + ":" +
    result.principalVariation.join(" ") + ":" + String(result.completed) + ":" + String(result.claimDraw);
} else if (mode === "perft") checksum = game.perft(amount);
else if (mode === "evaluate") { for (let i = 0; i < amount; i++) checksum += game.evaluate(); }
else { for (let i = 0; i < amount; i++) checksum += game.legalMoves().length; }
const milliseconds = performance.now() - started;
if (game.fen() !== original || game.history().length !== 0) throw new Error("Workload changed game state");
console.log(JSON.stringify({ mode, amount, checksum, detail, milliseconds }));
