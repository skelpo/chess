/**
 * Settings for the chess app on Bloom, set before @bloomengine/web installs
 * the browser (this module imports nothing that starts it).
 */
import { existsSync } from "node:fs";
import { configure } from "@bloomengine/web/config";
import { configureThree } from "@bloomengine/three/config";
import type { Object3D, Mesh, MeshStandardMaterial } from "three";
import { tintedPath } from "./tinted.ts";

const home = process.env["TUICHESS_HOME"];
configure({
  app: "tuichess",
  title: "tuichess 3D — Bloom",
  width: 1280,
  height: 800,
  root: new URL("../", import.meta.url).pathname,   // web3d/
  bundle: "web3d",                                    // assets/web3d/ in an app bundle (stage-assets.sh)
  served: "public/",                                  // Vite serves public/ as the site's root
  canvas: "#view",
  storageName: "web3d-storage.json",
  storageFile: home !== undefined && home !== "" ? home + "/web3d-storage.json" : "",
});

/** Pieces drawn from a copy with their side's colors baked in: those Bloom draws untinted. */
const baked = new WeakSet<Object3D>();

/** The piece's Body material: its color tints the model, its opacity fades it. */
function body(root: Object3D): MeshStandardMaterial | null {
  let found: MeshStandardMaterial | null = null;
  root.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (found === null && m !== undefined && !Array.isArray(m) && m.name === "Body") found = m;
  });
  return found;
}

configureThree({
  // three.js parses the low-poly copy (web3d/models/lod) for skeletons, clips and picking; a
  // themed piece whose original the bundle leaves out is read from its white copy
  parseFile(path: string): string {
    const lod = path.replace(/\/public\/models\/([^/]+)$/, "/models/lod/$1");
    if (existsSync(lod)) return lod;
    if (existsSync(path)) return path;
    return tintedPath(path, "white") ?? path;
  },
  modelFile(root: Object3D, path: string): string {
    // BLOOM_LOD=1: draw the low-poly models on the GPU too
    if (process.env["BLOOM_LOD"] === "1") path = path.replace(/\/public\/models\/([^/]+)$/, "/models/lod/$1");
    let side = "";
    root.traverse((o) => { const a = o.userData.actor as { color?: string } | undefined; if (a?.color !== undefined) side = a.color; });
    const copy = side === "" ? null : tintedPath(path, side);
    if (copy === null) return path;
    baked.add(root);
    return copy;
  },
  modelTint(root: Object3D) {
    const m = body(root);
    if (m === null) return null;
    const a = Math.round((m.transparent ? m.opacity : 1) * 255);
    // Bloom multiplies the albedo by the tint in linear light: three's (linear) color, not sRGB
    if (baked.has(root)) return { r: 255, g: 255, b: 255, a };
    return { r: Math.round(m.color.r * 255), g: Math.round(m.color.g * 255), b: Math.round(m.color.b * 255), a };
  },
});
