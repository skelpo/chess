// Loads the generated piece GLBs and wraps each board piece in an Actor that
// owns its skinned clone, animation mixer and clip playback. The GLBs follow
// the conventions in models/pieces.py (1 unit = 1 square, origin at the base,
// front = +Z, clips idle/select/hop/captured/celebrate, timing in extras).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { Color, PieceType } from "@plain-chess/engine";

export const PIECE_TYPES: readonly PieceType[] = ["pawn", "knight", "bishop", "rook", "queen", "king"];

export interface PieceTiming {
  height: number;
  hop: { duration: number; takeoff: number; land: number };
  captured: { duration: number; fall: number };
  celebrate: { duration: number };
}

interface PieceAsset {
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  timing: PieceTiming;
}

const assets = new Map<PieceType, PieceAsset>();

export async function loadPieces(baseUrl: string): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(PIECE_TYPES.map(async (type) => {
    const gltf = await loader.loadAsync(`${baseUrl}${type}.glb`);
    let timing: PieceTiming | null = null;
    gltf.scene.traverse((o) => {
      const raw = o.userData.tuichess;
      if (typeof raw === "string") timing = JSON.parse(raw) as PieceTiming;
    });
    if (!timing) throw new Error(`${type}.glb has no tuichess extras`);
    assets.set(type, {
      scene: gltf.scene,
      clips: new Map(gltf.animations.map((c) => [c.name, c])),
      timing,
    });
  }));
}

export interface SideStyle { color: THREE.ColorRepresentation; roughness: number; }
export const SIDE_STYLE: Record<Color, SideStyle> = {
  white: { color: 0xeee3cc, roughness: 0.32 },
  black: { color: 0x2a221d, roughness: 0.28 },
};

const easeInOut = (k: number) => k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;

/** One-shot callback tween advanced by the render loop. */
export class Tweens {
  private list: { t: number; d: number; step: (k: number) => void; done: () => void }[] = [];
  run(duration: number, step: (k: number) => void): Promise<void> {
    return new Promise((resolve) => {
      if (duration <= 0) { step(1); resolve(); return; }
      this.list.push({ t: 0, d: duration, step, done: resolve });
    });
  }
  wait(seconds: number): Promise<void> { return this.run(seconds, () => {}); }
  update(dt: number): void {
    const active = this.list;
    this.list = [];
    for (const tw of active) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.d);
      tw.step(k);
      if (k < 1) this.list.push(tw); else tw.done();
    }
  }
}

/** Every actor that exists, on or off the board; the render loop ticks all of them. */
export const liveActors = new Set<Actor>();

export class Actor {
  /** Positioned on the board square; rotated to face the opponent. */
  readonly group = new THREE.Group();
  /** Child of group: carries travel tilt and lifting so group stays on the square. */
  readonly pivot = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  readonly timing: PieceTiming;
  readonly materials: THREE.MeshStandardMaterial[] = [];
  private actions = new Map<string, THREE.AnimationAction>();
  private oneShot: THREE.AnimationAction | null = null;
  private base: THREE.AnimationAction;
  private lift = 0;

  readonly type: PieceType;
  readonly color: Color;
  private tweens: Tweens;

  constructor(type: PieceType, color: Color, tweens: Tweens) {
    this.type = type;
    this.color = color;
    this.tweens = tweens;
    const asset = assets.get(type);
    if (!asset) throw new Error(`piece ${type} not loaded`);
    this.timing = asset.timing;
    const model = cloneSkinned(asset.scene);
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // skinned bounds move with the animation
      mesh.userData.actor = this;
      const swap = (m: THREE.Material) => {
        const src = m as THREE.MeshStandardMaterial;
        const mat = src.clone();
        if (src.name === "Body") {
          const style = SIDE_STYLE[color];
          mat.color.set(style.color);
          mat.roughness = style.roughness;
          mat.envMapIntensity = 0.9;
        }
        this.materials.push(mat);
        return mat;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    this.pivot.add(model);
    this.group.add(this.pivot);
    // glTF front is +Z; white faces black (toward -Z), black faces white.
    // Knights turn sideways so both players see their profile.
    this.group.rotation.y = type === "knight"
      ? (color === "white" ? -Math.PI / 2 : Math.PI / 2)
      : (color === "white" ? Math.PI : 0);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of asset.clips) this.actions.set(name, this.mixer.clipAction(clip));
    const idle = this.action("idle");
    idle.time = Math.random() * clip(idle).duration;
    idle.timeScale = 0.85 + Math.random() * 0.3;
    idle.play();
    this.base = idle;
    liveActors.add(this);
  }

  private action(name: string): THREE.AnimationAction {
    const a = this.actions.get(name);
    if (!a) throw new Error(`clip ${name} missing on ${this.type}`);
    return a;
  }

  /**
   * Play a clip once; resolves when it ends. Three.js averages actions by
   * weight, so the looping base clip (idle/select) fades out while a one-shot
   * plays and fades back in afterwards — otherwise every move plays at half strength.
   */
  play(name: "hop" | "captured" | "celebrate", opts: { timeScale?: number; hold?: boolean } = {}): Promise<void> {
    const a = this.action(name);
    if (this.oneShot && this.oneShot !== a) this.oneShot.fadeOut(0.08);
    this.base.fadeOut(0.08);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = opts.timeScale ?? 1;
    a.fadeIn(0.08).play();
    this.oneShot = a;
    const seconds = clip(a).duration / a.timeScale;
    return this.tweens.wait(seconds).then(() => {
      if (opts.hold || this.oneShot !== a) return;
      a.fadeOut(0.2);
      this.oneShot = null;
      this.fadeInBase(0.2);
    });
  }

  private fadeInBase(seconds: number): void {
    const b = this.base;
    b.enabled = true;
    b.setLoop(THREE.LoopRepeat, Infinity);
    b.fadeIn(seconds).play();
  }

  /** Switch the looping base clip; only audible when no one-shot is playing. */
  private setBase(name: "idle" | "select", seconds: number): void {
    const next = this.action(name);
    if (next === this.base) return;
    this.base.fadeOut(seconds);
    this.base = next;
    if (name === "select") next.reset();
    if (!this.oneShot) this.fadeInBase(seconds);
  }

  setSelected(on: boolean): void {
    this.setBase(on ? "select" : "idle", 0.15);
    const from = this.lift, to = on ? 0.14 : 0;
    void this.tweens.run(0.22, (k) => {
      this.lift = from + (to - from) * easeInOut(k);
      this.pivot.position.y = this.lift;
    });
  }

  /**
   * Hop from the current position to `to`. The clip squashes and stretches;
   * this moves the piece along an arc between the clip's takeoff and landing
   * times and tilts it toward the direction of travel.
   */
  async hopTo(to: THREE.Vector3, opts: { onLand?: () => void; high?: boolean } = {}): Promise<void> {
    const from = this.group.position.clone();
    const dist = from.distanceTo(to);
    const { duration, takeoff, land } = this.timing.hop;
    const air = land - takeoff;
    const wantAir = 0.3 + 0.07 * dist;                       // longer jumps hang longer
    const timeScale = Math.min(1.6, Math.max(0.55, air / wantAir));
    const height = (opts.high ? 0.75 : 0.3) + 0.09 * dist;
    const dir = to.clone().sub(from).setY(0);
    const axis = dir.lengthSq() > 0 ? new THREE.Vector3(dir.z, 0, -dir.x).normalize() : new THREE.Vector3(1, 0, 0);
    const startLift = this.lift;
    this.setSelectedSilently();
    const t0 = takeoff / timeScale, t1 = land / timeScale, total = duration / timeScale;
    const done = this.play("hop", { timeScale });
    let landed = false;
    await this.tweens.run(total, (k) => {
      const t = k * total;
      const a = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      const e = easeInOut(a);
      this.group.position.lerpVectors(from, to, e);
      const arc = 4 * a * (1 - a) * height;
      this.pivot.position.y = arc + startLift * (1 - Math.min(1, t / t0));
      // tilt into the travel direction, back upright on landing (world axis -> local)
      const tilt = Math.sin(Math.PI * a) * 0.16;
      const local = axis.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.group.rotation.y);
      this.pivot.quaternion.setFromAxisAngle(local, tilt);
      if (!landed && a >= 1) { landed = true; opts.onLand?.(); }
    });
    this.lift = 0;
    this.pivot.position.y = 0;
    this.pivot.quaternion.identity();
    await done;
  }

  private setSelectedSilently(): void {
    if (this.base !== this.action("idle")) {
      this.base.fadeOut(0.08);
      this.base = this.action("idle");
    }
  }

  fade(to: number, seconds: number): Promise<void> {
    const from = this.materials[0]?.opacity ?? 1;
    for (const m of this.materials) { m.transparent = true; m.depthWrite = to > 0.99; }
    return this.tweens.run(seconds, (k) => {
      for (const m of this.materials) m.opacity = from + (to - from) * k;
      if (k >= 1 && to > 0.99) for (const m of this.materials) { m.transparent = false; m.depthWrite = true; }
    });
  }

  pop(seconds = 0.35): Promise<void> {
    this.pivot.scale.setScalar(0.001);
    return this.tweens.run(seconds, (k) => {
      const s = 1 + Math.sin(k * Math.PI) * 0.18 * (1 - k);
      this.pivot.scale.setScalar(Math.max(0.001, easeInOut(k) * s));
    });
  }

  dispose(): void {
    liveActors.delete(this);
    this.mixer.stopAllAction();
    this.group.removeFromParent();
    for (const m of this.materials) m.dispose();
  }
}

const clip = (a: THREE.AnimationAction) => a.getClip();
