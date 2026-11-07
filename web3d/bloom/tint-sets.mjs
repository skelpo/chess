// Themed piece sets color each material per side: the "tint" in a piece's tuichess extras
// (models/themes.py) maps material name -> color, and pieces.ts sets those colors on clones of the
// materials while the rest (eyes, gold...) keep theirs. Bloom draws a model from its file with
// one tint for the whole model, so this bakes each side's colors into its own copy of the file:
//
//   node web3d/bloom/tint-sets.mjs <models dir> <out dir>
//     public/models/<theme>/<piece>.glb -> <out>/<theme>/<piece>-white.glb, <piece>-black.glb
//
// renderer.ts draws those copies (untinted) for themed pieces.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [models, out] = process.argv.slice(2);
if (!models || !out) { console.error("usage: node tint-sets.mjs <models dir> <out dir>"); process.exit(1); }

/** sRGB hex -> linear [r, g, b] (three's Color.set does the same; glTF factors are linear). */
function linear(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
}

function readGlb(bytes) {
  const jsonLen = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLen).toString("utf8"));
  const rest = bytes.subarray(20 + jsonLen);   // the BIN chunk, header included
  return { json, rest };
}

function writeGlb(json, rest) {
  let text = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (text.length % 4)) % 4;
  text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);          // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);         // "JSON"
  return Buffer.concat([header, text, rest]);
}

let count = 0;
for (const theme of readdirSync(models)) {
  const dir = join(models, theme);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".glb") || file === "props.glb") continue;
    const bytes = readFileSync(join(dir, file));
    const { json, rest } = readGlb(bytes);
    let tint = null;
    for (const node of json.nodes ?? []) {
      const raw = node.extras?.tuichess;
      if (typeof raw === "string") tint = JSON.parse(raw).tint ?? null;
    }
    if (tint === null) continue;
    mkdirSync(join(out, theme), { recursive: true });
    for (const side of ["white", "black"]) {
      const colors = tint[side] ?? {};
      const copy = structuredClone(json);
      for (const m of copy.materials ?? []) {
        const hex = colors[m.name];
        if (hex === undefined) continue;
        const pbr = (m.pbrMetallicRoughness ??= {});
        const alpha = pbr.baseColorFactor?.[3] ?? 1;
        pbr.baseColorFactor = [...linear(hex), alpha];
      }
      writeFileSync(join(out, theme, file.replace(/\.glb$/, `-${side}.glb`)), writeGlb(copy, rest));
      count++;
    }
  }
}
console.log(`tint-sets: ${count} files in ${out}`);
