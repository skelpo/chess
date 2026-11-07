// The game menu: an HTML overlay (index.html, #menu) over the canvas.
// Screens stack: the title or pause screen at the bottom, sub-screens
// (new game, settings, help) on top; Back and Esc pop them.
import { levelSettings, type Color, type Level } from "@plain-chess/engine";
import { saveSettings, type Settings, type Speed } from "./settings.ts";

export type ScreenId = "title" | "new" | "settings" | "help" | "pause" | "over";
const SCREENS: readonly ScreenId[] = ["title", "new", "settings", "help", "pause", "over"];

export interface MenuActions {
  start(color: Color, level: Level): void;
  continueGame(): void;
  resume(): void;
  undo(): void;
  resign(): void;
  rematch(): void;
  review(): void;
  toTitle(): void;
  quit(): void;
  settingsChanged(): void;
}

const LEVEL_MIN = 1, LEVEL_MAX = 10;

export function levelLabel(level: Level): string { return `${level} · ${levelSettings(level).name}`; }

function levelNote(level: Level): string {
  const s = levelSettings(level);
  const style = s.inaccuracy >= 300 ? "Makes plenty of mistakes." : s.inaccuracy >= 90 ? "Makes the odd mistake."
    : s.inaccuracy > 0 ? "Rarely slips." : "Plays its best move.";
  return `Searches ${s.depth} ${s.depth === 1 ? "ply" : "plies"} deep. ${style}`;
}

export class Menu {
  private readonly root: HTMLElement;
  private readonly settings: Settings;
  private readonly actions: MenuActions;
  private stack: ScreenId[] = [];

  constructor(settings: Settings, actions: MenuActions) {
    this.root = document.getElementById("menu") as HTMLElement;
    this.settings = settings;
    this.actions = actions;
    this.root.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest("button");
      if (button !== null) this.press(button as HTMLButtonElement);
    });
    const quit = document.getElementById("quit");
    // only a native build can close its window; it provides nativeApp.quit
    if (quit !== null) quit.hidden = (globalThis as { nativeApp?: unknown }).nativeApp === undefined;
    // the help screen describes the input there is: touch, or mouse and keyboard
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    for (const e of this.root.querySelectorAll<HTMLElement>(".for-touch")) e.hidden = !touch;
    for (const e of this.root.querySelectorAll<HTMLElement>(".for-mouse")) e.hidden = touch;
  }

  get current(): ScreenId | null { return this.stack.at(-1) ?? null; }
  isOpen(): boolean { return this.stack.length > 0; }

  /** Open a base screen (title, pause, game over), replacing whatever was open. */
  show(id: ScreenId): void { this.stack = [id]; this.render(); }
  /** Open a sub-screen on top of the current one. */
  push(id: ScreenId): void { this.stack.push(id); this.render(); }
  back(): void { if (this.stack.length > 1) { this.stack.pop(); this.render(); } }
  close(): void { this.stack = []; this.root.hidden = true; }

  setContinue(info: string | null): void {
    (document.getElementById("continue") as HTMLElement).hidden = info === null;
    (document.getElementById("continue-info") as HTMLElement).textContent = info ?? "";
  }
  setPauseInfo(text: string): void { (document.getElementById("pause-info") as HTMLElement).textContent = text; }
  setGameOver(title: string, text: string): void {
    (document.getElementById("over-title") as HTMLElement).textContent = title;
    (document.getElementById("over-text") as HTMLElement).textContent = text;
  }

  /** Keyboard: Esc goes back (or resumes from pause), arrows move the focus. Returns true if handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.isOpen()) return false;
    if (e.key === "Escape") {
      if (this.stack.length > 1) this.back();
      else if (this.current === "pause") this.actions.resume();
      return true;
    }
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return false;
    const items = this.buttons();
    if (items.length === 0) return true;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
    items[next]?.focus();
    return true;
  }

  private screen(): HTMLElement | null { return this.current === null ? null : document.getElementById("screen-" + this.current); }

  private buttons(): HTMLButtonElement[] {
    const screen = this.screen();
    if (screen === null) return [];
    return [...screen.querySelectorAll("button")].filter((b) => b.checkVisibility()) as HTMLButtonElement[];
  }

  private render(): void {
    const id = this.current;
    this.root.hidden = false;
    this.root.classList.toggle("title", id === "title");
    for (const s of SCREENS) {
      (document.getElementById("screen-" + s) as HTMLElement).hidden = s !== id;
    }
    this.sync();
    const first = this.buttons().find((b) => b.classList.contains("primary")) ?? this.buttons()[0];
    first?.focus({ preventScroll: true });
  }

  /** Reflect the settings in the segmented controls and the level stepper. */
  private sync(): void {
    const values: Record<string, string> = {
      color: this.settings.color,
      hints: this.settings.hints ? "on" : "off",
      lastMove: this.settings.lastMove ? "on" : "off",
      shadows: this.settings.shadows ? "on" : "off",
      speed: this.settings.speed,
    };
    for (const seg of this.root.querySelectorAll<HTMLElement>("[data-setting]")) {
      const value = values[seg.dataset.setting ?? ""];
      for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === value));
    }
    (document.getElementById("level-value") as HTMLElement).textContent = levelLabel(this.settings.level);
    (document.getElementById("level-note") as HTMLElement).textContent = levelNote(this.settings.level);
    const meter = document.getElementById("level-meter") as HTMLElement;
    for (const [i, bar] of [...meter.children].entries()) bar.classList.toggle("on", i < this.settings.level);
  }

  private press(button: HTMLButtonElement): void {
    const setting = (button.parentElement as HTMLElement | null)?.dataset.setting;
    if (setting !== undefined && button.dataset.value !== undefined) { this.change(setting, button.dataset.value); return; }
    const action = button.dataset.action ?? "";
    if (action.startsWith("open:")) { this.push(action.slice(5) as ScreenId); return; }
    if (action.startsWith("level:")) {
      const level = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, this.settings.level + Number(action.slice(6))));
      this.settings.level = level as Level;
      saveSettings(this.settings);
      this.sync();
      return;
    }
    switch (action) {
      case "back": this.back(); break;
      case "start": {
        const pick = this.settings.color;
        const color: Color = pick === "random" ? (Math.random() < 0.5 ? "white" : "black") : pick;
        this.actions.start(color, this.settings.level);
        break;
      }
      case "continue": this.actions.continueGame(); break;
      case "resume": this.actions.resume(); break;
      case "undo": this.actions.undo(); break;
      case "resign": this.actions.resign(); break;
      case "rematch": this.actions.rematch(); break;
      case "review": this.actions.review(); break;
      case "title": this.actions.toTitle(); break;
      case "quit": this.actions.quit(); break;
    }
  }

  private change(setting: string, value: string): void {
    const s = this.settings;
    if (setting === "color") s.color = value as Settings["color"];
    else if (setting === "hints") s.hints = value === "on";
    else if (setting === "lastMove") s.lastMove = value === "on";
    else if (setting === "shadows") s.shadows = value === "on";
    else if (setting === "speed") s.speed = value as Speed;
    saveSettings(s);
    this.sync();
    this.actions.settingsChanged();
  }
}
