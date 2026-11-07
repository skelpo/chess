// Sound: effects and background music, with Web Audio. One fixed set, at
// fixed levels (there are no sound settings in this version).
//
// Files live in public/audio:
//   sfx/<name>[-n].(wav|mp3)   effects; several takes (move-1, move-2, ...) are
//                              picked at random, never the same twice in a row,
//                              with a little pitch drift on moves and clicks
//   menu.mp3                   title screen music
//   music.mp3                  in-game loop
//
// Browsers only allow sound after the player has clicked or pressed a key, so
// nothing plays before that (the native build sends one at launch: autoplay
// in bloom/config.ts).

export type Sfx = "move" | "capture" | "select" | "illegal" | "click" | "check" | "promote" | "start" | "win" | "lose" | "draw";
/** What the music is doing: title screen, playing, paused (quieter), game over (quieter still). */
export type MusicScene = "title" | "game" | "pause" | "over";

/** Every effect's files, relative to the audio folder. */
const SFX: Record<Sfx, readonly string[]> = {
  move: ["sfx/move-1.wav", "sfx/move-2.wav", "sfx/move-3.wav", "sfx/move-4.wav"],
  capture: ["sfx/capture-1.wav", "sfx/capture-2.wav", "sfx/capture-3.wav"],
  select: ["sfx/select.wav"],
  illegal: ["sfx/illegal.wav"],
  click: ["sfx/click.wav"],
  check: ["sfx/check.mp3"],
  promote: ["sfx/promote.mp3"],
  start: ["sfx/start.mp3"],
  win: ["sfx/win.mp3"],
  lose: ["sfx/lose.mp3"],
  draw: ["sfx/draw.mp3"],
};
const MUSIC: Record<MusicScene, string> = { title: "menu.mp3", game: "music.mp3", pause: "music.mp3", over: "music.mp3" };

const MUSIC_GAIN = 0.3;
const SFX_GAIN = 1;
const DUCK: Record<MusicScene, number> = { title: 1, game: 1, pause: 0.5, over: 0.3 };
/** Seconds the end of the track overlaps its start when it loops. */
const LOOP_FADE = 3;
/** Effects that get a random pitch drift. */
const DRIFT: ReadonlySet<Sfx> = new Set(["move", "capture", "select", "click"]);

interface Track { el: HTMLAudioElement; gain: GainNode }

export class Sound {
  private readonly base: string;
  private ctx: AudioContext | null = null;
  private sfxOut: GainNode | null = null;
  private duck: GainNode | null = null;
  private tracks: Track[] = [];
  /** Index into tracks of the one playing now. */
  private live = 0;
  private looping = false;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly lastTake = new Map<Sfx, string>();
  private scene: MusicScene = "title";

  constructor(base: string) {
    this.base = base.endsWith("/") ? base : base + "/";
    if (typeof AudioContext === "undefined" || typeof document === "undefined") return;
    const unlock = () => {
      removeEventListener("pointerdown", unlock, true);
      removeEventListener("keydown", unlock, true);
      this.unlock();
    };
    addEventListener("pointerdown", unlock, true);
    addEventListener("keydown", unlock, true);
    document.addEventListener("visibilitychange", () => this.visibility());
  }

  /** Play an effect (dropped until sound is unlocked). */
  play(name: Sfx, opts: { gain?: number } = {}): void {
    const ctx = this.ctx, out = this.sfxOut;
    if (ctx === null || out === null) return;
    const takes = SFX[name];
    // a random take, but not the same one twice in a row
    const last = this.lastTake.get(name);
    const pool = takes.length > 1 ? takes.filter((t) => t !== last) : takes;
    const file = pool[Math.floor(Math.random() * pool.length)];
    this.lastTake.set(name, file);
    void this.buffer(file).then((buffer) => {
      if (buffer === null) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (DRIFT.has(name)) src.playbackRate.value = 0.94 + Math.random() * 0.12;
      let node: AudioNode = src;
      if (opts.gain !== undefined && opts.gain !== 1) {
        const g = ctx.createGain();
        g.gain.value = opts.gain;
        src.connect(g);
        node = g;
      }
      node.connect(out);
      src.start();
    });
  }

  /** Switch the music for a screen: picks the track, ducks it under menus. */
  setScene(scene: MusicScene): void {
    this.scene = scene;
    this.applyScene();
  }

  // -------------------------------------------------------------- internals

  private unlock(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    void ctx.resume();
    this.sfxOut = ctx.createGain();
    this.sfxOut.gain.value = SFX_GAIN;
    this.sfxOut.connect(ctx.destination);
    const musicOut = ctx.createGain();
    musicOut.gain.value = MUSIC_GAIN;
    musicOut.connect(ctx.destination);
    this.duck = ctx.createGain();
    this.duck.gain.value = DUCK[this.scene];
    this.duck.connect(musicOut);
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.duck);
      el.addEventListener("timeupdate", () => this.checkLoop(i));
      el.addEventListener("ended", () => this.checkLoop(i, true));
      this.tracks.push({ el, gain });
    }
    // Safari lets an element play later only if it was started inside a gesture
    // (only pause it again if the music hasn't been given a track meanwhile)
    for (const t of this.tracks) {
      t.el.muted = true;
      void t.el.play().catch(() => {}).then(() => { t.el.muted = false; if (t.el.src === "") t.el.pause(); });
    }
    // decode the common effects now so the first move doesn't wait for them
    for (const name of ["move", "capture", "select", "click", "illegal", "check"] as Sfx[]) for (const f of SFX[name]) void this.buffer(f);
    this.applyScene();
  }

  private buffer(file: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(file);
    if (p === undefined) {
      const ctx = this.ctx;
      p = ctx === null ? Promise.resolve(null)
        : fetch(this.base + file).then((r) => r.arrayBuffer()).then((data) => ctx.decodeAudioData(data)).catch(() => null);
      this.buffers.set(file, p);
    }
    return p;
  }

  private applyScene(): void {
    const ctx = this.ctx, duck = this.duck;
    if (ctx === null || duck === null || this.tracks.length === 0) return;
    duck.gain.setTargetAtTime(DUCK[this.scene], ctx.currentTime, 0.4);
    const now = this.tracks[this.live];
    const url = new URL(this.base + MUSIC[this.scene], location.href).href;
    if (now.el.src === url && !now.el.paused) return;
    if (now.el.src === url) { void now.el.play().catch(() => {}); this.fade(now, 1, 0.8); return; }
    // a different track: crossfade from the one playing to the other element
    const next = this.tracks[1 - this.live];
    this.fade(now, 0, 1.5, true);
    next.el.src = url;
    next.el.currentTime = 0;
    void next.el.play().catch(() => {});
    this.fade(next, 1, 1.5);
    this.live = 1 - this.live;
  }

  /** Near the end of the live track, start it again on the other element and crossfade. */
  private checkLoop(i: number, ended = false): void {
    if (i !== this.live || this.looping || this.ctx === null) return;
    const now = this.tracks[i];
    const d = now.el.duration;
    if (!Number.isFinite(d) || (!ended && now.el.currentTime < d - LOOP_FADE)) return;
    const next = this.tracks[1 - i];
    this.looping = true;
    next.el.src = now.el.src;
    next.el.currentTime = 0;
    void next.el.play().catch(() => {});
    this.fade(now, 0, LOOP_FADE, true);
    this.fade(next, 1, Math.min(LOOP_FADE, 1.2));
    this.live = 1 - i;
    setTimeout(() => { this.looping = false; }, LOOP_FADE * 1000);
  }

  private fade(t: Track, to: number, seconds: number, pauseAfter = false): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const g = t.gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(to, ctx.currentTime + seconds);
    // once silent, stop the element (unless something faded it back up meanwhile)
    if (pauseAfter) setTimeout(() => { if (g.value < 0.01) t.el.pause(); }, seconds * 1000 + 50);
  }

  private visibility(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    if (document.hidden) {
      void ctx.suspend();
      for (const t of this.tracks) t.el.pause();
    } else {
      void ctx.resume();
      const now = this.tracks[this.live];
      if (now.el.src !== "") void now.el.play().catch(() => {});
    }
  }
}
