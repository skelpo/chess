/** Chess tools for the MCP server. Pure: imports only the engine, no I/O. */
import { Chess, levelSettings, parseLevel } from "../../engine/src/chess.ts";
import type { Color, Level, SearchResult } from "../../engine/src/chess.ts";

export type Player = Color | "both";

export interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}
/** Everything needed to rebuild a session: FEN cannot encode repetition history, so moves are replayed. */
export type Snapshot = {
  readonly start: string;
  readonly moves: readonly string[];
  readonly player: Player;
  readonly level: number;
  readonly claimed: boolean;
};
/** Plain data for drawing the board. `squares` is 64 characters, a1 first, then b1 ... h8; "." is empty. */
export type View = {
  readonly squares: string;
  readonly player: Player;
  readonly turn: Color;
  readonly playerTurn: boolean;
  readonly legal: readonly string[];
  readonly last: string | null;
  readonly check: string | null;
  readonly over: boolean;
  readonly status: string;
  readonly level: number;
  readonly levelName: string;
  readonly moves: string;
};
export interface SessionOptions {
  /** The person sees the board elsewhere (a pane), so tool results ask the model not to repeat it. */
  readonly boardShownElsewhere?: boolean;
  /** Never run the engine on its own; the host plays engine moves (`search` + `playEngineMove`). */
  readonly deferEngine?: boolean;
}

const MATE = 30000;
const MAX_PLY = 128;
const LEVEL_SCHEMA = { type: "integer", minimum: 1, maximum: 10, description: "Engine difficulty 1..10 (5 = Club, 10 = Master; level 10 can take several seconds)." };

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "chess_new_game",
    description: "Start a new game, replacing the current one. The engine plays the side the player does not. If the player is black, the engine makes White's first move immediately. Returns the board.",
    inputSchema: {
      type: "object",
      properties: {
        player: { type: "string", enum: ["white", "black", "both"], description: "The player's side; 'both' means two humans and the engine never moves on its own. Default white." },
        level: LEVEL_SCHEMA,
        fen: { type: "string", description: "Optional six-field FEN to start from instead of the initial position." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "chess_move",
    description: "Play the player's move in UCI coordinate notation (e2e4, e1g1 to castle, a7a8q to promote). If the engine has the other side, it replies automatically. Returns both moves and the board.",
    inputSchema: {
      type: "object",
      properties: { move: { type: "string", description: "Coordinate move, for example e2e4 or e7e8q." } },
      required: ["move"],
      additionalProperties: false,
    },
  },
  {
    name: "chess_show",
    description: "Show the current board, whose turn it is, game status, FEN and move history.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "chess_legal_moves",
    description: "List the legal moves in the current position, optionally only those from one square.",
    inputSchema: {
      type: "object",
      properties: { square: { type: "string", description: "Origin square such as e2." } },
      additionalProperties: false,
    },
  },
  {
    name: "chess_hint",
    description: "Ask the engine for its best move, evaluation and principal variation without playing it. Only use when the player asks for a hint or analysis.",
    inputSchema: { type: "object", properties: { level: LEVEL_SCHEMA }, additionalProperties: false },
  },
  {
    name: "chess_engine_move",
    description: "Make the engine choose and play a move for the side to move, whoever owns it (useful in 'both' mode or to let the engine take over).",
    inputSchema: { type: "object", properties: { level: LEVEL_SCHEMA }, additionalProperties: false },
  },
  {
    name: "chess_undo",
    description: "Take back the player's last move and the engine's reply (one ply in 'both' mode).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "chess_claim_draw",
    description: "Claim a threefold-repetition or fifty-move draw, now or by announcing a move that would make it claimable (the announced move is not played).",
    inputSchema: {
      type: "object",
      properties: { move: { type: "string", description: "Optional announced coordinate move." } },
      additionalProperties: false,
    },
  },
  {
    name: "chess_settings",
    description: "Change the engine level or the player's side mid-game. If the engine now has the side to move, it plays.",
    inputSchema: {
      type: "object",
      properties: { level: LEVEL_SCHEMA, player: { type: "string", enum: ["white", "black", "both"] } },
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {}

function readObject(args: unknown): Readonly<Record<string, unknown>> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("Arguments must be an object.");
  return args as Readonly<Record<string, unknown>>;
}
function readString(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ToolError("'" + key + "' must be a string.");
  return value.trim();
}
function readLevel(args: Readonly<Record<string, unknown>>): Level | null {
  const value = args["level"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new ToolError("'level' must be an integer 1..10.");
  try { return parseLevel(value); } catch { throw new ToolError("'level' must be an integer 1..10."); }
}
function readPlayer(args: Readonly<Record<string, unknown>>): Player | null {
  const value = readString(args, "player");
  if (value === null) return null;
  if (value !== "white" && value !== "black" && value !== "both") throw new ToolError("'player' must be white, black or both.");
  return value;
}
function capitalized(color: Color): string { return color === "white" ? "White" : "Black"; }

/** A search score (centipawns for `mover`) in words, from White's point of view or as a mate. */
export function formatScore(score: number, mover: Color): string {
  const absolute = Math.abs(score);
  const favored: Color = score >= 0 ? mover : mover === "white" ? "black" : "white";
  if (absolute >= MATE - MAX_PLY) {
    const plies = MATE - absolute;
    if (plies === 0) return "checkmate";
    return capitalized(favored) + " mates in " + String(Math.ceil(plies / 2));
  }
  const white = mover === "white" ? score : -score;
  return (white >= 0 ? "+" : "-") + (Math.abs(white) / 100).toFixed(2) + " (positive favors White)";
}

/** One game per server process, like one terminal session. */
export class ChessSession {
  private game = new Chess();
  private player: Player = "white";
  private level: Level = 5;
  private startFen: string = this.game.fen();
  private readonly boardShownElsewhere: boolean;
  private readonly deferEngine: boolean;

  constructor(options: SessionOptions = {}) {
    this.boardShownElsewhere = options.boardShownElsewhere ?? false;
    this.deferEngine = options.deferEngine ?? false;
  }

  static restore(snapshot: Snapshot, options: SessionOptions = {}): ChessSession {
    const session = new ChessSession(options);
    const game = new Chess(snapshot.start);
    for (const move of snapshot.moves) if (game.play(move) === null) throw new Error("Saved game has an illegal move: " + move);
    if (snapshot.claimed) game.claimDraw();
    session.game = game;
    session.startFen = snapshot.start;
    session.player = snapshot.player;
    session.level = parseLevel(snapshot.level);
    return session;
  }

  snapshot(): Snapshot {
    const status = this.game.status();
    const claimed = status.drawReason === "threefold-repetition" || status.drawReason === "fifty-move";
    return { start: this.startFen, moves: [...this.game.history()], player: this.player, level: this.level, claimed };
  }

  view(): View {
    let squares = "";
    let check: string | null = null;
    const status = this.game.status();
    for (let rank = 1; rank <= 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const name = "abcdefgh".charAt(file) + String(rank);
        const piece = this.game.pieceAt(name);
        squares += piece === null ? "." : pieceLetter(piece.type, piece.color);
        if (status.check && piece !== null && piece.type === "king" && piece.color === status.turn) check = name;
      }
    }
    const history = this.game.history();
    return {
      squares, check, player: this.player, turn: status.turn,
      playerTurn: status.state === "playing" && (this.player === "both" || this.player === status.turn),
      legal: status.state === "playing" ? this.game.legalMoves().map((move) => move.uci) : [],
      last: history[history.length - 1] ?? null,
      over: status.state !== "playing",
      status: this.statusLine(),
      level: this.level, levelName: levelSettings(this.level).name,
      moves: numbered(history, this.startFen),
    };
  }

  /** Plays the person's move without the engine's reply; returns an error message or null. */
  playerMove(uci: string): string | null {
    const result = this.call("chess_move_only", { move: uci });
    return result.isError ? result.text : null;
  }

  /** True when the engine owns the side to move in a live game. */
  engineToMove(): boolean {
    return this.player !== "both" && this.game.status().state === "playing" && this.game.turn() !== this.player;
  }

  /** Searches the current position without playing; the built-in engine. */
  search(level: number): SearchResult {
    return this.game.search({ level: parseLevel(level) });
  }

  /** Who is to move, and the level the engine plays at. */
  get turn(): Color { return this.game.turn(); }
  get engineLevel(): number { return this.level; }

  /** Plays a move the host's engine chose for the side to move; returns what happened, or null if it was not legal. */
  playEngineMove(uci: string, claimDraw: boolean): string | null {
    const mover = capitalized(this.game.turn());
    if (this.game.status().state !== "playing") return null;
    if (claimDraw) return this.game.claimDraw() ? "Engine (" + mover + ") claims a draw." : null;
    const played = this.game.play(uci);
    return played === null ? null : "Engine (" + mover + ") played " + played.uci + ".";
  }

  /** Plays the engine's reply if it is the engine's turn; returns what happened. */
  engineReply(): string | null {
    const notes: string[] = [];
    this.replyIfEngineTurn(notes);
    return notes[0] ?? null;
  }

  call(name: string, rawArgs: unknown): ToolResult {
    try {
      const args = readObject(rawArgs);
      return { text: this.dispatch(name, args), isError: false };
    } catch (error) {
      if (error instanceof ToolError) return { text: error.message, isError: true };
      if (error instanceof Error) return { text: error.message, isError: true };
      return { text: "Tool failed.", isError: true };
    }
  }

  private dispatch(name: string, args: Readonly<Record<string, unknown>>): string {
    switch (name) {
      case "chess_new_game": return this.newGame(args);
      case "chess_move": return this.move(args, true);
      case "chess_move_only": return this.move(args, false);
      case "chess_show": return this.render([]);
      case "chess_legal_moves": return this.legal(args);
      case "chess_hint": return this.hint(args);
      case "chess_engine_move": return this.engineMove(args);
      case "chess_undo": return this.undo();
      case "chess_claim_draw": return this.claim(args);
      case "chess_settings": return this.settings(args);
      default: throw new ToolError("Unknown tool: " + name);
    }
  }

  private newGame(args: Readonly<Record<string, unknown>>): string {
    const fen = readString(args, "fen");
    const player = readPlayer(args) ?? "white";
    const level = readLevel(args) ?? this.level;
    const game = fen === null || fen === "" ? new Chess() : new Chess(fen);
    this.game = game;
    this.player = player;
    this.level = level;
    this.startFen = game.fen();
    const notes = ["New game. You play " + (player === "both" ? "both sides" : player) + "; engine level " + this.levelName() + "."];
    this.autoReply(notes);
    return this.render(notes);
  }

  private move(args: Readonly<Record<string, unknown>>, reply: boolean): string {
    const uci = (readString(args, "move") ?? "").toLowerCase();
    if (uci === "") throw new ToolError("'move' is required.");
    const status = this.game.status();
    if (status.state !== "playing") throw new ToolError("The game is over. Start a new game or undo.");
    if (this.player !== "both" && status.turn !== this.player) throw new ToolError("It is the engine's turn, not yours.");
    const played = this.game.play(uci);
    if (played === null) {
      const hint = /^[a-h][1-8]$/.test(uci.slice(0, 2)) ? this.movesFrom(uci.slice(0, 2)) : "";
      throw new ToolError("Illegal move: " + uci + "." + (hint === "" ? "" : " Legal from " + uci.slice(0, 2) + ": " + hint + "."));
    }
    const notes = ["You played " + played.uci + "."];
    if (reply) this.autoReply(notes);
    return this.render(notes);
  }

  private legal(args: Readonly<Record<string, unknown>>): string {
    const square = (readString(args, "square") ?? "").toLowerCase();
    if (square !== "") {
      if (!/^[a-h][1-8]$/.test(square)) throw new ToolError("'square' must look like e2.");
      const moves = this.movesFrom(square);
      return moves === "" ? "No legal moves from " + square + "." : "Legal from " + square + ": " + moves;
    }
    const moves = this.game.legalMoves().map((move) => move.uci);
    return moves.length === 0 ? "No legal moves." : String(moves.length) + " legal moves: " + moves.join(" ");
  }

  private hint(args: Readonly<Record<string, unknown>>): string {
    if (this.game.status().state !== "playing") return "The game is over.";
    // Level 7 is the first preset without a deliberate handicap and answers in well under a second.
    const level = readLevel(args) ?? 7;
    const mover = this.game.turn();
    const result = this.game.search({ level });
    if (result.claimDraw) return "Suggestion: claim a draw.";
    if (result.move === null) return "No move available.";
    return [
      "Suggested move for " + capitalized(mover) + ": " + result.move.uci,
      "Evaluation: " + formatScore(result.score, mover),
      "Line: " + result.principalVariation.join(" "),
      "Depth " + String(result.depth) + ", " + String(result.nodes) + " nodes.",
    ].join("\n");
  }

  private engineMove(args: Readonly<Record<string, unknown>>): string {
    if (this.game.status().state !== "playing") throw new ToolError("The game is over.");
    const notes: string[] = [];
    this.playEngine(readLevel(args) ?? this.level, notes);
    return this.render(notes);
  }

  private undo(): string {
    const history = this.game.history();
    if (history.length === 0) throw new ToolError("Nothing to undo.");
    const undone: string[] = [];
    const first = this.game.undo();
    if (first !== null) undone.push(first.uci);
    // Return to the player's turn: take back the engine reply and the player's move together.
    if (this.player !== "both" && this.game.turn() !== this.player && this.game.history().length > 0) {
      const second = this.game.undo();
      if (second !== null) undone.push(second.uci);
    }
    const notes = ["Took back " + undone.join(", ") + "."];
    this.autoReply(notes);
    return this.render(notes);
  }

  private claim(args: Readonly<Record<string, unknown>>): string {
    const move = (readString(args, "move") ?? "").toLowerCase();
    const claimed = this.game.claimDraw(move);
    return this.render([claimed ? "Draw claimed." : "No draw can be claimed here."]);
  }

  private settings(args: Readonly<Record<string, unknown>>): string {
    const level = readLevel(args);
    const player = readPlayer(args);
    if (level !== null) this.level = level;
    if (player !== null) this.player = player;
    const notes = ["Engine level " + this.levelName() + "; you play " + (this.player === "both" ? "both sides" : this.player) + "."];
    this.autoReply(notes);
    return this.render(notes);
  }

  private autoReply(notes: string[]): void {
    if (!this.deferEngine) this.replyIfEngineTurn(notes);
  }

  private replyIfEngineTurn(notes: string[]): void {
    if (this.player === "both") return;
    if (this.game.status().state !== "playing" || this.game.turn() === this.player) return;
    this.playEngine(this.level, notes);
  }

  private playEngine(level: Level, notes: string[]): void {
    const mover = this.game.turn();
    const result = this.game.search({ level });
    if (result.claimDraw) { this.game.claimDraw(); notes.push("Engine (" + capitalized(mover) + ") claims a draw."); return; }
    if (result.move === null) return;
    this.game.play(result.move.uci);
    notes.push("Engine (" + capitalized(mover) + ") played " + result.move.uci + ".");
  }

  private movesFrom(square: string): string {
    return this.game.legalMoves().filter((move) => move.from === square).map((move) => move.uci).join(" ");
  }

  private levelName(): string { return String(this.level) + " (" + levelSettings(this.level).name + ")"; }

  private render(notes: readonly string[]): string {
    const lines = [...notes];
    if (lines.length > 0) lines.push("");
    lines.push(...this.board(), "", this.statusLine());
    const history = this.game.history();
    lines.push("Moves: " + (history.length === 0 ? "(none)" : numbered(history, this.startFen)));
    lines.push("FEN: " + this.game.fen());
    lines.push("You: " + (this.player === "both" ? "both sides" : this.player) + " | Engine level " + this.levelName());
    if (this.boardShownElsewhere) lines.push("", "The user sees this position live in the chess pane. Don't paste the board; answer in a sentence or two.");
    return lines.join("\n");
  }

  private board(): string[] {
    const flipped = this.player === "black";
    const files = flipped ? "h g f e d c b a" : "a b c d e f g h";
    const rows = ["    " + files, "  +-----------------+"];
    for (let row = 0; row < 8; row++) {
      const rank = flipped ? row + 1 : 8 - row;
      const cells: string[] = [];
      for (let column = 0; column < 8; column++) {
        const file = flipped ? 7 - column : column;
        const piece = this.game.pieceAt("abcdefgh".charAt(file) + String(rank));
        cells.push(piece === null ? "." : pieceLetter(piece.type, piece.color));
      }
      rows.push(String(rank) + " | " + cells.join(" ") + " | " + String(rank));
    }
    rows.push("  +-----------------+", "    " + files);
    return rows;
  }

  private statusLine(): string {
    const status = this.game.status();
    if (status.state === "checkmate") return "Checkmate. " + capitalized(status.winner ?? "white") + " wins.";
    if (status.state === "draw") return "Draw (" + (status.drawReason ?? "draw") + ").";
    const turn = capitalized(status.turn) + " to move" + (this.player === status.turn || this.player === "both" ? " (you)" : " (engine)");
    const extras: string[] = [];
    if (status.check) extras.push("check");
    if (status.canClaimThreefold) extras.push("threefold draw claimable");
    if (status.canClaimFiftyMove) extras.push("fifty-move draw claimable");
    return turn + (extras.length === 0 ? "." : ", " + extras.join(", ") + ".");
  }
}

function pieceLetter(type: string, color: Color): string {
  const letter = type === "knight" ? "n" : type.charAt(0);
  return color === "white" ? letter.toUpperCase() : letter;
}

function numbered(history: readonly string[], startFen: string): string {
  const fields = startFen.split(" ");
  let number = Number(fields[5] ?? "1");
  let white = fields[1] !== "b";
  const parts: string[] = [];
  for (const move of history) {
    if (white) parts.push(String(number) + ". " + move);
    else if (parts.length === 0) parts.push(String(number) + "... " + move);
    else parts.push(move);
    if (!white) number++;
    white = !white;
  }
  return parts.join(" ");
}
