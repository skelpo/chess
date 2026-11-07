// Bakes the low-poly pieces (models/lod/*.glb, from `pieces.py --lod`) into
// tui/src/view3d/models.ts for the terminal 3D view. Run with node:
//   node models/embed-tui.ts
//
// The terminal renderer stays small and fast (also under Perry) by not
// parsing glTF at runtime. Per piece, one base64 blob, little-endian:
//   u16 vertexCount, u16 bodyTris, u16 feltTris, u16 clipCount, f32 posScale
//   i16 positions[v*3] (* posScale)      i8 normals[v*3] (/127)
//   u8 joint0[v], u8 joint1[v], u8 weight0[v] (weight1 = 255 - weight0)
//   u16 indices[(bodyTris + feltTris) * 3]   (body triangles first)
//   per clip: u16 frames, i16 skin[frames * 3 bones * 12] (/16384)
// A skin matrix is the 3x4 (column-major, no last row) mesh-space transform
// for one bone at one frame: bindMatrixInverse * boneWorld * boneInverse * bindMatrix.
// The rest pose is the identity for every bone.
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const g = globalThis as { navigator?: unknown };
if (g.navigator === undefined) g.navigator = { userAgent: "node" };

const root = new URL("..", import.meta.url).pathname;
const out = new URL("../../tui/src/view3d/models.ts", import.meta.url).pathname;
const TYPES = ["pawn", "knight", "bishop", "rook", "queen", "king"] as const;
const CLIPS = ["select", "hop", "captured", "celebrate"] as const;
const FPS = 30;

function load(type: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const buf = readFileSync(`${root}models/lod/${type}.glb`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, "", resolve as never, reject));
}

class Writer {
  private bytes: number[] = [];
  private view = new DataView(new ArrayBuffer(8));
  u8(v: number) { this.bytes.push(v & 255); }
  i8(v: number) { this.bytes.push((Math.max(-127, Math.min(127, Math.round(v))) + 256) & 255); }
  u16(v: number) { this.view.setUint16(0, v, true); this.bytes.push(this.view.getUint8(0), this.view.getUint8(1)); }
  i16(v: number) {
    const c = Math.max(-32767, Math.min(32767, Math.round(v)));
    this.view.setInt16(0, c, true); this.bytes.push(this.view.getUint8(0), this.view.getUint8(1));
  }
  f32(v: number) { this.view.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.bytes.push(this.view.getUint8(i)); }
  base64(): string { return Buffer.from(this.bytes).toString("base64"); }
}

const meta: Record<string, unknown> = {};
const blobs: Record<string, string> = {};
let total = 0;
for (const type of TYPES) {
  const gltf = await load(type);
  const meshes: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  const body = meshes.find((m) => (m.material as THREE.Material).name === "Body");
  const felt = meshes.find((m) => (m.material as THREE.Material).name === "Felt");
  if (!body || !felt) throw new Error(`${type}: expected Body and Felt primitives`);
  const bones = body.skeleton.bones;
  if (bones.map((b) => b.name).join() !== "root,body,head") throw new Error(`${type}: unexpected bones`);

  // merge both primitives into one vertex list
  const pos: number[] = [], nor: number[] = [], j0: number[] = [], j1: number[] = [], w0: number[] = [];
  const idx: number[][] = [];
  for (const mesh of [body, felt]) {
    const geo = mesh.geometry;
    const base = pos.length / 3;
    const P = geo.attributes.position, N = geo.attributes.normal, J = geo.attributes.skinIndex, W = geo.attributes.skinWeight;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      // keep the two strongest influences, renormalized
      const inf = [0, 1, 2, 3].map((k) => ({ j: J.getComponent(i, k), w: W.getComponent(i, k) })).sort((a, b) => b.w - a.w);
      const a = inf[0], b = inf[1];
      const sum = a.w + b.w;
      j0.push(a.j); j1.push(b.w > 0 ? b.j : a.j); w0.push(sum > 0 ? a.w / sum : 1);
    }
    const list: number[] = [];
    const I = geo.index!;
    for (let t = 0; t < I.count; t++) list.push(I.getX(t) + base);
    idx.push(list);
  }
  const vcount = pos.length / 3;
  const maxAbs = Math.max(...pos.map(Math.abs));
  const posScale = maxAbs / 32767;

  const w = new Writer();
  w.u16(vcount); w.u16(idx[0].length / 3); w.u16(idx[1].length / 3); w.u16(CLIPS.length); w.f32(posScale);
  for (const v of pos) w.i16(v / posScale);
  for (const v of nor) w.i8(v * 127);
  for (const v of j0) w.u8(v);
  for (const v of j1) w.u8(v);
  for (const v of w0) w.u8(v * 255);
  for (const list of idx) for (const v of list) w.u16(v);

  // sample every clip into per-frame skin matrices
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clipFrames: Record<string, number> = {};
  const m = new THREE.Matrix4();
  for (const name of CLIPS) {
    const clip = gltf.animations.find((c) => c.name === name);
    if (!clip) throw new Error(`${type}: no clip ${name}`);
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset().play();
    const frames = Math.round(clip.duration * FPS) + 1;
    clipFrames[name] = frames;
    w.u16(frames);
    for (let f = 0; f < frames; f++) {
      action.time = Math.min(clip.duration, f / FPS);
      mixer.update(0);
      gltf.scene.updateMatrixWorld(true);
      for (let b = 0; b < 3; b++) {
        m.copy(body.bindMatrixInverse).multiply(bones[b].matrixWorld).multiply(body.skeleton.boneInverses[b]).multiply(body.bindMatrix);
        const e = m.elements;
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) w.i16(e[k] * 16384);
      }
    }
  }
  let timing: Record<string, unknown> = {};
  gltf.scene.traverse((o) => { if (typeof o.userData.tuichess === "string") timing = JSON.parse(o.userData.tuichess); });
  meta[type] = { height: timing.height, baseRadius: timing.baseRadius };
  meta.hop = timing.hop; meta.captured = timing.captured; meta.celebrate = timing.celebrate;
  blobs[type] = w.base64();
  total += blobs[type].length;
  console.log(`${type.padEnd(7)} ${vcount} verts, ${(idx[0].length + idx[1].length) / 3} tris, ${(blobs[type].length / 1024).toFixed(0)} KiB base64, frames ${JSON.stringify(clipFrames)}`);
}

const source = `// Generated by web3d/models/embed-tui.ts from web3d/models/lod/*.glb — do not edit.
// Low-poly tuichess pieces for the terminal 3D view; format described in that script.
export const MODEL_FPS = ${FPS};
export const CLIP_NAMES = ${JSON.stringify(CLIPS)} as const;
export const MODEL_INFO = ${JSON.stringify(meta)} as const;
export const MODEL_DATA: Record<string, string> = {
${TYPES.map((t) => `  ${t}: "${blobs[t]}",`).join("\n")}
};
`;
writeFileSync(out, source);
console.log(`wrote ${out} (${(total / 1024).toFixed(0)} KiB of model data)`);
