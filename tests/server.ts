/** Tests for the online server: the lobby's rules in-process, then the HTTP server with long polling. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABANDON_MS, Lobby, ONLINE_MS, RATED_PLIES } from "../server/src/lobby.ts";
import type { User } from "../server/src/lobby.ts";

let passed = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error("FAIL: " + label);
  passed++;
}

// Lobby rules.
{
  const lobby = new Lobby();
  let now = 1_000_000;
  assert(lobby.register("ab", "t0", now).ok === false, "short name refused");
  assert(lobby.register("bad name", "t0", now).ok === false, "space refused");
  assert(lobby.register("Admin", "t0", now).ok === false, "reserved name refused");
  assert(lobby.register("Alice", "ta", now).ok, "alice registers");
  const taken = lobby.register("alice", "tx", now);
  assert(!taken.ok && taken.status === 409, "names are unique regardless of case");
  lobby.register("Bob", "tb", now);
  lobby.register("Carol", "tc", now);
  const alice = lobby.authenticate("ta", now) as User;
  const bob = lobby.authenticate("tb", now) as User;
  const carol = lobby.authenticate("tc", now) as User;
  assert(lobby.authenticate("nope", now) === null, "unknown token refused");

  // Play anyone: the first waiting player gets White.
  assert(lobby.act(alice, { type: "queue" }, now).ok, "alice queues");
  assert(lobby.view(bob, now).online.some((p) => p.name === "Alice" && p.status === "queued"), "bob sees alice queued");
  lobby.act(bob, { type: "queue" }, now);
  const game = lobby.view(alice, now).game;
  assert(game !== null && game.white === "Alice" && game.black === "Bob" && game.you === "white", "queue pairs alice (white) with bob");
  assert(lobby.view(bob, now).game?.you === "black", "bob plays black");
  assert(!lobby.act(bob, { type: "move", uci: "e7e5" }, now).ok, "not bob's turn");
  assert(!lobby.act(alice, { type: "move", uci: "e2e5" }, now).ok, "illegal move refused");
  assert(!lobby.act(carol, { type: "challenge", name: "Alice" }, now).ok, "can't challenge a player in a game");

  // Fool's mate in 4 plies: decided, but unrated.
  for (const [who, uci] of [[alice, "f2f3"], [bob, "e7e5"], [alice, "g2g4"], [bob, "d8h4"]] as const) assert(lobby.act(who, { type: "move", uci }, now).ok, "move " + uci);
  const over = lobby.view(alice, now).game;
  assert(over?.result === "black" && over.reason === "checkmate" && !over.rated, "checkmate ends the game, unrated under " + String(RATED_PLIES) + " plies");
  assert(lobby.leaderboard().length === 0, "unrated games stay off the high scores");

  // Challenges: decline, then accept; a rated resignation counts.
  lobby.act(alice, { type: "leave" }, now);
  lobby.act(bob, { type: "leave" }, now);
  assert(lobby.act(carol, { type: "challenge", name: "alice" }, now).ok, "carol challenges alice");
  assert(lobby.view(alice, now).incoming[0] === "Carol" && lobby.view(carol, now).outgoing === "Alice", "challenge visible both ways");
  assert(lobby.act(alice, { type: "decline", name: "Carol" }, now).ok && lobby.view(alice, now).incoming.length === 0, "decline");
  lobby.act(carol, { type: "challenge", name: "Alice" }, now);
  assert(lobby.act(alice, { type: "accept", name: "carol" }, now).ok, "accept");
  const second = lobby.view(alice, now).game;
  assert(second?.white === "Carol" && second.result === null, "challenger plays white");
  const moves = ["g1f3", "g8f6", "f3g1", "f6g8", "b1c3", "b8c6", "c3b1", "c6b8", "g1f3", "g8f6"];
  moves.forEach((uci, i) => assert(lobby.act(i % 2 === 0 ? carol : alice, { type: "move", uci }, now).ok, "rated move " + uci));
  assert(lobby.act(alice, { type: "resign" }, now).ok, "resign");
  assert(lobby.view(carol, now).game?.rated === true, "10 plies are rated");
  const table = lobby.leaderboard();
  assert(table[0]?.name === "Carol" && table[0].wins === 1 && table[1]?.name === "Alice" && table[1].losses === 1, "high scores count rated wins");
  assert(!lobby.act(alice, { type: "resign" }, now).ok, "no game to resign");

  // Mutual challenges start a game; presence and abandonment expire.
  lobby.act(alice, { type: "leave" }, now);
  lobby.act(carol, { type: "leave" }, now);
  lobby.act(alice, { type: "challenge", name: "Carol" }, now);
  lobby.act(carol, { type: "challenge", name: "Alice" }, now);
  assert(lobby.view(alice, now).game?.result === null, "crossed challenges start a game");
  now += ONLINE_MS + 1;
  lobby.authenticate("ta", now);
  assert(!lobby.view(alice, now).online.some((p) => p.name === "Carol"), "carol drops off the online list");
  now += ABANDON_MS;
  lobby.authenticate("ta", now);
  assert(lobby.sweep(now), "sweep finds the abandoned game");
  const abandoned = lobby.view(alice, now).game;
  assert(abandoned?.result === "white" && abandoned.reason === "abandoned", "the player who stayed wins an abandoned game");

  // Saved state round-trips.
  const copy = new Lobby(JSON.parse(JSON.stringify(lobby.save())));
  assert(copy.authenticate("tc", now)?.name === "Carol" && copy.leaderboard()[0]?.name === "Carol", "save and load keep players and scores");
}

// HTTP with long polling, against the real server.
const directory = mkdtempSync(join(tmpdir(), "chess-server-"));
const port = 18000 + Math.floor(Math.random() * 2000);
const binary = process.env["CHESS_SERVER"];
const command = binary !== undefined ? [binary] : [process.execPath, fileURLToPath(new URL("../server/src/main.ts", import.meta.url))];
const child = spawn(command[0] ?? "", command.slice(1), { env: { ...process.env, PORT: String(port), CHESS_DATA: join(directory, "data.json") }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve) => child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("chess server on")) resolve(); }));
const base = "http://127.0.0.1:" + String(port);
async function call(path: string, token: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = "Bearer " + token;
  const init: RequestInit = body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) };
  const response = await fetch(base + path, init);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
try {
  const a = await call("/v1/register", null, { name: "Dana" });
  const b = await call("/v1/register", null, { name: "Eli" });
  assert(a.status === 200 && typeof a.json["token"] === "string" && (a.json["token"] as string).length === 48, "register returns a token");
  assert((await call("/v1/register", null, { name: "dana" })).status === 409, "taken name over HTTP");
  assert((await call("/v1/state", "wrong")).status === 401, "bad token over HTTP");
  const ta = a.json["token"] as string;
  const tb = b.json["token"] as string;
  const first = await call("/v1/state", ta);
  const version = first.json["version"] as number;
  await call("/v1/state", tb);
  // A held poll returns as soon as the other player acts.
  const started = Date.now();
  const held = call("/v1/state?since=" + String((await call("/v1/state", ta)).json["version"]), ta);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert((await call("/v1/action", tb, { type: "queue" })).status === 200, "eli queues");
  const woke = await held;
  assert(Date.now() - started < 5000 && Array.isArray(woke.json["online"]), "long poll wakes on a change");
  assert((woke.json["online"] as { name: string; status: string }[]).some((p) => p.name === "Eli" && p.status === "queued"), "poll shows eli queued");
  await call("/v1/action", ta, { type: "queue" });
  const playing = await call("/v1/state", ta);
  const game = playing.json["game"] as { white: string; you: string } | null;
  assert(game !== null && game.white === "Eli" && game.you === "black", "queue starts a game over HTTP");
  assert((await call("/v1/action", tb, { type: "move", uci: "e2e4" })).status === 200, "move over HTTP");
  assert((await call("/v1/action", tb, { type: "move", uci: "d2d4" })).status === 409, "out of turn over HTTP");
  assert((await call("/v1/action", ta, { type: "fly" })).status === 400, "unknown action");
  assert(version >= 0, "state has a version");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const saved = JSON.parse(readFileSync(join(directory, "data.json"), "utf8")) as { users: { name: string }[]; games: { moves: string[] }[] };
  assert(saved.users.length === 2 && saved.games[0]?.moves[0] === "e2e4", "server saves players and games");
} finally {
  child.kill();
  rmSync(directory, { recursive: true, force: true });
}
console.log("server" + (binary !== undefined ? " (" + binary + ")" : "") + ": " + String(passed) + " assertions passed");
