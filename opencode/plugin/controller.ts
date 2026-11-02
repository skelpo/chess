/**
 * The board's game: a ChessSession saved to the shared game file after every change, an engine that
 * thinks in a worker thread, and a watcher that picks up the agent's changes from the chess_board tool.
 */
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { createSignal } from "solid-js";
import { formatScore } from "./lib/session.ts";
import type { ChessSession, Player, View } from "./lib/session.ts";
import { parseSaved, readText, restore, save, statePath } from "./game.ts";
import type { OnlineRecord } from "./game.ts";
import { searchPosition, type SearchReply, type SearchRequest } from "./engine-worker.ts";

export type Extras = {
  readonly thinking: boolean;
  readonly message: string;
  /** The suggested move, highlighted until the position changes. */
  readonly hint: string | null;
  /** Depth and nodes of the last search. */
  readonly stats: string;
};

export type Game = {
  readonly view: () => View;
  readonly extras: () => Extras;
  readonly play: (uci: string) => void;
  readonly undo: () => void;
  readonly newGame: (player?: Player) => void;
  readonly hint: () => void;
  readonly level: (delta: number) => void;
  readonly side: (player: Player) => void;
  readonly say: (message: string) => void;
  /** Records the online game the board shows (or null) in the shared file, for the agent. */
  readonly publishOnline?: (online: OnlineRecord | null) => void;
  readonly dispose: () => void;
};

const OPTIONS = { boardShownElsewhere: true, deferEngine: true } as const;
const HINT_LEVEL = 7;

export function createGame(file: string = statePath()): Game {
  let written = readText(file);
  let session: ChessSession = restore(parseSaved(written), OPTIONS);
  const [revision, setRevision] = createSignal(0);
  const [extras, setExtras] = createSignal<Extras>({ thinking: false, message: parseSaved(written)?.note ?? "", hint: null, stats: "" });
  const patch = (next: Partial<Extras>) => setExtras((current) => ({ ...current, ...next }));

  let online: OnlineRecord | null = null;
  let lastNote = parseSaved(written)?.note ?? "";
  const write = () => {
    try { written = save(session, "board", lastNote, file, online); } catch (error) { patch({ message: "Could not save the game: " + String(error) }); }
  };
  const commit = (note: string) => {
    lastNote = note;
    write();
    setRevision((value) => value + 1);
  };

  // Engine searches run in a worker; if workers are unavailable, search on this thread after a paint.
  let worker: Worker | null = null;
  let workerFailed = false;
  let nextID = 0;
  const waiting = new Map<number, { request: SearchRequest; resolve: (reply: SearchReply) => void }>();
  const settleAll = () => {
    for (const [id, item] of waiting) { waiting.delete(id); item.resolve(searchPosition(item.request)); }
  };
  const startWorker = (): Worker | null => {
    if (worker !== null || workerFailed) return worker;
    try {
      const created = new Worker(new URL("./engine-worker.ts", import.meta.url));
      created.on("message", (reply: SearchReply) => {
        const item = waiting.get(reply.id);
        waiting.delete(reply.id);
        item?.resolve(reply);
      });
      created.on("error", () => { workerFailed = true; worker = null; settleAll(); });
      created.unref();
      worker = created;
    } catch {
      workerFailed = true;
    }
    return worker;
  };
  const search = (level: number): Promise<SearchReply> => {
    const snapshot = session.snapshot();
    const request: SearchRequest = { id: ++nextID, start: snapshot.start, moves: snapshot.moves, level };
    return new Promise((resolve) => {
      const thread = startWorker();
      if (thread === null) { setTimeout(() => resolve(searchPosition(request)), 30); return; }
      waiting.set(request.id, { request, resolve });
      thread.postMessage(request);
    });
  };
  const statsLine = (reply: SearchReply, by: string) =>
    by + ": depth " + String(reply.depth) + ", " + reply.nodes.toLocaleString("en-US") + " nodes";

  const engineTurn = async (): Promise<void> => {
    if (!session.engineToMove() || extras().thinking) return;
    const at = revision();
    patch({ thinking: true, hint: null });
    const reply = await search(session.engineLevel);
    patch({ thinking: false });
    // The game changed while the engine thought (undo, new game, the agent): think again from there.
    if (revision() !== at) { void engineTurn(); return; }
    const note = reply.move === null && !reply.claimDraw ? null : session.playEngineMove(reply.move ?? "", reply.claimDraw);
    patch({ stats: statsLine(reply, "Engine"), message: note ?? reply.error ?? "The engine found no move." });
    if (note !== null) commit(note);
  };

  // The agent (chess_board tool) or another opencode window changed the game file.
  mkdirSync(dirname(file), { recursive: true });
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reload = () => {
    timer = null;
    const text = readText(file);
    if (text === null || text === written) return;
    const saved = parseSaved(text);
    if (saved === null) return;
    written = text;
    lastNote = saved.note;
    session = restore(saved, OPTIONS);
    patch({ hint: null, message: saved.note === "" ? "" : (saved.by === "agent" ? "Agent: " : "") + saved.note });
    setRevision((value) => value + 1);
    void engineTurn();
  };
  try {
    watcher = watch(dirname(file), (_event, name) => {
      if (name !== null && name !== basename(file)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(reload, 40);
    });
  } catch {
    watcher = null;
  }

  const busy = () => {
    if (!extras().thinking) return false;
    patch({ message: "The engine is thinking…" });
    return true;
  };
  const run = (tool: string, args: Record<string, unknown>) => {
    const result = session.call(tool, args);
    const note = result.text.split("\n")[0] ?? "";
    patch({ message: note, hint: null });
    if (!result.isError) { commit(note); void engineTurn(); }
  };

  void engineTurn();

  return {
    view: () => { revision(); return session.view(); },
    extras,
    play(uci) {
      if (busy()) return;
      const error = session.playerMove(uci);
      if (error !== null) { patch({ message: error }); return; }
      patch({ message: "You played " + uci + ".", hint: null });
      commit("You played " + uci + ".");
      void engineTurn();
    },
    undo() { if (!busy()) run("chess_undo", {}); },
    newGame(player) { if (!busy()) run("chess_new_game", { player: player ?? session.view().player, level: session.engineLevel }); },
    hint() {
      if (busy()) return;
      if (session.view().over) { patch({ message: "The game is over." }); return; }
      const at = revision();
      const mover = session.turn;
      patch({ thinking: true, message: "Looking for a hint…" });
      void search(HINT_LEVEL).then((reply) => {
        patch({ thinking: false });
        if (revision() !== at) return;
        if (reply.claimDraw) { patch({ message: "Hint: claim a draw." }); return; }
        if (reply.move === null) { patch({ message: reply.error ?? "No move available." }); return; }
        patch({
          hint: reply.move,
          message: "Hint: " + reply.move + " (" + formatScore(reply.score, mover).replace(" (positive favors White)", "") + ")",
          stats: statsLine(reply, "Hint"),
        });
      });
    },
    level(delta) {
      const next = Math.min(10, Math.max(1, session.engineLevel + delta));
      if (next !== session.engineLevel) run("chess_settings", { level: next });
    },
    side(player) { if (!busy()) run("chess_settings", { player }); },
    say(message) { patch({ message }); },
    publishOnline(next) {
      if (JSON.stringify(next) === JSON.stringify(online)) return;
      online = next;
      write();
    },
    dispose() {
      if (online !== null) { online = null; write(); }
      watcher?.close();
      if (timer !== null) clearTimeout(timer);
      void worker?.terminate();
      worker = null;
    },
  };
}
