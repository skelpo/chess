/**
 * Online play on the opencode board: the terminal game's OnlineClient (lib/online.ts) with the same
 * accounts file (lib/accounts.ts), wrapped in Solid signals. `game` adapts the server's game to the
 * board's Game interface, so the big board draws and plays it like the engine game. No engine here:
 * undo and hints are refused against a person.
 */
import { createSignal } from "solid-js";
import { Chess } from "./lib/chess.ts";
import { DEFAULT_SERVER, NAME, OnlineClient, verdict } from "./lib/online.ts";
import type { GameView, Network, StateView } from "./lib/online.ts";
import { fileStore } from "./lib/accounts.ts";
import type { View } from "./lib/session.ts";
import type { Extras, Game } from "./controller.ts";
import type { OnlineRecord } from "./game.ts";

const NO_ENGINE = "Not in online games: no undo or hints against a person. o goes back to the engine game.";

const network: Network = {
  async request(method, url, headers, body) {
    const response = await fetch(url, body === null ? { method, headers } : { method, headers, body });
    return { status: response.status, text: await response.text() };
  },
  later(ms, then) { setTimeout(then, ms); },
};

export type Online = {
  readonly client: OnlineClient;
  /** Reactive: the latest server state, or null before the first answer. */
  readonly view: () => StateView | null;
  readonly game: Game;
  readonly needsName: () => boolean;
  readonly link: () => string;
  readonly error: () => string;
  readonly pending: () => boolean;
  readonly message: () => string;
  readonly say: (text: string) => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly register: (name: string) => Promise<string>;
  /** Sends one lobby or game action and shows `done` (or the server's error). */
  readonly act: (action: Record<string, string>, done: string) => void;
  /** The record the agent's chess_board tool reads, or null in the lobby. */
  readonly record: () => OnlineRecord | null;
};

export function opponentOf(game: GameView): string { return game.you === "white" ? game.black : game.white; }

/** Server game -> the board's View. `optimistic` is a move sent but not yet confirmed. */
function boardView(game: GameView | null, optimistic: string | null, pending: boolean): View {
  const board = new Chess(game?.start);
  const moves = game === null ? [] : [...game.moves];
  if (optimistic !== null) moves.push(optimistic);
  for (const uci of moves) if (board.play(uci) === null) break;
  const status = board.status();
  let squares = "";
  let check: string | null = null;
  for (let rank = 1; rank <= 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const name = "abcdefgh".charAt(file) + String(rank);
      const piece = board.pieceAt(name);
      const letter = piece === null ? "." : piece.type === "knight" ? "n" : piece.type.charAt(0);
      squares += piece !== null && piece.color === "white" ? letter.toUpperCase() : letter;
      if (status.check && piece !== null && piece.type === "king" && piece.color === status.turn) check = name;
    }
  }
  const live = game !== null && game.result === null;
  const yourTurn = live && status.state === "playing" && status.turn === game.you && optimistic === null && !pending;
  const opponent = game === null ? "" : opponentOf(game);
  return {
    squares, check,
    player: game?.you ?? "white",
    turn: status.turn,
    playerTurn: yourTurn,
    legal: yourTurn ? board.legalMoves().map((move) => move.uci) : [],
    last: moves[moves.length - 1] ?? null,
    over: game !== null && game.result !== null,
    status: game === null ? "" : game.result !== null ? verdict(game)
      : (status.turn === game.you ? "Your move" : opponent + " to move") + (status.check ? ", check." : "."),
    level: 0, levelName: "",
    moves: numbered(moves),
  };
}

function numbered(moves: readonly string[]): string {
  const parts: string[] = [];
  moves.forEach((move, index) => parts.push(index % 2 === 0 ? String(index / 2 + 1) + ". " + move : move));
  return parts.join(" ");
}

export function createOnline(options: { readonly server?: string; readonly onEvent?: (text: string, view: StateView) => void } = {}): Online {
  const server = options.server ?? (process.env["TUICHESS_SERVER"] || DEFAULT_SERVER);
  const client = new OnlineClient(server, network, fileStore());
  const [tick, setTick] = createSignal(0);
  const [message, setMessage] = createSignal("");
  const [optimistic, setOptimistic] = createSignal<string | null>(null);
  const read = <T>(value: () => T) => () => { tick(); return value(); };
  const view = read(() => client.view);

  // Announce what changed, for toasts while the board is not on screen.
  let previous: StateView | null = null;
  client.onChange = () => {
    const next = client.view;
    const sent = optimistic();
    if (sent !== null && next?.game !== null && next?.game !== undefined && next.game.moves[next.game.moves.length - 1] === sent) setOptimistic(null);
    const ended = next?.game?.result !== null && next?.game?.result !== undefined && previous?.game?.id === next.game.id && previous.game.result === null;
    if ((next?.game !== null && next?.game !== undefined && next.game.id !== previous?.game?.id) || ended) setMessage("");
    if (next !== null && previous !== null && options.onEvent !== undefined) {
      const game = next.game;
      const before = previous.game;
      if (game !== null && (before === null || before.id !== game.id)) options.onEvent("New game against " + opponentOf(game) + ": you play " + game.you + ".", next);
      else if (game !== null && before !== null && game.moves.length > before.moves.length && game.result === null && game.moves.length % 2 === (game.you === "white" ? 0 : 1))
        options.onEvent(opponentOf(game) + " played " + (game.moves[game.moves.length - 1] ?? "") + ". Your move.", next);
      else if (game !== null && game.result !== null && before !== null && before.result === null) options.onEvent(verdict(game), next);
      for (const from of next.incoming) if (!previous.incoming.includes(from)) options.onEvent(from + " challenges you to a game.", next);
    }
    if (next !== null) previous = next;
    setTick((value) => value + 1);
  };

  const act = (action: Record<string, string>, done: string) => {
    void client.send(action).then((error) => {
      if (action["type"] === "move" && error !== "") setOptimistic(null);
      setMessage(error === "" ? done : error);
      setTick((value) => value + 1);
    });
    setTick((value) => value + 1);
  };

  const refuse = () => setMessage(NO_ENGINE);
  const game: Game = {
    view: () => { tick(); return boardView(client.view?.game ?? null, optimistic(), client.pending); },
    extras: (): Extras => ({ thinking: false, message: message(), hint: null, stats: "" }),
    play(uci) {
      const current = client.view?.game ?? null;
      if (current === null || current.result !== null) { setMessage("No game in progress: p plays anyone."); return; }
      const shown = boardView(current, optimistic(), client.pending);
      if (!shown.playerTurn) { setMessage("Wait for " + opponentOf(current) + "'s move."); return; }
      if (!shown.legal.includes(uci)) { setMessage("Illegal move: " + uci + "."); return; }
      // Shown at once; the server's answer confirms it or puts the board back.
      setOptimistic(uci);
      act({ type: "move", uci }, "You played " + uci + ".");
    },
    undo: refuse,
    newGame: refuse,
    hint: refuse,
    level: refuse,
    side: refuse,
    say: setMessage,
    dispose: () => client.stop(),
  };

  return {
    client, view, game,
    needsName: read(() => client.account === null),
    link: read(() => client.link),
    error: read(() => client.error),
    pending: read(() => client.pending),
    message,
    say: setMessage,
    start() { if (client.account !== null) client.start(); setTick((value) => value + 1); },
    stop() { client.stop(); setOptimistic(null); setTick((value) => value + 1); },
    async register(name) {
      const trimmed = name.trim();
      if (!NAME.test(trimmed)) return "Usernames are 3 to 20 letters, digits, _ or -.";
      setMessage("Asking for " + trimmed + "…");
      const answer = await client.register(trimmed);
      const text = answer.startsWith("You are ") ? "You are " + (client.account?.name ?? trimmed) + ". p plays anyone; m menu to challenge someone." : answer;
      setMessage(text);
      setTick((value) => value + 1);
      return text;
    },
    act,
    record: read((): OnlineRecord | null => {
      const current = client.view?.game ?? null;
      if (current === null) return null;
      return {
        pid: process.pid, server: client.server, white: current.white, black: current.black, you: current.you,
        start: current.start, moves: [...current.moves], result: current.result, verdict: verdict(current),
      };
    }),
  };
}
