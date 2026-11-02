import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Keep the full application. Avoid Perry 0.5.1663's unbounded small-loop
// expansion in a generated copy, without changing the ordinary build.
const noRegex = process.argv.includes("--no-regex");
const directory = "dist/perry-small/" + (noRegex ? "no-regex-source" : "source");
for (const component of ["engine/src", "tui/src", "tests"]) {
  mkdirSync(directory + "/" + component, { recursive: true });
  cpSync(component, directory + "/" + component, { recursive: true });
}
const changes: { file: string; before: string; after: string }[] = [];
for (const file of ["engine/src/chess.ts", "tui/src/app.ts"]) {
  const path = directory + "/" + file;
  const source = readFileSync(path, "utf8");
  const updated = source.replace(
    /for \(let (\w+) = (-?\d+); \1 (<|<=) (-?\d+); \1\+\+\)/g,
    (before: string, variable: string, low: string, comparison: string, high: string): string => {
      const trips = Number(high) - Number(low) + (comparison === "<=" ? 1 : 0);
      if (trips <= 0 || trips > 8) return before;
      const after = before.replace(variable + "++", variable + " += 1");
      changes.push({ file, before, after });
      return after;
    },
  );
  writeFileSync(path, updated);
}
if (noRegex) {
  function replace(file: string, before: string, after: string, expected = 1): void {
    const path = directory + "/" + file;
    const source = readFileSync(path, "utf8");
    const count = source.split(before).length - 1;
    if (count !== expected) throw new Error(file + ": expected " + expected + " occurrences of " + before + ", got " + count);
    writeFileSync(path, source.split(before).join(after));
    changes.push({ file, before, after });
  }
  function append(file: string, after: string): void {
    const path = directory + "/" + file;
    writeFileSync(path, readFileSync(path, "utf8") + after);
    changes.push({ file, before: "", after });
  }
  const splitWhitespace = String.raw`
function splitWhitespace(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ((text[i] ?? "").trim() === "") {
      result.push(text.slice(start, i));
      while (i + 1 < text.length && (text[i + 1] ?? "").trim() === "") i += 1;
      start = i + 1;
    }
  }
  result.push(text.slice(start));
  return result;
}
`;
  replace("engine/src/chess.ts", String.raw`fen.trim().split(/\s+/)`, "splitWhitespace(fen.trim())");
  append("engine/src/chess.ts", splitWhitespace);
  replace("tui/src/app.ts", String.raw`raw.trim().replace(/^:/, "")`, "stripCommandPrefix(raw.trim())");
  replace("tui/src/app.ts", String.raw`command.split(/\s+/)`, "splitWhitespace(command)");
  replace("tui/src/app.ts", String.raw`/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(verb)`, "isCoordinateMove(verb)");
  replace("tui/src/app.ts", String.raw`.replace(/-/g, " ")`, `.split("-").join(" ")`);
  append("tui/src/app.ts", splitWhitespace + String.raw`
function stripCommandPrefix(text: string): string { return text.startsWith(":") ? text.slice(1) : text; }
function isCoordinateMove(text: string): boolean {
  if (text.length !== 4 && text.length !== 5) return false;
  const a = text.charCodeAt(0), b = text.charCodeAt(1), c = text.charCodeAt(2), d = text.charCodeAt(3);
  return a >= 97 && a <= 104 && b >= 49 && b <= 56 && c >= 97 && c <= 104 && d >= 49 && d <= 56 &&
    (text.length === 4 || "qrbn".includes(text[4] ?? ""));
}
`);
  replace("tui/src/main.ts", String.raw`frame.replace(/\n/g, "\r\n")`, String.raw`frame.split("\n").join("\r\n")`);
  replace("tui/src/main.ts", String.raw`pending.slice(0, newline).replace(/\r$/, "")`, "stripLineEnd(pending.slice(0, newline))");
  append("tui/src/main.ts", String.raw`
function stripLineEnd(text: string): string { return text.endsWith("\r") ? text.slice(0, -1) : text; }
`);
  // Perry's regex detector also matches unrelated methods named "search".
  // Rename only this generated app and its tests; the public source stays intact.
  replace("engine/src/chess.ts", "search(", "findMove(");
  replace("tui/src/app.ts", "search(", "findMove(", 2);
  replace("tests/run.ts", "search(", "findMove(", 9);
  // The patched compiler can rule out IPC for a discarded signal-listener
  // call with a lexical callback. Preserve each callback for removal on exit.
  replace("tui/src/main.ts", "  function restore(): void {",
    "  let onInterrupt: () => void;\n  let onTerminate: () => void;\n  function restore(): void {");
  replace("tui/src/main.ts", `process.removeListener("SIGINT", finish)`, `process.removeListener("SIGINT", onInterrupt)`);
  replace("tui/src/main.ts", `process.removeListener("SIGTERM", finish)`, `process.removeListener("SIGTERM", onTerminate)`);
  replace("tui/src/main.ts", `process.on("exit", restore)`, `process.on("exit", () => restore())`);
  replace("tui/src/main.ts", `process.on("SIGINT", finish)`, `process.on("SIGINT", onInterrupt = () => finish())`);
  replace("tui/src/main.ts", `process.on("SIGTERM", finish)`, `process.on("SIGTERM", onTerminate = () => finish())`);
  mkdirSync(directory + "/scripts", { recursive: true });
  writeFileSync(directory + "/scripts/compare-workload.ts", readFileSync("scripts/compare-workload.ts", "utf8"));
  replace("scripts/compare-workload.ts", ".search(", ".findMove(", 2);
}
writeFileSync(directory + "-changes.json", JSON.stringify(changes, null, 2) + "\n");
console.log("Prepared full app with " + String(changes.length) + " size updates for Perry in " + directory + ".");
