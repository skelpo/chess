import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ScriptC 0.4.7 rejects this stdout event registration (SC2020).
// Keep the compatibility experiment separate from the production entry point:
// this copy lacks its stdout-error/EPIPE handler registration.
const destination = "dist/compiler-trials/scriptc-adapted";
const source = readFileSync("tui/src/main.ts", "utf8");
const unsupported = '  process.stdout.on("error", onError);\n';
if (source.split(unsupported).length !== 2) {
  throw new Error("Expected exactly one stdout error-listener registration; review the ScriptC adaptation.");
}
mkdirSync(destination, { recursive: true });
cpSync("engine/src", destination + "/engine/src", { recursive: true });
cpSync("tui/src", destination + "/tui/src", { recursive: true });
writeFileSync(destination + "/tui/src/main.ts", source.replace(unsupported, ""));
console.log("Prepared " + destination + "/tui/src/main.ts (one stdout listener omitted)");
