import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { cpus, totalmem } from "node:os";

// Run after npm run build && npm run build:perry. This driver is Node-only;
// every measurement exercises the unmodified CLI, including Perry's native CLI.
// No runtime benchmarks run concurrently. Results include all raw samples.
interface Target { name: string; command: string[] }
const manifestIndex = process.argv.indexOf("--manifest");
const manifestPath = manifestIndex < 0 ? undefined : process.argv[manifestIndex + 1];
if (manifestIndex >= 0 && manifestPath === undefined) throw new Error("Expected manifest path");
const manifest: { directory: string; targets: Target[] } | undefined = manifestPath === undefined
  ? undefined : JSON.parse(readFileSync(manifestPath, "utf8"));
const fourWay = process.argv.includes("--four-way");
const targets: Target[] = manifest?.targets ?? (fourWay ? [
  { name: "Node JS", command: [process.execPath, "dist/tui/src/main.js"] },
  { name: "Bun TS", command: ["bun", "tui/src/main.ts"] },
  { name: "Perry", command: ["./dist/chess"] },
  { name: "ScriptC", command: ["./dist/compiler-trials/chess-scriptc-adapted"] },
] : [
  { name: "Node TS", command: [process.execPath, "tui/src/main.ts"] },
  { name: "Node JS", command: [process.execPath, "dist/tui/src/main.js"] },
  { name: "Bun TS", command: ["bun", "tui/src/main.ts"] },
  { name: "Perry", command: ["./dist/chess"] },
]);
const opening = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const middle = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const ending = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
const cases = [
  { name: "opening-L1", fen: opening, level: 1 },
  { name: "opening-L5", fen: opening, level: 5 },
  { name: "opening-L7", fen: opening, level: 7 },
  { name: "opening-L10", fen: opening, level: 10 },
  { name: "middlegame-L5", fen: middle, level: 5 },
  { name: "endgame-L5", fen: ending, level: 5 },
];
const quick = process.argv.includes("--quick");
const startupOnly = process.argv.includes("--startup-only");
const startupRuns = quick ? 4 : 25;
const searchRuns = quick ? 2 : 5;
const output = manifest?.directory ?? (fourWay ? "dist/benchmarks-four-way" : "dist/benchmarks");
mkdirSync(output, { recursive: true });
function exec(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(command + ": " + result.stderr);
  return result.stdout.trim();
}
function summarize(values: number[]): { median: number; min: number; max: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    median: ((sorted[Math.floor((n - 1) / 2)] ?? 0) + (sorted[Math.floor(n / 2)] ?? 0)) / 2,
    min: sorted[0] ?? 0, max: sorted[n - 1] ?? 0,
    p95: sorted[Math.ceil(n * 0.95) - 1] ?? 0,
  };
}
class Session {
  child: ChildProcessWithoutNullStreams;
  buffer = "";
  stderr = "";
  frames: string[] = [];
  pending: { resolve: (frame: string) => void; reject: (error: Error) => void } | null = null;
  closed: Promise<number | null>;
  started = performance.now();
  constructor(target: Target, args: string[] = [], timed = false) {
    const command = [...target.command, "--plain", "--side", "both", ...args];
    if (timed) command.unshift("/usr/bin/time", "-l");
    this.child = spawn(command[0] ?? "", command.slice(1), {
      stdio: "pipe", env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const marker = "\n  > \n";
      let end = this.buffer.indexOf(marker);
      while (end >= 0) {
        const frame = this.buffer.slice(0, end + marker.length);
        this.buffer = this.buffer.slice(end + marker.length);
        if (this.pending !== null) {
          const waiter = this.pending; this.pending = null; waiter.resolve(frame);
        } else this.frames.push(frame);
        end = this.buffer.indexOf(marker);
      }
    });
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.closed = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (code) => {
        if (this.pending !== null) this.pending.reject(new Error("CLI exited: " + this.stderr));
        resolve(code);
      });
    });
  }
  async frame(): Promise<string> {
    const queued = this.frames.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL"); reject(new Error("CLI response timed out"));
      }, 240000);
      this.pending = {
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }
  async send(command: string): Promise<{ ms: number; frame: string }> {
    const start = performance.now();
    this.child.stdin.write(command + "\n");
    const frame = await this.frame();
    return { ms: performance.now() - start, frame };
  }
  async stop(): Promise<number | null> {
    this.child.stdin.end("quit\n");
    const code = await this.closed;
    if (code !== 0) throw new Error("CLI failed: " + this.stderr);
    const match = /([0-9]+)\s+maximum resident set size/.exec(this.stderr);
    return match === null ? null : Number(match[1]); // macOS time -l uses bytes.
  }
}
const startup: Record<string, { milliseconds: number[]; idleRssBytes: number[] }> = {};
const searches: Record<string, Record<string, {
  firstMs: number; repeatMs: number[]; peakRssBytes: number | null; fingerprint: string;
}>> = {};
const localMoves: Record<string, number[]> = {};
const metadata = {
  measuredAt: new Date().toISOString(), commit: exec("git", ["rev-parse", "HEAD"]),
  cpu: cpus()[0]?.model, memoryBytes: totalmem(), os: exec("sw_vers", ["-productVersion"]),
  architecture: process.arch, node: process.version, bun: exec("bun", ["--version"]),
  perry: exec("perry", ["--version"]),
  scriptc: fourWay ? exec("dist/toolchains/scriptc-0.4.7/bin/scriptc", ["--version"]) : null,
  scriptcAdaptation: fourWay ? "Only the stdout error-listener registration is omitted; engine source is identical." : null,
  startupRuns, searchRuns, quick,
  cases, targets,
  methodology: "Serial CLI sessions over pipes; parent monotonic wall clock. Startup: spawn to complete first board, 3 discarded launches per target, rotated target order. Idle RSS: ps after first board in 5 separate launches after startup timing. Search: first hint in fresh session, then repeated hints in that session with cleared engine search table; first repeat discarded except L10. L10: first search plus 2 repeats. Peak RSS: macOS /usr/bin/time -l across each entire search session. These are warm-filesystem process starts, not cold boot starts. All search result frames must match across runtimes and repeats. Local move: play e2e4 from a reset board, including validation and render, 3 discarded then 25 measured (5 in quick mode). No console output inside timed regions.",
};
function save(): void {
  writeFileSync(output + (startupOnly ? "/startup-results.json" : "/results.json"), JSON.stringify({ metadata, startup, searches, localMoves }, null, 2) + "\n");
}

for (const target of targets) {
  startup[target.name] = { milliseconds: [], idleRssBytes: [] };
  searches[target.name] = {};
  localMoves[target.name] = [];
}
console.log("Startup and idle RSS...");
for (let round = -3; round < startupRuns; round++) {
  for (let j = 0; j < targets.length; j++) {
    const target = targets[(j + round + 3) % targets.length];
    if (target === undefined) continue;
    const session = new Session(target);
    const frame = await session.frame();
    const ms = performance.now() - session.started;
    if (!frame.includes("WHITE TO MOVE")) throw new Error("Missing initial board");
    const record = startup[target.name];
    if (record !== undefined && round >= 0) {
      record.milliseconds.push(ms);
    }
    await session.stop();
  }
}
for (const target of targets) {
  for (let i = 0; i < 5; i++) {
    const session = new Session(target);
    await session.frame();
    startup[target.name]?.idleRssBytes.push(Number(exec("ps", ["-o", "rss=", "-p", String(session.child.pid)])) * 1024);
    await session.stop();
  }
}
save();
for (const target of targets) console.log(target.name, JSON.stringify(summarize(startup[target.name]?.milliseconds ?? [])));
if (startupOnly) process.exit(0);

console.log("Local move latency...");
for (const target of targets) {
  const session = new Session(target);
  await session.frame();
  for (let i = -3; i < (quick ? 5 : 25); i++) {
    await session.send("new");
    const result = await session.send("e2e4");
    if (!result.frame.includes("Played e2e4.")) throw new Error("Local move failed");
    if (i >= 0) localMoves[target.name]?.push(result.ms);
  }
  await session.stop();
}
save();

if (process.argv.includes("--local-only")) process.exit(0);

for (let c = 0; c < cases.length; c++) {
  const scenario = cases[c];
  if (scenario === undefined) continue;
  let reference: string | undefined;
  for (let j = 0; j < targets.length; j++) {
    const target = targets[(j + c) % targets.length];
    if (target === undefined) continue;
    console.log("Search", scenario.name, target.name);
    const session = new Session(target, ["--fen", scenario.fen, "--level", String(scenario.level)], true);
    await session.frame();
    const first = await session.send("hint");
    if (!first.frame.includes("Hint: ")) throw new Error("Missing hint: " + first.frame);
    if (reference === undefined) reference = first.frame;
    if (first.frame !== reference) throw new Error("Cross-runtime search mismatch: " + scenario.name + " " + target.name);
    const repeatMs: number[] = [];
    const repeats = scenario.level === 10 ? 2 : searchRuns + 1;
    for (let i = 0; i < repeats; i++) {
      const result = await session.send("hint");
      if (result.frame !== reference) throw new Error("Repeat search mismatch");
      if (i > 0 || scenario.level === 10) repeatMs.push(result.ms);
    }
    const peakRssBytes = await session.stop();
    if (peakRssBytes === null) throw new Error("Missing peak RSS");
    const fingerprint = (first.frame.match(/Depth .+/)?.[0] ?? "") + " | " +
      (first.frame.match(/PV .+/)?.[0] ?? "") + " | " + (first.frame.match(/Hint: .+/)?.[0] ?? "");
    const record = searches[target.name];
    if (record !== undefined) record[scenario.name] = { firstMs: first.ms, repeatMs, peakRssBytes, fingerprint };
    save();
    console.log(JSON.stringify({ firstMs: first.ms, repeated: summarize(repeatMs), peakRssBytes, fingerprint }));
  }
}

// Report payload bytes, not filesystem block allocation. Exclude dev dependencies,
// declarations and source maps. Compressed figures use gzip level 9 on each file.
const sourceFiles = ["package.json", "engine/src/chess.ts", "tui/src/app.ts", "tui/src/main.ts"];
const jsFiles = ["package.json", "dist/engine/src/chess.js", "dist/tui/src/app.js", "dist/tui/src/main.js"];
function sizes(paths: string[]): { bytes: number; gzipBytes: number; files: { path: string; bytes: number; gzipBytes: number }[] } {
  const files = paths.map((path) => {
    const content = readFileSync(path);
    return { path, bytes: statSync(path).size, gzipBytes: gzipSync(content, { level: 9 }).length };
  });
  return { bytes: files.reduce((sum, f) => sum + f.bytes, 0), gzipBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0), files };
}
const nodePath = realpathSync(process.execPath);
const bunPath = realpathSync(exec("which", ["bun"]));
const distribution = {
  source: sizes(sourceFiles), javascript: sizes(jsFiles),
  nodeRuntime: sizes([nodePath]), bunRuntime: sizes([bunPath]), perryExecutable: sizes(["dist/chess"]),
  scriptcExecutable: fourWay ? sizes(["dist/compiler-trials/chess-scriptc-adapted"]) : null,
  linkage: {
    node: exec("otool", ["-L", nodePath]), bun: exec("otool", ["-L", bunPath]),
    perry: exec("otool", ["-L", "dist/chess"]),
  },
};
writeFileSync(output + "/distribution.json", JSON.stringify(distribution, null, 2) + "\n");
console.log("Saved " + output + "/results.json and distribution.json");
