// Bundles the web version into web3d/dist (run with bun):
//   bun build.ts            -> dist/ (static files, deploy anywhere)
//   bun build.ts --serve    -> build, then serve dist/ on http://localhost:8173
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts"), join(root, "src/engine.worker.ts")],
  outdir: out,
  naming: "[name].js",
  target: "browser",
  format: "esm",
  minify: !process.argv.includes("--dev"),
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync(join(root, "index.html"), join(out, "index.html"));
cpSync(join(root, "public"), out, { recursive: true });
for (const o of result.outputs) console.log(`${o.path.replace(root + "/", "")}  ${(o.size / 1024).toFixed(0)} KiB`);

if (process.argv.includes("--serve")) {
  const port = Number(process.env.PORT ?? 8173);
  Bun.serve({
    port,
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(out, decodeURIComponent(path)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  console.log(`serving http://localhost:${port}/`);
}
