// opencode TUI plugin: a graphical chess board. /chess (or /board) opens it full screen; while a game is on,
// a small board sits in the session sidebar. The agent sees and plays the same game with the
// chess_board tool from server.ts. `o` (or /chess online) plays people online through tuichess.dev.
import { createEffect, createRoot, createSignal, Show } from "solid-js";
import { ChessBoard, MiniBoard, type BoardKeys } from "./board.tsx";
import { createGame, type Game } from "./controller.ts";
import { createOnline, opponentOf, type Online } from "./online-game.ts";
import { OnlinePanel } from "./online-panel.tsx";
import type { Player } from "./lib/session.ts";

// The host passes the plugin context (`Plugin.Context` from @opencode/plugin/tui); only the parts used here are typed.
type Route = { readonly type: string; readonly [key: string]: unknown };
type Command = {
  readonly id?: string;
  readonly title?: string;
  readonly group?: string;
  readonly bind?: string;
  readonly palette?: true;
  readonly slash?: { readonly name: string; readonly aliases?: string[]; readonly arguments?: true };
  readonly run: (input?: string) => void | false;
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
      prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>;
      select<T>(options: { title: string; options: { title: string; value: T; description?: string }[] }): Promise<T | undefined>;
    };
    readonly slot: (claim: { append: string; render: (input: any) => unknown }) => () => void;
    readonly toast: { show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void };
  };
};

const ROUTE = "chess";
const FILE_KEYS = "abcdefgh12345678qrnuitlm+=-opxy";

type Prefs = { flipped: boolean; letters: boolean; sidebar: boolean };

type Mode = "local" | "online";

function ChessPage(props: {
  context: Context; game: Game; online: Online; mode: () => Mode; goOnline: () => void; goOffline: () => void;
  prefs: Prefs; setPrefs: (mutate: (draft: Prefs) => void) => void; close: () => void;
}) {
  let keys: BoardKeys | null = null;
  const online = props.online;
  const active = () => (props.mode() === "online" ? online.game : props.game);
  const flip = () => props.setPrefs((draft) => { draft.flipped = !draft.flipped; });

  const resign = async () => {
    const game = online.view()?.game;
    if (game === null || game === undefined || game.result !== null) { online.say("No game in progress."); return; }
    const ok = await props.context.ui.dialog.confirm({ title: "Resign", message: "Give up the game against " + opponentOf(game) + "?" });
    if (ok === true) online.act({ type: "resign" }, "");
  };
  const challenge = async () => {
    const view = online.view();
    const idle = (view?.online ?? []).filter((player) => player.status === "idle").map((player) => player.name);
    const name = idle.length > 0
      ? await props.context.ui.dialog.select<string>({ title: "Challenge", options: [...idle.map((player) => ({ title: player, value: player })), { title: "Someone else…", value: "" }] })
      : "";
    const who = name === "" ? await props.context.ui.dialog.prompt({ title: "Challenge", description: "Their username", placeholder: "username" }) : name;
    if (who !== undefined && who.trim() !== "") online.act({ type: "challenge", name: who.trim() }, "Challenged " + who.trim() + ".");
  };
  /** p: play anyone, stop waiting, withdraw a challenge, or back to the lobby after a game. */
  const lobbyKey = () => {
    const view = online.view();
    if (view === null) { online.start(); return; }
    if (view.game !== null) {
      if (view.game.result === null) online.say("Finish the game first: r resigns.");
      else online.act({ type: "leave" }, "Back in the lobby.");
      return;
    }
    if (view.queued) online.act({ type: "unqueue" }, "Stopped waiting.");
    else if (view.outgoing !== null) online.act({ type: "cancel" }, "Challenge withdrawn.");
    else online.act({ type: "queue" }, "Waiting for the next player…");
  };
  const onlineMenu = async () => {
    const view = online.view();
    const game = view?.game ?? null;
    const options: { title: string; value: () => void; description?: string }[] = [];
    if (game !== null && game.result === null) {
      options.push({ title: "Resign", value: () => void resign() });
      options.push({ title: "Claim a draw", value: () => online.act({ type: "draw" }, ""), description: "Threefold repetition or fifty moves" });
    } else if (game !== null) {
      options.push({ title: "Back to the lobby", value: () => online.act({ type: "leave" }, "Back in the lobby.") });
    } else if (view !== null) {
      if (view.queued) options.push({ title: "Stop waiting", value: () => online.act({ type: "unqueue" }, "Stopped waiting.") });
      else options.push({ title: "Play anyone", value: () => online.act({ type: "queue" }, "Waiting for the next player…") });
      if (view.outgoing !== null) options.push({ title: "Withdraw the challenge to " + view.outgoing, value: () => online.act({ type: "cancel" }, "Challenge withdrawn.") });
      else options.push({ title: "Challenge a player…", value: () => void challenge() });
    }
    for (const from of view?.incoming ?? []) {
      if (game !== null && game.result === null) break;
      options.push({ title: "Accept " + from, value: () => online.act({ type: "accept", name: from }, "") });
      options.push({ title: "Decline " + from, value: () => online.act({ type: "decline", name: from }, "Declined.") });
    }
    if (online.link() === "error") options.push({ title: "Reconnect", value: () => online.start() });
    options.push({ title: "Flip board", value: flip });
    options.push({ title: "Engine game (offline)", value: props.goOffline, description: "The online game keeps going" });
    options.push({ title: "Back to the session", value: props.close });
    const action = await props.context.ui.dialog.select<() => void>({ title: "Chess online", options });
    action?.();
  };
  const onlineCommand = (character: string) => {
    const view = online.view();
    switch (character) {
      case "o": props.goOffline(); break;
      case "p": lobbyKey(); break;
      case "r": void resign(); break;
      case "y": case "x": {
        const from = view?.incoming[0];
        if (from === undefined) { online.say("No challenges right now."); break; }
        if (view?.game !== null && view?.game !== undefined && view.game.result === null) { online.say("Finish the game first."); break; }
        if (character === "y") online.act({ type: "accept", name: from }, "");
        else online.act({ type: "decline", name: from }, "Declined " + from + ".");
        break;
      }
      case "t": flip(); break;
      case "l": props.setPrefs((draft) => { draft.letters = !draft.letters; }); break;
      case "m": void onlineMenu(); break;
      case "u": case "i": case "n": case "+": case "=": case "-": online.game.undo(); break;
    }
  };

  const menu = async () => {
    type Action = "online" | "new-white" | "new-black" | "new-both" | "undo" | "hint" | "flip" | "harder" | "easier" | "letters" | "sidebar" | "back";
    const view = props.game.view();
    const action = await props.context.ui.dialog.select<Action>({
      title: "Chess",
      options: [
        { title: "Play online", value: "online", description: "People on tuichess.dev, with high scores" },
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
    if (action === "online") props.goOnline();
    else if (action === "new-white" || action === "new-black" || action === "new-both") props.game.newGame(action.slice(4) as Player);
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
    if (props.mode() === "online") { onlineCommand(character); return; }
    switch (character) {
      case "o": props.goOnline(); break;
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
      {/* A new board per mode and online game, so the cursor and orientation start fresh. */}
      <Show when={props.mode() + ":" + (props.mode() === "online" ? online.view()?.game?.id ?? "" : "")} keyed>
        {() => (
          <ChessBoard
            game={active()}
            theme={() => props.context.theme}
            flipped={() => props.prefs.flipped}
            letters={() => props.prefs.letters}
            bindKeys={(handlers) => { keys = handlers; }}
            command={command}
            {...(props.mode() === "online" ? { panel: (moves: () => string) => <OnlinePanel online={online} theme={() => props.context.theme} moves={moves} /> } : {})}
          />
        )}
      </Show>
    </box>
  );
}

export default {
  id: "tuichess.board",
  setup(context: Context) {
    const game = createGame();
    const [mode, setMode] = createSignal<Mode>("local");
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

    const onBoard = () => { const current = context.ui.router.current(); return current.type === "plugin" && current["name"] === ROUTE; };
    const online = createOnline({
      onEvent(text) { if (mode() === "online" && !onBoard()) context.ui.toast.show({ title: "Chess", message: text + " /chess opens the board." }); },
    });
    const goOnline = async () => {
      setMode("online");
      if (online.needsName()) {
        const name = await context.ui.dialog.prompt({
          title: "Play online",
          description: "Pick a username: 3 to 20 letters, digits, _ or -. No password: this computer keeps it, and the tuichess terminal game uses the same one.",
          placeholder: "username",
        });
        if (name === undefined || name.trim() === "") {
          if (online.needsName()) { setMode("local"); game.say("Online play needs a username: o to try again."); }
          return;
        }
        const answer = await online.register(name);
        if (online.needsName()) { context.ui.toast.show({ title: "Chess", message: answer, variant: "warning" }); return; }
      }
      online.say(online.message() !== "" ? online.message() : "Online as " + (online.client.account?.name ?? "") + ". p plays anyone; m menu to challenge someone.");
      online.start();
    };
    const goOffline = () => {
      const live = online.view()?.game ?? null;
      online.stop();
      setMode("local");
      game.say("Back to the engine game.");
      if (live !== null && live.result === null) {
        context.ui.toast.show({ title: "Chess", message: "Your game against " + opponentOf(live) + " is still on: o goes back to it. Away 10 minutes loses.", variant: "warning" });
      }
    };
    // The agent's chess_board tool reads the online game from the shared file.
    const disposeEffects = createRoot((dispose) => {
      createEffect(() => game.publishOnline?.(mode() === "online" ? online.record() : null));
      return dispose;
    });

    context.ui.router.register({
      name: ROUTE,
      render: () => (
        <ChessPage
          context={context} game={game} online={online} mode={mode}
          goOnline={() => void goOnline()} goOffline={goOffline}
          prefs={prefs} setPrefs={setPrefs} close={close}
        />
      ),
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
            {
              id: "tuichess.board.online",
              title: "Chess online",
              group: "Chess",
              slash: { name: "chess-online" },
              palette: true,
              run: () => { open(); if (mode() !== "online") void goOnline(); },
            },
          ],
        }));
        return null;
      },
    });
    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={prefs.sidebar && (mode() === "online" ? online.game : game).view().moves !== ""}>
          <MiniBoard game={mode() === "online" ? online.game : game} theme={() => context.theme} flipped={() => prefs.flipped} open={open} />
        </Show>
      ),
    });
    return () => { disposeEffects(); online.stop(); game.dispose(); };
  },
};
