// Exercise the complete CLI's text handling against the original Node app.
// Usage: node tests/text-parity.ts EXECUTABLE [ARGUMENTS]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const candidate = process.argv.slice(2);
const executable = candidate.shift();
if (executable === undefined) throw new Error("Pass the candidate executable and arguments");
const whitespace = [9, 11, 12, 32, 160, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const commands = [":help", "::help", ": help", "e2e4", "undo", "E2E4", "undo", "e2e4q", "a0a1",
  "a1i2", "e2e4qq", "e2e", "1234", "level 5\r", "level 5\r\r", "flip", "flip"];
for (const code of whitespace) {
  const space = String.fromCharCode(code);
  commands.push(space + ":level" + space + "5" + space,
    "load" + space + fen.split(" ").join(space + space), "fen");
}
for (const separator of ["\0", "\x85", "\u200b", "\u180e"]) commands.push("level" + separator + "5");
commands.push("load 4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8x", "a7a8n", "fen", "quit");
const input = commands.join("\n") + "\n";
function run(command: string, args: string[]): string {
  const result = spawnSync(command, [...args, "--plain", "--side", "both", "--unicode"], {
    input, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed: " + result.stderr);
  return result.stdout + result.stderr;
}
const expected = run(process.execPath, ["tui/src/main.ts"]);
const actual = run(executable, candidate);
if (actual !== expected) throw new Error("Candidate CLI text behavior differs from Node");
console.log(JSON.stringify({ commands: commands.length, whitespaceCharacters: whitespace.length,
  bytes: Buffer.byteLength(actual), sha256: createHash("sha256").update(actual).digest("hex"), matched: true }));
