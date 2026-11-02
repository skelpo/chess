/**
 * Online play against other people through the chess server (server/src/main.ts): a username, the lobby,
 * the play-anyone queue, challenges, games and the high-score table. Long polling keeps the pane current.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface } from 'claude-code'

import { ChessSession } from '../lib/session.ts'
import type { Account, Online, ServerGame, ServerView } from '../types'

export const DEFAULT_SERVER = 'https://api.tuichess.dev'
const NAME = /^[A-Za-z0-9_-]{3,20}$/
const RETRY_MS = 3000
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/

const OFFLINE: Online = { mode: 'local', link: 'off', error: '', view: null, pending: false, message: '' }
const online = atom({ plugin: 'chess', key: 'online' } as const, OFFLINE, { shape: 'online-1' })

/** The online state, for the pane's drawing and the main module. */
export function onlineState($: EngineInterface): Promise<Online> { return read($, online) }

// Which poll loop is current: stopping or restarting one bumps it, and older loops end.
let generation = 0
let server = DEFAULT_SERVER

export function configure(url: string): void { server = url.trim().replace(/\/+$/, '') || DEFAULT_SERVER }
export function serverUrl(): string { return server }

export async function accountName($: EngineInterface): Promise<string | null> { return (await account($))?.name ?? null }

async function account($: EngineInterface): Promise<Account | null> {
  const stored = (await $.store.get('account')) as Account | undefined
  return stored !== undefined && stored !== null && stored.server === server ? stored : null
}

type Reply = { status: number; json: Record<string, unknown> }
async function call($: EngineInterface, method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['authorization'] = 'Bearer ' + token
  const response = await $.http.fetch(server + path, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) })
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(response.text) as Record<string, unknown> } catch { json = { error: 'The server answered something that is not JSON (HTTP ' + String(response.status) + ').' } }
  return { status: response.status, json }
}

async function show($: EngineInterface, view: ServerView): Promise<void> {
  await update($, online, (x): Online => (x.view !== null && x.view.version > view.version ? x : { ...x, view, link: 'live', error: '' }))
}

/** Polls the server until online mode ends; each answer redraws the pane. */
export async function startPolling($: EngineInterface): Promise<void> {
  const mine = ++generation
  const me = await account($)
  if (me === null) return
  await update($, online, (x): Online => ({ ...x, link: x.view === null ? 'connecting' : x.link }))
  const loop = async (since: number): Promise<void> => {
    if (mine !== generation) return
    let next = since
    try {
      const reply = await call($, 'GET', '/v1/state?since=' + String(since), me.token)
      if (mine !== generation) return
      if (reply.status === 401) {
        await $.store.delete('account')
        await update($, online, (x): Online => ({ ...x, view: null, link: 'off', error: 'The server no longer knows this username; pick one again.' }))
        return
      }
      if (reply.status !== 200) throw new Error(typeof reply.json['error'] === 'string' ? reply.json['error'] : 'HTTP ' + String(reply.status))
      const view = reply.json as unknown as ServerView
      await show($, view)
      next = view.version
    } catch (error) {
      if (mine !== generation) return
      await update($, online, (x): Online => ({ ...x, link: 'error', error: 'Cannot reach ' + server + ': ' + (error instanceof Error ? error.message : 'no answer') }))
      $.clock.after(RETRY_MS, () => { void loop(-1) })
      return
    }
    $.clock.after(0, () => { void loop(next) })
  }
  await loop(-1)
}

export function stopPolling(): void { generation++ }

/** Sends one action and shows the server's answer at once, without waiting for the poll. */
async function send($: EngineInterface, action: Record<string, unknown>): Promise<string> {
  const me = await account($)
  if (me === null) return say($, 'Pick a username first.')
  await update($, online, (x): Online => ({ ...x, pending: true }))
  try {
    const reply = await call($, 'POST', '/v1/action', me.token, action)
    if (reply.status !== 200) return await say($, typeof reply.json['error'] === 'string' ? reply.json['error'] : 'HTTP ' + String(reply.status))
    const state = await call($, 'GET', '/v1/state', me.token)
    if (state.status === 200) await show($, state.json as unknown as ServerView)
    await say($, '')
    return 'Done.'
  } catch (error) {
    return await say($, 'Cannot reach ' + server + ': ' + (error instanceof Error ? error.message : 'no answer'))
  } finally {
    await update($, online, (x): Online => ({ ...x, pending: false }))
  }
}

async function say($: EngineInterface, message: string): Promise<string> {
  await update($, online, (x): Online => ({ ...x, message }))
  return message
}

async function register($: EngineInterface, name: string): Promise<string> {
  if (!NAME.test(name)) return say($, 'Usernames are 3 to 20 letters, digits, _ or -.')
  try {
    const reply = await call($, 'POST', '/v1/register', null, { name })
    if (reply.status !== 200) return await say($, typeof reply.json['error'] === 'string' ? reply.json['error'] : 'HTTP ' + String(reply.status))
    const token = reply.json['token']
    const chosen = reply.json['name']
    if (typeof token !== 'string' || typeof chosen !== 'string') return await say($, 'The server did not return a token.')
    const saved: Account = { server, name: chosen, token }
    await $.store.set('account', saved)
    await say($, 'You are ' + chosen + '.')
    void startPolling($)
    return 'You are ' + chosen + '.'
  } catch (error) {
    return await say($, 'Cannot reach ' + server + ': ' + (error instanceof Error ? error.message : 'no answer'))
  }
}

export async function goOnline($: EngineInterface): Promise<string> {
  await update($, online, (x): Online => ({ ...x, mode: 'online', message: '' }))
  const me = await account($)
  if (me === null) return 'Pick a username to play online.'
  void startPolling($)
  return 'Online as ' + me.name + '.'
}

export async function goOffline($: EngineInterface): Promise<string> {
  stopPolling()
  await update($, online, (x): Online => ({ ...x, mode: 'local', link: 'off' }))
  return 'Back to the engine game.'
}

/** True while an online game is being played: Claude's tools stay out of it. */
export async function inOnlineGame($: EngineInterface): Promise<boolean> {
  const state = await read($, online)
  return state.mode === 'online' && state.view?.game !== null && state.view?.game !== undefined && state.view.game.result === null
}

/** A command from the move field, a menu button or the board, in online mode. */
export async function onlineAct($: EngineInterface, input: string): Promise<string> {
  const text = input.trim()
  const lower = text.toLowerCase()
  if (lower === 'offline' || lower === 'local' || lower === 'engine game') return goOffline($)
  const me = await account($)
  if (me === null) return register($, lower.startsWith('name ') ? text.slice(5).trim() : text)
  const state = await read($, online)
  if (state.pending) return 'Still sending the last action.'
  const [word = '', ...rest] = lower.split(/\s+/)
  const target = text.split(/\s+/).slice(1).join(' ')
  if (word === 'retry' || word === 'online') { void startPolling($); return 'Reconnecting.' }
  if (word === 'queue' || word === 'play' || word === 'anyone') return send($, { type: 'queue' })
  if (word === 'unqueue' || word === 'cancel') { await send($, { type: 'unqueue' }); return send($, { type: 'cancel' }) }
  if ((word === 'challenge' || word === 'accept' || word === 'decline') && rest.length > 0) return send($, { type: word, name: target })
  if (word === 'resign') return send($, { type: 'resign' })
  if (word === 'draw') return send($, { type: 'draw' })
  if (word === 'lobby' || word === 'leave' || word === 'new') return send($, { type: 'leave' })
  if (UCI.test(lower)) return send($, { type: 'move', uci: lower })
  if (word === 'undo' || word === 'hint') return say($, 'No ' + (word === 'undo' ? 'takebacks' : 'hints') + ' in online games.')
  return say($, 'Online commands: a move (e2e4), play, cancel, challenge <name>, accept <name>, decline <name>, resign, draw, lobby, offline.')
}

function standing(wins: number, losses: number, draws: number): string {
  return String(wins) + ' W · ' + String(losses) + ' L · ' + String(draws) + ' D'
}

function reasonText(game: ServerGame): string {
  if (game.result === null) return ''
  const winner = game.result === 'draw' ? null : game.result === 'white' ? game.white : game.black
  const how = (game.reason ?? '').replace(/-/g, ' ')
  const verdict = winner === null ? 'Draw' : (winner === (game.you === 'white' ? game.white : game.black) ? 'You won' : winner + ' won')
  return verdict + ' by ' + how + (game.rated ? '.' : ' (too short to count for the high scores).')
}

/** The board's props for an online game: the position from the server, the player's side, and what to say. */
export function gameProps(game: ServerGame, pending: boolean, message: string): Record<string, unknown> {
  const live = ChessSession.restore({ start: game.start, moves: game.moves, player: game.you, level: 1, claimed: false })
  const view = live.view()
  const opponent = game.you === 'white' ? game.black : game.white
  const yourTurn = view.playerTurn
  const status = game.result !== null
    ? reasonText(game)
    : (yourTurn ? 'Your move' : opponent + ' to move') + (view.status.includes('check') ? ' (check)' : '') +
      (game.opponentOnline ? '.' : '. ' + opponent + ' is offline: they lose after 10 minutes away.')
  return {
    ...view,
    playerTurn: yourTurn && game.result === null && !pending,
    over: game.result !== null,
    status,
    heading: 'Online · ' + game.white + ' (White) vs ' + game.black + ' (Black)',
    online: true,
    thinking: false,
    message,
    hint: null,
    stats: '',
  }
}

/** The lobby, the username form, or the connection state; the board itself is drawn by the caller. */
export function lobbyTree(elements: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>, state: Online, name: string | null, run: (command: string) => () => void) {
  const { Box, Text, Button } = elements
  if (name === null) {
    return (
      <Box flexDirection="column">
        <Text bold>Play online</Text>
        <Text>Pick a username (3 to 20 letters, digits, _ or -). No password: this computer keeps it for you.</Text>
        <Text dimColor>Server: {server}</Text>
        {state.message !== '' && <Text color="warning">{state.message}</Text>}
        {state.error !== '' && <Text color="warning">{state.error}</Text>}
      </Box>
    )
  }
  const view = state.view
  if (view === null) {
    return (
      <Box flexDirection="column">
        <Text bold>Online as {name}</Text>
        <Text color={state.link === 'error' ? 'warning' : undefined}>{state.link === 'error' ? state.error : 'Connecting to ' + server + '…'}</Text>
        {state.link === 'error' && <Box marginTop={1}><Button key="retry" label="Retry" onPress={run('retry')} /></Box>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>Online as {view.me.name} · {standing(view.me.wins, view.me.losses, view.me.draws)}</Text>
      {state.link === 'error' && <Text color="warning">{state.error}</Text>}
      {state.message !== '' && <Text color="warning">{state.message}</Text>}
      <Box marginTop={1} flexDirection="row" columnGap={1}>
        {view.queued
          ? <Button key="cancel" label="Stop waiting" onPress={run('cancel')} />
          : <Button key="queue" label="Play anyone" variant="primary" onPress={run('play')} />}
        {view.queued && <Text color="suggestion">Waiting for an opponent…</Text>}
      </Box>
      {view.incoming.map(from => (
        <Box key={'in:' + from} flexDirection="row" columnGap={1} marginTop={1}>
          <Text bold>{from} challenges you</Text>
          <Button key={'accept:' + from} label="Accept" variant="primary" onPress={run('accept ' + from)} />
          <Button key={'decline:' + from} label="Decline" onPress={run('decline ' + from)} />
        </Box>
      ))}
      {view.outgoing !== null && (
        <Box flexDirection="row" columnGap={1} marginTop={1}>
          <Text>Waiting for {view.outgoing} to accept</Text>
          <Button key="withdraw" label="Withdraw" onPress={run('cancel')} />
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Online now</Text>
        {view.online.length === 0 && <Text dimColor>Nobody else right now. Play anyone waits for the next player.</Text>}
        {view.online.map(player => player.status === 'playing'
          ? <Text key={'p:' + player.name} dimColor>{player.name} · playing</Text>
          : <Button key={'ch:' + player.name} plain label={'Challenge ' + player.name + (player.status === 'queued' ? ' (waiting)' : '')} onPress={run('challenge ' + player.name)} />)}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>High scores</Text>
        {view.leaderboard.length === 0 && <Text dimColor>No finished games yet. Games of 10 or more half-moves count.</Text>}
        {view.leaderboard.map((row, index) => (
          <Text key={'hs:' + row.name} bold={row.name === view.me.name}>
            {String(index + 1).padStart(2, ' ')}. {row.name.padEnd(20, ' ')} {standing(row.wins, row.losses, row.draws)}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
