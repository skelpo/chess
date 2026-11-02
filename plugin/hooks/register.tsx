import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ChessSession, TOOLS, formatScore } from '../lib/session.ts'
import type { Player, Snapshot } from '../lib/session.ts'
import type { Extras } from '../types'
import { DEFAULT_SERVER, accountName, configure, gameProps, goOnline, inOnlineGame, lobbyTree, onlineAct, onlineState, startPolling } from './online.tsx'

const PANE = 'chess'
// The session never runs the engine itself: `engineTurn` asks Perry's native engine, or the built-in one.
const OPTIONS = { boardShownElsewhere: true, deferEngine: true } as const
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const FRESH: Snapshot = { start: START, moves: [], player: 'white', level: 5, claimed: false }
const INITIAL: Extras = { thinking: false, message: '', hint: null, engine: 'perry', native: 'unknown', stats: '', flipped: false }
const HINT_LEVEL = 7
// Change a tag when its value's fields change: a reload keeps what an earlier version stored.
const game = atom({ plugin: 'chess', key: 'game' } as const, FRESH, { shape: 'game-1' })
const extras = atom({ plugin: 'chess', key: 'extras' } as const, INITIAL, { shape: 'extras-3' })
// What the person has typed in the pane's move field.
const draft = atom({ plugin: 'chess', key: 'draft' } as const, '')

/** What the board module posts: a move, or a command word as the move field takes it. */
type Message = { type: 'move'; uci: string } | { type: 'command'; text: string }

const FIELD_HELP = 'Moves like e2e4 or e7e8q; or undo, hint, new, flip, easier, harder, level 1-10, engine.'

/** One engine answer, from whichever engine gave it. */
type Thought = {
  move: string | null
  claimDraw: boolean
  score: number
  depth: number
  nodes: number
  line: readonly string[]
  ms: number
  by: 'perry' | 'builtin'
  note: string
}

// The live game is rebuilt from `game` whenever it differs, as after a reload.
let session: ChessSession | null = null
let sessionKey = ''
// The native engine's path once probed: null when this platform has no binary.
let nativePath: string | null | undefined

async function current($: EngineInterface): Promise<ChessSession> {
  const snapshot = await read($, game)
  const key = JSON.stringify(snapshot)
  if (session === null || key !== sessionKey) {
    try {
      session = ChessSession.restore(snapshot, OPTIONS)
    } catch {
      session = new ChessSession(OPTIONS)
    }
    sessionKey = JSON.stringify(session.snapshot())
  }
  return session
}

async function save($: EngineInterface, live: ChessSession): Promise<void> {
  const snapshot = live.snapshot()
  sessionKey = JSON.stringify(snapshot)
  await update($, game, () => snapshot)
}

function quiet(x: Extras): Extras { return { ...x, message: '', hint: null } }

function openPane($: EngineInterface, focus: boolean) {
  // Docked (fullscreen layout) it asks for room for the big board plus the side panel; inline it takes the rows it needs.
  const pane = { id: PANE, title: 'Chess', columns: 92, rows: 32 }
  return $.ui.open(focus ? { ...pane, focus: true } : pane)
}

/** Finds bin/chess-engine-<os>-<arch>, the Perry build of cli/src/main.ts, and checks that it runs. */
async function findNative($: EngineInterface): Promise<string | null> {
  if (nativePath !== undefined) return nativePath
  try {
    const uname = await $.process.run(['uname', '-sm'], { timeoutMs: 5000 })
    const [system = '', machine = ''] = uname.stdout.trim().toLowerCase().split(/\s+/)
    const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' ? 'arm64' : machine
    const path = $.plugin.root + '/bin/chess-engine-' + system + '-' + arch
    const probe = await $.process.run([path, '--help'], { timeoutMs: 5000 })
    nativePath = probe.exitCode === 0 ? path : null
  } catch {
    nativePath = null
  }
  const native: Extras['native'] = nativePath !== null ? 'ready' : 'missing'
  await update($, extras, x => ({ ...x, native }))
  return nativePath
}

function readThought(stdout: string, ms: number): Thought {
  const value = JSON.parse(stdout) as Record<string, unknown>
  if (typeof value['error'] === 'string') throw new Error(value['error'])
  const move = value['move']
  const line = value['line']
  if (move !== null && typeof move !== 'string') throw new Error('no move in the answer')
  return {
    move,
    claimDraw: value['claimDraw'] === true,
    score: typeof value['score'] === 'number' ? value['score'] : 0,
    depth: typeof value['depth'] === 'number' ? value['depth'] : 0,
    nodes: typeof value['nodes'] === 'number' ? value['nodes'] : 0,
    line: Array.isArray(line) ? line.filter((step): step is string => typeof step === 'string') : [],
    ms: typeof value['ms'] === 'number' ? value['ms'] : ms,
    by: 'perry',
    note: '',
  }
}

/** Searches the current position with the preferred engine, falling back to the built-in one. */
async function think($: EngineInterface, live: ChessSession, level: number): Promise<Thought> {
  let note = ''
  if ((await read($, extras)).engine === 'perry') {
    const path = await findNative($)
    if (path === null) note = 'No Perry engine for this platform; the built-in engine played.'
    else {
      const snapshot = live.snapshot()
      const stdin = JSON.stringify({ start: snapshot.start, moves: snapshot.moves, level })
      const started = await $.clock.now()
      try {
        const ran = await $.process.run([path, 'move'], { stdin, timeoutMs: 600000 })
        return readThought(ran.stdout, (await $.clock.now()) - started)
      } catch (error) {
        note = 'Perry engine failed (' + (error instanceof Error ? error.message : 'no answer') + '); the built-in engine played.'
      }
    }
  }
  const started = await $.clock.now()
  const result = live.search(level)
  return {
    move: result.move === null ? null : result.move.uci,
    claimDraw: result.claimDraw,
    score: result.score,
    depth: result.depth,
    nodes: result.nodes,
    line: result.principalVariation,
    ms: (await $.clock.now()) - started,
    by: 'builtin',
    note,
  }
}

function grouped(count: number): string { return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }
function engineName(by: Thought['by']): string { return by === 'perry' ? 'Perry native' : 'built-in JS' }
function stats(thought: Thought): string {
  return engineName(thought.by) + ' · depth ' + String(thought.depth) + ' · ' + grouped(thought.nodes) + ' nodes · ' + String(Math.round(thought.ms)) + ' ms'
}

/** Plays the engine's move when it is the engine's turn; returns what happened. */
async function engineTurn($: EngineInterface): Promise<string | null> {
  let live = await current($)
  if (!live.engineToMove()) return null
  const before = JSON.stringify(live.snapshot())
  await update($, extras, x => ({ ...x, thinking: true }))
  try {
    const thought = await think($, live, live.engineLevel)
    live = await current($)
    // The person or the model may have changed the game while the engine thought.
    if (JSON.stringify(live.snapshot()) !== before) return null
    const note = thought.move === null && !thought.claimDraw ? null : live.playEngineMove(thought.move ?? '', thought.claimDraw)
    await save($, live)
    await update($, extras, x => ({ ...x, message: thought.note, stats: stats(thought) }))
    return note === null ? null : note.replace(/\.$/, '') + ' (' + engineName(thought.by) + ', ' + String(Math.round(thought.ms)) + ' ms).'
  } finally {
    await update($, extras, x => ({ ...x, thinking: false }))
  }
}

/** Starts the engine's turn after the pane has drawn the person's move. */
async function engineSoon($: EngineInterface): Promise<void> {
  if (!(await current($)).engineToMove()) return
  await update($, extras, x => ({ ...x, thinking: true }))
  $.clock.after(30, () => { void engineTurn($) })
}

async function hint($: EngineInterface, level: number): Promise<{ text: string; summary: string }> {
  const live = await current($)
  const mover = live.turn
  const thought = await think($, live, level)
  await update($, extras, x => ({ ...x, stats: stats(thought) }))
  if (thought.claimDraw) return { text: 'Suggestion: claim a draw.', summary: 'Hint: claim a draw' }
  if (thought.move === null) return { text: 'No move available.', summary: 'No move available.' }
  const score = formatScore(thought.score, mover)
  await update($, extras, x => ({ ...x, hint: thought.move, message: 'Hint: ' + (thought.move ?? '') + ' · ' + score }))
  return {
    text: [
      'Suggested move for ' + (mover === 'white' ? 'White' : 'Black') + ': ' + thought.move,
      'Evaluation: ' + score,
      'Line: ' + thought.line.join(' '),
      'Depth ' + String(thought.depth) + ', ' + String(thought.nodes) + ' nodes, ' + engineName(thought.by) + ' engine, ' + String(Math.round(thought.ms)) + ' ms.',
    ].join('\n'),
    summary: 'Hint: ' + thought.move + ' (' + score + ')',
  }
}

/** One command from the menu, the move field, the board or `/chess <word>`; answers what happened. */
async function act($: EngineInterface, input: string): Promise<string> {
  const text = input.trim().toLowerCase()
  if (text === '') return ''
  if (text === 'online') return goOnline($)
  if ((await onlineState($)).mode === 'online') return onlineAct($, input)
  const say = async (message: string) => { await update($, extras, x => ({ ...x, message })); return message }
  if (text === 'flip') {
    await update($, extras, x => ({ ...x, flipped: !x.flipped }))
    return 'Board flipped.'
  }
  if (text === 'engine') {
    const shown = await read($, extras)
    const engine: Extras['engine'] = shown.engine === 'perry' ? 'builtin' : 'perry'
    await update($, extras, x => ({ ...quiet(x), engine }))
    if (engine === 'perry') await findNative($)
    return engine === 'perry' ? 'Engine: Perry native.' : 'Engine: built-in JS.'
  }
  if ((await read($, extras)).thinking) return say('The engine is still thinking.')
  const live = await current($)
  if (text === 'hint') return live.view().over ? say('The game is over.') : (await hint($, HINT_LEVEL)).summary
  if (text === 'undo') {
    const result = live.call('chess_undo', {})
    await save($, live)
    await update($, extras, quiet)
    return result.isError ? say(result.text) : 'Took back the last move.'
  }
  if (text === 'new' || text === 'restart') {
    const snapshot = live.snapshot()
    live.call('chess_new_game', { player: snapshot.player, level: snapshot.level })
    await save($, live)
    await update($, extras, quiet)
    await engineSoon($)
    return 'New game.'
  }
  const level = /^(?:level\s+)?(\d+)$/.exec(text)
  if (level !== null || text === 'easier' || text === 'harder') {
    const now = live.snapshot().level
    const next = level !== null ? Number(level[1]) : Math.min(10, Math.max(1, now + (text === 'harder' ? 1 : -1)))
    const result = live.call('chess_settings', { level: next })
    if (result.isError) return say(result.text)
    await save($, live)
    await engineSoon($)
    return 'Level ' + live.view().level + ' (' + live.view().levelName + ').'
  }
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) {
    const error = live.playerMove(text)
    await save($, live)
    await update($, extras, x => ({ ...quiet(x), message: error ?? '' }))
    if (error !== null) return error
    await engineSoon($)
    return 'Played ' + text + '.'
  }
  return say('Unknown: "' + text + '". ' + FIELD_HELP)
}

function parseCommand(args: string): { player: Player | null; level: number | null; fen: string | null } {
  let player: Player | null = null
  let level: number | null = null
  let fen: string | null = null
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  for (let i = 0; i < words.length; i++) {
    const word = (words[i] ?? '').toLowerCase()
    if (word === 'white' || word === 'black' || word === 'both') player = word
    else if (word === 'level' && words[i + 1] !== undefined) level = Number(words[++i])
    else if (/^\d+$/.test(word)) level = Number(word)
    else if (word === 'fen') { fen = words.slice(i + 1).join(' '); break }
  }
  return { player, level, fen }
}

export const register: Register = (on, options) => {
  configure(typeof options['server'] === 'string' ? options['server'] : DEFAULT_SERVER)

  on('session.start', async ($, e, next) => {
    if ((await onlineState($)).mode === 'online') void startPolling($)
    await $.command.register({
      name: 'chess',
      description: 'Open the chess board; /chess e2e4 plays a move, /chess black 7 or /chess new starts a game',
    })
    for (const tool of TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema } })
    }
    return next(e)
  })

  on('command.run', { command: 'chess' }, async ($, e) => {
    const live = await current($)
    const word = e.args.trim().toLowerCase()
    // Play from the prompt: /chess e2e4, /chess undo, /chess hint, /chess flip, ...
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(word) || ['undo', 'hint', 'flip', 'engine', 'easier', 'harder', 'online', 'offline'].includes(word)) {
      await openPane($, false)
      return { text: 'Chess: ' + (await act($, word)) }
    }
    const options = parseCommand(e.args)
    const fresh = e.args.trim() !== ''
    if (fresh) {
      const snapshot = live.snapshot()
      const args: Record<string, unknown> = {
        player: options.player ?? snapshot.player,
        level: options.level ?? snapshot.level,
      }
      if (options.fen !== null) args['fen'] = options.fen
      const result = live.call('chess_new_game', args)
      if (result.isError) return { text: 'Chess: ' + result.text }
      await save($, live)
      await update($, extras, quiet)
      await engineSoon($)
    }
    await openPane($, true)
    // Focus is granted only over an empty prompt, which the command's own run still holds: ask again after it.
    $.clock.after(250, () => { void openPane($, true).then(() => $.ui.focus({ requestId: PANE, key: 'move' })).catch(() => undefined) })
    const layout = e.presentation.isFullscreen
      ? ' Click the board to use the arrow keys.'
      : ' For the board beside the chat (and clicking it), switch to the fullscreen layout: /tui fullscreen'
    return {
      text: (fresh ? 'New game. ' : '') +
        'Chess board open. Type moves (e2e4) in its field or use its menu; ctrl+x tab focuses the pane, Esc returns to the prompt.' + layout,
    }
  })

  // The model's tools act on the same game the pane shows, with the same engine.
  on('tool.call', { tool: /^mcp__chess__chess_/ }, async ($, e, next) => {
    const tool = TOOLS.find(spec => 'mcp__chess__' + spec.name === e.tool)
    if (tool === undefined) return next(e)
    if (await inOnlineGame($)) return { deny: 'The person is playing an online game against another person; Claude stays out of it until that game ends.' }
    const input = e as unknown as Record<string, unknown>
    const args: Record<string, unknown> = {}
    for (const key of Object.keys(tool.inputSchema.properties)) if (input[key] !== undefined) args[key] = input[key]
    const live = await current($)
    const level = typeof args['level'] === 'number' ? args['level'] : null
    if (tool.name === 'chess_hint') {
      if (live.view().over) return { result: 'The game is over.' }
      return { result: (await hint($, level ?? HINT_LEVEL)).text }
    }
    if (tool.name === 'chess_engine_move') {
      if (live.view().over) return { deny: 'The game is over.' }
      const thought = await think($, live, level ?? live.engineLevel)
      const note = live.playEngineMove(thought.move ?? '', thought.claimDraw)
      await save($, live)
      await update($, extras, x => ({ ...quiet(x), stats: stats(thought) }))
      return { result: (note ?? 'No move available.') + '\n\n' + live.call('chess_show', {}).text }
    }
    const result = live.call(tool.name, args)
    if (result.isError) return { deny: result.text }
    await save($, live)
    await update($, extras, quiet)
    if (tool.name === 'chess_new_game') void openPane($, false)
    const note = await engineTurn($)
    if (note === null) return { result: result.text }
    const first = result.text.split('\n')[0] ?? ''
    return { result: first + '\n' + note + '\n\n' + (await current($)).call('chess_show', {}).text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'chess: the game could not be updated.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const live = await current($)
    const shown = await read($, extras)
    if (!('Client' in elements) || !('Input' in elements)) {
      const { Text } = elements
      return <Text>{live.call('chess_show', {}).text}</Text>
    }
    const { Client, Box, Button, Input, Text } = elements
    const typed = await read($, draft)
    const docked = e.props.placement === 'dock'
    // Rows the menu and the move field take under the board.
    const below = 4
    const room = { columns: e.props.bodyColumns, rows: Math.max(10, e.props.scroll.bodyRows - below), focused: e.props.isFocused, docked }
    const run = (command: string) => () => { void act($, command) }
    const field = (label: string, placeholder: string) => (
      <Input
        key="move"
        label={label}
        placeholder={placeholder}
        value={typed}
        submitLabel="Go"
        onInput={value => { void update($, draft, () => value) }}
        onSubmit={value => { void update($, draft, () => '').then(() => act($, value)) }}
      />
    )
    const net = await onlineState($)
    if (net.mode === 'online') {
      const name = await accountName($)
      const match = net.view?.game ?? null
      if (match !== null) {
        const playing = match.result === null
        return (
          <Box flexDirection="column" height={docked ? '100%' : undefined}>
            <Client key="board" module="./board.tsx" props={{ ...gameProps(match, net.pending, net.message, net.viewAt ?? 0, net.now ?? 0), flipped: shown.flipped, engine: shown.engine, native: shown.native, room }} width="100%" flexGrow={1} />
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
              {playing && <Button key="resign" label="Resign" onPress={run('resign')} />}
              {playing && <Button key="draw" label="Claim draw" onPress={run('draw')} />}
              {!playing && <Button key="lobby" label="Back to lobby" variant="primary" onPress={run('lobby')} />}
              <Button key="flip" label="Flip" onPress={run('flip')} />
              <Button key="offline" label="Engine game" onPress={run('offline')} />
            </Box>
            {field('Move', playing ? 'e2e4, resign, draw' : 'lobby, offline')}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {lobbyTree({ Box, Text, Button }, net, name, run)}
          <Box flexDirection="row" columnGap={1} marginTop={1}>
            <Button key="offline" label="Engine game" onPress={run('offline')} />
          </Box>
          {name === null ? field('Username', 'pick a username') : field('Command', 'play, challenge <name>, accept <name>, offline')}
        </Box>
      )
    }
    const view = live.view()
    return (
      <Box flexDirection="column" height={docked ? '100%' : undefined}>
        <Client key="board" module="./board.tsx" props={{ ...view, ...shown, room, heading: '', online: false }} width="100%" flexGrow={1} />
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button key="new" label="New game" onPress={run('new')} />
          <Button key="undo" label="Undo" onPress={run('undo')} />
          <Button key="hint" label="Hint" onPress={run('hint')} />
          <Button key="flip" label="Flip" onPress={run('flip')} />
          <Button key="easier" label="Easier" onPress={run('easier')} />
          <Button key="harder" label="Harder" onPress={run('harder')} />
          <Button key="engine" label={shown.engine === 'perry' ? 'Engine: Perry' : 'Engine: built-in'} onPress={run('engine')} />
          <Button key="online" label="Play online" variant="primary" onPress={run('online')} />
        </Box>
        {field('Move', view.over ? 'Game over: type new, or undo' : 'e2e4, undo, hint, new, flip, level 7, online')}
      </Box>
    )
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const message = e.data as Message
    await act($, message.type === 'move' ? message.uci : message.text)
    return {}
  })
}
