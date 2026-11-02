import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'chess',
  component: 'Pane',
  requestId: 'chess',
  surface: 'terminal',
  props: {
    title: 'Chess',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const CURSOR = '#3f7fd0'
const SELECTED = '#5b8fcf'

test('keys select and play a move, then the engine replies', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'chess' } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__chess__' + e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 40, in: 'board' })

  // The cursor starts on e2; Enter selects it and marks its targets.
  expect((await ui.find({ key: 'e2', in: 'board' }))?.props['backgroundColor']).toBe(CURSOR)
  await ui.key({ key: 'return', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  expect((await ui.find({ key: 'e2', in: 'board' }))?.props['backgroundColor']).toBe(SELECTED)
  expect((await ui.find({ key: 'e4', in: 'board' }))?.props['backgroundColor']).toBe(CURSOR)
  await ui.key({ key: 'return', in: 'board' })

  expect(await ui.find({ type: 'Text', text: /Engine is thinking/, in: 'board' })).toBeDefined()
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /^1\. e2e4 \S+$/, in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /White to move \(you\)/, in: 'board' })).toBeDefined()

  // The model's tools see the same game.
  const shown = await $.tool.call({ tool: 'mcp__chess__chess_show' })
  expect(shown.text ?? JSON.stringify(shown.result)).toContain('1. e2e4')

  // Undo takes back both plies.
  await ui.key({ key: 'u', in: 'board' })
  expect(await ui.find({ type: 'Text', text: /No moves yet/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

test('clicking squares plays a move', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 40, in: 'board' })
  // Largest squares are 7x3 after a 2-column rank label: g1 is column 6, row 7; f3 is column 5, row 5.
  await ui.pointer({ type: 'down', x: 2 + 6 * 7 + 3, y: 7 * 3 + 1, in: 'board' })
  await ui.pointer({ type: 'down', x: 2 + 5 * 7 + 3, y: 5 * 3 + 1, in: 'board' })
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /^1\. g1f3 \S+$/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane still draws the board with small squares', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 40, rows: 20, in: 'board' })
  expect((await ui.find({ key: 'a1', in: 'board' }))?.props['width']).toBe(3)
  await ui.unmount()
})

test('the board says when it has the keys, and fills a large pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false } })
  await ui.resize({ columns: 100, rows: 40, in: 'board' })
  expect((await ui.find({ key: 'a1', in: 'board' }))?.props['width']).toBe(7)
  // Large squares draw block-pixel pieces: three rows per square, the rook's battlements on top.
  const rook = await ui.findAll({ type: 'Text', text: '█▄█▄█', in: 'board' })
  expect(rook.length).toBe(4)
  await ui.key({ key: 'g', in: 'board' })
  expect((await ui.findAll({ type: 'Text', text: /^R$/, in: 'board' })).length).toBe(2)
  await ui.key({ key: 'g', in: 'board' })
  expect(await ui.find({ type: 'Text', text: /Click the board, or ctrl\+x tab/, in: 'board' })).toBeDefined()
  await ui.redraw({ ...PANE.props, isFocused: true })
  await ui.pointer({ type: 'down', x: 2 + 4 * 7 + 3, y: 6 * 3 + 1, in: 'board' })
  expect(await ui.find({ type: 'Text', text: /Board has the keys/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

test('/chess e2e4 plays from the prompt', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'chess' } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__chess__' + e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'chess', args: 'e2e4', ...TYPED })
  expect(JSON.stringify(ran)).toContain('Played e2e4')
  await clock.advance(100)
  const shown = await $.tool.call({ tool: 'mcp__chess__chess_show' })
  expect(shown.text ?? JSON.stringify(shown.result)).toMatch(/1\. e2e4 [a-h][1-8][a-h][1-8]/)
  const bad = await $.command.run({ command: 'chess', args: 'e2e5', ...TYPED })
  expect(JSON.stringify(bad)).toContain('Illegal move')
})

function result(stdout: string, exitCode = 0) {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

test('without a local build, the Perry engine is downloaded from npm, verified, and used', async ($, on) => {
  const clock = mock.clock(on)
  const hex = '00ff10'.repeat(21) + '7f'  // a stand-in sha512; its base64 is the integrity the registry reports
  const integrity = 'sha512-AP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8QAP8Qfw=='
  const cache = '/home/t/.cache/tuichess/engine/0.1.3'
  let unpacked = false
  const calls: string[] = []
  on('http.fetch', (_, e) => {
    calls.push('fetch ' + e.url)
    const body = { version: '0.1.3', dist: { tarball: 'https://registry.npmjs.org/tuichess-darwin-arm64/-/tuichess-darwin-arm64-0.1.3.tgz', integrity } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('process.run', (_, e) => {
    const [cmd = '', ...args] = e.argv
    calls.push(e.argv.join(' '))
    if (cmd === 'uname') return result('Darwin arm64\n')
    if (cmd === 'printenv') return args[0] === 'HOME' ? result('/home/t\n') : result('', 1)
    if (cmd === 'ls') return result('', 1)
    if (cmd === 'sha512sum') return result(hex + '  ' + cache + '/package.tgz\n')
    if (cmd === 'tar') { unpacked = true; return result('') }
    if (cmd === 'mkdir' || cmd === 'curl' || cmd === 'rm') return result('')
    if (cmd === cache + '/package/bin/tuichess') {
      if (args[0] === '--help') return unpacked ? result('Usage: tuichess\n') : { deny: 'no such file' }
      return result('{"move":"d7d5","claimDraw":false,"score":3,"depth":5,"nodes":40000,"line":["d7d5"],"completed":true,"ms":11}\n')
    }
    return { deny: 'no such file' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 40, in: 'board' })
  // The first move: no engine binary yet, so the built-in engine replies and the download starts.
  await ui.input({ key: 'move', text: 'e2e4' })
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /not here yet/, in: 'board' })).toBeDefined()
  await clock.advance(1000)
  expect(calls).toContain('fetch https://registry.npmjs.org/tuichess-darwin-arm64/latest')
  expect(calls).toContain('curl -fsSL --max-time 120 -o ' + cache + '/package.tgz https://registry.npmjs.org/tuichess-darwin-arm64/-/tuichess-darwin-arm64-0.1.3.tgz')
  expect(calls).toContain('tar -xzf ' + cache + '/package.tgz -C ' + cache)
  // From then on the downloaded Perry engine plays.
  await ui.input({ key: 'move', text: 'd2d4' })
  await clock.advance(100)
  expect(calls).toContain(cache + '/package/bin/tuichess move')
  expect(await ui.find({ type: 'Text', text: /^Perry native · depth 5/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

test('a download that fails its checksum is discarded', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: '0.1.3', dist: { tarball: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-AAAA' } }) } }))
  on('process.run', (_, e) => {
    calls.push(e.argv.join(' '))
    if (e.argv[0] === 'uname') return result('Linux x86_64\n')
    if (e.argv[0] === 'printenv') return e.argv[1] === 'HOME' ? result('/home/t\n') : result('', 1)
    if (e.argv[0] === 'sha512sum') return result('ffff  file\n')
    if (['mkdir', 'curl', 'rm', 'ls'].includes(e.argv[0] ?? '')) return result('')
    return { deny: 'no such file' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'move', text: 'e2e4' })
  await clock.advance(1500)
  expect(calls).toContain('rm -rf /home/t/.cache/tuichess/engine/0.1.3')
  expect(calls.some(call => call.startsWith('tar '))).toBe(false)
  await ui.unmount()
})

test('the Perry engine answers engine moves, and its stats show', async ($, on) => {
  const clock = mock.clock(on)
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.argv[0] === 'uname') return result('Darwin arm64\n')
    if (e.argv[1] === '--help') return result('Usage: chess-engine move | mcp\n')
    return result('{"move":"e7e5","claimDraw":false,"score":12,"depth":4,"nodes":12785,"line":["e7e5","g1f3"],"completed":true,"ms":9}\n')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 40, in: 'board' })
  await ui.key({ key: 'return', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'return', in: 'board' })
  await clock.advance(100)

  const engine = calls.find(call => call.argv[1] === 'move')
  expect(engine?.argv[0]).toMatch(/\/bin\/chess-engine-darwin-arm64$/)
  expect(JSON.parse(engine?.stdin ?? '{}')).toEqual({ start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4'], level: 5 })
  expect(await ui.find({ type: 'Text', text: /^1\. e2e4 e7e5$/, in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Perry native · depth 4 · 12,785 nodes · 9 ms', in: 'board' })).toBeDefined()

  // e switches to the built-in engine, which needs no process.
  await ui.key({ key: 'e', in: 'board' })
  expect(await ui.find({ type: 'Text', text: 'built-in JS', in: 'board' })).toBeDefined()
  const before = calls.length
  await ui.key({ key: 'h', in: 'board' })
  expect(calls.length).toBe(before)
  expect(await ui.find({ type: 'Text', text: /^built-in JS · depth/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

test('without a native binary the built-in engine plays and says so', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', (_, e) => (e.argv[0] === 'uname' ? result('Linux riscv64\n') : { deny: 'no such file' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 100, rows: 40, in: 'board' })
  await ui.pointer({ type: 'down', x: 2 + 4 * 7 + 3, y: 6 * 3 + 1, in: 'board' })
  await ui.pointer({ type: 'down', x: 2 + 4 * 7 + 3, y: 4 * 3 + 1, in: 'board' })
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /^1\. e2e4 \S+$/, in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'built-in JS (Perry not downloaded yet)', in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not here yet .*the built-in engine played/, in: 'board' })).toBeDefined()
  await ui.unmount()
})

test('the menu and the move field play without the board having focus', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const inline = { ...PANE, props: { ...PANE.props, placement: 'inline', isFocused: true } } as const
  const ui = await $.ui.mount(inline)
  await ui.resize({ columns: 100, rows: 30, in: 'board' })
  expect(await ui.find({ type: 'Text', text: /Type a move below/, in: 'board' })).toBeDefined()

  await ui.input({ key: 'move', text: 'e2e4' })
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /^1\. e2e4 \S+$/, in: 'board' })).toBeDefined()

  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Text', text: /No moves yet/, in: 'board' })).toBeDefined()
  await ui.press({ key: 'harder' })
  expect(await ui.find({ type: 'Text', text: /level 6 \(Advanced\)/, in: 'board' })).toBeDefined()
  await ui.input({ key: 'move', text: 'level 2' })
  expect(await ui.find({ type: 'Text', text: /level 2 \(Beginner\)/, in: 'board' })).toBeDefined()
  await ui.press({ key: 'flip' })
  expect(await ui.find({ type: 'Text', text: /h {2,}g {2,}f/, in: 'board' })).toBeDefined()
  await ui.press({ key: 'hint' })
  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /^Hint: /, in: 'board' })).toBeDefined()
  await ui.input({ key: 'move', text: 'banana' })
  expect(await ui.find({ type: 'Text', text: /Unknown: "banana"/, in: 'board' })).toBeDefined()
  await ui.unmount()
})
