import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Diagnostic sources only; production engine and terminal sources stay intact.
const directory = "dist/comparison";
mkdirSync(directory, { recursive: true });
writeFileSync(directory + "/hello.ts", 'console.log("hello");\n');
writeFileSync(directory + "/stdio.ts", 'process.stdout.write("hello\\n");\n');
for (const component of ["engine", "tui"]) {
  mkdirSync(directory + "/no-unroll/" + component, { recursive: true });
  cpSync(component + "/src", directory + "/no-unroll/" + component + "/src", { recursive: true });
}
const path = directory + "/no-unroll/tui/src/app.ts";
let app = readFileSync(path, "utf8");
for (const variable of ["row", "col"]) {
  const original = "for (let " + variable + " = 0; " + variable + " < 8; " + variable + "++)";
  if (app.split(original).length !== 2) throw new Error("Expected exactly one renderer loop: " + variable);
  app = app.replace(original, original.replace(variable + "++", variable + " += 1"));
}
writeFileSync(path, app);
console.log("Prepared minimal size probes and renderer diagnostic copy in " + directory);
