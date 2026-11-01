import { spawnSync } from "node:child_process";

interface Runtime { readonly name: string; readonly executable: string; readonly arguments: readonly string[] }
const runtimes: readonly Runtime[] = [
  { name: "Node", executable: process.execPath, arguments: ["tui/src/main.ts"] },
  { name: "Bun", executable: "bun", arguments: ["tui/src/main.ts"] },
  { name: "Perry", executable: "./dist/chess", arguments: [] },
  { name: "compiled Node", executable: process.execPath, arguments: ["dist/tui/src/main.js"] },
];
interface Scenario { readonly name: string; readonly arguments: readonly string[]; readonly input: string; readonly status: number; readonly expected: string }
const scenarios: readonly Scenario[] = [
  { name: "help", arguments: ["--help"], input: "", status: 0, expected: "Usage: chess" },
  { name: "bad level", arguments: ["--level", "11"], input: "", status: 1, expected: "Level must" },
  { name: "bad FEN", arguments: ["--fen", "invalid"], input: "", status: 1, expected: "FEN must" },
  { name: "local play", arguments: ["--plain", "--side", "both"], input: "e2e4\ne7e5\nfen\nundo\nfen\nquit\n", status: 0, expected: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2" },
  { name: "EOF without newline", arguments: ["--plain", "--side", "both"], input: "e2e4", status: 0, expected: "Played e2e4." },
  { name: "promotion", arguments: ["--plain", "--side", "both", "--fen", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"], input: "a7a8n\nfen\nquit\n", status: 0, expected: "N3k3/8/8/8/8/8/8/4K3 b - - 0 1" },
  { name: "kids reply", arguments: ["--plain", "--level", "1"], input: "e2e4\nundo\nquit\n", status: 0, expected: "Computer played" },
  { name: "club opening", arguments: ["--plain", "--side", "black", "--level", "5"], input: "quit\n", status: 0, expected: "Computer played" },
  { name: "master opening", arguments: ["--plain", "--side", "black", "--level", "10"], input: "quit\n", status: 0, expected: "Computer played" },
];

for (const scenario of scenarios) {
  let reference = "";
  for (const runtime of runtimes) {
    const result = spawnSync(runtime.executable, [...runtime.arguments, ...scenario.arguments], {
      input: scenario.input, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error !== undefined) throw result.error;
    const output = result.stdout + result.stderr;
    if (result.status !== scenario.status || !output.includes(scenario.expected)) {
      throw new Error(runtime.name + " failed " + scenario.name + ": " + output);
    }
    if (runtime.name === "Node") reference = output;
    else if (output !== reference) throw new Error(runtime.name + " differs from Node in " + scenario.name + "\nNODE:\n" + reference + "\nACTUAL:\n" + output);
  }
  console.log("ok · identical output on all four targets: " + scenario.name);
}

const node = spawnSync(process.execPath, ["tests/run.ts"], { encoding: "utf8", timeout: 120000 });
const native = spawnSync("./dist/chess-tests", [], { encoding: "utf8", timeout: 120000 });
if (node.error !== undefined) throw node.error;
if (native.error !== undefined) throw native.error;
if (node.status !== 0 || native.status !== 0 || node.stdout !== native.stdout) {
  throw new Error("Native test results differ from Node.\nNODE:\n" + node.stdout + node.stderr + "\nNATIVE:\n" + native.stdout + native.stderr);
}
console.log("PASS · runtime parity, full-strength search, CLI, pipes and native test fingerprint");
