/** Tests for the Claude Code plugin's MCP server: tool logic in-process, then the real stdio protocol. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ChessSession, TOOLS } from "../mcp/src/tools.ts";
import { pluginCopies } from "../scripts/sync-plugin.ts";
import { answer } from "../cli/src/move.ts";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

let passed = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error("FAIL: " + label);
  passed++;
}
function contains(text: string, part: string, label: string): void {
  assert(text.includes(part), label + " (missing " + JSON.stringify(part) + " in:\n" + text + ")");
}

// Tool layer.
{
  const s = new ChessSession();
  let r = s.call("chess_new_game", { level: 1 });
  assert(!r.isError, "new game");
  contains(r.text, "8 | r n b q k b n r | 8", "initial board black back rank");
  contains(r.text, "White to move (you).", "white to move");

  r = s.call("chess_move", { move: "e2e4" });
  assert(!r.isError, "e2e4 legal");
  contains(r.text, "You played e2e4.", "player move noted");
  contains(r.text, "Engine (Black) played", "engine replied");
  contains(r.text, "White to move (you).", "back to player");

  r = s.call("chess_move", { move: "e4e6" });
  assert(r.isError, "illegal move rejected");
  contains(r.text, "Illegal move: e4e6.", "illegal message");

  r = s.call("chess_undo", {});
  assert(!r.isError, "undo");
  contains(r.text, "Moves: (none)", "undo removed both plies");

  r = s.call("chess_legal_moves", { square: "g1" });
  contains(r.text, "g1f3", "knight move listed");
  contains(r.text, "g1h3", "knight move listed 2");

  r = s.call("chess_hint", { level: 3 });
  contains(r.text, "Suggested move for White:", "hint");
  contains(s.call("chess_show", {}).text, "Moves: (none)", "hint does not play");

  r = s.call("chess_move", { move: 42 });
  assert(r.isError, "non-string move rejected");
  r = s.call("chess_new_game", { level: 11 });
  assert(r.isError, "level out of range rejected");
  r = s.call("chess_new_game", { fen: "not a fen" });
  assert(r.isError, "bad fen rejected");
  contains(s.call("chess_show", {}).text, "Moves: (none)", "bad fen leaves game intact");
}
{
  // As black, the engine opens and the board is flipped.
  const s = new ChessSession();
  const r = s.call("chess_new_game", { player: "black", level: 1 });
  contains(r.text, "Engine (White) played", "engine opens for black player");
  contains(r.text, "    h g f e d c b a", "board flipped for black");
  assert(r.text.indexOf("\n1 | ") >= 0 && r.text.indexOf("\n1 | ") < r.text.indexOf("\n8 | "), "rank 1 on top when flipped");
  contains(r.text, "\n8 | r n b k q b n r | 8", "black pieces mirrored on rank 8");
  assert(s.call("chess_move", { move: "e2e4" }).isError, "cannot move white pieces as black");
}
{
  // Mate in one, both mode: engine never moves on its own; hint finds mate.
  const s = new ChessSession();
  s.call("chess_new_game", { player: "both", fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1" });
  const hint = s.call("chess_hint", { level: 5 }).text;
  contains(hint, "a1a8", "hint finds back-rank mate");
  contains(hint, "White mates in 1", "mate score formatted");
  const r = s.call("chess_move", { move: "a1a8" });
  contains(r.text, "Checkmate. White wins.", "checkmate reported");
  assert(s.call("chess_move", { move: "g8h8" }).isError, "no moves after mate");
}
assert(TOOLS.every((tool) => tool.name.startsWith("chess_")), "tool names prefixed");
for (const copy of pluginCopies()) assert(readFileSync(copy.path, "utf8") === copy.text, copy.path + " is in sync (run node scripts/sync-plugin.ts)");
{
  // Snapshots rebuild the same game, including history the FEN cannot hold.
  const s = new ChessSession({ boardShownElsewhere: true });
  s.call("chess_new_game", { player: "both" });
  for (const move of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) s.call("chess_move", { move });
  const copy = ChessSession.restore(s.snapshot());
  assert(copy.view().status.includes("threefold draw claimable"), "restored repetition history");
  assert(JSON.stringify(copy.snapshot()) === JSON.stringify(s.snapshot()), "snapshot round trip");
  contains(s.call("chess_show", {}).text, "chess pane", "pane note when the board is shown elsewhere");
  assert(s.playerMove("e2e4") === null && s.view().last === "e2e4" && !s.engineToMove(), "move without reply in both mode");
}

// chess-engine move: one JSON request, one JSON answer.
{
  const start = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
  const mate = JSON.parse(answer(JSON.stringify({ start, moves: [], level: 5 }), () => 7)) as Record<string, unknown>;
  assert(mate["move"] === "a1a8" && mate["ms"] === 7 && mate["completed"] === true, "engine CLI finds mate");
  const after = JSON.parse(answer(JSON.stringify({ start: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: ["e2e4"], level: 2 }), () => 0)) as Record<string, unknown>;
  assert(typeof after["move"] === "string" && /^[a-h][1-8]/.test(String(after["move"])) && String(after["move"]).charAt(1) !== "2", "engine CLI moves for Black after history");
  for (const [request, error] of [["{bad", "Request is not JSON."], ['{"start":"x","moves":[],"level":5}', "FEN must contain six fields."], ['{"start":"' + start + '","moves":["a1a2x"],"level":5}', "Illegal move in history: a1a2x"], ['{"start":"' + start + '","moves":[],"level":11}', "'level' must be an integer 1..10."]] as const) {
    assert((JSON.parse(answer(request, () => 0)) as Record<string, unknown>)["error"] === error, "engine CLI error: " + error);
  }
  // The Perry build, when present, must answer exactly as the source does (timing aside).
  const native = new URL("../plugin/bin/chess-engine-" + process.platform + "-" + (process.arch === "x64" ? "x64" : process.arch), import.meta.url);
  if (existsSync(native)) {
    const request = JSON.stringify({ start: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", moves: [], level: 3 });
    const strip = (text: string) => text.replace(/,"ms":\d+/, "");
    const fromNative = strip(execFileSync(fileURLToPath(native), ["move"], { input: request, encoding: "utf8" }).trim());
    assert(fromNative === strip(answer(request, () => 0)), "Perry engine matches the source engine");
  }
}

// Protocol over stdio.
const server = fileURLToPath(new URL("../mcp/src/server.ts", import.meta.url));
const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map<number, (message: Record<string, unknown>) => void>();
let output = "";
const parseErrors: Record<string, unknown>[] = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  output += chunk;
  let newline = output.indexOf("\n");
  while (newline >= 0) {
    const message = JSON.parse(output.slice(0, newline)) as Record<string, unknown>;
    output = output.slice(newline + 1);
    const id = message["id"];
    if (typeof id === "number") pending.get(id)?.(message);
    else parseErrors.push(message);
    newline = output.indexOf("\n");
  }
});
let nextId = 1;
function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function result(message: Record<string, unknown>): Record<string, unknown> {
  return (message["result"] ?? {}) as Record<string, unknown>;
}
function toolText(message: Record<string, unknown>): string {
  const content = result(message)["content"] as { text: string }[] | undefined;
  return content?.[0]?.text ?? "";
}

const init = result(await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }));
assert(init["protocolVersion"] === "2025-06-18", "protocol version negotiated");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = result(await request("tools/list"))["tools"] as { name: string }[];
assert(listed.length === TOOLS.length, "tools listed");
const call = await request("tools/call", { name: "chess_new_game", arguments: { level: 1 } });
contains(toolText(call), "White to move (you).", "tool call over stdio");
const move = await request("tools/call", { name: "chess_move", arguments: { move: "d2d4" } });
contains(toolText(move), "Engine (Black) played", "state persists across calls");
const unknown = await request("tools/unknown");
assert((unknown["error"] as { code: number } | undefined)?.code === -32601, "unknown method error");
const ping = await request("ping");
assert(ping["result"] !== undefined, "ping");
child.stdin.write("{not json\n");
await request("ping");
assert(parseErrors.length === 1 && (parseErrors[0]?.["error"] as { code: number }).code === -32700, "parse error reported");
child.stdin.end();
await new Promise((resolve) => child.on("exit", resolve));

console.log("mcp: " + String(passed) + " assertions passed");
