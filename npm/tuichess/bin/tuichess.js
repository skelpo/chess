#!/usr/bin/env node
// Runs the native tuichess binary for this computer. npm installs exactly one of the optional
// tuichess-<os>-<cpu> packages (picked by their os/cpu fields); this script finds it and passes
// the arguments, the terminal and the exit status straight through.
"use strict";
const { spawn } = require("child_process");

const PACKAGES = {
  "darwin-arm64": "tuichess-darwin-arm64",
  "darwin-x64": "tuichess-darwin-x64",
  "linux-arm64": "tuichess-linux-arm64",
  "linux-x64": "tuichess-linux-x64",
};

const key = process.platform + "-" + process.arch;
const name = PACKAGES[key];
const file = process.platform === "win32" ? "tuichess.exe" : "tuichess";

if (name === undefined) {
  console.error("tuichess: no native build for " + key + " yet. Builds exist for " + Object.keys(PACKAGES).join(", ") + "." +
    (process.platform === "win32" ? " On Windows, run it in WSL." : ""));
  console.error("Run it from source instead: git clone https://github.com/skelpo/chess && cd chess && node tui/src/main.ts");
  process.exit(1);
}

let binary;
try {
  binary = require.resolve(name + "/bin/" + file);
} catch (error) {
  console.error("tuichess: the " + name + " package is missing; npm skipped the optional dependency for " + key + ".");
  console.error("Reinstall with optional dependencies: npm install -g tuichess --include=optional");
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
// The game reads Ctrl-C itself in raw mode; signals from outside still reach it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch (_) {} });
}
child.on("error", (error) => {
  console.error("tuichess: cannot start " + binary + ": " + error.message);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 0 : code);
});
