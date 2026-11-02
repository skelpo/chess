// opencode TUI plugin: a graphical chess board. /chess (or /board) opens it full screen; while a game is on,
// a small board sits in the session sidebar. The agent sees and plays the same game with the
// chess_board tool from server.ts.
import { createSignal, Show } from "solid-js";
import { ChessBoard, MiniBoard, type BoardKeys } from "./board.tsx";
import { createGame, type Game } from "./controller.ts";
import type { Player } from "./lib/session.ts";

// The host passes the plugin context (`Plugin.Context` from @opencode/plugin/tui); only the parts used here are typed.
type Route = { readonly type: string; readonly [key: string]: unknown };
type Command = {
  readonly id?: string;
  readonly title?: string;
  readonly group?: string;
  readonly bind?: string;
  readonly palette?: true;
  readonly slash?: { readonly name: string; readonly aliases?: string[] };
  readonly run: () => void | false;
};
type Context = {
  readonly theme: any;
  readonly keymap: { layer(input: () => { readonly mode?: string; readonly priority?: number; readonly commands: readonly Command[] }): void };
  readonly storage: { store<T extends object>(key: string, options: { initial: T }): readonly [T, (mutate: (draft: T) => void) => Promise<void>] };
  readonly ui: {
    readonly router: { register(page: { name: string; render: () => unknown }): () => void; navigate(destination: Route | { type: "plugin"; name: string }): void; current(): Route };
    readonly dialog: {
      clear(): void;
      confirm(options: { title: string; message: string }): Promise<boolean | undefined>;
      select<T>(options: { title: string; options: { title: string; value: T; description?: string }[] }): Promise<T | undefined>;
    };
    readonly slot: (claim: { append: string; render: (input: any) => unknown }) => () => void;
  };
};

const ROUTE = "chess";
const FILE_KEYS = "abcdefgh12345678qrnuitlm+=-";

type Prefs = { flipped: boolean; letters: boolean; sidebar: boolean };

function ChessPage(props: { context: Context; game: Game; prefs: Prefs; setPrefs: (mutate: (draft: Prefs) => void) => void; close: () => void }) {
  let keys: BoardKeys | null = null;
  const menu = async () => {
    type Action = "new-white" | "new-black" | "new-both" | "undo" | "hint" | "flip" | "harder" | "easier" | "letters" | "sidebar" | "back";
    const view = props.game.view();
    const action = await props.context.ui.dialog.select<Action>({
      title: "Chess",
      options: [
        { title: "New game as White", value: "new-white" },
        { title: "New game as Black", value: "new-black" },
        { title: "New game, both sides (no engine)", value: "new-both" },
        { title: "Undo", value: "undo", description: "Take back your last move" },
        { title: "Hint", value: "hint", description: "The engine's best move" },
        { title: "Flip board", value: "flip" },
        { title: "Harder", value: "harder", description: "Level " + String(Math.min(10, view.level + 1)) },
        { title: "Easier", value: "easier", description: "Level " + String(Math.max(1, view.level - 1)) },
        { title: props.prefs.letters ? "Show pieces" : "Show letters", value: "letters" },
        { title: props.prefs.sidebar ? "Hide the sidebar board" : "Show the sidebar board", value: "sidebar" },
        { title: "Back to the session", value: "back" },
      ],
    });
    if (action === undefined) return;
    if (action === "new-white" || action === "new-black" || action === "new-both") props.game.newGame(action.slice(4) as Player);
    else if (action === "undo") props.game.undo();
    else if (action === "hint") props.game.hint();
    else if (action === "flip") props.setPrefs((draft) => { draft.flipped = !draft.flipped; });
    else if (action === "harder") props.game.level(1);
    else if (action === "easier") props.game.level(-1);
    else if (action === "letters") props.setPrefs((draft) => { draft.letters = !draft.letters; });
    else if (action === "sidebar") props.setPrefs((draft) => { draft.sidebar = !draft.sidebar; });
    else props.close();
  };
  const newGame = async () => {
    if (props.game.view().moves !== "" && !props.game.view().over) {
      const ok = await props.context.ui.dialog.confirm({ title: "New game", message: "Abandon this game and start a new one?" });
      if (ok !== true) return;
    }
    props.game.newGame();
  };
  const command = (character: string) => {
    switch (character) {
      case "n": void newGame(); break;
      case "u": props.game.undo(); break;
      case "i": props.game.hint(); break;
      case "t": props.setPrefs((draft) => { draft.flipped = !draft.flipped; }); break;
      case "l": props.setPrefs((draft) => { draft.letters = !draft.letters; }); break;
      case "m": void menu(); break;
      case "+": case "=": props.game.level(1); break;
      case "-": props.game.level(-1); break;
    }
  };

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "up", title: "Cursor up", group: "Chess", run: () => keys?.up() },
      { bind: "down", title: "Cursor down", group: "Chess", run: () => keys?.down() },
      { bind: "left", title: "Cursor left", group: "Chess", run: () => keys?.left() },
      { bind: "right", title: "Cursor right", group: "Chess", run: () => keys?.right() },
      { bind: "return,space", title: "Select or move", group: "Chess", run: () => keys?.activate() },
      { bind: "backspace", title: "Erase typed move", group: "Chess", run: () => keys?.backspace() },
      { bind: "escape", title: "Back", group: "Chess", run: () => { if (keys?.escape() !== true) props.close(); } },
      ...[...FILE_KEYS].map((character): Command => ({ bind: character, title: "Chess key " + character, group: "Chess", run: () => keys?.type(character) })),
    ],
  }));

  return (
    <box width="100%" height="100%" backgroundColor={props.context.theme.background.base}>
      <ChessBoard
        game={props.game}
        theme={() => props.context.theme}
        flipped={() => props.prefs.flipped}
        letters={() => props.prefs.letters}
        bindKeys={(handlers) => { keys = handlers; }}
        command={command}
      />
    </box>
  );
}

export default {
  id: "tuichess.board",
  setup(context: Context) {
    const game = createGame();
    const [prefs, updatePrefs] = context.storage.store<Prefs>("prefs", { initial: { flipped: false, letters: false, sidebar: true } });
    const setPrefs = (mutate: (draft: Prefs) => void) => { void updatePrefs(mutate).catch(() => undefined); };
    const [previous, setPrevious] = createSignal<Route>({ ...context.ui.router.current() });
    const close = () => {
      const back = previous();
      context.ui.router.navigate(back.type === "plugin" ? { type: "home" } : back);
    };
    const open = () => {
      const current = context.ui.router.current();
      if (current.type === "plugin" && current["name"] === ROUTE) return;
      setPrevious({ ...current });
      context.ui.dialog.clear();
      context.ui.router.navigate({ type: "plugin", name: ROUTE });
    };

    context.ui.router.register({
      name: ROUTE,
      render: () => <ChessPage context={context} game={game} prefs={prefs} setPrefs={setPrefs} close={close} />,
    });
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "tuichess.board.open",
              title: "Chess board",
              group: "Chess",
              slash: { name: "chess", aliases: ["board", "chessboard"] },
              palette: true,
              run: open,
            },
          ],
        }));
        return null;
      },
    });
    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={prefs.sidebar && game.view().moves !== ""}>
          <MiniBoard game={game} theme={() => context.theme} flipped={() => prefs.flipped} open={open} />
        </Show>
      ),
    });
    return () => game.dispose();
  },
};
