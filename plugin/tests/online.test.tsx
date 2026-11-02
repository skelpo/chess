import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { Lobby, parseAction } from './lobby.ts'
import type { User } from './lobby.ts'

const PANE = {
  plugin: 'chess',
  component: 'Pane',
  requestId: 'chess',
  surface: 'terminal',
  props: { title: 'Chess', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The real lobby behind a fake network: polls are held until the lobby's version moves, as the server does. */
function server(on: On) {
  const lobby = new Lobby()
  const now = 1_000_000
  let tokens = 0
  let waiting: (() => void)[] = []
  const wake = () => { const all = waiting; waiting = []; for (const resolve of all) resolve() }
  const reply = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const body = typeof e.init?.body === 'string' ? JSON.parse(e.init.body) as Record<string, unknown> : null
    const auth = (e.init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
    if (url.pathname === '/v1/register') {
      const result = lobby.register(String(body?.['name']), 'token' + String(++tokens), now)
      wake()
      return result.ok ? reply(200, result.value) : reply(result.status, { error: result.error })
    }
    const user = lobby.authenticate(auth.replace('Bearer ', ''), now)
    if (user === null) return reply(401, { error: 'Unknown token' })
    if (url.pathname === '/v1/state') {
      const since = Number(url.searchParams.get('since') ?? '-1')
      while (lobby.version <= since) await new Promise<void>(resolve => waiting.push(resolve))
      return reply(200, lobby.view(user, now))
    }
    const action = parseAction(body)
    if (action === null) return reply(400, { error: 'Unknown action.' })
    const result = lobby.act(user, action, now)
    wake()
    return result.ok ? reply(200, { ok: true }) : reply(result.status, { error: result.error })
  })
  /** Another player, acting on the lobby directly. */
  const other = (name: string): User => {
    lobby.register(name, 'other-' + name, now)
    return lobby.authenticate('other-' + name, now) as User
  }
  const act = (user: User, action: Parameters<Lobby['act']>[1]) => { const result = lobby.act(user, action, now); wake(); return result }
  return { lobby, other, act }
}

test('pick a username, get paired, play, and Claude stays out of the game', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'chess' } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__chess__' + e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const net = server(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 30, in: 'board' })

  await ui.press({ key: 'online' })
  expect(await ui.find({ type: 'Text', text: /Pick a username/ })).toBeDefined()
  await ui.input({ key: 'move', text: 'x' })
  expect(await ui.find({ type: 'Text', text: /3 to 20 letters/ })).toBeDefined()
  net.other('Taken')
  await ui.input({ key: 'move', text: 'taken' })
  expect(await ui.find({ type: 'Text', text: /That username is taken/ })).toBeDefined()
  await ui.input({ key: 'move', text: 'Dana' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /Online as Dana · 0 W · 0 L · 0 D/ })).toBeDefined()

  // Eli waits in the queue; Dana sees it and presses Play anyone.
  const eli = net.other('Eli')
  net.act(eli, { type: 'queue' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Button', key: 'ch:Eli' })).toBeDefined()
  await ui.press({ key: 'queue' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Online · Eli (White) vs Dana (Black)', in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Eli to move/, in: 'board' })).toBeDefined()

  // Eli's move arrives through the held poll; Dana answers from the move field.
  net.act(eli, { type: 'move', uci: 'e2e4' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /Your move/, in: 'board' })).toBeDefined()
  await ui.input({ key: 'move', text: 'e7e5' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /^1\. e2e4 e7e5$/, in: 'board' })).toBeDefined()
  await ui.input({ key: 'move', text: 'd7d5' })
  expect(await ui.find({ type: 'Text', text: /It is not your turn/, in: 'board' })).toBeDefined()

  const denied = await $.tool.call({ tool: 'mcp__chess__chess_show' })
  expect(JSON.stringify(denied)).toContain('Claude stays out of it')

  await ui.press({ key: 'resign' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /Eli won by resignation \(too short/, in: 'board' })).toBeDefined()
  await ui.press({ key: 'lobby' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /No finished games yet/ })).toBeDefined()

  // Challenges both ways, and the engine game is one press away.
  net.act(eli, { type: 'leave' })
  net.act(eli, { type: 'challenge', name: 'Dana' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Eli challenges you' })).toBeDefined()
  await ui.press({ key: 'decline:Eli' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: 'Eli challenges you' })).toBeUndefined()
  await ui.press({ key: 'ch:Eli' })
  await clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /Waiting for Eli to accept/ })).toBeDefined()
  await ui.press({ key: 'offline' })
  expect(await ui.find({ type: 'Button', key: 'new' })).toBeDefined()
  await ui.unmount()
})
