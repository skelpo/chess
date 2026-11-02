/**
 * opencode server plugin: the chess_board tool, so the agent can see and play the game on the user's
 * graphical board (the TUI plugin in tui.tsx). Both read and write the shared game file in game.ts.
 * No imports beyond the engine and node:, so it loads without installing anything.
 */
import { TOOLS } from "./lib/session.ts";
import { parseSaved, readText, restore, save } from "./game.ts";

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
  "Only move for the user when they ask you to. This is a different game from the chess_* MCP tools.";

type Input = { action?: unknown } & Record<string, unknown>;

export function runBoardTool(input: Input): { text: string; isError: boolean } {
  const action = input.action as Action;
  if (!ACTIONS.includes(action)) return { text: "Unknown action. Use one of: " + ACTIONS.join(", ") + ".", isError: true };
  const session = restore(parseSaved(readText()), { boardShownElsewhere: true });
  const args: Record<string, unknown> = {};
  for (const key of ["move", "square", "level", "player", "fen"]) if (input[key] !== undefined && input[key] !== null) args[key] = input[key];
  const result = session.call("chess_" + action, args);
  const changes = action !== "show" && action !== "legal_moves" && action !== "hint";
  if (changes && !result.isError) save(session, "agent", summary(result.text));
  return result;
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
