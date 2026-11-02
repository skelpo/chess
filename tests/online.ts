/**
 * Online play in the terminal game, end to end: two ChessApps with real HTTP clients against a local server
 * (node server/src/main.ts, or the binary in $CHESS_SERVER), through username, lobby, a game and resigning.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChessApp } from "../tui/src/app.ts";
import { OnlineClient } from "../tui/src/online.ts";
import type { Account, AccountStore, Network } from "../tui/src/online.ts";
import { START_FEN } from "../engine/src/chess.ts";

let passed = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error("FAIL: " + label);
  passed++;
}

const port = 18000 + Math.floor(Math.random() * 2000);
const data = mkdtempSync(join(tmpdir(), "tuichess-online-"));
const command = process.env["CHESS_SERVER"];
const server = spawn(command ?? process.execPath, command === undefined ? ["server/src/main.ts"] : [], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CHESS_DATA: join(data, "data.json") },
  stdio: ["ignore", "pipe", "inherit"],
});

const network: Network = {
  async request(method, url, headers, body) {
    const response = await fetch(url, body === null ? { method, headers } : { method, headers, body });
    return { status: response.status, text: await response.text() };
  },
  later(ms, then) { setTimeout(then, ms); },
};
function memory(): AccountStore & { saved: Map<string, Account> } {
  const saved = new Map<string, Account>();
  return { saved, load: (s) => saved.get(s) ?? null, save: (s, a) => { if (a === null) saved.delete(s); else saved.set(s, a); } };
}

async function until(test: () => boolean, label: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("FAIL (timeout): " + label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  passed++;
}

function player(): { app: ChessApp; client: OnlineClient; store: ReturnType<typeof memory> } {
  const store = memory();
  const client = new OnlineClient("http://127.0.0.1:" + String(port) + "/", network, store);
  const app = new ChessApp({ level: 1, human: "white", fen: START_FEN, color: false, unicode: false });
  app.online = client;
  return { app, client, store };
}

async function main(): Promise<void> {
  await until(() => true, "start");
  for (let i = 0; ; i++) {
    try { if ((await fetch("http://127.0.0.1:" + String(port) + "/health")).ok) break; } catch { /* starting */ }
    if (i > 100) throw new Error("server did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const a = player();
  const b = player();
  // The local game waits while online.
  a.app.command("e2e4");
  assert(a.app.game.history().length === 1, "local move before going online");

  a.app.command("online");
  assert(a.app.mode === "online" && a.app.render(100).includes("PLAY ONLINE"), "online asks for a username");
  a.app.command("x");
  assert(a.app.message.includes("3 to 20"), "short name refused locally");
  a.app.command("alice_t");
  await until(() => a.client.account?.name === "alice_t" && a.client.view !== null, "alice registered and live");
  assert(a.store.saved.size === 1, "account saved");
  assert(a.app.render(100).includes("ONLINE · ALICE_T"), "lobby shown");

  b.app.command("online");
  b.app.command("name alice_t");
  await until(() => b.app.message.toLowerCase().includes("taken"), "duplicate username refused: " + b.app.message);
  b.app.command("name bob_t");
  await until(() => b.client.view !== null, "bob live");
  await until(() => a.client.view?.online.some((p) => p.name === "bob_t") === true, "alice sees bob online");

  a.app.command("play");
  await until(() => a.client.view?.queued === true, "alice queued");
  b.app.command("play");
  await until(() => a.client.view?.game !== null && a.client.view?.game !== undefined, "alice's game starts");
  await until(() => b.client.view?.game?.you === "black", "bob plays black");
  a.app.render(100); b.app.render(100);
  assert(a.app.game.history().length === 0, "online board starts fresh");
  assert(b.app.flipped && !a.app.flipped, "boards face each player");
  assert(a.app.render(100).includes("YOUR MOVE"), "alice to move");

  b.app.command("e7e5");
  assert(b.app.message.includes("Wait"), "bob must wait");
  a.app.command("e2e4");
  assert(a.app.game.history().length === 1, "move shown at once");
  await until(() => (b.client.view?.game?.moves.length ?? 0) === 1, "bob receives e2e4 by long poll");
  b.app.render(100);
  assert(b.app.render(100).includes("YOUR MOVE"), "bob to move");
  b.app.command("e7e5");
  await until(() => (a.client.view?.game?.moves.length ?? 0) === 2, "alice receives e7e5");
  a.app.command("undo");
  assert(a.app.message.includes("Not in online"), "no takebacks online");
  a.app.command("e2e5");
  assert(a.app.message.includes("Illegal"), "illegal move refused");

  // Select-and-move with the cursor: g1 to f3.
  a.app.render(100);
  a.app.cursorFile = 6; a.app.cursorRank = 0; a.app.key(" ");
  a.app.cursorFile = 5; a.app.cursorRank = 2; a.app.key(" ");
  await until(() => (b.client.view?.game?.moves.length ?? 0) === 3, "cursor move sent");

  b.app.command("resign");
  await until(() => a.client.view?.game?.result === "white", "bob resigned");
  const screen = a.app.render(100);
  assert(screen.includes("You won by resignation"), "verdict shown");
  assert(screen.includes("HIGH SCORES"), "high scores shown");
  a.app.command("lobby");
  await until(() => a.client.view?.game === null, "back in the lobby");

  // Challenges.
  a.app.command("challenge bob_t");
  await until(() => b.client.view?.incoming.includes("alice_t") === true, "bob sees the challenge");
  assert(b.app.render(100).includes("alice_t challenges you"), "challenge shown");
  b.app.command("lobby");
  await until(() => b.client.view?.game === null, "bob back in the lobby");
  b.app.command("accept alice_t");
  await until(() => a.client.view?.game?.result === null, "challenge accepted, new game");

  a.app.command("offline");
  assert(a.app.mode === "local" && a.app.game.history().length === 1, "engine game restored");

  a.client.stop(); b.client.stop();
  process.stdout.write("online: " + String(passed) + " assertions passed\n");
}

main().then(() => { server.kill(); rmSync(data, { recursive: true, force: true }); process.exit(0); },
  (error: unknown) => { server.kill(); rmSync(data, { recursive: true, force: true }); process.stderr.write(String(error) + "\n"); process.exit(1); });
