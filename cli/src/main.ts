/**
 * The chess engine as one native program (Perry) or a Node/Bun script.
 *   chess-engine move   read {"start","moves","level"} on stdin, print the engine's move as JSON
 *   chess-engine mcp    serve the chess tools over stdio (Model Context Protocol)
 */
import { serve } from "../../mcp/src/serve.ts";
import { answer } from "./move.ts";

const USAGE = `Usage: chess-engine move | mcp

  move   Read {"start": "<FEN>", "moves": ["e2e4", ...], "level": 1..10} on stdin;
         print {"move", "claimDraw", "score", "depth", "nodes", "line", "completed", "ms"}.
  mcp    Serve the chess tools over stdio (Model Context Protocol).
`;

function readAll(done: (text: string) => void): void {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { text += chunk; });
  process.stdin.on("end", () => { done(text); });
  process.stdin.resume();
}

const mode = process.argv[2] ?? "";
if (mode === "move") {
  readAll((text) => {
    const started = Date.now();
    process.stdout.write(answer(text, () => Date.now() - started) + "\n");
  });
} else if (mode === "mcp") {
  serve();
} else {
  process.stdout.write(USAGE);
  if (mode !== "--help" && mode !== "-h") process.exitCode = 2;
}
