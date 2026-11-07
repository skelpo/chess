/**
 * The chess app's hooks into the running browser: the Apple TV remote (tv.ts)
 * and BLOOM_SCRIPT commands that drive the game through its test API
 * (globalThis.web3d):
 *   move <uci>, select <square>, new white|black, load <fen>, state,
 *   clicksq <square> (a click on a square through the app's own raycast)
 */
import { clickAt, configure } from "@bloomengine/web";
import { tv } from "./tv.ts";

type Api = Record<string, (...args: unknown[]) => unknown>;
const api = (): Api | undefined => (globalThis as Record<string, unknown>)["web3d"] as Api | undefined;

configure({
  tv,
  scriptCommands: {
    move: (arg) => console.log("move", arg, api()?.["move"]?.(arg)),
    select: (arg) => { api()?.["select"]?.(arg); },
    new: (arg) => { api()?.["newGame"]?.(arg === "black" ? "black" : "white"); },
    load: (arg) => { api()?.["newGame"]?.("white", arg); },
    state: () => console.log("state", JSON.stringify(api()?.["state"]?.())),
    clicksq: (arg) => {
      const p = api()?.["screenOf"]?.(arg) as [number, number] | undefined;
      if (p === undefined) return;
      const t0 = Date.now();
      clickAt(p[0], p[1]);
      console.log("click", arg, "at", p.map(Math.round).join(","), "handled in", Date.now() - t0, "ms");
    },
  },
});
