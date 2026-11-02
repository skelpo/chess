// The board's side panel in online mode: the lobby (record, play anyone, challenges, players online,
// high scores) or the game (players, whose move, result). Wording follows the terminal game.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { clockNow, formatClock, record, timeControl } from "./lib/online.ts";
import { opponentOf, type Online } from "./online-game.ts";

type Theme = {
  readonly text: { readonly base: string; readonly muted: string; readonly feedback: Record<"success" | "warning" | "error", { readonly base: string }> };
};

export function OnlinePanel(props: { readonly online: Online; readonly theme: () => Theme; readonly moves: () => string }) {
  const theme = () => props.theme();
  const view = () => props.online.view();
  const game = () => view()?.game ?? null;
  const host = () => props.online.client.host;
  const name = () => props.online.client.account?.name ?? "";
  const status = () => props.online.game.view().status;

  // Live clocks: re-read the time while a clock runs, and redraw only when the shown text changes.
  // The timer lives with the panel, so it stops when the board closes.
  const times = (at: number) => {
    const clock = game()?.clock ?? null;
    return clock === null ? null : clockNow(clock, props.online.client.viewAt, at);
  };
  const shown = (at: number) => { const value = times(at); return value === null ? "" : formatClock(value.white) + "|" + formatClock(value.black); };
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => {
    const running = game()?.result === null && (game()?.clock?.running ?? null) !== null;
    if (running && shown(Date.now()) !== shown(now())) setNow(Date.now());
  }, 100);
  onCleanup(() => clearInterval(timer));
  const left = (color: "white" | "black") => times(now())?.[color] ?? 0;
  const clockColor = (color: "white" | "black") => {
    const running = game()?.clock?.running === color && game()?.result === null;
    if (running && left(color) < 30_000) return theme().text.feedback.error.base;
    return running ? theme().text.base : theme().text.muted;
  };
  const player = (color: "white" | "black") => {
    const current = game()!;
    const name = (color === "white" ? "White  " : "Black  ") + (color === "white" ? current.white : current.black) + (current.you === color ? " (you)" : "");
    return (
      <box flexDirection="row" justifyContent="space-between" width={34}>
        <text fg={theme().text.base}>{name}</text>
        <Show when={game()?.clock !== null}>
          <text fg={clockColor(color)}>
            {game()?.clock?.running === color && game()?.result === null ? <b>{("▶ " + formatClock(left(color))).padStart(8)}</b> : formatClock(left(color)).padStart(8)}
          </text>
        </Show>
      </box>
    );
  };

  return (
    <box flexDirection="column">
      <Show when={!props.online.needsName()} fallback={
        <box flexDirection="column">
          <text fg={theme().text.base}><b>Play online</b></text>
          <text fg={theme().text.muted}>Pick a username: 3 to 20 letters, digits, _ or -. No password: this computer keeps it, shared with the tuichess terminal game.</text>
          <text fg={theme().text.muted}>{host()}</text>
          <box marginTop={1}><text fg={theme().text.muted}>Enter  pick a username   o  engine game</text></box>
        </box>
      }>
        <Show when={view() !== null} fallback={
          <box flexDirection="column">
            <text fg={theme().text.base}><b>{"Online · " + name()}</b></text>
            <text fg={theme().text.muted}>{props.online.link() === "error" ? props.online.error() : "Connecting to " + host() + "…"}</text>
            <box marginTop={1}><text fg={theme().text.muted}>o  engine game   esc  back</text></box>
          </box>
        }>
          <Show when={game()} fallback={
            <box flexDirection="column">
              <text fg={theme().text.base}><b>{"Online · " + name()}</b> <span style={{ fg: theme().text.muted }}>{host()}</span></text>
              <text fg={theme().text.muted}>{record(view()!.me)}</text>
              <box marginTop={1} flexDirection="column">
                <Show when={view()!.queued} fallback={<text fg={theme().text.base}>p  Play anyone</text>}>
                  <text fg={theme().text.feedback.warning.base}>Waiting for an opponent…  p cancels</text>
                </Show>
                <For each={view()!.incoming}>
                  {(from, index) => (
                    <text fg={theme().text.feedback.warning.base}>
                      {from + " challenges you" + (index() === 0 ? "  y accept · x decline" : "")}
                    </text>
                  )}
                </For>
                <Show when={view()!.outgoing !== null}>
                  <text fg={theme().text.base}>{"Waiting for " + view()!.outgoing + "…  p withdraws"}</text>
                </Show>
              </box>
              <box marginTop={1} flexDirection="column">
                <text fg={theme().text.base}><b>Online now</b></text>
                <Show when={view()!.online.length > 0} fallback={<text fg={theme().text.muted}>Nobody else right now.</text>}>
                  <For each={view()!.online.slice(0, 6)}>
                    {(player) => (
                      <text fg={theme().text.base}>
                        {player.name}<span style={{ fg: theme().text.muted }}>{player.status === "idle" ? "" : " · " + player.status}</span>
                      </text>
                    )}
                  </For>
                  <Show when={view()!.online.length > 6}>
                    <text fg={theme().text.muted}>{"and " + String(view()!.online.length - 6) + " more"}</text>
                  </Show>
                  <text fg={theme().text.muted}>m menu: challenge a player</text>
                </Show>
              </box>
            </box>
          }>
            {(current) => (
              <box flexDirection="column">
                <text fg={current().result !== null ? theme().text.feedback.warning.base : theme().text.base}>
                  <b>{status() + (props.online.pending() ? " …" : "")}</b>
                </text>
                {player(current().you === "white" ? "black" : "white")}
                {player(current().you)}
                <Show when={current().clock !== null}>
                  <text fg={theme().text.muted}>{timeControl(current().clock!) + " · out of time loses"}</text>
                </Show>
                <Show when={current().result === null && !current().opponentOnline}>
                  <text fg={theme().text.muted}>{opponentOf(current()) + " is away: loses after 10 minutes offline."}</text>
                </Show>
                <box marginTop={1}>
                  <text fg={theme().text.muted}>{props.moves() === "" ? "No moves yet." : props.moves()}</text>
                </box>
                <box marginTop={1} flexDirection="column">
                  <Show when={current().result === null} fallback={
                    <box flexDirection="column">
                      <text fg={theme().text.muted}>p  back to the lobby</text>
                      <For each={view()!.incoming}>{(from) => <text fg={theme().text.feedback.warning.base}>{from + " challenges you: p, then y"}</text>}</For>
                    </box>
                  }>
                    <text fg={theme().text.muted}>←↑↓→ ⏎/space, or type e2e4</text>
                    <text fg={theme().text.muted}>r resign   m menu (claim a draw)</text>
                  </Show>
                </box>
              </box>
            )}
          </Show>
          <box marginTop={1} flexDirection="column">
            <text fg={theme().text.base}><b>High scores</b></text>
            <Show when={view()!.leaderboard.length > 0} fallback={<text fg={theme().text.muted}>No rated games yet.</text>}>
              <For each={view()!.leaderboard.slice(0, 5)}>
                {(row, index) => (
                  <text fg={row.name === view()!.me.name ? theme().text.base : theme().text.muted}>
                    {String(index() + 1) + ". " + row.name.padEnd(14, " ").slice(0, 14) + " " + String(row.wins) + "W " + String(row.losses) + "L " + String(row.draws) + "D"}
                  </text>
                )}
              </For>
            </Show>
          </box>
        </Show>
      </Show>
      <Show when={props.online.message() !== ""}>
        <box marginTop={1}><text fg={theme().text.feedback.success.base}>{props.online.message()}</text></box>
      </Show>
      <Show when={props.online.link() === "error" && view() !== null}>
        <text fg={theme().text.feedback.warning.base}>{props.online.error()}</text>
      </Show>
      <box marginTop={1}><text fg={theme().text.muted}>t flip  m menu  o engine game  esc back</text></box>
    </box>
  );
}
