// tuichess 3D: a Three.js board for the tuichess engine. Rules come from
// @plain-chess/engine; the engine searches in a worker; pieces are the
// generated GLBs animated by their own clips (see models/pieces.py).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Chess, START_FEN, type Color, type Level, type Move, type PieceType, type Promotion } from "@plain-chess/engine";
import { Actor, Tweens, liveActors, loadPieces } from "./pieces.ts";
import { Menu, levelLabel } from "./menu.ts";
import { Sound } from "./audio.ts";
import { SPEED_SCALE, loadGame, loadSettings, saveGame, type SavedGame } from "./settings.ts";

const FILES = "abcdefgh";
const LIGHT_SQ = "#c9a878", DARK_SQ = "#8a6a43", FRAME = "#241b15", LABEL = "#b6a283";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const statusEl = $("status");
const hudEl = $("hud");
const settings = loadSettings();
const sound = new Sound(new URL("./audio/", location.href).href);

// ---------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1012);
scene.fog = new THREE.Fog(0x0f1012, 18, 34);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 6;
controls.maxDistance = 24;
controls.maxPolarAngle = 1.3;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x1a1410, 0.45));
const key = new THREE.DirectionalLight(0xfff1dc, 1.9);
key.position.set(4.5, 10, 5.5);
key.castShadow = settings.shadows;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -7.5;
key.shadow.camera.right = key.shadow.camera.top = 7.5;
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fb8ff, 0.6);
rim.position.set(-6, 5, -7);
scene.add(rim);

// table + board
const table = new THREE.Mesh(new THREE.CircleGeometry(30, 64),
  new THREE.MeshStandardMaterial({ color: 0x0c0b0a, roughness: 0.95 }));
table.rotation.x = -Math.PI / 2;
table.position.y = -0.26;
table.receiveShadow = true;
scene.add(table);

function boardTexture(): THREE.CanvasTexture {
  const sq = 128, border = 64, size = sq * 8 + border * 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = FRAME;
  g.fillRect(0, 0, size, size);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    g.fillStyle = (f + r) % 2 === 1 ? LIGHT_SQ : DARK_SQ;
    g.fillRect(border + f * sq, border + (7 - r) * sq, sq, sq);
  }
  // subtle grain
  g.globalAlpha = 0.05;
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = Math.random() < 0.5 ? "#000" : "#fff";
    g.fillRect(border + Math.random() * sq * 8, border + Math.random() * sq * 8, 40 + Math.random() * 120, 1);
  }
  g.globalAlpha = 1;
  g.fillStyle = LABEL;
  g.font = "600 30px ui-monospace, Menlo, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  // White reads the near/left labels, black the far/right ones (drawn upside down).
  const label = (text: string, x: number, y: number, flip: boolean) => {
    g.save();
    g.translate(x, y);
    if (flip) g.rotate(Math.PI);
    g.fillText(text, 0, 0);
    g.restore();
  };
  for (let i = 0; i < 8; i++) {
    const x = border + i * sq + sq / 2, y = border + (7 - i) * sq + sq / 2;
    label(FILES[i], x, size - border / 2, false);
    label(FILES[i], x, border / 2, true);
    label(String(i + 1), border / 2, y, false);
    label(String(i + 1), size - border / 2, y, true);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const boardBase = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.24, 9.0),
  new THREE.MeshStandardMaterial({ color: FRAME, roughness: 0.6 }));
boardBase.position.y = -0.121;
boardBase.receiveShadow = true;
boardBase.castShadow = true;
scene.add(boardBase);
const boardTop = new THREE.Mesh(new THREE.PlaneGeometry(9, 9),
  new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.42, metalness: 0 }));
boardTop.rotation.x = -Math.PI / 2;
boardTop.receiveShadow = true;
scene.add(boardTop);

// ---------------------------------------------------------------- helpers

const squarePos = (sq: string) => new THREE.Vector3(FILES.indexOf(sq[0]) - 3.5, 0, 3.5 - (Number(sq[1]) - 1));
function squareAt(p: THREE.Vector3): string | null {
  const f = Math.floor(p.x + 4), r = Math.floor(4 - p.z);
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null;
}

function marker(color: number, opacity: number, geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}
const squareGeo = new THREE.PlaneGeometry(1, 1);
const dotGeo = new THREE.CircleGeometry(0.15, 32);
const ringGeo = new THREE.RingGeometry(0.38, 0.47, 48);
const glowGeo = new THREE.CircleGeometry(0.48, 48);

const lastMoveMarks = [marker(0xf2d36b, 0.28, squareGeo), marker(0xf2d36b, 0.28, squareGeo)];
const selectMark = marker(0x6fbf73, 0.4, squareGeo);
const checkMark = marker(0xe0473b, 0.55, glowGeo);
for (const m of [...lastMoveMarks, selectMark, checkMark]) { m.visible = false; scene.add(m); }
const targetMarks: THREE.Mesh[] = [];

function place(m: THREE.Object3D, sq: string, y = 0.004) { m.position.copy(squarePos(sq)).setY(y); m.visible = true; }

// ---------------------------------------------------------------- game state

const tweens = new Tweens();
const chess = new Chess();
let moves: string[] = [];
let human: Color = "white";
let level: Level = settings.level;
/** "title": the board turns slowly behind the main menu; "game": you are playing. */
let mode: "title" | "game" = "title";
let busy = false;
let selected: string | null = null;
let gameOver = false;
const actors = new Map<string, Actor>();
const tray: Actor[] = [];

function spawn(type: PieceType, color: Color, sq: string): Actor {
  const a = new Actor(type, color, tweens);
  a.group.position.copy(squarePos(sq));
  scene.add(a.group);
  actors.set(sq, a);
  return a;
}

function trayPosition(color: Color, index: number): THREE.Vector3 {
  // Pieces a side has lost line up beside the board on that side's right.
  const side = color === "white" ? 1 : -1;
  const col = Math.floor(index / 8), row = index % 8;
  return new THREE.Vector3(side * (5.0 + col * 0.55), -0.26, side * (3.5 - row));
}

function addToTray(type: PieceType, color: Color, animate: boolean): void {
  const index = tray.filter((a) => a.color === color).length;
  const a = new Actor(type, color, tweens);
  a.group.position.copy(trayPosition(color, index));
  a.group.scale.setScalar(0.72);
  scene.add(a.group);
  tray.push(a);
  if (animate) void a.pop(0.4);
}

function rebuild(animate: boolean): void {
  for (const a of actors.values()) a.dispose();
  for (const a of tray) a.dispose();
  actors.clear();
  tray.length = 0;
  let i = 0;
  const present: Record<string, number> = {};
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = FILES[f] + (r + 1);
    const p = chess.pieceAt(sq);
    if (!p) continue;
    present[p.color + p.type] = (present[p.color + p.type] ?? 0) + 1;
    const a = spawn(p.type, p.color, sq);
    if (animate) {
      a.pivot.scale.setScalar(0.001);
      const delay = (i++) * 0.018;
      void tweens.wait(delay).then(() => a.pop(0.35));
    }
  }
  const full: Record<PieceType, number> = { pawn: 8, knight: 2, bishop: 2, rook: 2, queen: 1, king: 1 };
  for (const color of ["white", "black"] as Color[]) {
    for (const type of ["queen", "rook", "bishop", "knight", "pawn"] as PieceType[]) {
      const lost = full[type] - (present[color + type] ?? 0);
      for (let k = 0; k < lost; k++) addToTray(type, color, false);
    }
  }
  refreshMarks();
}

function refreshMarks(): void {
  const last = chess.history().at(-1);
  if (last && settings.lastMove) { place(lastMoveMarks[0], last.slice(0, 2), 0.003); place(lastMoveMarks[1], last.slice(2, 4), 0.003); }
  else for (const m of lastMoveMarks) m.visible = false;
  checkMark.visible = false;
  if (chess.inCheck()) {
    for (const [sq, a] of actors) if (a.type === "king" && a.color === chess.turn()) place(checkMark, sq, 0.005);
  }
}

function setStatus(text: string) { statusEl.textContent = text; }
function turnText(): string {
  const st = chess.status();
  if (st.state === "checkmate") return `Checkmate. ${st.winner === human ? "You win!" : "The engine wins."}`;
  if (st.state === "draw") return `Draw (${st.drawReason?.replace(/-/g, " ")}).`;
  const who = st.turn === human ? "Your move" : "Engine is thinking…";
  return st.check ? `${who} (check)` : who;
}

// ---------------------------------------------------------------- selection

function clearSelection(): void {
  if (selected) actors.get(selected)?.setSelected(false);
  selected = null;
  selectMark.visible = false;
  for (const m of targetMarks) scene.remove(m);
  targetMarks.length = 0;
}

function select(sq: string): void {
  clearSelection();
  selected = sq;
  actors.get(sq)?.setSelected(true);
  place(selectMark, sq, 0.004);
  if (!settings.hints) return;
  for (const mv of chess.legalMoves()) {
    if (mv.from !== sq || (mv.promotion && mv.promotion !== "q")) continue;
    const m = mv.capture ? marker(0x6fbf73, 0.75, ringGeo) : marker(0x101010, 0.38, dotGeo);
    place(m, mv.to, 0.006);
    scene.add(m);
    targetMarks.push(m);
  }
}

function onSquare(sq: string): void {
  if (mode !== "game" || menu.isOpen() || busy || gameOver || chess.turn() !== human) return;
  const piece = chess.pieceAt(sq);
  if (selected) {
    const options = chess.legalMoves().filter((m) => m.from === selected && m.to === sq);
    if (options.length) {
      if (options.length > 1) void choosePromotion().then((p) => humanMove(options.find((m) => m.promotion === p)!));
      else void humanMove(options[0]);
      return;
    }
    if (sq === selected) { clearSelection(); return; }
  }
  if (piece && piece.color === human) { select(sq); sound.play("select"); return; }
  if (selected) sound.play("illegal");
  clearSelection();
}

function choosePromotion(): Promise<Promotion> {
  const box = $("promo");
  box.hidden = false;
  return new Promise((resolve) => {
    box.onclick = (e) => {
      const p = (e.target as HTMLElement).closest("button")?.dataset.p as Promotion | undefined;
      if (!p) return;
      box.hidden = true;
      resolve(p);
    };
  });
}

// pointer picking: pieces first (skinned raycast), then the board plane
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) { downAt = null; return; }
  downAt = null;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const pieceObjects = [...actors.values()].map((a) => a.group);
  const hit = raycaster.intersectObjects(pieceObjects, true).find((h) => h.object.userData.actor);
  if (hit) {
    const actor = hit.object.userData.actor as Actor;
    for (const [sq, a] of actors) if (a === actor) { onSquare(sq); return; }
  }
  const board = raycaster.intersectObject(boardTop)[0];
  const sq = board && squareAt(board.point);
  if (sq) onSquare(sq);
});

// ---------------------------------------------------------------- moves

const ease = (k: number) => k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;

async function knockOut(victim: Actor, delay: number): Promise<void> {
  await tweens.wait(delay);
  const fall = victim.play("captured", { hold: true });
  const back = new THREE.Vector3(0, 0, victim.color === "white" ? 0.62 : -0.62);
  const from = victim.group.position.clone();
  await tweens.run(0.75, (k) => victim.group.position.copy(from).addScaledVector(back, ease(k)));
  await fall;
  await victim.fade(0, 0.35);
  victim.dispose();
  addToTray(victim.type, victim.color, true);
}

async function animateMove(mv: Move): Promise<void> {
  const actor = actors.get(mv.from);
  if (!actor) return;
  const capSq = mv.enPassant ? mv.to[0] + mv.from[1] : mv.to;
  const victim = mv.capture ? actors.get(capSq) : undefined;
  actors.delete(mv.from);
  if (victim) actors.delete(capSq);
  actors.set(mv.to, actor);
  const jobs: Promise<void>[] = [];
  if (victim) jobs.push(knockOut(victim, 0.1));
  jobs.push(actor.hopTo(squarePos(mv.to), { high: actor.type === "knight" }).then(() => sound.play(victim ? "capture" : "move")));
  if (mv.castle) {
    const rank = mv.from[1];
    const [rf, rt] = mv.to[0] === "g" ? ["h" + rank, "f" + rank] : ["a" + rank, "d" + rank];
    const rook = actors.get(rf);
    if (rook) {
      actors.delete(rf);
      actors.set(rt, rook);
      jobs.push(tweens.wait(0.18).then(() => rook.hopTo(squarePos(rt))).then(() => sound.play("move", { gain: 0.8 })));
    }
  }
  await Promise.all(jobs);
  if (mv.promotion) {
    const type = ({ q: "queen", r: "rook", b: "bishop", n: "knight" } as const)[mv.promotion];
    await actor.fade(0, 0.2);
    actor.dispose();
    const promoted = spawn(type, actor.color, mv.to);
    sound.play("promote");
    await promoted.pop(0.4);
    void promoted.play("celebrate");
  }
}

async function commit(mv: Move): Promise<void> {
  chess.play(mv.uci);
  moves.push(mv.uci);
  persist();
  await animateMove(mv);
  refreshMarks();
  if (chess.inCheck() && chess.status().state === "playing") sound.play("check");
  await afterMove();
}

async function afterMove(): Promise<void> {
  const st = chess.status();
  setStatus(turnText());
  if (st.state !== "playing") { await finale(); return; }
  if (chess.turn() !== human) await engineMove();
}

async function humanMove(mv: Move): Promise<void> {
  busy = true;
  clearSelection();
  try { await commit(mv); } finally { busy = false; setStatus(turnText()); }
}

// engine worker
const worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
let requestId = 0;
function think(): Promise<{ uci: string | null; claimDraw: boolean }> {
  const id = ++requestId;
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      resolve(e.data);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, fen: startFen, moves, level });
  });
}

async function engineMove(): Promise<void> {
  busy = true;
  setStatus(turnText());
  const started = performance.now();
  const gen = generation;
  const reply = await think();
  if (gen !== generation) return;                   // new game / undo meanwhile
  const minThink = 450 - (performance.now() - started);
  if (minThink > 0) await tweens.wait(minThink / 1000);
  if (gen !== generation) return;
  if (reply.claimDraw && chess.claimDraw(reply.uci ?? "")) {
    busy = false;
    setStatus("The engine claims a draw.");
    sound.play("draw");
    endGame("Draw", "The engine claims a draw.", 0.6);
    return;
  }
  const mv = chess.legalMoves().find((m) => m.uci === reply.uci);
  if (!mv) { busy = false; setStatus("Engine found no move."); return; }
  setStatus(`Engine plays ${mv.uci}`);
  await commit(mv);
  busy = false;
  setStatus(turnText());
}

async function finale(): Promise<void> {
  const st = chess.status();
  const count = Math.ceil(moves.length / 2);
  if (st.state === "checkmate") {
    for (const a of actors.values()) {
      if (a.type !== "king") continue;
      if (a.color === st.winner) void a.play("celebrate").then(() => a.play("celebrate"));
      else void a.play("captured", { hold: true });
    }
    sound.play(st.winner === human ? "win" : "lose");
    if (st.winner === human) endGame("You win!", `Checkmate in ${plural(count, "move")} against ${levelLabel(level)}.`, 2.4);
    else endGame("Checkmate", `${levelLabel(level)} mates you in ${plural(count, "move")}.`, 2.4);
  } else {
    sound.play("draw");
    endGame("Draw", `Drawn by ${st.drawReason?.replace(/-/g, " ") ?? "agreement"} after ${plural(count, "move")}.`, 1.2);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The game is over: forget the saved game, then show the result screen after a moment. */
function endGame(title: string, text: string, delay: number): void {
  gameOver = true;
  persist();
  const gen = generation;
  void tweens.wait(delay).then(() => {
    if (gen !== generation || mode !== "game") return;
    clearSelection();
    menu.setGameOver(title, text);
    menu.show("over");
    sound.setScene("over");
  });
}

// ---------------------------------------------------------------- camera

function cameraHome(color: Color): THREE.Vector3 {
  // Fit the board (plus a little of the trays) to the viewport width; look
  // down more steeply on portrait screens.
  const aspect = camera.aspect;
  const portrait = aspect < 1;
  const halfWidth = portrait ? 4.9 : 6.4;
  const dist = Math.max(14.5, halfWidth / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect));
  controls.maxDistance = Math.max(24, dist * 1.3);
  const side = color === "white" ? 1 : -1;
  const dir = new THREE.Vector3(0, portrait ? 0.9 : 0.78, side * (portrait ? 0.42 : 0.62)).normalize();
  return dir.multiplyScalar(dist);
}

function flyCamera(color: Color, seconds = 0.9): Promise<void> {
  const from = camera.position.clone();
  const to = cameraHome(color);
  const a0 = Math.atan2(from.x, from.z), a1 = Math.atan2(to.x, to.z);
  let da = a1 - a0;
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  const r0 = Math.hypot(from.x, from.z), r1 = Math.hypot(to.x, to.z);
  return tweens.run(seconds, (k) => {
    const e = ease(k);
    const a = a0 + da * e, r = r0 + (r1 - r0) * e;
    camera.position.set(Math.sin(a) * r, from.y + (to.y - from.y) * e, Math.cos(a) * r);
    camera.lookAt(controls.target);
  });
}

// ---------------------------------------------------------------- UI

let generation = 0;
let startFen = START_FEN;

function newGame(color: Color, fen = START_FEN): void {
  generation++;
  clearSelection();
  chess.load(fen);
  startFen = fen;
  moves = [];
  human = color;
  gameOver = false;
  busy = false;
  rebuild(true);
  enterGame();
  sound.play("start");
  persist();
  void flyCamera(color);
  setStatus(turnText());
  if (chess.turn() !== human) void tweens.wait(0.9).then(() => engineMove());
}

/** Set up a saved game on the board (no animation). False if it doesn't replay. */
function loadPosition(g: SavedGame): boolean {
  generation++;
  clearSelection();
  try {
    chess.load(g.startFen);
    for (const uci of g.moves) chess.play(uci);
  } catch {
    chess.load(START_FEN);
    startFen = START_FEN; moves = []; human = "white";
    rebuild(false);
    return false;
  }
  startFen = g.startFen;
  moves = [...g.moves];
  human = g.human;
  level = g.level;
  gameOver = chess.status().state !== "playing";
  busy = false;
  rebuild(false);
  return true;
}

function continueGame(): void {
  const saved = loadGame();
  if (saved === null || !loadPosition(saved) || gameOver) { menu.push("new"); return; }
  enterGame();
  void flyCamera(human);
  setStatus(turnText());
  if (chess.turn() !== human) void tweens.wait(0.9).then(() => engineMove());
}

/** The game in progress survives a reload; a finished one doesn't. */
function persist(): void {
  saveGame(mode === "game" && !gameOver ? { startFen, moves, human, level } : null);
}

/** The Continue button's line: side, engine and move of the saved game. */
function savedInfo(): string | null {
  const g = loadGame();
  if (g === null) return null;
  return `${g.human === "white" ? "White" : "Black"} vs ${levelLabel(g.level)} · move ${Math.floor(g.moves.length / 2) + 1}`;
}

function enterGame(): void {
  mode = "game";
  menu.close();
  sound.setScene("game");
  hudEl.hidden = false;
  statusEl.hidden = false;
  controls.enabled = true;
}

function toTitle(): void {
  generation++;                                     // drop a pending engine reply
  mode = "title";
  busy = false;
  clearSelection();
  hudEl.hidden = true;
  statusEl.hidden = true;
  $("promo").hidden = true;
  controls.enabled = false;
  orbit = Math.atan2(camera.position.x, camera.position.z);
  menu.setContinue(savedInfo());
  menu.show("title");
  sound.setScene("title");
}

function openPause(): void {
  if (mode !== "game") return;
  clearSelection();
  controls.enabled = false;
  if (gameOver) { menu.show("over"); sound.setScene("over"); return; }
  const turn = chess.turn() === human ? "your move" : "engine to move";
  menu.setPauseInfo(`You play ${human} against ${levelLabel(level)} · move ${Math.floor(moves.length / 2) + 1}, ${turn}`);
  menu.show("pause");
  sound.setScene("pause");
}

function resume(): void {
  menu.close();
  controls.enabled = mode === "game";
  if (mode === "game") sound.setScene(gameOver ? "over" : "game");
}

function resign(): void {
  if (mode !== "game" || gameOver) return;
  generation++;
  busy = false;
  setStatus("You resigned.");
  gameOver = true;
  persist();
  for (const a of actors.values()) if (a.type === "king" && a.color === human) void a.play("captured", { hold: true });
  sound.play("lose");
  sound.setScene("over");
  menu.setGameOver("You resigned", moves.length === 0 ? `${levelLabel(level)} wins.` : `${levelLabel(level)} wins after ${plural(Math.ceil(moves.length / 2), "move")}.`);
  menu.show("over");
}

function undo(): void {
  if (mode !== "game" || moves.length === 0) return;
  generation++;
  clearSelection();
  // take back to the last position where it was the human's move
  do { chess.undo(); moves.pop(); } while (moves.length && chess.turn() !== human);
  gameOver = false;
  busy = false;
  rebuild(false);
  persist();
  setStatus(turnText());
  if (chess.turn() !== human) void engineMove();
}

const flip = () => void flyCamera(camera.position.z >= 0 ? "black" : "white");
$("undo").onclick = () => undo();
$("flip").onclick = flip;
$("menu-open").onclick = () => openPause();
// a tick for every menu and HUD button (setting changes included)
for (const id of ["menu", "hud", "promo"]) $(id).addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) sound.play("click"); });

const menu = new Menu(settings, {
  start: (color, l) => { level = l; menu.close(); newGame(color); },
  continueGame,
  resume,
  undo: () => { resume(); undo(); },
  resign,
  rematch: () => { menu.close(); newGame(human); },
  review: () => { resume(); setStatus(turnText()); },
  toTitle,
  quit: () => (globalThis as { nativeApp?: { quit(): void } }).nativeApp?.quit(),
  settingsChanged: () => {
    key.castShadow = settings.shadows;
    if (selected !== null) select(selected);
    refreshMarks();
  },
});

addEventListener("keydown", (e) => {
  if (menu.key(e)) { e.preventDefault(); return; }
  if (mode !== "game" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") { e.preventDefault(); openPause(); }
  else if (e.key === "u" || e.key === "U") undo();
  else if (e.key === "f" || e.key === "F") flip();
});

// ---------------------------------------------------------------- loop

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.fov = camera.aspect < 1 ? 50 : 36;
  camera.updateProjectionMatrix();
}
addEventListener("resize", () => {
  resize();
  camera.position.copy(cameraHome(camera.position.z >= 0 ? "white" : "black"));
  camera.lookAt(controls.target);
});

const timer = new THREE.Timer();
let orbit = 0;
function frame(time: number): void {
  timer.update(time);
  const real = Math.min(0.05, timer.getDelta());
  // the pause menu stops the game clock: animations, the engine's reply and its landing wait
  const paused = mode === "game" && menu.isOpen() && !gameOver;
  const dt = paused ? 0 : real * SPEED_SCALE[settings.speed];
  tweens.update(dt);
  for (const a of liveActors) a.mixer.update(dt);
  if (mode === "title") {
    // a slow turn around the board behind the main menu
    orbit += real * 0.07;
    const r = 15.5, h = 7.2;
    camera.position.set(Math.sin(orbit) * r, h, Math.cos(orbit) * r);
    camera.lookAt(controls.target);
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
}

async function start(): Promise<void> {
  resize();
  controls.enabled = false;
  const bar = $("loading-progress");
  bar.style.width = "8%";
  await loadPieces(new URL("./models/", location.href).href, (done, total) => {
    bar.style.width = `${Math.round(8 + 92 * done / total)}%`;
  });
  // behind the title: the saved game if there is one, else the starting position
  const saved = loadGame();
  if (saved === null || !loadPosition(saved)) chess.load(START_FEN);
  rebuild(true);
  orbit = human === "white" ? 0.35 : Math.PI + 0.35;
  renderer.setAnimationLoop(frame);
  toTitle();
  // fade the loading screen out over the title (its CSS transition), then take it away
  const loading = $("loading");
  loading.classList.add("done");
  setTimeout(() => { loading.hidden = true; }, 450);
}

// Small hook for automated checks and the console.
Object.assign(window, {
  web3d: {
    chess,
    state: () => ({ fen: chess.fen(), moves: [...moves], busy, human, gameOver, mode, menu: menu.current, status: statusEl.textContent }),
    move: (uci: string) => {
      const mv = chess.legalMoves().find((m) => m.uci === uci);
      if (!mv || mode !== "game" || busy || chess.turn() !== human) return false;
      void humanMove(mv);
      return true;
    },
    select: (sq: string) => onSquare(sq),
    /** CSS pixel position of a square's center, for driving real pointer clicks in tests. */
    screenOf: (sq: string, y = 0) => {
      const v = squarePos(sq).setY(y).project(camera);
      const r = canvas.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    },
    newGame,
    setLevel: (l: Level) => { level = l; },
    openMenu: () => openPause(),
    toTitle,
  },
});

start().catch((err) => { setStatus(`Failed to start: ${err}`); console.error(err); });
