import { Chess, START_FEN, levelSettings, parseLevel } from "../../engine/src/chess.ts";
import type { Color, Level, Move, Piece, SearchResult } from "../../engine/src/chess.ts";
import { NAME, clockNow, formatClock, record, timeControl, verdict } from "./online.ts";
import type { GameView, OnlineClient } from "./online.ts";

export interface AppOptions {
  readonly level: Level;
  readonly human: Color | "both";
  readonly fen: string;
  readonly color: boolean;
  readonly unicode: boolean;
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
  "flip / help / quit",
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

  render(width: number = 80): string {
    this.syncOnline();
    const lines: string[] = [];
    const status = this.game.status();
    const title = this.paint("  CHESS", "1;38;5;151") + this.paint("   /   plain TypeScript", "38;5;245");
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
    lines.push("", "  " + this.paint("RECENT MOVES", "38;5;245") + "  " + (history.length === 0 ? "—" : history.slice(-8).join("  ")));
    if (status.canClaimFiftyMove || status.canClaimThreefold) lines.push("  A draw is available. Type draw to claim it.");
    lines.push("");
    for (const line of wrap(this.message, Math.max(24, width - 4))) lines.push("  " + line);
    if (this.showHelp) { lines.push(""); for (const line of this.mode === "online" ? ONLINE_HELP : HELP) lines.push("  " + line); }
    if (this.promotion !== "") lines.push("", "  PROMOTE: press q (queen), r (rook), b (bishop), or n (knight).");
    lines.push("", "  " + this.paint("> ", "38;5;151") + this.input);
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

/** Streaming decoder: escape sequences can arrive split across input chunks. */
export class KeyDecoder {
  private escape = "";
  feed(chunk: string): string[] {
    const keys: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charAt(i);
      if (this.escape !== "") {
        this.escape += c;
        if (this.escape === "\u001b[" || this.escape === "\u001bO") continue;
        if (this.escape.length === 3 && (this.escape.charAt(1) === "[" || this.escape.charAt(1) === "O")) {
          if (c === "A") keys.push("up");
          else if (c === "B") keys.push("down");
          else if (c === "C") keys.push("right");
          else if (c === "D") keys.push("left");
          else if (c >= "0" && c <= "9") continue;
          this.escape = ""; continue;
        }
        if (this.escape.length > 3 && c >= "0" && c <= "9") continue;
        if (c === ";" && this.escape.length < 20) continue;
        this.escape = "";
        if (c !== "~") { keys.push("escape"); if (c !== "\u001b") keys.push(c); }
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

export function defaultOptions(): AppOptions {
  return { level: 5, human: "white", fen: START_FEN, color: true, unicode: false };
}
