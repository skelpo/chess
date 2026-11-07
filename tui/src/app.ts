import { Chess, START_FEN, levelSettings, parseLevel } from "../../engine/src/chess.ts";
import type { Color, Level, Move, Piece, SearchResult } from "../../engine/src/chess.ts";
import { NAME, clockNow, formatClock, record, timeControl, verdict } from "./online.ts";
import type { GameView, OnlineClient } from "./online.ts";
import { View3D } from "./view3d/view3d.ts";
import type { Graphics } from "./view3d/view3d.ts";

export interface AppOptions {
  readonly level: Level;
  readonly human: Color | "both";
  readonly fen: string;
  readonly color: boolean;
  readonly unicode: boolean;
  /** Start with the 3D board (needs color). */
  readonly threeD?: boolean;
  /** How the 3D board reaches the terminal (default: half-block characters). */
  readonly graphics?: Graphics;
}

export const ONLINE_HELP = [
  "e2e4 / arrows + Space    play your move",
  "play                     meet the next player who is waiting",
  "challenge <name>         challenge someone online",
  "accept / decline <name>  answer a challenge",
  "cancel                   stop waiting, or withdraw a challenge",
  "resign                   give up the game",
  "draw                     claim a draw (threefold or fifty moves)",
  "lobby                    leave a finished game",
  "retry                    reconnect",
  "offline                  back to the engine game",
  "flip / 3d / help / quit",
];

export const HELP = [
  "Arrows / Space / Enter   move cursor / select / move",
  "e2e4, a7a8q             play a move (promotion: q/r/b/n)",
  "undo                     take back your turn",
  "hint                     suggest a move",
  "level 1..10              change difficulty",
  "side white|black|both    choose side or local two-player",
  "new                      restart the initial position",
"flip                     rotate the board",
  "3d                       3D board on/off (needs a truecolor terminal)",
  "[ ] + - 0                3D: turn, zoom, reset view (or drag and scroll with the mouse)",
  "fen                      show the current FEN",
  "load <FEN>               start from a position",
  "moves [e2]               list legal moves",
  "draw [move]              claim a draw, optionally with an intended move",
  "online                   play people online, with high scores (tuichess.dev)",
  "help                     toggle this help",
  "quit / Ctrl-C / Ctrl-D   exit",
];

function pieceLetter(piece: Piece | null, unicode: boolean): string {
  if (piece === null) return " ";
  let index = 0;
  if (piece.type === "knight") index = 1;
  else if (piece.type === "bishop") index = 2;
  else if (piece.type === "rook") index = 3;
  else if (piece.type === "queen") index = 4;
  else if (piece.type === "king") index = 5;
  if (unicode) return (piece.color === "white" ? "♙♘♗♖♕♔" : "♟♞♝♜♛♚").charAt(index);
  return (piece.color === "white" ? "PNBRQK" : "pnbrqk").charAt(index);
}

function square(file: number, rank: number): string { return "abcdefgh".charAt(file) + String(rank + 1); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Invalid command."; }

/** UI state and rendering are separate from terminal I/O and can be embedded or tested. */
export class ChessApp {
  game: Chess;
  mode: "local" | "online" = "local";
  online: OnlineClient | null = null;
  /** Redraws the screen when an online answer arrives after the keypress that caused it. */
  onAsync: () => void = () => {};
  private localGame: Chess | null = null;
  private onlineBoard = "";
  level: Level;
  human: Color | "both";
  flipped: boolean;
  running = true;
  input = "";
  message = "Welcome. Play e2e4, or use arrows and Space. Type online to play people, help for commands.";
  showHelp = false;
  selected = "";
  promotion = "";
  cursorFile = 4;
  cursorRank = 1;
  lastSearch: SearchResult | null = null;
  /** The 3D board, when it is on. */
  view3d: View3D | null = null;
  private graphics: Graphics;
  /** Where the 3D viewport starts on screen (1-based cell), for mouse input and the pixel image. */
  private viewTop = 0;
  private viewLeft = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private initialFen: string;
  private color: boolean;
  private unicode: boolean;

  constructor(options: AppOptions) {
    this.game = new Chess(options.fen);
    this.initialFen = options.fen;
    this.level = options.level;
    this.human = options.human;
    this.flipped = options.human === "black";
    this.color = options.color;
    this.unicode = options.unicode;
    if (this.flipped) this.cursorRank = 6;
    this.graphics = options.graphics ?? "blocks";
    if (options.threeD === true && this.color) this.view3d = new View3D(this.graphics);
  }

  /** True while 3D pieces are moving: the terminal should keep redrawing. */
  animating(): boolean { return this.view3d !== null && this.view3d.animating(); }

  /** True while a move is still landing on the 3D board; the engine waits for it. */
  waiting(): boolean {
    if (this.view3d === null) return false;
    this.view3d.sync(this.game);
    return this.view3d.busy();
  }

  computerTurn(): boolean {
    return this.running && this.mode === "local" && this.human !== "both" && this.game.turn() !== this.human && this.game.status().state === "playing";
  }

  advanceComputer(): void {
    if (!this.computerTurn()) return;
    const result = this.game.search({ level: this.level });
    this.lastSearch = result;
    if (result.claimDraw) {
      this.game.claimDraw(); this.message = "Computer claims a draw.";
    } else if (result.move !== null) {
      this.game.play(result.move.uci);
      this.message = "Computer played " + result.move.uci + ". Your move.";
    }
    this.selected = "";
    this.promotion = "";
  }

  command(raw: string): void {
    const command = raw.trim().replace(/^:/, "");
    if (command === "") return;
    this.syncOnline();
    const words = command.split(/\s+/);
    const verb = (words[0] ?? "").toLowerCase();
    const argument = words[1] ?? "";
    try {
      if (verb === "quit" || verb === "exit" || verb === "q") { this.running = false; return; }
      if (verb === "help" || verb === "?") { this.showHelp = !this.showHelp; return; }
      if (verb === "flip") { this.flipped = !this.flipped; return; }
      if (verb === "3d") {
        if (!this.color) { this.message = "The 3D board needs a color terminal."; return; }
        this.view3d = this.view3d === null ? new View3D(this.graphics) : null;
        this.message = this.view3d === null ? "Classic board." : "3D board. Arrows and Space work as before; type 3d for the classic board.";
        return;
      }
      if (verb === "online") { this.goOnline(); return; }
      if (this.mode === "online") { this.onlineCommand(command, verb, words.slice(1).join(" ")); return; }
      if (verb === "fen") { this.message = this.game.fen(); return; }
      if (verb === "level") {
        this.level = parseLevel(Number(argument));
        this.message = "Level " + String(this.level) + " · " + levelSettings(this.level).name;
        return;
      }
      if (verb === "side") {
        if (argument !== "white" && argument !== "black" && argument !== "both") throw new Error("Use side white, side black, or side both.");
        this.human = argument;
        if (argument !== "both") this.flipped = argument === "black";
        this.selected = "";
        this.message = argument === "both" ? "Local two-player game." : "You play " + argument + ".";
        return;
      }
      if (verb === "new" || verb === "load") {
        const fen = verb === "new" ? this.initialFen : command.slice(5).trim();
        this.game.load(fen);
        this.initialFen = fen;
        this.selected = ""; this.promotion = ""; this.lastSearch = null;
        this.message = "New position. " + this.game.turn() + " to move.";
        return;
      }
      if (verb === "undo") {
        let move = this.game.undo();
        if (move !== null && this.human !== "both" && this.game.turn() !== this.human) move = this.game.undo() ?? move;
        if (move !== null) {
          this.cursorFile = move.from.charCodeAt(0) - 97;
          this.cursorRank = move.from.charCodeAt(1) - 49;
        }
        this.selected = ""; this.promotion = ""; this.lastSearch = null;
        this.message = move === null ? "No move to take back." : "Move taken back.";
        return;
      }
      if (verb === "moves") {
        const moves: string[] = [];
        for (const move of this.game.legalMoves()) if (argument === "" || move.from === argument) moves.push(move.uci);
        this.message = moves.length === 0 ? "No legal moves." : moves.join(" ");
        return;
      }
      if (verb === "draw") {
        this.message = this.game.claimDraw(argument) ? "Draw claimed." : "No draw can be claimed here.";
        return;
      }
      if (verb === "hint") {
        const result = this.game.search({ level: this.level });
        this.lastSearch = result;
        this.message = result.claimDraw ? "Hint: claim a draw." : result.move === null ? "The game is over." : "Hint: " + result.move.uci;
        return;
      }
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(verb)) { this.play(verb); return; }
      this.message = "Unknown command. Type help, or a move such as e2e4.";
    } catch (error: unknown) { this.message = errorText(error); }
  }

  key(key: string): void {
    if (key.startsWith("mouse:")) { this.mouse(key); return; }
    if (key.startsWith("cell:")) {
      // the terminal's answer to "how many pixels is a cell" (CSI 16 t)
      const parts = key.split(":");
      const h = Number(parts[1]), w = Number(parts[2]);
      if (this.view3d !== null && w > 0 && h > 0) { this.view3d.cellWidth = w; this.view3d.cellHeight = h; }
      return;
    }
    if (this.view3d !== null && this.input === "" && this.promotion === "") {
      const view = this.view3d;
      if (key === "[") { view.orbit(-0.2, 0); return; }
      if (key === "]") { view.orbit(0.2, 0); return; }
      if (key === "+" || key === "=") { view.zoom(0.9); return; }
      if (key === "-" || key === "_") { view.zoom(1 / 0.9); return; }
      if (key === "0") { view.resetCamera(); return; }
    }
    this.syncOnline();
    if (key === "\u0003" || key === "\u0004") { this.running = false; return; }
    if (key === "escape") { this.input = ""; this.selected = ""; this.promotion = ""; return; }
    if (this.promotion !== "") {
      if (key === "q" || key === "r" || key === "b" || key === "n") {
        const move = this.promotion + key;
        this.promotion = ""; this.play(move);
      }
      return;
    }
    const direction = this.flipped ? -1 : 1;
    if (key === "up") this.cursorRank = Math.min(7, Math.max(0, this.cursorRank + direction));
    else if (key === "down") this.cursorRank = Math.min(7, Math.max(0, this.cursorRank - direction));
    else if (key === "left") this.cursorFile = Math.min(7, Math.max(0, this.cursorFile - direction));
    else if (key === "right") this.cursorFile = Math.min(7, Math.max(0, this.cursorFile + direction));
    else if (key === "\u007f" || key === "\b") this.input = this.input.slice(0, -1);
    else if (key === "\r" || key === "\n") {
      if (this.input !== "") { const command = this.input; this.input = ""; this.command(command); }
      else this.select();
    } else if (key === " " && this.input === "") this.select();
    else if (key.length === 1 && key >= " " && key <= "~" && this.input.length < 512) this.input += key;
  }

  /**
   * Mouse on the 3D board: click a square to select or move, drag to turn
   * the view, scroll to zoom. Keys look like "mouse:<button>:<x>:<y>:<down|up>"
   * (1-based cells, xterm SGR button codes).
   */
  private mouse(key: string): void {
    const view = this.view3d;
    if (view === null) return;
    const parts = key.split(":");
    const button = Number(parts[1]), x = Number(parts[2]), y = Number(parts[3]), down = parts[4] === "down";
    if ((button & 64) !== 0) { if (down) view.zoom((button & 1) === 0 ? 0.92 : 1 / 0.92); return; }
    if ((button & 32) !== 0) {
      const d = this.drag;
      if (d === null) return;
      if (x !== d.x || y !== d.y) {
        view.orbit((x - d.x) * -0.06, (y - d.y) * 0.05);
        d.x = x; d.y = y; d.moved = true;
      }
      return;
    }
    if ((button & 3) !== 0) return;
    if (down) { this.drag = { x, y, moved: false }; return; }
    const d = this.drag;
    this.drag = null;
    if (d !== null && d.moved) return;
    const sq = view.pick(x - this.viewLeft, y - this.viewTop);
    if (sq === null || this.promotion !== "") return;
    this.syncOnline();
    this.cursorFile = sq.charCodeAt(0) - 97;
    this.cursorRank = sq.charCodeAt(1) - 49;
    this.select();
  }

  /** Graphics for the 3D board (pixel output): positioned at the viewport, written after the text frame. */
  overlay(): string {
    const view = this.view3d;
    if (view === null || view.overlay() === "") return "";
    return "\u001b[" + String(this.viewTop) + ";" + String(this.viewLeft) + "H" + view.overlay();
  }

  /** Switches to online play; the engine game waits until `offline`. */
  goOnline(): void {
    const client = this.online;
    if (client === null) { this.message = "Online play is not available here."; return; }
    if (this.mode === "local") { this.localGame = this.game; this.mode = "online"; }
    this.selected = ""; this.promotion = ""; this.lastSearch = null; this.onlineBoard = "";
    this.syncOnline();
    if (client.account === null) { this.message = "Pick a username: type it and press Enter (3 to 20 letters, digits, _ or -)."; return; }
    this.message = "Online as " + client.account.name + ". Type play to meet the next player, or challenge <name>.";
    client.start();
  }

  goOffline(): void {
    this.online?.stop();
    if (this.mode === "online" && this.localGame !== null) this.game = this.localGame;
    this.mode = "local";
    this.flipped = this.human === "black";
    this.selected = ""; this.promotion = ""; this.onlineBoard = "";
    this.message = "Back to the engine game.";
  }

  /** The time for clocks; tests can replace it. */
  now: () => number = () => Date.now();

  /** True while an online game's clock is running: the screen redraws every second then. */
  clockRunning(): boolean {
    const game = this.mode === "online" ? this.onlineGame() : null;
    return game !== null && game.result === null && game.clock !== null && game.clock.running !== null;
  }

  /** The clock text as shown now; it changes when the screen needs a redraw for the clocks. */
  clockKey(): string {
    const game = this.onlineGame();
    if (game === null || game.clock === null || this.online === null) return "";
    const times = clockNow(game.clock, this.online.viewAt, this.now());
    return formatClock(times.white) + "|" + formatClock(times.black);
  }

  /** The current online game, if any. */
  onlineGame(): GameView | null { return this.online?.view?.game ?? null; }

  /** Keeps the board in step with the server's game: the start position plus its moves. */
  syncOnline(): void {
    if (this.mode !== "online") return;
    const game = this.onlineGame();
    const key = game === null ? "none" : game.id + ":" + String(game.moves.length) + ":" + String(game.result);
    if (key === this.onlineBoard) return;
    const fresh = game === null || !this.onlineBoard.startsWith(game.id + ":");
    this.onlineBoard = key;
    const board = new Chess(game === null ? START_FEN : game.start);
    if (game !== null) for (const uci of game.moves) board.play(uci);
    this.game = board;
    this.selected = ""; this.promotion = "";
    if (fresh && game !== null) {
      this.flipped = game.you === "black";
      this.cursorFile = 4; this.cursorRank = game.you === "black" ? 6 : 1;
    }
  }

  private onlineCommand(command: string, verb: string, rest: string): void {
    const client = this.online;
    if (client === null) return;
    if (verb === "offline" || verb === "local") { this.goOffline(); return; }
    if (client.account === null) {
      const name = verb === "name" ? rest.trim() : command.trim();
      if (!NAME.test(name)) { this.message = "Usernames are 3 to 20 letters, digits, _ or -."; return; }
      this.message = "Asking for " + name + "…";
      this.later(client.register(name));
      return;
    }
    if (verb === "retry" || verb === "reconnect") { client.start(); this.message = "Reconnecting…"; return; }
    if (verb === "play" || verb === "queue" || verb === "anyone") { this.act({ type: "queue" }, "Waiting for the next player…"); return; }
    if (verb === "cancel" || verb === "unqueue") {
      const view = client.view;
      this.act({ type: view !== null && view.outgoing !== null ? "cancel" : "unqueue" }, "Cancelled.");
      return;
    }
    if (verb === "challenge" || verb === "accept" || verb === "decline") {
      const name = rest.trim();
      if (name === "") { this.message = "Say who: " + verb + " <name>."; return; }
      this.act({ type: verb, name }, verb === "challenge" ? "Challenged " + name + "." : verb === "accept" ? "" : "Declined.");
      return;
    }
    if (verb === "resign") { this.act({ type: "resign" }, ""); return; }
    if (verb === "draw") { this.act({ type: "draw" }, ""); return; }
    if (verb === "lobby" || verb === "leave" || verb === "new") { this.act({ type: "leave" }, "Back in the lobby."); return; }
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(verb)) { this.sendMove(verb); return; }
    if (verb === "undo" || verb === "hint" || verb === "level" || verb === "side" || verb === "load") {
      this.message = "Not in online games. Type offline for the engine game."; return;
    }
    if (verb === "fen") { this.message = this.game.fen(); return; }
    if (verb === "moves") {
      const moves: string[] = [];
      for (const move of this.game.legalMoves()) if (rest === "" || move.from === rest) moves.push(move.uci);
      this.message = moves.length === 0 ? "No legal moves." : moves.join(" ");
      return;
    }
    this.message = "Online: a move (e2e4), play, challenge <name>, accept <name>, resign, draw, lobby, offline. Type help for all.";
  }

  private sendMove(uci: string): void {
    const game = this.onlineGame();
    if (game === null || game.result !== null) { this.message = "No game in progress. Type play or challenge <name>."; return; }
    if (this.game.turn() !== game.you) { this.message = "Wait for your opponent's move."; return; }
    if (!this.game.legalMoves().some((move) => move.uci === uci)) { this.message = "Illegal move: " + uci + ". Type moves to see legal moves."; return; }
    // Shown at once; the server's answer confirms it or puts the board back.
    this.game.play(uci);
    this.selected = ""; this.promotion = "";
    this.cursorFile = uci.charCodeAt(2) - 97; this.cursorRank = uci.charCodeAt(3) - 49;
    this.onlineBoard = "";
    this.act({ type: "move", uci }, "Played " + uci + ".");
  }

  private act(action: Record<string, string>, done: string): void {
    const client = this.online;
    if (client === null) return;
    this.later(client.send(action).then((error) => error === "" ? done : error));
  }

  /** Shows what a request comes back with, then redraws. */
  private later(answer: Promise<string>): void {
    answer.then((text) => {
      if (text !== "") this.message = text;
      this.onlineBoard = "";
      this.syncOnline();
      this.onAsync();
    }).catch(() => { this.onAsync(); });
  }

  private onlinePanel(): string[] {
    const client = this.online;
    if (client === null) return [];
    const head = (text: string): string => this.paint(text, "1;38;5;151");
    const dim = (text: string): string => this.paint(text, "38;5;245");
    if (client.account === null) {
      return [head("PLAY ONLINE"), "", "Type a username and press", "Enter: 3 to 20 letters,", "digits, _ or -. No password:", "this computer keeps it.", "", dim(client.host), "offline    Engine game", ...(client.error === "" ? [] : ["", client.error])];
    }
    const view = client.view;
    if (view === null) {
      return [head("ONLINE · " + client.account.name.toUpperCase()), "", client.link === "error" ? client.error : "Connecting to " + client.host + "…", "", "retry      Reconnect", "offline    Engine game"];
    }
    const panel: string[] = [];
    const game = view.game;
    if (game !== null) {
      const opponent = game.you === "white" ? game.black : game.white;
      const status = this.game.status();
      let line = game.result !== null ? verdict(game)
        : (this.game.turn() === game.you ? "YOUR MOVE" : opponent.toUpperCase() + " TO MOVE") + (status.check ? " · CHECK" : "");
      if (client.pending) line += " …";
      panel.push(head(line), "");
      const times = game.clock === null ? null : clockNow(game.clock, client.viewAt, this.now());
      const side = (color: "white" | "black", name: string): string => {
        const label = (color === "white" ? "White  " : "Black  ") + (name + (game.you === color ? " (you)" : "")).padEnd(20, " ").slice(0, 20);
        if (times === null || game.clock === null) return label;
        const time = formatClock(times[color]);
        const running = game.clock.running === color;
        const low = times[color] < 30_000;
        return label + " " + this.paint((running ? "▶ " : "  ") + time, running ? (low ? "1;38;5;203" : "1;38;5;151") : "38;5;245");
      };
      panel.push(side("white", game.white));
      panel.push(side("black", game.black));
      if (game.clock !== null) panel.push(this.paint(timeControl(game.clock) + " · out of time loses", "38;5;245"));
      if (game.result === null && !game.opponentOnline) panel.push(dim(opponent + " is away: loses"), dim("after 10 minutes offline."));
      panel.push("");
      if (game.result === null) panel.push("e2e4       Your move", "resign     Give up", "draw       Claim a draw");
      else {
        panel.push("lobby      Back to the lobby");
        for (const from of view.incoming) panel.push(this.paint(from + " challenges you", "38;5;178"), "lobby, then accept " + from);
      }
      panel.push("offline    Engine game");
    } else {
      panel.push(head("ONLINE · " + view.me.name.toUpperCase()), record(view.me), "");
      if (view.queued) panel.push(this.paint("Waiting for an opponent…", "38;5;178"), "cancel     Stop waiting");
      else panel.push("play       Play anyone");
      for (const from of view.incoming) panel.push(this.paint(from + " challenges you", "38;5;178"), "accept " + from + " / decline " + from);
      if (view.outgoing !== null) panel.push("Waiting for " + view.outgoing, "cancel     Withdraw");
      panel.push("", head("ONLINE NOW"));
      if (view.online.length === 0) panel.push(dim("Nobody else right now."));
      for (const player of view.online.slice(0, 6)) panel.push(player.name + dim(player.status === "idle" ? "" : " · " + player.status));
      if (view.online.length > 6) panel.push(dim("and " + String(view.online.length - 6) + " more"));
      panel.push(dim("challenge <name>"));
    }
    panel.push("", head("HIGH SCORES"));
    if (view.leaderboard.length === 0) panel.push(dim("No rated games yet."));
    view.leaderboard.slice(0, 5).forEach((row, index) => {
      const text = String(index + 1) + ". " + row.name.padEnd(14, " ").slice(0, 14) + " " + String(row.wins) + "W " + String(row.losses) + "L " + String(row.draws) + "D";
      panel.push(row.name === view.me.name ? this.paint(text, "1") : text);
    });
    if (client.link === "error") panel.push("", this.paint(client.error, "38;5;178"));
    return panel;
  }

  render(width: number = 80, height: number = 24): string {
    this.syncOnline();
    const lines: string[] = [];
    const status = this.game.status();
    const title = this.paint("  TUICHESS", "1;38;5;151") + this.paint("   /   tuichess.dev", "38;5;245");
    lines.push(title, "");
    const settings = levelSettings(this.level);
    if (this.mode === "online") {
      const game = this.onlineGame();
      lines.push("  " + this.paint("ONLINE", "1;38;5;151") + "  " + (this.online?.host ?? "") +
        (game === null ? "" : "    " + game.white + " vs " + game.black + (game.rated ? "" : " · casual")));
    } else lines.push("  " + this.paint("LEVEL " + String(this.level), "1;38;5;151") + "  " + settings.name +
      "    " + (this.human === "both" ? "LOCAL TWO-PLAYER" : "YOU / " + this.human.toUpperCase()));
    lines.push("");
    let outcome = this.game.turn().toUpperCase() + " TO MOVE" + (status.check ? " · CHECK" : "");
    if (status.state === "checkmate") outcome = "CHECKMATE · " + (status.winner ?? "").toUpperCase() + " WINS";
    else if (status.state === "draw") outcome = "DRAW · " + (status.drawReason ?? "").replace(/-/g, " ");
    const panel: string[] = [this.paint(outcome, "1;38;5;151"), "", "Arrows     Move cursor", "Space      Select / move", "e2e4       Type a move", "help       All commands", "undo       Take back", "hint       Suggest a move", "online     Play people", "quit       Exit", ""];
    if (this.mode === "online") panel.splice(0, panel.length, ...this.onlinePanel());
    if (this.lastSearch !== null && this.mode === "local") {
      panel.push("Depth " + String(this.lastSearch.depth) + " · " + String(this.lastSearch.nodes) + " nodes");
      panel.push("PV " + this.lastSearch.principalVariation.slice(0, 4).join(" "));
    }
    const destinations: string[] = [];
    if (this.selected !== "") for (const move of this.game.legalMoves()) if (move.from === this.selected) destinations.push(move.to);
    const history = this.game.history();
    const last = history[history.length - 1] ?? "";
    if (this.view3d !== null) return this.render3d(lines, panel, destinations, history, status, width, height);
    const wide = width >= 78;
    const files = this.flipped ? "h  g  f  e  d  c  b  a" : "a  b  c  d  e  f  g  h";
    lines.push("      " + files + (wide ? "       " + (panel[0] ?? "") : ""));
    for (let row = 0; row < 8; row++) {
      const rank = this.flipped ? row : 7 - row;
      let line = "  " + String(rank + 1) + "  ";
      for (let col = 0; col < 8; col++) {
        const file = this.flipped ? 7 - col : col;
        const name = square(file, rank);
        const piece = this.game.pieceAt(name);
        let letter = pieceLetter(piece, this.unicode);
        const target = destinations.includes(name);
        if (piece === null) letter = target ? "·" : ((file + rank) & 1) === 0 ? "." : " ";
        const cursor = this.cursorFile === file && this.cursorRank === rank;
        if (this.color) {
          let background = ((file + rank) & 1) === 0 ? 240 : 250;
          if (last.slice(0, 2) === name || last.slice(2, 4) === name) background = 66;
          if (target) background = 65;
          if (name === this.selected) background = 178;
          if (cursor) background = 109;
          const foreground = piece !== null && piece.color === "white" ? 231 : 16;
          line += this.paint(" " + letter + " ", "1;48;5;" + String(background) + ";38;5;" + String(foreground));
        } else line += cursor ? "[" + letter + "]" : name === this.selected ? "(" + letter + ")" : " " + letter + " ";
      }
      line += "  " + String(rank + 1);
      if (wide) line += "    " + (panel[row + 1] ?? "");
      lines.push(line);
    }
    lines.push("      " + files + (wide ? "       " + (panel[9] ?? "") : ""));
    if (wide) for (let i = 10; i < panel.length; i++) lines.push("                                     " + (panel[i] ?? ""));
    else { lines.push(""); for (const line of panel) if (line !== "") lines.push("  " + line); }
    lines.push(...this.footer(history, status, width));
    return lines.join("\n") + "\n";
  }

  private footer(history: readonly string[], status: ReturnType<Chess["status"]>, width: number): string[] {
    const lines: string[] = [];
    lines.push("", "  " + this.paint("RECENT MOVES", "38;5;245") + "  " + (history.length === 0 ? "—" : history.slice(-8).join("  ")));
    if (status.canClaimFiftyMove || status.canClaimThreefold) lines.push("  A draw is available. Type draw to claim it.");
    lines.push("");
    for (const line of wrap(this.message, Math.max(24, width - 4))) lines.push("  " + line);
    if (this.showHelp) { lines.push(""); for (const line of this.mode === "online" ? ONLINE_HELP : HELP) lines.push("  " + line); }
    if (this.promotion !== "") lines.push("", "  PROMOTE: press q (queen), r (rook), b (bishop), or n (knight).");
    lines.push("", "  " + this.paint("> ", "38;5;151") + this.input);
    return lines;
  }

  /** The 3D board fills the space the terminal has; the panel stays on the right when it fits. */
  private render3d(head: string[], panel: string[], destinations: string[], history: readonly string[],
    status: ReturnType<Chess["status"]>, width: number, height: number): string {
    const view = this.view3d;
    if (view === null) return "";
    const footer = this.footer(history, status, width);
    const cursor = square(this.cursorFile, this.cursorRank);
    const side = [...panel, "", this.paint("CURSOR " + cursor.toUpperCase(), "38;5;245") + (this.selected === "" ? "" : this.paint("  ·  " + this.selected + " selected", "38;5;178")),
      this.paint("[ ] + - 0 view · mouse: drag, scroll", "38;5;240")];
    const wide = width >= 100;
    const rows = Math.max(10, height - head.length - footer.length - (wide ? 0 : side.length + 1) - 1);
    let cols = wide ? width - 44 : width - 2;
    cols = Math.max(20, Math.min(cols, Math.round(rows * 2 * 1.6)));
    const board = view.render(this.game, { cursor, selected: this.selected, targets: destinations, flipped: this.flipped }, cols, rows);
    this.viewTop = head.length + 1;
    this.viewLeft = 2;
    const lines = head.slice();
    for (let i = 0; i < board.length; i++) lines.push(" " + (board[i] ?? "") + (wide ? "   " + (side[i] ?? "") : ""));
    if (wide) for (let i = board.length; i < side.length; i++) lines.push(" ".repeat(cols + 4) + (side[i] ?? ""));
    else { lines.push(""); for (const line of side) if (line !== "") lines.push("  " + line); }
    lines.push(...footer);
    return lines.join("\n") + "\n";
  }

  private paint(text: string, style: string): string { return this.color ? "\u001b[" + style + "m" + text + "\u001b[0m" : text; }
  private play(uci: string): void {
    if (this.mode === "online") { this.sendMove(uci); return; }
    if (this.computerTurn()) { this.message = "It is the computer's turn."; return; }
    const move: Move | null = this.game.play(uci);
    if (move === null) { this.message = "Illegal move: " + uci + ". Type moves to see legal moves."; return; }
    this.selected = ""; this.promotion = "";
    this.cursorFile = uci.charCodeAt(2) - 97; this.cursorRank = uci.charCodeAt(3) - 49;
    this.message = "Played " + move.uci + ".";
  }
  private select(): void {
    const target = square(this.cursorFile, this.cursorRank);
    const piece = this.game.pieceAt(target);
    if (this.selected === target) { this.selected = ""; return; }
    if (piece !== null && piece.color === this.game.turn() && (this.mode === "local" || piece.color === this.onlineGame()?.you)) { this.selected = target; return; }
    if (this.selected === "") { this.message = "Select one of your pieces first."; return; }
    const uci = this.selected + target;
    for (const move of this.game.legalMoves()) {
      if (move.from === this.selected && move.to === target && move.promotion !== null) {
        this.promotion = uci; this.message = "Choose a promotion piece: q, r, b, or n."; return;
      }
    }
    this.play(uci);
  }
}

function wrap(text: string, width: number): string[] {
  const result: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + word.length + 1 > width) { result.push(line); line = ""; }
    line += (line === "" ? "" : " ") + word;
  }
  if (line !== "") result.push(line);
  return result;
}

/**
 * Streaming decoder: escape sequences can arrive split across input chunks.
 * Produces characters, "up"/"down"/"left"/"right", "escape", mouse reports
 * as "mouse:<button>:<x>:<y>:<down|up>" (SGR 1006 and classic X10), and the
 * terminal's cell size answer as "cell:<height>:<width>".
 */
export class KeyDecoder {
  private escape = "";
  private x10 = "";
  feed(chunk: string): string[] {
    const keys: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charAt(i);
      if (this.x10 !== "") {
        // classic mouse report: ESC [ M then three bytes (button, x, y), each offset by 32
        this.x10 += c;
        if (this.x10.length === 4) {
          const b = this.x10.charCodeAt(1) - 32, x = this.x10.charCodeAt(2) - 32, y = this.x10.charCodeAt(3) - 32;
          keys.push("mouse:" + String((b & 3) === 3 ? 0 : b) + ":" + String(x) + ":" + String(y) + ":" + ((b & 3) === 3 ? "up" : "down"));
          this.x10 = "";
        }
        continue;
      }
      if (this.escape !== "") {
        this.escape += c;
        if (this.escape === "\u001b[" || this.escape === "\u001bO") continue;
        if (this.escape.charAt(1) === "O") {
          const arrow = ARROWS[c];
          if (arrow !== undefined) keys.push(arrow);
          this.escape = "";
          continue;
        }
        if (this.escape.charAt(1) === "[") {
          if (this.escape === "\u001b[M") { this.x10 = "M"; this.escape = ""; continue; }
          const code = c.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            const key = csi(this.escape.slice(2, -1), c);
            if (key !== "") keys.push(key);
            this.escape = "";
          } else if (this.escape.length > 40) this.escape = "";
          continue;
        }
        this.escape = "";
        keys.push("escape");
        if (c !== "\u001b") keys.push(c);
      } else if (c === "\u001b") this.escape = c;
      else keys.push(c);
    }
    return keys;
  }
  flushEscape(): string[] {
    if (this.escape === "\u001b") { this.escape = ""; return ["escape"]; }
    return [];
  }
}

const ARROWS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };

/** A complete CSI sequence (parameters and final character) as a key, or "" to ignore it. */
function csi(params: string, final: string): string {
  const arrow = ARROWS[final];
  if (arrow !== undefined) return arrow;
  if (params.startsWith("<") && (final === "M" || final === "m")) {
    const p = params.slice(1).split(";");
    if (p.length === 3) return "mouse:" + (p[0] ?? "0") + ":" + (p[1] ?? "0") + ":" + (p[2] ?? "0") + ":" + (final === "M" ? "down" : "up");
  }
  if (final === "t" && params.startsWith("6;")) {
    const p = params.split(";");
    return "cell:" + (p[1] ?? "0") + ":" + (p[2] ?? "0");
  }
  return "";
}

export function defaultOptions(): AppOptions {
  return { level: 5, human: "white", fen: START_FEN, color: true, unicode: false };
}
