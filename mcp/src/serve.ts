/**
 * Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0.
 * `serve()` touches host APIs (process stdin/stdout); everything else is plain.
 */
import { ChessSession, TOOLS } from "./tools.ts";

const VERSION = "0.1.0";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Chess against a built-in engine. Moves use UCI coordinate notation (e2e4, e1g1, e7e8q). " +
  "Always play and read moves through these tools; never invent the engine's moves or the position. " +
  "Show the returned board to the user in a code block.";

type Id = string | number | null;
interface Request { readonly id?: Id; readonly method?: unknown; readonly params?: unknown }

const session = new ChessSession();


function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function reply(id: Id, result: unknown): void { send({ jsonrpc: "2.0", id, result }); }
function fail(id: Id, code: number, message: string): void { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function field(params: unknown, key: string): unknown {
  if (typeof params !== "object" || params === null) return undefined;
  return (params as Readonly<Record<string, unknown>>)[key];
}

function handle(request: Request): void {
  const id = request.id;
  const method = request.method;
  // Notifications (no id) need no response; the only ones sent here are lifecycle notices.
  if (id === undefined) return;
  if (typeof method !== "string") { fail(id, -32600, "Invalid request."); return; }
  switch (method) {
    case "initialize": {
      const requested = field(request.params, "protocolVersion");
      const protocolVersion = typeof requested === "string" && SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
      reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "chess", version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "ping": reply(id, {}); return;
    case "tools/list": reply(id, { tools: TOOLS }); return;
    case "tools/call": {
      const name = field(request.params, "name");
      if (typeof name !== "string") { fail(id, -32602, "Missing tool name."); return; }
      if (!TOOLS.some((tool) => tool.name === name)) { fail(id, -32602, "Unknown tool: " + name); return; }
      const result = session.call(name, field(request.params, "arguments"));
      reply(id, { content: [{ type: "text", text: result.text }], isError: result.isError });
      return;
    }
    default: fail(id, -32601, "Method not found: " + method);
  }
}

function onLine(line: string): void {
  if (line.trim() === "") return;
  let message: unknown;
  try { message = JSON.parse(line); } catch { fail(null, -32700, "Parse error."); return; }
  if (typeof message !== "object" || message === null || Array.isArray(message)) { fail(null, -32600, "Invalid request."); return; }
  handle(message as Request);
}

/** Reads requests from stdin until it closes. */
export function serve(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => { onLine(buffer); process.exit(0); });
}
