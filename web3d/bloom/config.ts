/**
 * Settings for the chess app on Bloom, set before @bloomengine/web installs
 * the browser (this module imports nothing that starts it).
 */
import { existsSync } from "node:fs";
import { configure } from "@bloomengine/web/config";
import { configureThree } from "@bloomengine/three/config";
import type { Object3D, Mesh, MeshStandardMaterial } from "three";

const home = process.env["TUICHESS_HOME"];
configure({
  app: "tuichess",
  // a native app starts its music with the app, not with the first tap
  autoplay: true,
  title: "tuichess",
  width: 1280,
  height: 800,
  root: new URL("../", import.meta.url).pathname,   // web3d/
  bundle: "web3d",                                    // assets/web3d/ in an app bundle (stage-assets.sh)
  served: "public/",                                  // Vite serves public/ as the site's root
  canvas: "#view",
  storageName: "web3d-storage.json",
  storageFile: home !== undefined && home !== "" ? home + "/web3d-storage.json" : "",
});

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
  // three.js parses the low-poly copy (web3d/models/lod) for skeletons, clips and picking
  parseFile(path: string): string {
    const lod = path.replace(/\/public\/models\/([^/]+)$/, "/models/lod/$1");
    return existsSync(lod) ? lod : path;
  },
  modelFile(_root: Object3D, path: string): string {
    // BLOOM_LOD=1: draw the low-poly models on the GPU too
    if (process.env["BLOOM_LOD"] === "1") return path.replace(/\/public\/models\/([^/]+)$/, "/models/lod/$1");
    return path;
  },
  modelTint(root: Object3D) {
    const m = body(root);
    if (m === null) return null;
    const a = Math.round((m.transparent ? m.opacity : 1) * 255);
    // Bloom multiplies the albedo by the tint in linear light: three's (linear) color, not sRGB
    return { r: Math.round(m.color.r * 255), g: Math.round(m.color.g * 255), b: Math.round(m.color.b * 255), a };
  },
});
