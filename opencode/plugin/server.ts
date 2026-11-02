/**
 * opencode server plugin: the chess_board tool, so the agent can see and play the game on the user's
 * graphical board (the TUI plugin in tui.tsx). Both read and write the shared game file in game.ts.
 * No imports beyond the engine and node:, so it loads without installing anything.
 */
import { Chess } from "./lib/chess.ts";
import { TOOLS } from "./lib/session.ts";
import { liveOnline, parseSaved, readText, restore, save, statePath } from "./game.ts";
import type { OnlineRecord } from "./game.ts";

const ACTIONS = ["show", "move", "legal_moves", "hint", "engine_move", "undo", "new_game", "settings", "claim_draw"] as const;
type Action = (typeof ACTIONS)[number];

function parameter(name: string, key: string): unknown {
  const tool = TOOLS.find((item) => item.name === name);
  return tool?.inputSchema.properties[key];
}

const INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ACTIONS,
      description:
        "show: position, status, moves and FEN. move: play `move` for the player (the engine replies if it has the other side). " +
        "legal_moves: legal moves, optionally from `square`. hint: the engine's best move without playing it. " +
        "engine_move: the engine plays the side to move. undo: take back the last move pair. " +
        "new_game: start over (`player`, `level`, `fen`). settings: change `level` or `player`. claim_draw: claim a claimable draw.",
    },
    move: { type: "string", description: "Coordinate move for action move (e2e4, e1g1, e7e8q), or an announced move for claim_draw." },
    square: { type: "string", description: "Origin square for legal_moves, such as e2." },
    level: parameter("chess_new_game", "level"),
    player: { type: "string", enum: ["white", "black", "both"], description: "The user's side for new_game or settings." },
    fen: { type: "string", description: "Optional starting FEN for new_game." },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const DESCRIPTION =
  "The chess game on the user's graphical board in opencode (they open it with /chess). " +
  "Use it whenever the user talks about 'the board', their game, or asks for a comment or hint on their position: " +
  "action show returns the current position, whose turn it is, the move list and the FEN. " +
  "Changes you make (moves, undo, new game) show up on the user's board right away. " +
  "Only move for the user when they ask you to. This is a different game from the chess_* MCP tools. " +
  "When the board shows a live online game against a person, show describes that game and every other action is refused: never help with moves there.";

type Input = { action?: unknown } & Record<string, unknown>;

export function runBoardTool(input: Input): { text: string; isError: boolean } {
  const action = input.action as Action;
  if (!ACTIONS.includes(action)) return { text: "Unknown action. Use one of: " + ACTIONS.join(", ") + ".", isError: true };
  const saved = parseSaved(readText());
  const online = liveOnline(saved);
  if (online !== null && (online.result === null || action === "show")) {
    if (action === "show") return { text: describeOnline(online), isError: false };
    return {
      text: "The user is playing a live online game against a person (" + opponent(online) + "), so you cannot " + action.replace("_", " ") +
        " now: no engine moves, hints, undo or analysis help while it is on. You may read it with action show and talk about it, " +
        "but do not suggest moves. The engine game is on hold until the user goes offline (key o on the board).",
      isError: true,
    };
  }
  const session = restore(saved, { boardShownElsewhere: true });
  const args: Record<string, unknown> = {};
  for (const key of ["move", "square", "level", "player", "fen"]) if (input[key] !== undefined && input[key] !== null) args[key] = input[key];
  const result = session.call("chess_" + action, args);
  const changes = action !== "show" && action !== "legal_moves" && action !== "hint";
  if (changes && !result.isError) save(session, "agent", summary(result.text), statePath(), saved?.online ?? null);
  return result;
}

function opponent(online: OnlineRecord): string { return online.you === "white" ? online.black : online.white; }

/** The online game as the user sees it on the board, from their side. */
function describeOnline(online: OnlineRecord): string {
  const game = new Chess(online.start);
  for (const move of online.moves) if (game.play(move) === null) break;
  const rows: string[] = [];
  const flipped = online.you === "black";
  for (let row = 0; row < 8; row++) {
    const rank = flipped ? row + 1 : 8 - row;
    let line = String(rank) + " |";
    for (let column = 0; column < 8; column++) {
      const piece = game.pieceAt("abcdefgh".charAt(flipped ? 7 - column : column) + String(rank));
      const letter = piece === null ? "." : piece.type === "knight" ? "n" : piece.type.charAt(0);
      line += " " + (piece !== null && piece.color === "white" ? letter.toUpperCase() : letter);
    }
    rows.push(line + " |");
  }
  const status = game.status();
  const toMove = status.turn === online.you ? "the user (" + online.you + ")" : opponent(online);
  return [
    "Live online game on " + online.server.replace(/^https?:\/\//, "") + ": " + online.white + " (White) vs " + online.black + " (Black). The user is " + online.you + ".",
    online.result !== null ? "Finished: " + online.verdict : "In progress: " + toMove + " to move" + (status.check ? ", check" : "") + ".",
    "",
    ...rows,
    "    " + (flipped ? "h g f e d c b a" : "a b c d e f g h"),
    "",
    "Moves: " + (online.moves.length === 0 ? "(none)" : online.moves.join(" ")),
    "FEN: " + game.fen(),
    "",
    online.result === null
      ? "This is a game against a real person. You may describe the position, but do not suggest moves, plans or evaluations: that would be cheating. Moves, hints and undo are refused."
      : "The game is over; you may discuss it freely.",
    "The user sees this board; don't paste it back.",
  ].join("\n");
}

/** The notes above the board ("You played e2e4." ...), told from the board's side: the agent did it. */
function summary(text: string): string {
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("  ")) break;
    notes.push(line.replace(/^You played /, "Played "));
  }
  return notes.join(" ");
}

type ToolEditor = { add(tool: Record<string, unknown>): void };
type Context = { tool: { transform(edit: (tools: ToolEditor) => void): Promise<unknown> } };

export default {
  id: "tuichess.board",
  async setup(context: Context) {
    await context.tool.transform((tools) => {
      tools.add({
        name: "chess_board",
        description: DESCRIPTION,
        input: INPUT,
        options: { codemode: false },
        execute: async (input: Input) => {
          const result = runBoardTool(input);
          return { content: (result.isError ? "Error: " : "") + result.text, metadata: { error: result.isError } };
        },
      });
    });
  },
};
