/**
 * Online play for the terminal game: a username, the lobby, the play-anyone queue, challenges, games and
 * the high scores, through the tuichess server (server/src/main.ts) with long polling.
 * Network and storage are passed in, so the client runs the same in Node, Bun, Perry and tests.
 */
import type { Color } from "../../engine/src/chess.ts";

export const DEFAULT_SERVER = "https://api.tuichess.dev";
export const NAME = /^[A-Za-z0-9_-]{3,20}$/;
const RETRY_MS = 3000;

export type Result = "white" | "black" | "draw";
export interface Standing { readonly name: string; readonly wins: number; readonly losses: number; readonly draws: number }
export interface GameView {
  readonly id: string;
  readonly white: string;
  readonly black: string;
  readonly you: Color;
  readonly start: string;
  readonly moves: readonly string[];
  readonly result: Result | null;
  readonly reason: string | null;
  readonly rated: boolean;
  readonly opponentOnline: boolean;
  /** Null for untimed games. Times are as of the moment the server answered. */
  readonly clock: ClockView | null;
}
export interface ClockView {
  readonly white: number;
  readonly black: number;
  readonly running: Color | null;
  readonly initial: number;
  readonly increment: number;
}
export interface StateView {
  readonly version: number;
  readonly me: Standing;
  readonly online: readonly { readonly name: string; readonly status: "idle" | "queued" | "playing" }[];
  readonly queued: boolean;
  readonly incoming: readonly string[];
  readonly outgoing: string | null;
  readonly game: GameView | null;
  readonly leaderboard: readonly Standing[];
}

export interface Account { readonly name: string; readonly token: string }
export interface Reply { readonly status: number; readonly text: string }
export interface Network {
  request(method: "GET" | "POST", url: string, headers: Record<string, string>, body: string | null): Promise<Reply>;
  /** Runs `then` after `ms`; the client's only timer. */
  later(ms: number, then: () => void): void;
}
export interface AccountStore {
  load(server: string): Account | null;
  save(server: string, account: Account | null): void;
}

export type Link = "off" | "connecting" | "live" | "error";

function errorOf(reply: Reply): string {
  try {
    const value = JSON.parse(reply.text) as Record<string, unknown>;
    if (typeof value["error"] === "string") return value["error"];
  } catch { /* not JSON */ }
  return "HTTP " + String(reply.status);
}
function reason(error: unknown): string { return error instanceof Error ? error.message : "no answer"; }

export class OnlineClient {
  readonly server: string;
  account: Account | null;
  link: Link = "off";
  error = "";
  view: StateView | null = null;
  /** When `view` arrived, by this computer's clock: the running side's time counts down from here. */
  viewAt = 0;
  pending = false;
  /** Called after every change the screen should show. */
  onChange: () => void = () => {};
  private generation = 0;
  private readonly net: Network;
  private readonly store: AccountStore;

  constructor(server: string, net: Network, store: AccountStore) {
    this.net = net;
    this.store = store;
    this.server = server.trim().replace(/\/+$/, "") || DEFAULT_SERVER;
    this.account = store.load(this.server);
  }

  get host(): string { return this.server.replace(/^https?:\/\//, ""); }

  /** Starts (or restarts) the long poll; each answer updates `view`. */
  start(): void {
    const mine = ++this.generation;
    const me = this.account;
    if (me === null) return;
    if (this.view === null) this.link = "connecting";
    this.onChange();
    const loop = (since: number): void => {
      if (mine !== this.generation) return;
      this.call("GET", "/v1/state?since=" + String(since), me.token, null).then((reply) => {
        if (mine !== this.generation) return;
        if (reply.status === 401) {
          this.forget("The server no longer knows " + me.name + "; pick a username again.");
          return;
        }
        if (reply.status !== 200) throw new Error(errorOf(reply));
        const view = JSON.parse(reply.text) as StateView;
        this.show(view);
        this.net.later(0, () => loop(view.version));
      }).catch((error: unknown) => {
        if (mine !== this.generation) return;
        this.link = "error";
        this.error = "Cannot reach " + this.host + ": " + reason(error);
        this.onChange();
        this.net.later(RETRY_MS, () => loop(-1));
      });
    };
    loop(-1);
  }

  stop(): void { this.generation++; this.link = "off"; }

  /** Picks a username; resolves to what to tell the player. */
  async register(name: string): Promise<string> {
    if (!NAME.test(name)) return "Usernames are 3 to 20 letters, digits, _ or -.";
    try {
      const reply = await this.call("POST", "/v1/register", null, JSON.stringify({ name }));
      if (reply.status !== 200) return errorOf(reply);
      const value = JSON.parse(reply.text) as Record<string, unknown>;
      const token = value["token"];
      const chosen = value["name"];
      if (typeof token !== "string" || typeof chosen !== "string") return "The server did not return a token.";
      this.account = { name: chosen, token };
      this.store.save(this.server, this.account);
      this.start();
      return "You are " + chosen + ". Type play to meet the next player, or challenge <name>.";
    } catch (error: unknown) {
      return "Cannot reach " + this.host + ": " + reason(error);
    }
  }

  /** Sends one action, then shows the new state without waiting for the poll. Resolves to an error or "". */
  async send(action: Record<string, string>): Promise<string> {
    const me = this.account;
    if (me === null) return "Pick a username first.";
    if (this.pending) return "Still sending the last action.";
    this.pending = true;
    this.onChange();
    try {
      const reply = await this.call("POST", "/v1/action", me.token, JSON.stringify(action));
      if (reply.status !== 200) return errorOf(reply);
      const state = await this.call("GET", "/v1/state", me.token, null);
      if (state.status === 200) this.show(JSON.parse(state.text) as StateView);
      return "";
    } catch (error: unknown) {
      return "Cannot reach " + this.host + ": " + reason(error);
    } finally {
      this.pending = false;
    }
  }

  private forget(message: string): void {
    this.store.save(this.server, null);
    this.account = null;
    this.view = null;
    this.link = "off";
    this.error = message;
    this.onChange();
  }

  private show(view: StateView): void {
    if (this.view !== null && this.view.version > view.version) return;
    this.view = view;
    this.viewAt = Date.now();
    this.link = "live";
    this.error = "";
    this.onChange();
  }

  private call(method: "GET" | "POST", path: string, token: string | null, body: string | null): Promise<Reply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["authorization"] = "Bearer " + token;
    return this.net.request(method, this.server + path, headers, body);
  }
}

/** "3 W · 1 L · 0 D" */
export function record(standing: Standing): string {
  return String(standing.wins) + " W · " + String(standing.losses) + " L · " + String(standing.draws) + " D";
}

/** Both players' remaining time now, counting the running side down from when the view arrived. */
export function clockNow(clock: ClockView, viewAt: number, now: number): { readonly white: number; readonly black: number } {
  const spent = Math.max(0, now - viewAt);
  return {
    white: Math.max(0, clock.white - (clock.running === "white" ? spent : 0)),
    black: Math.max(0, clock.black - (clock.running === "black" ? spent : 0)),
  };
}

/** "9:41", or "0:07.3" in the last ten seconds. */
export function formatClock(ms: number): string {
  if (ms < 10_000) return "0:0" + (Math.floor(ms / 100) / 10).toFixed(1);
  const seconds = Math.ceil(ms / 1000);
  return String(Math.floor(seconds / 60)) + ":" + String(seconds % 60).padStart(2, "0");
}

/** "10+5" */
export function timeControl(clock: ClockView): string {
  return String(Math.round(clock.initial / 60_000)) + "+" + String(Math.round(clock.increment / 1000));
}

/** The finished game's verdict, from the player's side. */
export function verdict(game: GameView): string {
  if (game.result === null) return "";
  const how = game.reason === "timeout" ? "time" : game.reason === "timeout-vs-insufficient-material" ? "time, with no mating material left" : (game.reason ?? "").replace(/-/g, " ");
  const winner = game.result === "draw" ? null : game.result === "white" ? game.white : game.black;
  const mine = game.you === "white" ? game.white : game.black;
  const text = winner === null ? "Draw" : winner === mine ? "You won" : winner + " won";
  return text + (game.reason === "timeout" ? " on " : " by ") + how + (game.rated ? "." : " (too short to count).");
}
