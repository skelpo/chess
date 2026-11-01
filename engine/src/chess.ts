/** Standalone chess computation. No imports, I/O, clocks, or ambient runtime APIs. */
export type Color = "white" | "black";
export type PieceType = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
export type Promotion = "q" | "r" | "b" | "n";
export type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export interface Piece { readonly color: Color; readonly type: PieceType }
export interface Move {
  readonly from: string;
  readonly to: string;
  readonly promotion: Promotion | null;
  readonly uci: string;
  readonly capture: boolean;
  readonly castle: boolean;
  readonly enPassant: boolean;
}
export type DrawReason = "stalemate" | "insufficient-material" | "fivefold-repetition" |
  "seventy-five-move" | "threefold-repetition" | "fifty-move";
export interface GameStatus {
  readonly state: "playing" | "checkmate" | "draw";
  readonly turn: Color;
  readonly check: boolean;
  readonly winner: Color | null;
  readonly drawReason: DrawReason | null;
  readonly canClaimThreefold: boolean;
  readonly canClaimFiftyMove: boolean;
}
export interface LevelSettings {
  readonly level: Level;
  readonly name: string;
  readonly depth: number;
  readonly nodes: number;
  /** Deterministic root evaluation handicap in centipawns. */
  readonly inaccuracy: number;
}
export interface SearchOptions {
  readonly level?: Level;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}
export interface SearchResult {
  readonly move: Move | null;
  /** Centipawns from the side to move. Mate scores approach +/- 30000. */
  readonly score: number;
  readonly depth: number;
  readonly nodes: number;
  readonly principalVariation: readonly string[];
  readonly completed: boolean;
  readonly claimDraw: boolean;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KNIGHT = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP = [-17, -15, 15, 17];
const ROOK = [-16, -1, 1, 16];
const KING = [-17, -16, -15, -1, 1, 15, 16, 17];
const VALUES = [0, 100, 320, 335, 500, 950, 0];
const EP = 1 << 17;
const CASTLE = 1 << 18;
const DOUBLE = 1 << 19;
const MATE = 30000;
const INFINITY = 32000;
const MAX_PLY = 96;

export function levelSettings(level: Level): LevelSettings {
  switch (level) {
    case 1: return { level, name: "Kids", depth: 1, nodes: 300, inaccuracy: 650 };
    case 2: return { level, name: "Beginner", depth: 2, nodes: 1000, inaccuracy: 350 };
    case 3: return { level, name: "Learner", depth: 2, nodes: 3000, inaccuracy: 180 };
    case 4: return { level, name: "Casual", depth: 3, nodes: 8000, inaccuracy: 90 };
    case 5: return { level, name: "Club", depth: 4, nodes: 20000, inaccuracy: 40 };
    case 6: return { level, name: "Advanced", depth: 5, nodes: 50000, inaccuracy: 15 };
    case 7: return { level, name: "Expert", depth: 6, nodes: 120000, inaccuracy: 0 };
    case 8: return { level, name: "Challenger", depth: 7, nodes: 300000, inaccuracy: 0 };
    case 9: return { level, name: "Elite", depth: 8, nodes: 700000, inaccuracy: 0 };
    case 10: return { level, name: "Master", depth: 10, nodes: 1500000, inaccuracy: 0 };
    default: throw new Error("Level must be an integer from 1 to 10.");
  }
}

export function parseLevel(value: number): Level {
  switch (value) {
    case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 9: case 10: return value;
    default: throw new Error("Level must be an integer from 1 to 10.");
  }
}

function opposite(color: Color): Color { return color === "white" ? "black" : "white"; }
function sign(color: Color): number { return color === "white" ? 1 : -1; }
function onBoard(square: number): boolean { return square >= 0 && square < 128 && (square & 0x88) === 0; }
function squareIndex(square: string): number {
  if (square.length !== 2) throw new Error("Invalid square: " + square);
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) throw new Error("Invalid square: " + square);
  return rank * 16 + file;
}
function squareName(square: number): string {
  return "abcdefgh".charAt(square & 7) + String((square >> 4) + 1);
}
function encode(from: number, to: number, promotion = 0, flags = 0): number {
  return from | (to << 7) | (promotion << 14) | flags;
}
function moveFrom(move: number): number { return move & 127; }
function moveTo(move: number): number { return (move >> 7) & 127; }
function movePromotion(move: number): number { return (move >> 14) & 7; }
function promotionName(piece: number): Promotion | null {
  if (piece === 5) return "q";
  if (piece === 4) return "r";
  if (piece === 3) return "b";
  if (piece === 2) return "n";
  return null;
}
function moveUci(move: number): string {
  return squareName(moveFrom(move)) + squareName(moveTo(move)) + (promotionName(movePromotion(move)) ?? "");
}
function pieceType(piece: number): PieceType {
  switch (Math.abs(piece)) {
    case 1: return "pawn";
    case 2: return "knight";
    case 3: return "bishop";
    case 4: return "rook";
    case 5: return "queen";
    default: return "king";
  }
}
function integer(text: string, minimum: number): number {
  if (text.length === 0) throw new Error("Missing FEN counter.");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) throw new Error("Invalid FEN counter.");
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > 1000000000) {
    throw new Error("FEN counter is out of range.");
  }
  return value;
}

interface Undo {
  move: number;
  piece: number;
  captured: number;
  captureSquare: number;
  rights: number;
  ep: number;
  halfmove: number;
  fullmove: number;
  whiteKing: number;
  blackKing: number;
  hashA: number;
  hashB: number;
  context: number;
  tracked: boolean;
}
interface TableEntry {
  key: string;
  depth: number;
  score: number;
  bound: number;
  move: number;
}

/** Mutable game position; all returned moves, pieces, histories and search results are detached. */
export class Chess {
  private board: number[] = new Array<number>(128).fill(0);
  private side: Color = "white";
  private rights = 0;
  private ep = -1;
  private halfmove = 0;
  private fullmove = 1;
  private whiteKing = -1;
  private blackKing = -1;
  private hashA = 0;
  private hashB = 0;
  private zobristA: number[] = [];
  private zobristB: number[] = [];
  private historyKeys: string[] = [];
  private context = 0;
  private played: Undo[] = [];
  private claimed: DrawReason | null = null;
  private table: Map<string, TableEntry> = new Map<string, TableEntry>();
  private killers: number[] = new Array<number>(MAX_PLY * 2).fill(0);
  private historyScores: number[] = new Array<number>(128 * 128).fill(0);
  private nodes = 0;
  private nodeLimit = 1;
  private stopped = false;

  constructor(fen: string = START_FEN) {
    let seed = 0x6d2b79f5;
    for (let i = 0; i < 13 * 128; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      this.zobristA.push(seed);
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      this.zobristB.push(seed);
    }
    this.readFen(fen);
    this.historyKeys.push(this.positionKey());
  }

  turn(): Color { return this.side; }

  pieceAt(square: string): Piece | null {
    const piece = this.at(squareIndex(square));
    return piece === 0 ? null : { color: piece > 0 ? "white" : "black", type: pieceType(piece) };
  }

  /** Replaces the position atomically; invalid FEN leaves this game untouched. */
  load(fen: string): void {
    const next = new Chess(fen);
    this.board = next.board;
    this.side = next.side;
    this.rights = next.rights;
    this.ep = next.ep;
    this.halfmove = next.halfmove;
    this.fullmove = next.fullmove;
    this.whiteKing = next.whiteKing;
    this.blackKing = next.blackKing;
    this.hashA = next.hashA;
    this.hashB = next.hashB;
    this.historyKeys = next.historyKeys;
    this.context = 0;
    this.played = [];
    this.claimed = null;
    this.table.clear();
  }

  fen(): string {
    let placement = "";
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.at(rank * 16 + file);
        if (p === 0) { empty++; continue; }
        if (empty > 0) { placement += String(empty); empty = 0; }
        placement += p > 0 ? " PNBRQK".charAt(p) : " pnbrqk".charAt(-p);
      }
      if (empty > 0) placement += String(empty);
      if (rank > 0) placement += "/";
    }
    let castling = "";
    if ((this.rights & 1) !== 0) castling += "K";
    if ((this.rights & 2) !== 0) castling += "Q";
    if ((this.rights & 4) !== 0) castling += "k";
    if ((this.rights & 8) !== 0) castling += "q";
    return placement + (this.side === "white" ? " w " : " b ") + (castling || "-") + " " +
      (this.ep < 0 ? "-" : squareName(this.ep)) + " " + String(this.halfmove) + " " + String(this.fullmove);
  }

  history(): readonly string[] {
    const result: string[] = [];
    for (const undo of this.played) result.push(moveUci(undo.move));
    return result;
  }

  legalMoves(): readonly Move[] {
    const result: Move[] = [];
    for (const move of this.generateLegal()) result.push(this.describe(move));
    return result;
  }

  /** UCI coordinate notation, e.g. e2e4, e1g1, a7a8n. Promotion suffix is required. */
  play(uci: string): Move | null {
    if (this.status().state !== "playing") return null;
    for (const move of this.generateLegal()) {
      if (moveUci(move) === uci) {
        const result = this.describe(move);
        this.played.push(this.make(move, true));
        return result;
      }
    }
    return null;
  }

  undo(): Move | null {
    if (this.claimed !== null) this.claimed = null;
    const last = this.played.pop();
    if (last === undefined) return null;
    this.unmake(last);
    return this.describe(last.move);
  }

  inCheck(): boolean { return this.attacked(this.king(this.side), opposite(this.side)); }

  status(): GameStatus {
    const check = this.inCheck();
    const moves = this.generateLegal();
    const repeats = this.repetitions();
    let state: "playing" | "checkmate" | "draw" = "playing";
    let reason: DrawReason | null = this.claimed;
    let winner: Color | null = null;
    if (moves.length === 0 && check) { state = "checkmate"; winner = opposite(this.side); }
    else {
      if (moves.length === 0) reason = "stalemate";
      else if (this.insufficientMaterial()) reason = "insufficient-material";
      else if (repeats >= 5) reason = "fivefold-repetition";
      else if (this.halfmove >= 150) reason = "seventy-five-move";
      if (reason !== null) state = "draw";
    }
    return {
      state, turn: this.side, check, winner, drawReason: reason,
      canClaimThreefold: state === "playing" && repeats >= 3,
      canClaimFiftyMove: state === "playing" && this.halfmove >= 100,
    };
  }

  /** Claims at the current position or with an announced legal move (which is not played). */
  claimDraw(intendedMove: string = ""): boolean {
    const current = this.status();
    if (current.state !== "playing") return false;
    if (current.canClaimThreefold) { this.claimed = "threefold-repetition"; return true; }
    if (current.canClaimFiftyMove) { this.claimed = "fifty-move"; return true; }
    if (intendedMove === "") return false;
    for (const move of this.generateLegal()) {
      if (moveUci(move) !== intendedMove) continue;
      const undo = this.make(move, true);
      const threefold = this.repetitions() >= 3;
      const fifty = this.halfmove >= 100;
      this.unmake(undo);
      if (threefold) this.claimed = "threefold-repetition";
      else if (fifty) this.claimed = "fifty-move";
      return this.claimed !== null;
    }
    return false;
  }

  /** Legal move tree count, independent of draw adjudication. Useful for verification. */
  perft(depth: number): number {
    if (!Number.isInteger(depth) || depth < 0 || depth > 8) throw new Error("Perft depth must be 0..8.");
    return this.countMoves(depth);
  }

  /** Static score in centipawns from the side to move. */
  evaluate(): number {
    let score = 0;
    let phase = 0;
    let whiteBishops = 0;
    let blackBishops = 0;
    const whitePawns = new Array<number>(8).fill(0);
    const blackPawns = new Array<number>(8).fill(0);
    for (let square = 0; square < 128; square++) {
      if ((square & 0x88) !== 0) { square += 7; continue; }
      const p = this.at(square);
      const type = Math.abs(p);
      if (type === 1) {
        const files = p > 0 ? whitePawns : blackPawns;
        files[square & 7] = (files[square & 7] ?? 0) + 1;
      } else if (type === 2 || type === 3) phase += 1;
      else if (type === 4) phase += 2;
      else if (type === 5) phase += 4;
    }
    phase = Math.min(24, phase);
    for (let square = 0; square < 128; square++) {
      if ((square & 0x88) !== 0) { square += 7; continue; }
      const p = this.at(square);
      if (p === 0) continue;
      const type = Math.abs(p);
      const file = square & 7;
      const rank = p > 0 ? square >> 4 : 7 - (square >> 4);
      const center = 7 - Math.abs(2 * file - 7) / 2 - Math.abs(2 * rank - 7) / 2;
      let value = VALUES[type] ?? 0;
      if (type === 1) {
        const own = p > 0 ? whitePawns : blackPawns;
        value += rank * 9 + center * 3;
        if ((own[file] ?? 0) > 1) value -= 14;
        if ((own[file - 1] ?? 0) === 0 && (own[file + 1] ?? 0) === 0) value -= 12;
        let passed = true;
        for (let r = (square >> 4) + (p > 0 ? 1 : -1); r >= 0 && r < 8; r += p > 0 ? 1 : -1) {
          for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
            if (this.at(r * 16 + f) === (p > 0 ? -1 : 1)) passed = false;
          }
        }
        if (passed) value += rank * rank * 3;
      } else if (type === 2) value += center * 12 - (rank === 0 ? 15 : 0);
      else if (type === 3) {
        value += center * 7;
        if (p > 0) whiteBishops++; else blackBishops++;
      } else if (type === 4) {
        const own = p > 0 ? whitePawns : blackPawns;
        const other = p > 0 ? blackPawns : whitePawns;
        if ((own[file] ?? 0) === 0) value += (other[file] ?? 0) === 0 ? 24 : 12;
        if (rank === 6) value += 24;
      } else if (type === 5) value += center * 3;
      else if (type === 6) {
        let safety = -center * 12 - rank * 12;
        if (rank < 2 && (file < 3 || file > 5)) safety += 35;
        const forward = p > 0 ? 16 : -16;
        for (let f = -1; f <= 1; f++) {
          const shield = square + forward + f;
          if (onBoard(shield) && this.at(shield) === (p > 0 ? 1 : -1)) safety += 12;
        }
        value += (safety * phase + center * 16 * (24 - phase)) / 24;
      }
      score += p > 0 ? value : -value;
    }
    if (whiteBishops >= 2) score += 30;
    if (blackBishops >= 2) score -= 30;
    return Math.round(score * sign(this.side)) + 10;
  }

  /** Deterministic, synchronous, node-bounded iterative deepening. Never plays its result. */
  search(options: SearchOptions = {}): SearchResult {
    const settings = levelSettings(options.level ?? 5);
    const depthLimit = options.maxDepth ?? settings.depth;
    const nodeLimit = options.maxNodes ?? settings.nodes;
    if (!Number.isInteger(depthLimit) || depthLimit < 1 || depthLimit > 32) throw new Error("Search depth must be 1..32.");
    if (!Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > 1000000000) throw new Error("Search nodes must be 1..1000000000.");
    this.nodes = 0;
    this.nodeLimit = nodeLimit;
    this.stopped = false;
    this.table.clear();
    this.killers.fill(0);
    this.historyScores.fill(0);
    const status = this.status();
    if (status.state !== "playing") return {
      move: null, score: status.state === "checkmate" ? -MATE : 0, depth: 0, nodes: 0,
      principalVariation: [], completed: true, claimDraw: false,
    };
    const canClaim = status.canClaimThreefold || status.canClaimFiftyMove;
    const legal = this.generateLegal();
    let bestMove = legal[0] ?? 0;
    let bestScore = this.evaluate();
    let completedDepth = 0;
    let pv: string[] = [moveUci(bestMove)];
    let claimDraw = false;
    for (let depth = 1; depth <= depthLimit; depth++) {
      const ordered = this.orderMoves(legal, bestMove, 0);
      let iterationMove = bestMove;
      let iterationScore = -INFINITY;
      let selectionScore = -INFINITY;
      let alpha = canClaim ? 0 : -INFINITY;
      for (const move of ordered) {
        const undo = this.make(move, true);
        // Full windows at handicapped levels ensure the handicap compares real scores.
        const score = -this.negamax(depth - 1, -INFINITY, settings.inaccuracy > 0 ? INFINITY : -alpha, 1);
        this.unmake(undo);
        if (this.stopped) break;
        const adjusted = score + this.handicap(move, settings.inaccuracy);
        if (adjusted > selectionScore) {
          selectionScore = adjusted; iterationScore = score; iterationMove = move;
        }
        if (score > alpha) alpha = score;
      }
      if (this.stopped) break;
      bestMove = iterationMove;
      bestScore = iterationScore;
      completedDepth = depth;
      claimDraw = canClaim && bestScore <= 0;
      if (claimDraw) bestScore = 0;
      pv = this.extractPv(bestMove, depth);
      if (Math.abs(bestScore) >= MATE - MAX_PLY) break;
    }
    // Even a one-node budget produces a legal move; no partially searched iteration is reported.
    if (completedDepth === 0 && canClaim) { claimDraw = true; bestScore = 0; }
    return {
      move: claimDraw ? null : this.describe(bestMove), score: bestScore, depth: completedDepth,
      nodes: this.nodes, principalVariation: claimDraw ? [] : pv,
      completed: !this.stopped, claimDraw,
    };
  }

  private at(square: number): number { return this.board[square] ?? 0; }
  private king(color: Color): number { return color === "white" ? this.whiteKing : this.blackKing; }
  private set(square: number, piece: number): void {
    const old = this.at(square);
    if (old !== 0) {
      this.hashA ^= this.zobristA[(old + 6) * 128 + square] ?? 0;
      this.hashB ^= this.zobristB[(old + 6) * 128 + square] ?? 0;
    }
    this.board[square] = piece;
    if (piece !== 0) {
      this.hashA ^= this.zobristA[(piece + 6) * 128 + square] ?? 0;
      this.hashB ^= this.zobristB[(piece + 6) * 128 + square] ?? 0;
    }
  }

  private readFen(fen: string): void {
    const fields = fen.trim().split(/\s+/);
    if (fields.length !== 6) throw new Error("FEN must contain six fields.");
    const ranks = (fields[0] ?? "").split("/");
    if (ranks.length !== 8) throw new Error("FEN must contain eight ranks.");
    let whiteCount = 0;
    let blackCount = 0;
    let whitePawns = 0;
    let blackPawns = 0;
    for (let row = 0; row < 8; row++) {
      const rank = ranks[row] ?? "";
      let file = 0;
      let previousDigit = false;
      for (let i = 0; i < rank.length; i++) {
        const c = rank.charAt(i);
        if (c >= "1" && c <= "8") {
          if (previousDigit) throw new Error("Adjacent empty counts in FEN.");
          file += Number(c); previousDigit = true; continue;
        }
        previousDigit = false;
        const type = "pnbrqk".indexOf(c.toLowerCase()) + 1;
        if (type === 0 || file >= 8) throw new Error("Invalid FEN piece or rank.");
        const white = c === c.toUpperCase();
        const sq = (7 - row) * 16 + file;
        if (type === 1 && (row === 0 || row === 7)) throw new Error("Pawn on promotion rank.");
        this.set(sq, white ? type : -type);
        if (white) { whiteCount++; if (type === 1) whitePawns++; }
        else { blackCount++; if (type === 1) blackPawns++; }
        if (type === 6) {
          if (white) {
            if (this.whiteKing !== -1) throw new Error("Multiple white kings.");
            this.whiteKing = sq;
          } else {
            if (this.blackKing !== -1) throw new Error("Multiple black kings.");
            this.blackKing = sq;
          }
        }
        file++;
      }
      if (file !== 8) throw new Error("FEN rank must contain eight squares.");
    }
    if (this.whiteKing < 0 || this.blackKing < 0) throw new Error("FEN requires both kings.");
    if (whiteCount > 16 || blackCount > 16 || whitePawns > 8 || blackPawns > 8) throw new Error("Too many pieces in FEN.");
    if (fields[1] !== "w" && fields[1] !== "b") throw new Error("Invalid FEN side to move.");
    this.side = fields[1] === "w" ? "white" : "black";
    const castling = fields[2] ?? "";
    if (castling !== "-") {
      for (let i = 0; i < castling.length; i++) {
        const bit = "KQkq".indexOf(castling.charAt(i));
        if (bit < 0 || (this.rights & (1 << bit)) !== 0) throw new Error("Invalid FEN castling rights.");
        this.rights |= 1 << bit;
      }
    }
    if (((this.rights & 3) !== 0 && this.at(4) !== 6) ||
        ((this.rights & 12) !== 0 && this.at(116) !== -6) ||
        ((this.rights & 1) !== 0 && this.at(7) !== 4) ||
        ((this.rights & 2) !== 0 && this.at(0) !== 4) ||
        ((this.rights & 4) !== 0 && this.at(119) !== -4) ||
        ((this.rights & 8) !== 0 && this.at(112) !== -4)) throw new Error("Castling rights require home king and rook.");
    this.halfmove = integer(fields[4] ?? "", 0);
    this.fullmove = integer(fields[5] ?? "", 1);
    if (fields[3] !== "-") {
      this.ep = squareIndex(fields[3] ?? "");
      const direction = this.side === "white" ? 16 : -16;
      const expectedRank = this.side === "white" ? 5 : 2;
      if ((this.ep >> 4) !== expectedRank || this.at(this.ep) !== 0 ||
          this.at(this.ep - direction) !== -sign(this.side) || this.at(this.ep + direction) !== 0 || this.halfmove !== 0) {
        throw new Error("Invalid FEN en passant target.");
      }
    }
    if (this.attacked(this.king(opposite(this.side)), this.side)) throw new Error("The side that just moved is in check.");
  }

  private attacked(square: number, by: Color): boolean {
    const color = sign(by);
    const direction = color * 16;
    for (const delta of [-1, 1]) {
      const source = square - direction + delta;
      if (onBoard(source) && this.at(source) === color) return true;
    }
    for (const delta of KNIGHT) {
      const source = square + delta;
      if (onBoard(source) && this.at(source) === color * 2) return true;
    }
    for (const delta of KING) {
      let source = square + delta;
      let distance = 1;
      while (onBoard(source)) {
        const piece = this.at(source);
        if (piece !== 0) {
          if (piece * color > 0) {
            const type = Math.abs(piece);
            const diagonal = delta === -17 || delta === -15 || delta === 15 || delta === 17;
            if (type === 5 || (diagonal && type === 3) || (!diagonal && type === 4) || (distance === 1 && type === 6)) return true;
          }
          break;
        }
        source += delta; distance++;
      }
    }
    return false;
  }

  private addPawn(moves: number[], from: number, to: number, flags: number): void {
    if ((to >> 4) === 0 || (to >> 4) === 7) {
      for (const promotion of [5, 4, 3, 2]) moves.push(encode(from, to, promotion, flags));
    } else moves.push(encode(from, to, 0, flags));
  }

  private generatePseudo(): number[] {
    const moves: number[] = [];
    const color = sign(this.side);
    for (let from = 0; from < 128; from++) {
      if ((from & 0x88) !== 0) { from += 7; continue; }
      const p = this.at(from);
      if (p * color <= 0) continue;
      const type = Math.abs(p);
      if (type === 1) {
        const direction = color * 16;
        const to = from + direction;
        if (onBoard(to) && this.at(to) === 0) {
          this.addPawn(moves, from, to, 0);
          const startRank = color === 1 ? 1 : 6;
          if ((from >> 4) === startRank && this.at(to + direction) === 0) moves.push(encode(from, to + direction, 0, DOUBLE));
        }
        for (const delta of [-1, 1]) {
          const capture = to + delta;
          if (!onBoard(capture)) continue;
          if (this.at(capture) * color < 0 && Math.abs(this.at(capture)) !== 6) this.addPawn(moves, from, capture, 0);
          else if (capture === this.ep) this.addPawn(moves, from, capture, EP);
        }
      } else {
        const directions = type === 2 ? KNIGHT : type === 3 ? BISHOP : type === 4 ? ROOK : KING;
        for (const delta of directions) {
          let to = from + delta;
          while (onBoard(to)) {
            const target = this.at(to);
            if (target * color > 0 || Math.abs(target) === 6) break;
            moves.push(encode(from, to));
            if (target !== 0 || type === 2 || type === 6) break;
            to += delta;
          }
        }
      }
    }
    const home = this.side === "white" ? 4 : 116;
    const shortRight = this.side === "white" ? 1 : 4;
    const longRight = this.side === "white" ? 2 : 8;
    const enemy = opposite(this.side);
    if (this.at(home) === color * 6 && !this.attacked(home, enemy)) {
      if ((this.rights & shortRight) !== 0 && this.at(home + 1) === 0 && this.at(home + 2) === 0 &&
          !this.attacked(home + 1, enemy) && !this.attacked(home + 2, enemy)) moves.push(encode(home, home + 2, 0, CASTLE));
      if ((this.rights & longRight) !== 0 && this.at(home - 1) === 0 && this.at(home - 2) === 0 && this.at(home - 3) === 0 &&
          !this.attacked(home - 1, enemy) && !this.attacked(home - 2, enemy)) moves.push(encode(home, home - 2, 0, CASTLE));
    }
    return moves;
  }

  private generateLegal(): number[] {
    const legal: number[] = [];
    const side = this.side;
    for (const move of this.generatePseudo()) {
      const undo = this.make(move, false);
      if (!this.attacked(this.king(side), this.side)) legal.push(move);
      this.unmake(undo);
    }
    return legal;
  }

  private make(move: number, tracked: boolean): Undo {
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = this.at(from);
    const color = sign(this.side);
    const captureSquare = (move & EP) !== 0 ? to - color * 16 : to;
    const undo: Undo = {
      move, piece, captured: this.at(captureSquare), captureSquare, rights: this.rights,
      ep: this.ep, halfmove: this.halfmove, fullmove: this.fullmove,
      whiteKing: this.whiteKing, blackKing: this.blackKing, hashA: this.hashA, hashB: this.hashB,
      context: this.context, tracked,
    };
    this.set(from, 0);
    if ((move & EP) !== 0) this.set(captureSquare, 0);
    this.set(to, movePromotion(move) === 0 ? piece : color * movePromotion(move));
    if ((move & CASTLE) !== 0) {
      const rookFrom = to > from ? from + 3 : from - 4;
      const rookTo = to > from ? from + 1 : from - 1;
      this.set(rookFrom, 0); this.set(rookTo, color * 4);
    }
    if (piece === 6) { this.whiteKing = to; this.rights &= ~3; }
    if (piece === -6) { this.blackKing = to; this.rights &= ~12; }
    if (from === 0 || to === 0) this.rights &= ~2;
    if (from === 7 || to === 7) this.rights &= ~1;
    if (from === 112 || to === 112) this.rights &= ~8;
    if (from === 119 || to === 119) this.rights &= ~4;
    this.ep = (move & DOUBLE) !== 0 ? from + color * 16 : -1;
    this.halfmove = Math.abs(piece) === 1 || undo.captured !== 0 ? 0 : this.halfmove + 1;
    if (this.side === "black") this.fullmove++;
    this.side = opposite(this.side);
    if (tracked) {
      this.historyKeys.push(this.positionKey());
      // Reversible history is part of the TT identity, preventing path-dependent draw reuse.
      this.context = this.halfmove === 0 ? 0 : ((this.context * 33) ^ this.hashA ^ this.hashB ^ move) | 0;
    }
    return undo;
  }

  private unmake(undo: Undo): void {
    const from = moveFrom(undo.move);
    const to = moveTo(undo.move);
    this.board[from] = undo.piece;
    this.board[to] = 0;
    this.board[undo.captureSquare] = undo.captured;
    if ((undo.move & CASTLE) !== 0) {
      const rookFrom = to > from ? from + 3 : from - 4;
      const rookTo = to > from ? from + 1 : from - 1;
      this.board[rookFrom] = undo.piece > 0 ? 4 : -4;
      this.board[rookTo] = 0;
    }
    this.side = opposite(this.side);
    this.rights = undo.rights; this.ep = undo.ep;
    this.halfmove = undo.halfmove; this.fullmove = undo.fullmove;
    this.whiteKing = undo.whiteKing; this.blackKing = undo.blackKing;
    this.hashA = undo.hashA; this.hashB = undo.hashB;
    this.context = undo.context;
    if (undo.tracked) this.historyKeys.pop();
  }

  private effectiveEp(): number {
    if (this.ep < 0) return -1;
    const direction = sign(this.side) * 16;
    const side = this.side;
    for (const delta of [-1, 1]) {
      const from = this.ep - direction + delta;
      if (!onBoard(from) || this.at(from) !== sign(side)) continue;
      const undo = this.make(encode(from, this.ep, 0, EP), false);
      const legal = !this.attacked(this.king(side), this.side);
      this.unmake(undo);
      if (legal) return this.ep;
    }
    return -1;
  }

  private positionKey(): string {
    return String(this.hashA) + ":" + String(this.hashB) + ":" + this.side + ":" + String(this.rights) + ":" + String(this.effectiveEp());
  }
  private searchKey(): string {
    return this.positionKey() + ":" + String(this.halfmove) + ":" + String(this.context);
  }
  private repetitions(): number {
    const key = this.historyKeys[this.historyKeys.length - 1] ?? "";
    let count = 0;
    const start = Math.max(0, this.historyKeys.length - 1 - this.halfmove);
    for (let i = this.historyKeys.length - 1; i >= start; i -= 2) {
      if (this.historyKeys[i] === key) count++;
    }
    return count;
  }
  private insufficientMaterial(): boolean {
    let minors = 0;
    let knights = 0;
    let bishopColor = -1;
    let sameBishops = true;
    for (let square = 0; square < 128; square++) {
      if ((square & 0x88) !== 0) { square += 7; continue; }
      const type = Math.abs(this.at(square));
      if (type === 0 || type === 6) continue;
      if (type === 1 || type === 4 || type === 5) return false;
      minors++;
      if (type === 2) knights++;
      else {
        const color = ((square >> 4) + (square & 7)) & 1;
        if (bishopColor !== -1 && bishopColor !== color) sameBishops = false;
        bishopColor = color;
      }
    }
    return minors <= 1 || (knights === 0 && sameBishops);
  }
  private describe(move: number): Move {
    return {
      from: squareName(moveFrom(move)), to: squareName(moveTo(move)), promotion: promotionName(movePromotion(move)),
      uci: moveUci(move), capture: this.at(moveTo(move)) !== 0 || (move & EP) !== 0,
      castle: (move & CASTLE) !== 0, enPassant: (move & EP) !== 0,
    };
  }
  private countMoves(depth: number): number {
    if (depth === 0) return 1;
    let count = 0;
    const side = this.side;
    for (const move of this.generatePseudo()) {
      const undo = this.make(move, false);
      if (!this.attacked(this.king(side), this.side)) count += depth === 1 ? 1 : this.countMoves(depth - 1);
      this.unmake(undo);
    }
    return count;
  }

  private visit(): boolean {
    if (this.nodes >= this.nodeLimit) { this.stopped = true; return false; }
    this.nodes++;
    return true;
  }
  private handicap(move: number, amount: number): number {
    if (amount === 0) return 0;
    let seed = this.hashA ^ this.hashB ^ move;
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    // A nonnegative 31-bit value is portable even on native backends that store
    // bitwise results as signed i32. Avoid unsigned-right-shift-by-zero coercion.
    return ((seed & 0x7fffffff) % (2 * amount + 1)) - amount;
  }
  private orderMoves(moves: readonly number[], preferred: number, ply: number): number[] {
    const result = moves.slice();
    const scores: number[] = [];
    for (const move of result) {
      let score = 0;
      if (move === preferred) score += 10000000;
      const captured = (move & EP) !== 0 ? 1 : Math.abs(this.at(moveTo(move)));
      if (captured !== 0) score += 100000 + 10 * (VALUES[captured] ?? 0) - (VALUES[Math.abs(this.at(moveFrom(move)))] ?? 0);
      if (movePromotion(move) !== 0) score += 80000 + (VALUES[movePromotion(move)] ?? 0);
      if (move === this.killers[ply * 2]) score += 50000;
      else if (move === this.killers[ply * 2 + 1]) score += 40000;
      score += this.historyScores[moveFrom(move) * 128 + moveTo(move)] ?? 0;
      scores.push(score);
    }
    // Explicit stable insertion sort keeps native and JS move ordering identical.
    for (let i = 1; i < result.length; i++) {
      const move = result[i] ?? 0;
      const score = scores[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (scores[j] ?? 0) < score) {
        result[j + 1] = result[j] ?? 0; scores[j + 1] = scores[j] ?? 0; j--;
      }
      result[j + 1] = move; scores[j + 1] = score;
    }
    return result;
  }

  private negamax(depth: number, alphaInput: number, beta: number, ply: number): number {
    if (depth <= 0) return this.quiescence(alphaInput, beta, ply, 0);
    if (!this.visit()) return 0;
    const moves = this.generateLegal();
    const check = this.inCheck();
    if (moves.length === 0) return check ? -MATE + ply : 0;
    if (this.halfmove >= 150 || this.repetitions() >= 5 || this.insufficientMaterial()) return 0;
    if (ply >= MAX_PLY - 1) return this.evaluate();
    const canClaim = this.halfmove >= 100 || this.repetitions() >= 3;
    let alpha = canClaim ? Math.max(alphaInput, 0) : alphaInput;
    if (alpha >= beta) return alpha;
    const key = this.searchKey();
    const cached = this.table.get(key);
    let preferred = 0;
    if (cached !== undefined) {
      preferred = cached.move;
      const score = cached.score > MATE - MAX_PLY ? cached.score - ply : cached.score < -MATE + MAX_PLY ? cached.score + ply : cached.score;
      if (cached.depth >= depth) {
        if (cached.bound === 0 || (cached.bound === 1 && score >= beta) || (cached.bound === -1 && score <= alpha)) return score;
      }
    }
    let best = canClaim ? 0 : -INFINITY;
    let bestMove = 0;
    for (const move of this.orderMoves(moves, preferred, ply)) {
      const quiet = this.at(moveTo(move)) === 0 && (move & EP) === 0 && movePromotion(move) === 0;
      const undo = this.make(move, true);
      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(undo);
      if (this.stopped) return 0;
      if (score > best) { best = score; bestMove = move; }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (quiet) {
          this.killers[ply * 2 + 1] = this.killers[ply * 2] ?? 0;
          this.killers[ply * 2] = move;
          const index = moveFrom(move) * 128 + moveTo(move);
          this.historyScores[index] = Math.min(20000, (this.historyScores[index] ?? 0) + depth * depth);
        }
        break;
      }
    }
    const storedScore = best > MATE - MAX_PLY ? best + ply : best < -MATE + MAX_PLY ? best - ply : best;
    if (this.table.size >= 100000) this.table.clear();
    this.table.set(key, { key, depth, score: storedScore, bound: best <= alphaInput ? -1 : best >= beta ? 1 : 0, move: bestMove });
    return best;
  }

  private quiescence(alphaInput: number, beta: number, ply: number, qDepth: number): number {
    if (!this.visit()) return 0;
    const moves = this.generateLegal();
    const check = this.inCheck();
    if (moves.length === 0) return check ? -MATE + ply : 0;
    const repeats = this.repetitions();
    if (this.halfmove >= 150 || repeats >= 5 || this.insufficientMaterial()) return 0;
    const canClaim = this.halfmove >= 100 || repeats >= 3;
    const evaluation = canClaim ? Math.max(0, this.evaluate()) : this.evaluate();
    if (ply >= MAX_PLY - 1 || (!check && qDepth >= 12)) return evaluation;
    let alpha = canClaim ? Math.max(alphaInput, 0) : alphaInput;
    if (alpha >= beta) return alpha;
    if (!check) {
      if (evaluation >= beta) return evaluation;
      if (evaluation > alpha) alpha = evaluation;
    }
    const tactical: number[] = [];
    for (const move of moves) {
      if (check || this.at(moveTo(move)) !== 0 || (move & EP) !== 0 || movePromotion(move) !== 0) tactical.push(move);
    }
    for (const move of this.orderMoves(tactical, 0, ply)) {
      const undo = this.make(move, true);
      const score = -this.quiescence(-beta, -alpha, ply + 1, qDepth + 1);
      this.unmake(undo);
      if (this.stopped) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  private extractPv(first: number, depth: number): string[] {
    const pv: string[] = [];
    const undos: Undo[] = [];
    let move = first;
    for (let ply = 0; ply < depth && move !== 0; ply++) {
      if (!this.generateLegal().includes(move)) break;
      pv.push(moveUci(move));
      undos.push(this.make(move, true));
      const next = this.table.get(this.searchKey());
      move = next === undefined ? 0 : next.move;
    }
    for (let i = undos.length - 1; i >= 0; i--) {
      const undo = undos[i];
      if (undo !== undefined) this.unmake(undo);
    }
    return pv;
  }
}
