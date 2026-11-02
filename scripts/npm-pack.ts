/**
 * Lays out the npm packages for a release:
 *   node scripts/npm-pack.ts <version> <binaries-dir> <out-dir>
 * <binaries-dir> holds tuichess-<os>-<cpu> (tuichess-win32-x64.exe on Windows), one per platform.
 * <out-dir> gets tuichess/ (the launcher, with every platform as an optional dependency) and one
 * folder per platform package, each ready for `npm publish`.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = [
  { key: "darwin-arm64", os: "darwin", cpu: "arm64", label: "macOS Apple silicon" },
  { key: "darwin-x64", os: "darwin", cpu: "x64", label: "macOS Intel" },
  { key: "linux-x64", os: "linux", cpu: "x64", label: "Linux x64" },
  { key: "linux-arm64", os: "linux", cpu: "arm64", label: "Linux arm64" },
  { key: "win32-x64", os: "win32", cpu: "x64", label: "Windows x64" },
] as const;

const [version, binaries, out] = process.argv.slice(2);
if (version === undefined || binaries === undefined || out === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  process.stderr.write("Usage: node scripts/npm-pack.ts <version> <binaries-dir> <out-dir>\n");
  process.exit(2);
}

const common = {
  version,
  license: "MIT",
  author: "Ralph Küpper",
  homepage: "https://tuichess.dev",
  repository: { type: "git", url: "git+https://github.com/skelpo/chess.git" },
  bugs: { url: "https://github.com/skelpo/chess/issues" },
  publishConfig: { access: "public" },
};

rmSync(out, { recursive: true, force: true });
const missing: string[] = [];
for (const platform of PLATFORMS) {
  const file = platform.os === "win32" ? "tuichess.exe" : "tuichess";
  const source = join(binaries, "tuichess-" + platform.key + (platform.os === "win32" ? ".exe" : ""));
  if (!existsSync(source)) { missing.push(platform.key); continue; }
  const dir = join(out, "tuichess-" + platform.key);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(source, join(dir, "bin", file));
  chmodSync(join(dir, "bin", file), 0o755);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
  writeFileSync(join(dir, "README.md"), "# tuichess-" + platform.key + "\n\nThe native " + platform.label +
    " binary of [tuichess](https://www.npmjs.com/package/tuichess). Install `tuichess` instead; it picks this package for you.\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "tuichess-" + platform.key,
    description: "tuichess native binary for " + platform.label + " (compiled with Perry).",
    ...common,
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["bin/", "README.md", "LICENSE"],
  }, null, 2) + "\n");
}
if (missing.length > 0) {
  process.stderr.write("Missing binaries for: " + missing.join(", ") + "\n");
  process.exit(1);
}

const main = join(out, "tuichess");
mkdirSync(join(main, "bin"), { recursive: true });
copyFileSync("npm/tuichess/bin/tuichess.js", join(main, "bin", "tuichess.js"));
chmodSync(join(main, "bin", "tuichess.js"), 0o755);
copyFileSync("npm/tuichess/README.md", join(main, "README.md"));
copyFileSync("LICENSE", join(main, "LICENSE"));
writeFileSync(join(main, "package.json"), JSON.stringify({
  name: "tuichess",
  description: "Chess in your terminal: the engine or people online, with high scores. One native binary, compiled from TypeScript with Perry.",
  ...common,
  keywords: ["chess", "terminal", "tui", "cli", "game", "mcp", "perry"],
  bin: { tuichess: "bin/tuichess.js" },
  files: ["bin/", "README.md", "LICENSE"],
  engines: { node: ">=16" },
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => ["tuichess-" + p.key, version])),
}, null, 2) + "\n");
process.stdout.write("Packed tuichess " + version + " for " + PLATFORMS.map((p) => p.key).join(", ") + " into " + out + "\n");
