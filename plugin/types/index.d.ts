/** The game as kept across reloads: moves are replayed from `start` (FEN), since FEN alone loses repetition history. */
export type GameSnapshot = {
  readonly start: string
  readonly moves: readonly string[]
  readonly player: 'white' | 'black' | 'both'
  readonly level: number
  readonly claimed: boolean
}

/** What the pane shows beside the position, kept apart from the game itself. */
export type Extras = {
  thinking: boolean
  message: string
  hint: string | null
  /** The engine the person prefers: Perry's native build, or the built-in one in Claude Code's worker. */
  engine: 'perry' | 'builtin'
  /** Whether this platform has a working native engine, once probed. */
  native: 'unknown' | 'ready' | 'missing'
  /** The last search: engine, depth, nodes, milliseconds. */
  stats: string
  /** The board drawn from the other side. */
  flipped: boolean
}

/** The username this computer holds on one server. */
export type Account = { server: string; name: string; token: string }

export type Standing = { name: string; wins: number; losses: number; draws: number }
/** A game as the server reports it (server/src/lobby.ts GameView). */
export type ServerGame = {
  id: string
  white: string
  black: string
  you: 'white' | 'black'
  start: string
  moves: string[]
  result: 'white' | 'black' | 'draw' | null
  reason: string | null
  rated: boolean
  opponentOnline: boolean
  /** Null for untimed games; milliseconds left as of the server's answer (server/src/lobby.ts ClockView). */
  clock?: { white: number; black: number; running: 'white' | 'black' | null; initial: number; increment: number } | null
}
/** Everything one player sees (server/src/lobby.ts StateView). */
export type ServerView = {
  version: number
  me: Standing
  online: { name: string; status: 'idle' | 'queued' | 'playing' }[]
  queued: boolean
  incoming: string[]
  outgoing: string | null
  game: ServerGame | null
  leaderboard: Standing[]
}
/** Online play: whether the pane shows it, the link to the server, and the latest view. */
export type Online = {
  mode: 'local' | 'online'
  link: 'off' | 'connecting' | 'live' | 'error'
  error: string
  view: ServerView | null
  pending: boolean
  message: string
  /** When `view` arrived, and the latest clock tick ($.clock.now()): the running clock counts down between them. */
  viewAt?: number
  now?: number
}

declare module 'claude-code' {
  interface PluginState {
    chess: { game: Shaped<GameSnapshot>; extras: Shaped<Extras>; draft: string; online: Shaped<Online> }
  }
}
