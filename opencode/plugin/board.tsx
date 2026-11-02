// The graphical board for opencode, drawn with opentui + Solid. A port of plugin/hooks/board.tsx
// (the Claude Code plugin's board): the same sprites, colors and highlights.
import { createMemo, createSignal, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { Game } from "./controller.ts";

const FILES = "abcdefgh";
const GLYPHS: Readonly<Record<string, string>> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
// Mid-tone squares keep both white and black pieces at roughly 3:1 contrast or better.
export const COLORS = {
  light: "#ad8e62",
  dark: "#8a6a43",
  lastLight: "#b5a048",
  lastDark: "#968332",
  targetLight: "#86a556",
  targetDark: "#6c8a40",
  selected: "#5b8fcf",
  cursor: "#3f7fd0",
  hint: "#6f95cf",
  check: "#c8423a",
  whitePiece: "#ffffff",
  blackPiece: "#1a1a1a",
} as const;
/** 7x6 pixel pieces for the largest squares, drawn two pixels per cell with half blocks. */
const SPRITES: Readonly<Record<string, readonly string[]>> = {
  p: [".......", ".......", "...#...", "..###..", "...#...", ".#####."],
  n: ["..##...", ".####..", "##.###.", "...###.", "..####.", ".#####."],
  b: ["...#...", "..###..", ".##.##.", "..###..", "...#...", ".#####."],
  r: [".#.#.#.", ".#####.", "..###..", "..###..", ".#####.", ".#####."],
  q: ["#.#.#.#", ".#####.", "..###..", "..###..", ".#####.", ".#####."],
  k: ["...#...", "..###..", "...#...", ".#####.", ".#####.", ".#####."],
};
const SPRITE_ROWS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(SPRITES).map(([piece, pixels]) => {
    const rows: string[] = [];
    for (let row = 0; row < 6; row += 2) {
      let line = "";
      for (let column = 0; column < 7; column++) {
        const top = pixels[row]?.charAt(column) === "#";
        const bottom = pixels[row + 1]?.charAt(column) === "#";
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      }
      rows.push(line);
    }
    return [piece, rows];
  }),
);
/** Square sizes in cells, largest first; terminal cells are about twice as tall as wide. */
const SIZES = [
  { width: 7, height: 3 },
  { width: 5, height: 2 },
  { width: 3, height: 1 },
] as const;
type Size = (typeof SIZES)[number];
const LABEL = 2;
const SIDE_PANEL = 36;

export function squareName(index: number): string { return FILES.charAt(index % 8) + String(Math.floor(index / 8) + 1); }
export function squareIndex(square: string): number { return FILES.indexOf(square.charAt(0)) + (Number(square.charAt(1)) - 1) * 8; }

/** Screen row and column of a square, row 0 at the top. */
function toScreen(square: number, flipped: boolean): { row: number; column: number } {
  const file = square % 8;
  const rank = Math.floor(square / 8);
  return flipped ? { row: rank, column: 7 - file } : { row: 7 - rank, column: file };
}
function fromScreen(row: number, column: number, flipped: boolean): number {
  return flipped ? row * 8 + (7 - column) : (7 - row) * 8 + column;
}

/** The tail of a long move list, cut at a move number so the panel keeps its height. */
function recent(moves: string, limit: number): string {
  if (moves.length <= limit) return moves;
  const cut = moves.indexOf(". ", moves.length - limit);
  const start = cut < 0 ? moves.length - limit : moves.lastIndexOf(" ", cut - 1) + 1;
  return "… " + moves.slice(start);
}

type Theme = {
  readonly text: { readonly base: string; readonly muted: string; readonly feedback: Record<"success" | "warning" | "error", { readonly base: string }> };
  readonly background: { readonly base: string };
};

export type BoardKeys = {
  readonly up: () => void;
  readonly down: () => void;
  readonly left: () => void;
  readonly right: () => void;
  readonly activate: () => void;
  readonly escape: () => boolean;
  readonly backspace: () => void;
  readonly type: (character: string) => void;
};

/** The full board with side panel and keyboard play. `bindKeys` receives the handlers to wire into a keymap layer. */
export function ChessBoard(props: {
  readonly game: Game;
  readonly theme: () => Theme;
  readonly flipped: () => boolean;
  readonly letters: () => boolean;
  readonly bindKeys: (keys: BoardKeys) => void;
  readonly command: (character: string) => void;
}) {
  const dimensions = useTerminalDimensions();
  const view = createMemo(() => props.game.view());
  const extras = () => props.game.extras();
  const flipped = createMemo(() => (view().player === "black") !== props.flipped());
  const [cursor, setCursor] = createSignal(squareIndex(props.game.view().player === "black" ? "e7" : "e2"));
  const [selected, setSelected] = createSignal<number | null>(null);
  const [promotion, setPromotion] = createSignal<{ from: number; to: number } | null>(null);
  const [typed, setTyped] = createSignal("");

  const layout = createMemo(() => {
    const columns = dimensions().width - 2;
    const rows = dimensions().height - 2;
    const fitsBeside = (size: Size) => columns >= LABEL + size.width * 8 + SIDE_PANEL;
    const size = SIZES.find((s) => (fitsBeside(s) || columns >= LABEL + s.width * 8) && rows >= s.height * 8 + 1 + (fitsBeside(s) ? 0 : 9))
      ?? SIZES[SIZES.length - 1]!;
    const beside = fitsBeside(size);
    return { size, beside, panel: beside ? Math.min(46, columns - LABEL - size.width * 8 - 2) : Math.min(46, columns) };
  });
  const size = () => layout().size;

  const canAct = () => view().playerTurn && !extras().thinking;
  const from = (square: number) => view().legal.filter((uci) => uci.startsWith(squareName(square)));
  const targets = createMemo(() => {
    const at = selected();
    return at === null ? [] : from(at).map((uci) => uci.slice(2, 4));
  });
  const lastSquares = createMemo(() => { const last = view().last; return last === null ? [] : [last.slice(0, 2), last.slice(2, 4)]; });
  const hintSquares = createMemo(() => { const hint = extras().hint; return hint === null ? [] : [hint.slice(0, 2), hint.slice(2, 4)]; });

  const clear = () => { setSelected(null); setPromotion(null); setTyped(""); };
  const play = (uci: string) => { clear(); props.game.play(uci); };

  const activate = (square: number) => {
    setCursor(square);
    setTyped("");
    if (!canAct()) {
      if (view().over) props.game.say("The game is over: n for a new game, u to undo.");
      else if (extras().thinking) props.game.say("The engine is thinking…");
      return;
    }
    const at = selected();
    if (at !== null && at !== square) {
      const moves = from(at).filter((uci) => uci.slice(2, 4) === squareName(square));
      if (moves.some((uci) => uci.length === 5)) { setPromotion({ from: at, to: square }); return; }
      const move = moves[0];
      if (move !== undefined) { play(move); setCursor(square); return; }
    }
    if (at === square) setSelected(null);
    else setSelected(from(square).length > 0 ? square : null);
  };

  const moveCursor = (dr: number, dc: number) => {
    const at = toScreen(cursor(), flipped());
    setCursor(fromScreen(Math.min(7, Math.max(0, at.row + dr)), Math.min(7, Math.max(0, at.column + dc)), flipped()));
  };

  const type = (character: string) => {
    const pending = promotion();
    if (pending !== null) {
      if ("qrbn".includes(character)) play(squareName(pending.from) + squareName(pending.to) + character);
      else setPromotion(null);
      return;
    }
    const text = typed();
    if (text.length === 4 && "qrbn".includes(character)) { play(text + character); return; }
    const file = FILES.includes(character);
    const rank = "12345678".includes(character);
    if ((file && (text.length === 0 || text.length === 2)) || (rank && (text.length === 1 || text.length === 3))) {
      const next = text + character;
      setTyped(next);
      if (next.length === 2) {
        const square = squareIndex(next);
        setCursor(square);
        setSelected(from(square).length > 0 ? square : null);
      }
      if (next.length === 4) {
        const moves = view().legal.filter((uci) => uci.startsWith(next));
        if (moves.some((uci) => uci.length === 5)) props.game.say("Promote to: q queen  r rook  b bishop  n knight");
        else if (moves[0] !== undefined) play(moves[0]);
        else { props.game.say("Illegal move: " + next + "."); clear(); }
      }
      return;
    }
    if (text === "") props.command(character);
    else setTyped("");
  };

  props.bindKeys({
    up: () => moveCursor(-1, 0),
    down: () => moveCursor(1, 0),
    left: () => moveCursor(0, -1),
    right: () => moveCursor(0, 1),
    activate: () => activate(cursor()),
    escape: () => {
      if (promotion() === null && selected() === null && typed() === "") return false;
      clear();
      return true;
    },
    backspace: () => setTyped((text) => text.slice(0, -1)),
    type,
  });

  const background = (square: number) => {
    const here = squareName(square);
    const light = ((square % 8) + Math.floor(square / 8)) % 2 === 1;
    let color: string = light ? COLORS.light : COLORS.dark;
    if (lastSquares().includes(here)) color = light ? COLORS.lastLight : COLORS.lastDark;
    if (hintSquares().includes(here)) color = COLORS.hint;
    if (targets().includes(here)) color = light ? COLORS.targetLight : COLORS.targetDark;
    if (view().check === here) color = COLORS.check;
    if (selected() === square) color = COLORS.selected;
    if (cursor() === square) color = COLORS.cursor;
    return color;
  };

  const Square = (squareProps: { square: () => number }) => {
    const letter = () => view().squares.charAt(squareProps.square());
    const white = () => letter() !== "." && letter() === letter().toUpperCase();
    const pieceColor = () => (white() ? COLORS.whitePiece : COLORS.blackPiece);
    const sprite = () => letter() !== "." && !props.letters() && size().height === 3;
    const glyph = () => {
      const value = letter();
      if (value === ".") return targets().includes(squareName(squareProps.square())) ? "•" : " ";
      return props.letters() ? value : (GLYPHS[value.toLowerCase()] ?? value);
    };
    return (
      <box
        width={size().width}
        height={size().height}
        backgroundColor={background(squareProps.square())}
        flexDirection="column"
        justifyContent={sprite() ? "flex-start" : "center"}
        alignItems={sprite() ? "flex-start" : "center"}
        onMouseDown={() => activate(squareProps.square())}
      >
        <Show
          when={sprite()}
          fallback={<text fg={letter() === "." ? COLORS.blackPiece : pieceColor()} selectable={false}><b>{glyph()}</b></text>}
        >
          <For each={SPRITE_ROWS[letter().toLowerCase()] ?? []}>
            {(line) => <text fg={pieceColor()} selectable={false}>{line}</text>}
          </For>
        </Show>
      </box>
    );
  };

  const fileLabels = () => {
    let files = " ".repeat(LABEL);
    for (let column = 0; column < 8; column++) {
      const file = FILES.charAt(flipped() ? 7 - column : column);
      const pad = size().width - 1;
      files += " ".repeat(Math.floor(pad / 2)) + file + " ".repeat(pad - Math.floor(pad / 2));
    }
    return files;
  };

  const status = () => (view().over ? view().status : extras().thinking ? "Engine is thinking…" : view().status);
  const help = () =>
    promotion() !== null || (typed().length === 4)
      ? ["Promote to: q queen  r rook  b bishop  n knight"]
      : [
          "←↑↓→ ⏎/space, or type e2e4",
          "u undo  i hint  t flip  n new",
          "+/- level  l letters  m menu",
          "esc back to the session",
        ];
  const theme = () => props.theme();

  return (
    <box flexDirection={layout().beside ? "row" : "column"} paddingLeft={1} paddingTop={1}>
      <box flexDirection="column" flexShrink={0}>
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
          {(row) => (
            <box flexDirection="row" height={size().height}>
              <box width={LABEL} height={size().height} justifyContent="center">
                <text fg={theme().text.muted}>{String(flipped() ? row + 1 : 8 - row)}</text>
              </box>
              <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
                {(column) => <Square square={() => fromScreen(row, column, flipped())} />}
              </For>
            </box>
          )}
        </For>
        <text fg={theme().text.muted}>{fileLabels()}</text>
      </box>
      <box
        flexDirection="column"
        width={layout().panel}
        marginLeft={layout().beside ? 2 : 0}
        marginTop={layout().beside ? 0 : 1}
        flexShrink={1}
      >
        <text fg={theme().text.base}><b>{"Chess · level " + String(view().level) + " (" + view().levelName + ")"}</b></text>
        <text fg={view().over ? theme().text.feedback.warning.base : extras().thinking ? theme().text.muted : theme().text.base}>
          {view().playerTurn || view().over ? <b>{status()}</b> : status()}
        </text>
        <text fg={theme().text.muted}>
          {"You: " + (view().player === "both" ? "both sides" : view().player) + (props.flipped() ? " · flipped" : "")}
        </text>
        <Show when={extras().stats !== ""}>
          <text fg={theme().text.muted} wrapMode="none" truncate>{extras().stats}</text>
        </Show>
        <Show when={extras().message !== ""}>
          <text fg={theme().text.feedback.success.base}>{extras().message}</text>
        </Show>
        <Show when={typed() !== ""}>
          <text fg={theme().text.base}>{"Move: " + typed() + "_"}</text>
        </Show>
        <box marginTop={1}>
          <text fg={theme().text.muted}>{view().moves === "" ? "No moves yet." : recent(view().moves, 180)}</text>
        </box>
        <box marginTop={1} flexDirection="column">
          <For each={help()}>{(line) => <text fg={theme().text.muted}>{line}</text>}</For>
          <text fg={theme().text.muted}>The agent sees this board too.</text>
        </box>
      </box>
    </box>
  );
}

/** A small read-only board for the sidebar: two cells per square. Click to open the full board. */
export function MiniBoard(props: { readonly game: Game; readonly theme: () => Theme; readonly flipped: () => boolean; readonly open: () => void }) {
  const view = createMemo(() => props.game.view());
  const flipped = createMemo(() => (view().player === "black") !== props.flipped());
  const last = createMemo(() => { const value = view().last; return value === null ? [] : [value.slice(0, 2), value.slice(2, 4)]; });
  const color = (square: number) => {
    const light = ((square % 8) + Math.floor(square / 8)) % 2 === 1;
    const here = squareName(square);
    if (view().check === here) return COLORS.check;
    if (last().includes(here)) return light ? COLORS.lastLight : COLORS.lastDark;
    return light ? COLORS.light : COLORS.dark;
  };
  return (
    <box flexDirection="column" onMouseDown={props.open}>
      <text fg={props.theme().text.base}><b>Chess</b> <span style={{ fg: props.theme().text.muted }}>{"· " + view().status}</span></text>
      <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
        {(row) => (
          <box flexDirection="row" height={1}>
            <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
              {(column) => {
                const square = () => fromScreen(row, column, flipped());
                const letter = () => view().squares.charAt(square());
                const white = () => letter() !== "." && letter() === letter().toUpperCase();
                return (
                  <box width={2} height={1} backgroundColor={color(square())}>
                    <text fg={white() ? COLORS.whitePiece : COLORS.blackPiece} selectable={false}>
                      {(letter() === "." ? " " : GLYPHS[letter().toLowerCase()] ?? letter()) + " "}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        )}
      </For>
      <text fg={props.theme().text.muted}>/chess to play</text>
    </box>
  );
}
