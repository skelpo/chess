/**
 * The web3d app, natively on Bloom. Nothing in ../src changes: this entry
 * sets the app's settings, installs a browser over Bloom (@bloomengine/web),
 * draws index.html over the 3D view from its own CSS, then loads the app's own
 * worker and main modules. `three` is the real three.js with a Bloom renderer
 * (@bloomengine/three, mapped at compile time by bloom-three).
 */
import "./config.ts";
import "@bloomengine/web";
import "./hooks.ts";
import "./overlay.ts";
import "../src/engine.worker.ts";
import "../src/main.ts";
