// Validates the generated GLBs (Khronos glTF-Validator) and checks the
// conventions the web version and Bloom rely on.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore no types
import validator from "gltf-validator";

const dir = new URL("../public/models/", import.meta.url).pathname;
let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".glb")).sort()) {
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const report = await validator.validateBytes(bytes);
  const { numErrors, numWarnings } = report.issues;
  // parse JSON chunk
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const jsonLen = dv.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const prim = gltf.meshes[0].primitives[0];
  const attrs = Object.keys(prim.attributes).sort().join(",");
  const clips = gltf.animations.map((a: any) => a.name).join(",");
  const joints = gltf.skins[0].joints.map((j: number) => gltf.nodes[j].name).join(",");
  const extras = gltf.nodes.find((n: any) => n.extras?.tuichess)?.extras.tuichess;
  const mats = gltf.materials.map((m: any) => m.name).join(",");
  const problems: string[] = [];
  if (numErrors) problems.push(`${numErrors} validator errors`);
  for (const need of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"])
    if (prim.attributes[need] === undefined) problems.push(`missing ${need}`);
  // Bloom addresses clips by index, so the order is part of the contract.
  const order = ["idle", "select", "hop", "captured", "celebrate"];
  if (gltf.animations.map((a: any) => a.name).join() !== order.join()) problems.push(`clip order must be ${order}`);
  if (prim.targets) problems.push("has morph targets");
  if (!extras) problems.push("missing tuichess extras");
  const bin = bytes.subarray(20 + jsonLen + 8);
  const floats = (index: number): Float32Array => {
    const acc = gltf.accessors[index];
    const view = gltf.bufferViews[acc.bufferView];
    const n = acc.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type];
    return new Float32Array(bin.slice(view.byteOffset + (acc.byteOffset ?? 0)).buffer, 0, n);
  };
  const uv = floats(prim.attributes.TEXCOORD_0);
  if (uv.some((v) => v < -1e-4 || v > 1 + 1e-4)) problems.push("UVs outside 0..1");
  const w = floats(prim.attributes.WEIGHTS_0);
  for (let i = 0; i < w.length; i += 4) {
    const sum = w[i] + w[i + 1] + w[i + 2] + w[i + 3];
    if (Math.abs(sum - 1) > 1e-3) { problems.push(`weights sum ${sum} at vertex ${i / 4}`); break; }
  }
  const pos = gltf.accessors[prim.attributes.POSITION];
  console.log(`${file.padEnd(11)} ${problems.length ? "FAIL" : "ok  "} errors=${numErrors} warnings=${numWarnings} ` +
    `y=${pos.min[1].toFixed(3)}..${pos.max[1].toFixed(3)} joints=${joints} mats=${mats}\n            attrs=${attrs}\n            clips=${clips}` +
    (problems.length ? `\n            ${problems.join("; ")}` : ""));
  // severity 0 = error, 1 = warning; infos/hints (e.g. unused tangents until a normal map exists) are expected
  for (const m of report.issues.messages.filter((m: any) => m.severity <= 1)) console.log(`            ${m.code}: ${m.message}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
