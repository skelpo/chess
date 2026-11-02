import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Diagnostic copies only: the production engine is never edited. These variants
// isolate source patterns identified by sampling the optimized Perry executable.
const directory = "dist/profiles/variants";
mkdirSync(directory, { recursive: true });
const source = readFileSync("engine/src/chess.ts", "utf8");
function inlineBounds(text: string): string {
  return text.replace(/^function onBoard\(square: number\): boolean \{.*\}\n/m, "")
    .replace(/\bonBoard\((\w+)\)/g, "($1 >= 0 && $1 < 128 && ($1 & 0x88) === 0)");
}
function indexedAttackLoops(text: string): string {
  const start = text.indexOf("  private attacked(");
  const end = text.indexOf("  private addPawn(", start);
  if (start < 0 || end < 0) throw new Error("Cannot locate attacked()");
  let attacked = text.slice(start, end);
  attacked = attacked.replace("for (const delta of [-1, 1]) {", "for (let delta = -1; delta <= 1; delta += 2) {");
  for (const array of ["KNIGHT", "KING"]) {
    attacked = attacked.replace("for (const delta of " + array + ") {",
      "for (let deltaIndex = 0; deltaIndex < " + array + ".length; deltaIndex++) {\n      const delta = " + array + "[deltaIndex] ?? 0;");
  }
  return text.slice(0, start) + attacked + text.slice(end);
}
const variants = [
  { name: "baseline", source },
  { name: "inline-bounds", source: inlineBounds(source) },
  { name: "indexed-attacks", source: indexedAttackLoops(source) },
  { name: "both", source: inlineBounds(indexedAttackLoops(source)) },
];
const workload = `import { Chess } from "./engine.ts";
const game = new Chess();
if (game.perft(3) !== 8902) throw new Error("perft mismatch");
const before = game.fen();
const result = game.search({ level: 10, maxNodes: 250000 });
if (game.fen() !== before) throw new Error("search changed position");
console.log(JSON.stringify(result));
`;
function run(command: string, args: string[]): { ms: number; stdout: string } {
  const start = performance.now();
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(command + " failed: " + result.stderr + String(result.error ?? ""));
  return { ms: performance.now() - start, stdout: result.stdout.trim() };
}
if (!process.argv.includes("--run-only")) {
  for (const variant of variants) {
    const path = directory + "/" + variant.name;
    mkdirSync(path, { recursive: true });
    writeFileSync(path + "/engine.ts", variant.source);
    writeFileSync(path + "/main.ts", workload);
    console.log("Building", variant.name);
    const result = run("perry", ["compile", path + "/main.ts", "-o", path + "/chess", "--strict-eval", "--strict-dynamic-import", "--strict-unimplemented"]);
    writeFileSync(path + "/compile.log", result.stdout);
  }
}
if (!process.argv.includes("--build-only")) {
  const results: { variant: string; runtime: string; ms: number; fingerprint: string }[] = [];
  let reference: string | undefined;
  // Rotate variants across rounds. All builds finish before timings begin.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[(round + i) % variants.length];
      if (variant === undefined) continue;
      const path = directory + "/" + variant.name;
      for (const runtime of ["Perry", "Node"]) {
        const result = runtime === "Perry" ? run(path + "/chess", []) : run(process.execPath, [path + "/main.ts"]);
        if (reference === undefined) reference = result.stdout;
        if (reference !== result.stdout) throw new Error("Result mismatch: " + variant.name + " / " + runtime);
        results.push({ variant: variant.name, runtime, ms: result.ms, fingerprint: result.stdout });
        writeFileSync(directory + "/results.json", JSON.stringify({ workload, rounds: 3, results }, null, 2) + "\n");
        console.log(variant.name, runtime, result.ms.toFixed(1), "ms");
      }
    }
  }
}
