/**
 * Themed pieces with each side's material colors baked in (tint-sets.mjs), because Bloom tints a
 * model as a whole: assets/web3d/tinted/ next to the binary or in the app bundle (stage-assets.sh,
 * which leaves out the originals these replace).
 */
import { existsSync } from "node:fs";
import { webRoot } from "@bloomengine/web/config";

/** The side's baked copy of a themed piece (".../public/models/<theme>/<piece>.glb"), if there is one. */
export function tintedPath(url: string, side: string): string | null {
  const m = /\/public\/models\/([^/]+)\/([^/]+)\.glb$/.exec(url);
  if (m === null || m[2] === "props") return null;
  const path = `${webRoot()}tinted/${m[1]}/${m[2]}-${side}.glb`;
  return existsSync(path) ? path : null;
}
