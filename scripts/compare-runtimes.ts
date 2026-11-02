import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

interface ComparisonManifest {
  directory: string;
  targets: { name: string; command: string[] }[];
  rounds?: number;
}
const manifestIndex = process.argv.indexOf("--manifest");
const manifestPath = manifestIndex < 0 ? undefined : process.argv[manifestIndex + 1];
if (manifestIndex >= 0 && manifestPath === undefined) throw new Error("Expected comparison manifest path");
const manifest: ComparisonManifest | undefined = manifestPath === undefined ? undefined : JSON.parse(readFileSync(manifestPath, "utf8"));
const rounds = manifest?.rounds ?? 3;
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error("Expected positive integer rounds");

const sizeComparison = process.argv.includes("--perry-size");
const noRegexComparison = process.argv.includes("--perry-regex-free");
const directory = manifest?.directory ?? (noRegexComparison ? "dist/minimize-perry/no-regex-performance" : sizeComparison ? "dist/minimize-perry/performance" : "dist/comparison");
mkdirSync(directory, { recursive: true });
const targets = manifest?.targets ?? (noRegexComparison ? [
  { name: "Perry original", command: ["dist/comparison/engine-perry-stripped"] },
  { name: "Perry minimum, no regex", command: ["dist/minimize-perry/engine-no-regex"] },
] : sizeComparison ? [
  { name: "Perry original", command: ["dist/comparison/engine-perry-stripped"] },
  { name: "Perry small app", command: ["dist/minimize-perry/engine-oz"] },
  { name: "Perry small runtime", command: ["dist/minimize-perry/engine-runtime-z"] },
  { name: "Perry small runtime, no specialized ABI", command: ["dist/minimize-perry/engine-runtime-z-no-abi"] },
] : [
  { name: "Node JS", command: [process.execPath, directory + "/js/scripts/compare-workload.js"] },
  { name: "Bun TS", command: ["bun", "scripts/compare-workload.ts"] },
  { name: "Perry", command: [directory + "/engine-perry-stripped"] },
  { name: "ScriptC", command: [directory + "/engine-scriptc-stripped"] },
]);
const workloads = process.argv.includes("--search-only") ? [{ mode: "search", amount: 250000 }] : [
  { mode: "evaluate", amount: 100000 }, { mode: "legal", amount: 10000 },
  { mode: "perft", amount: 4 }, { mode: "search", amount: 250000 },
];
interface Measurement {
  runtime: string; round: number; mode: string; amount: number; checksum: number;
  detail: string; milliseconds: number; processWallMs: number;
  instructions: number; cycles: number; peakRssBytes: number;
}
const results: Measurement[] = [];
for (const workload of workloads) {
  let reference: string | undefined;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[(i + round) % targets.length];
      if (target === undefined) continue;
      const start = performance.now();
      const run = spawnSync("/usr/bin/time", ["-l", ...target.command, workload.mode, String(workload.amount)], {
        encoding: "utf8", timeout: 180000, env: { ...process.env, NO_COLOR: "1" },
      });
      const processWallMs = performance.now() - start;
      if (run.status !== 0) throw new Error(target.name + ": " + run.stderr + String(run.error ?? ""));
      const value = JSON.parse(run.stdout) as { mode: string; amount: number; checksum: number; detail: string; milliseconds: number };
      const fingerprint = JSON.stringify([value.mode, value.amount, value.checksum, value.detail]);
      if (reference === undefined) reference = fingerprint;
      if (fingerprint !== reference) throw new Error("Workload mismatch: " + target.name);
      function counter(label: string): number {
        const match = new RegExp("([0-9]+)\\s+" + label).exec(run.stderr);
        if (match === null) throw new Error("Missing counter: " + label);
        return Number(match[1]);
      }
      results.push({ runtime: target.name, round, ...value, processWallMs,
        instructions: counter("instructions retired"), cycles: counter("cycles elapsed"),
        peakRssBytes: counter("maximum resident set size") });
      writeFileSync(directory + "/engine-results.json", JSON.stringify({
        recordedAt: new Date().toISOString(), targets, workloads, rounds,
        methodology: "Sequential child processes, rotating runtime order. Inner wall time excludes startup/setup/warmup/serialization. OS counters and peak RSS include the whole process. Each workload verifies unchanged game state and identical result fingerprints across all runs.", results,
      }, null, 2) + "\n");
      console.log(workload.mode, target.name, value.milliseconds.toFixed(2), "ms", counter("instructions retired"), "instructions");
    }
  }
}
