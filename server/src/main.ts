/**
 * The online chess server: HTTP + JSON with long polling, for Perry (native) or Node/Bun.
 *
 *   POST /v1/register  {"name"}                 -> {"name","token"}           no auth
 *   GET  /v1/state?since=<version>              -> StateView, held up to 25 s until something changes
 *   POST /v1/action    {"type", "name"?, "uci"?} -> {"ok":true} | {"error"}
 *   GET  /v1/leaderboard                        -> {"leaderboard"}            no auth
 *   GET  /health                                -> ok
 *
 * Authenticated calls send "Authorization: Bearer <token>". Environment: PORT (8787), HOST (127.0.0.1),
 * CHESS_DATA (chess-data.json), and for tests CHESS_CLOCK_MS / CHESS_INCREMENT_MS (600000 / 5000). Run it behind an HTTPS reverse proxy.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Lobby, parseAction } from "./lobby.ts";
import type { Saved, User } from "./lobby.ts";

const PORT = Number(process.env["PORT"] ?? "8787");
const HOST = process.env["HOST"] ?? "127.0.0.1";
const DATA = process.env["CHESS_DATA"] ?? "chess-data.json";
const HOLD_MS = 25_000;
// Once a second, so a player who runs out of time loses promptly.
const SWEEP_MS = 1_000;
const MAX_BODY = 8192;
const REGISTRATIONS_PER_HOUR = 10;

function log(text: string): void { process.stdout.write(new Date().toISOString() + " " + text + "\n"); }

function load(): Lobby {
  if (!existsSync(DATA)) return new Lobby();
  const saved = JSON.parse(readFileSync(DATA, "utf8")) as Saved;
  log("loaded " + String(saved.users.length) + " players, " + String(saved.games.length) + " games from " + DATA);
  return new Lobby(saved);
}

const lobby = load();
lobby.newGameId = () => randomBytes(8).toString("hex");
// Shorter clocks for testing; the defaults are 10 minutes plus 5 seconds a move.
const clockMs = Number(process.env["CHESS_CLOCK_MS"] ?? "");
const incrementMs = Number(process.env["CHESS_INCREMENT_MS"] ?? "");
if (process.env["CHESS_CLOCK_MS"] !== undefined && Number.isFinite(clockMs) && clockMs > 0) lobby.clockMs = clockMs;
if (process.env["CHESS_INCREMENT_MS"] !== undefined && Number.isFinite(incrementMs) && incrementMs >= 0) lobby.incrementMs = incrementMs;

// Writes at most once a second after a change, through a temporary file so a crash never leaves half a file.
let savedVersion = lobby.version;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer !== null || lobby.version === savedVersion) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savedVersion = lobby.version;
    writeFileSync(DATA + ".tmp", JSON.stringify(lobby.save()));
    renameSync(DATA + ".tmp", DATA);
  }, 1000);
}

/** Long polls waiting for the version to pass `since`. */
interface Waiter { readonly user: User; readonly since: number; readonly response: ServerResponse; readonly timer: ReturnType<typeof setTimeout> }
let waiters: Waiter[] = [];

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Answers every waiting poll the latest change concerns, then saves. */
function changed(): void {
  const now = Date.now();
  const still: Waiter[] = [];
  for (const waiter of waiters) {
    if (lobby.version > waiter.since) { clearTimeout(waiter.timer); send(waiter.response, 200, lobby.view(waiter.user, now)); }
    else still.push(waiter);
  }
  waiters = still;
  scheduleSave();
}

const registrations = new Map<string, number[]>();
function allowRegistration(address: string, now: number): boolean {
  const recent = (registrations.get(address) ?? []).filter((at) => now - at < 3_600_000);
  if (recent.length >= REGISTRATIONS_PER_HOUR) { registrations.set(address, recent); return false; }
  recent.push(now);
  registrations.set(address, recent);
  return true;
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0] : undefined;
  return (first ?? request.socket.remoteAddress ?? "unknown").trim();
}

function authenticate(request: IncomingMessage, now: number): User | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return lobby.authenticate(header.slice(7).trim(), now);
}

function readBody(request: IncomingMessage, done: (body: unknown) => void, tooLarge: () => void): void {
  let text = "";
  let over = false;
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    text += chunk;
    if (text.length > MAX_BODY) over = true;
  });
  request.on("end", () => {
    if (over) { tooLarge(); return; }
    let value: unknown = null;
    try { value = text === "" ? null : JSON.parse(text); } catch { value = undefined; }
    done(value);
  });
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const now = Date.now();
  const url = new URL(request.url ?? "/", "http://server");
  const route = (request.method ?? "GET") + " " + url.pathname;

  if (route === "GET /health") { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok\n"); return; }
  if (route === "GET /v1/leaderboard") { send(response, 200, { leaderboard: lobby.leaderboard() }); return; }

  if (route === "POST /v1/register") {
    readBody(request, (body) => {
      const name = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["name"] : undefined;
      if (typeof name !== "string") { send(response, 400, { error: "Send {\"name\": \"...\"}." }); return; }
      if (!allowRegistration(clientAddress(request), now)) { send(response, 429, { error: "Too many new usernames from here; try again later." }); return; }
      const result = lobby.register(name, randomBytes(24).toString("hex"), now);
      if (!result.ok) { send(response, result.status, { error: result.error }); return; }
      log("registered " + result.value.name);
      send(response, 200, result.value);
      changed();
    }, () => send(response, 413, { error: "Request too large." }));
    return;
  }

  const user = authenticate(request, now);
  if (route === "GET /v1/state" || route === "POST /v1/action") {
    if (user === null) { send(response, 401, { error: "Unknown token: pick a username first." }); return; }
  }
  if (route === "GET /v1/state" && user !== null) {
    const since = Number(url.searchParams.get("since") ?? "-1");
    if (!Number.isFinite(since) || lobby.version > since) { send(response, 200, lobby.view(user, now)); changed(); return; }
    const timer = setTimeout(() => {
      waiters = waiters.filter((waiter) => waiter.response !== response);
      send(response, 200, lobby.view(user, Date.now()));
    }, HOLD_MS);
    waiters.push({ user, since, response, timer });
    changed();
    return;
  }
  if (route === "POST /v1/action" && user !== null) {
    readBody(request, (body) => {
      const action = parseAction(body);
      if (action === null) { send(response, 400, { error: "Unknown action." }); return; }
      const result = lobby.act(user, action, Date.now());
      if (!result.ok) { send(response, result.status, { error: result.error }); return; }
      send(response, 200, { ok: true });
      changed();
    }, () => send(response, 413, { error: "Request too large." }));
    return;
  }
  send(response, 404, { error: "Not found." });
}

function sweep(): void {
  if (lobby.sweep(Date.now())) changed();
  setTimeout(sweep, SWEEP_MS);
}

createServer(handle).listen(PORT, HOST, () => {
  log("chess server on http://" + HOST + ":" + String(PORT) + ", data in " + DATA);
  setTimeout(sweep, SWEEP_MS);
});
