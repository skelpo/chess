import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { View } from '../lib/session.ts'
import type { Extras } from '../types'
import type { Clocks } from './online.tsx'

type Props = View & Extras & {
  room: { columns: number; rows: number; focused: boolean; docked: boolean }
  /** Replaces the level line, as for an online game. */
  heading: string
  /** An online game: no engine line. */
  online: boolean
  /** Both players' clocks in an online game; null or missing for untimed and engine games. */
  clocks?: Clocks | null
}
type Local = {
  cursor: number
  selected: number | null
  promotion: { from: number; to: number } | null
  letters: boolean
  /** A click or key reached this board since the pane last took the keyboard. */
  engaged: boolean
}

const FILES = 'abcdefgh'
const GLYPHS: Readonly<Record<string, string>> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
// Mid-tone squares keep both white and black pieces at roughly 3:1 contrast or better.
const COLORS = {
  light: '#ad8e62',
  dark: '#8a6a43',
  lastLight: '#b5a048',
  lastDark: '#968332',
  targetLight: '#86a556',
  targetDark: '#6c8a40',
  selected: '#5b8fcf',
  cursor: '#3f7fd0',
  hint: '#6f95cf',
  check: '#c8423a',
  whitePiece: '#ffffff',
  blackPiece: '#1a1a1a',
}
/** 7x6 pixel pieces for the largest squares, drawn two pixels per cell with half blocks. */
const SPRITES: Readonly<Record<string, readonly string[]>> = {
  p: ['.......', '.......', '...#...', '..###..', '...#...', '.#####.'],
  n: ['..##...', '.####..', '##.###.', '...###.', '..####.', '.#####.'],
  b: ['...#...', '..###..', '.##.##.', '..###..', '...#...', '.#####.'],
  r: ['.#.#.#.', '.#####.', '..###..', '..###..', '.#####.', '.#####.'],
  q: ['#.#.#.#', '.#####.', '..###..', '..###..', '.#####.', '.#####.'],
  k: ['...#...', '..###..', '...#...', '.#####.', '.#####.', '.#####.'],
}
function spriteRows(piece: string): string[] {
  const pixels = SPRITES[piece] ?? []
  const rows: string[] = []
  for (let row = 0; row < 6; row += 2) {
    let line = ''
    for (let column = 0; column < 7; column++) {
      const top = pixels[row]?.charAt(column) === '#'
      const bottom = pixels[row + 1]?.charAt(column) === '#'
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(line)
  }
  return rows
}
/** Square sizes in cells, largest first; terminal cells are about twice as tall as wide. */
const SIZES = [
  { width: 7, height: 3 },
  { width: 5, height: 2 },
  { width: 3, height: 1 },
] as const
const LABEL = 2
const SIDE_PANEL = 34

function name(index: number): string { return FILES.charAt(index % 8) + String(Math.floor(index / 8) + 1) }
function index(square: string): number { return FILES.indexOf(square.charAt(0)) + (Number(square.charAt(1)) - 1) * 8 }

/** The tail of a long move list, cut at a move number so the panel keeps its height. */
function recent(moves: string): string {
  if (moves.length <= 180) return moves
  const cut = moves.indexOf('. ', moves.length - 180)
  const start = cut < 0 ? moves.length - 180 : moves.lastIndexOf(' ', cut - 1) + 1
  return '… ' + moves.slice(start)
}

function defaults(props: Props): Local {
  return { cursor: index(props.player === 'black' ? 'e7' : 'e2'), selected: null, promotion: null, letters: false, engaged: false }
}

/** Screen row and column of a square, row 0 at the top. */
function toScreen(square: number, flipped: boolean): { row: number; column: number } {
  const file = square % 8
  const rank = Math.floor(square / 8)
  return flipped ? { row: rank, column: 7 - file } : { row: 7 - rank, column: file }
}
function fromScreen(row: number, column: number, flipped: boolean): number {
  return flipped ? row * 8 + (7 - column) : (7 - row) * 8 + column
}

const Board: ClientModule<Props, Local> = (props, surface: ClientSurface<Local>) => {
  const { Box, Text } = surface.elements
  const local = surface.state ?? defaults(props)
  const flipped = (props.player === 'black') !== props.flipped
  // The region is laid out to the pane's body; before the first layout, use the size the pane reported.
  const columns = surface.columns > 0 ? surface.columns : props.room.columns
  const height = surface.rows > 0 ? surface.rows : props.room.rows
  const keysActive = props.room.focused && local.engaged
  const fitsBeside = (size: { width: number }) => columns >= LABEL + size.width * 8 + SIDE_PANEL
  const size = SIZES.find(s =>
    (fitsBeside(s) || columns >= LABEL + s.width * 8) &&
    height >= s.height * 8 + 1 + (fitsBeside(s) ? 0 : 8),
  ) ?? SIZES[SIZES.length - 1] ?? { width: 3, height: 1 }
  const beside = fitsBeside(size)
  const canAct = props.playerTurn && !props.thinking

  const set = (next: Partial<Local>) => surface.setState({ ...local, engaged: true, ...next })
  const from = (square: number) => props.legal.filter(uci => uci.startsWith(name(square)))

  const activate = (square: number) => {
    if (!canAct) return
    if (local.selected !== null && local.selected !== square) {
      const moves = from(local.selected).filter(uci => uci.slice(2, 4) === name(square))
      if (moves.length > 1 || moves.some(uci => uci.length === 5)) {
        set({ cursor: square, promotion: { from: local.selected, to: square } })
        return
      }
      const move = moves[0]
      if (move !== undefined) {
        surface.post({ type: 'move', uci: move })
        set({ cursor: square, selected: null })
        return
      }
    }
    if (local.selected === square) set({ cursor: square, selected: null })
    else set({ cursor: square, selected: from(square).length > 0 ? square : null })
  }

  surface.onKey((key: ClientKeyEvent) => {
    if (local.promotion !== null) {
      if ('qrbn'.includes(key.key) && key.key.length === 1) {
        surface.post({ type: 'move', uci: name(local.promotion.from) + name(local.promotion.to) + key.key })
        set({ selected: null, promotion: null })
      } else set({ promotion: null })
      return
    }
    const at = toScreen(local.cursor, flipped)
    const moveCursor = (dr: number, dc: number) =>
      set({ cursor: fromScreen(Math.min(7, Math.max(0, at.row + dr)), Math.min(7, Math.max(0, at.column + dc)), flipped) })
    switch (key.key) {
      case 'up': moveCursor(-1, 0); break
      case 'down': moveCursor(1, 0); break
      case 'left': moveCursor(0, -1); break
      case 'right': moveCursor(0, 1); break
      case 'return': case ' ': activate(local.cursor); break
      case 'backspace': case 'delete': case 'x': set({ selected: null }); break
      case 'u': surface.post({ type: 'command', text: 'undo' }); set({ selected: null }); break
      case 'n': surface.post({ type: 'command', text: 'new' }); set({ selected: null }); break
      case 'h': surface.post({ type: 'command', text: 'hint' }); break
      case 'f': surface.post({ type: 'command', text: 'flip' }); break
      case 'g': set({ letters: !local.letters }); break
      case '+': case '=': surface.post({ type: 'command', text: 'harder' }); break
      case '-': surface.post({ type: 'command', text: 'easier' }); break
      case 'e': surface.post({ type: 'command', text: 'engine' }); break
    }
  })

  surface.onPointer((event: ClientPointerEvent) => {
    if (event.type !== 'down') return
    if (!local.engaged) set({})
    const column = Math.floor((event.x - LABEL) / size.width)
    const row = Math.floor(event.y / size.height)
    if (column < 0 || column > 7 || row < 0 || row > 7) return
    activate(fromScreen(row, column, flipped))
  })

  const selectedTargets = local.selected === null ? [] : from(local.selected).map(uci => uci.slice(2, 4))
  const lastSquares = props.last === null ? [] : [props.last.slice(0, 2), props.last.slice(2, 4)]
  const hintSquares = props.hint === null ? [] : [props.hint.slice(0, 2), props.hint.slice(2, 4)]

  const squareView = (square: number) => {
    const here = name(square)
    const light = (square % 8 + Math.floor(square / 8)) % 2 === 1
    const letter = props.squares.charAt(square)
    const target = selectedTargets.includes(here)
    let background = light ? COLORS.light : COLORS.dark
    if (lastSquares.includes(here)) background = light ? COLORS.lastLight : COLORS.lastDark
    if (hintSquares.includes(here)) background = COLORS.hint
    if (target) background = light ? COLORS.targetLight : COLORS.targetDark
    if (props.check === here) background = COLORS.check
    if (local.selected === square) background = COLORS.selected
    if (local.cursor === square) background = COLORS.cursor
    const white = letter !== '.' && letter === letter.toUpperCase()
    const pieceColor = white ? COLORS.whitePiece : COLORS.blackPiece
    if (letter !== '.' && !local.letters && size.height === 3) {
      return (
        <Box key={here} width={size.width} height={size.height} backgroundColor={background} flexDirection="column">
          {spriteRows(letter.toLowerCase()).map((line, row) => <Text key={String(row)} color={pieceColor}>{line}</Text>)}
        </Box>
      )
    }
    const glyph = letter === '.'
      ? (target ? '•' : ' ')
      : local.letters ? letter : (GLYPHS[letter.toLowerCase()] ?? letter)
    return (
      <Box key={here} width={size.width} height={size.height} backgroundColor={background} justifyContent="center" alignItems="center">
        <Text bold color={letter === '.' ? COLORS.blackPiece : pieceColor}>{glyph}</Text>
      </Box>
    )
  }

  const rows = []
  for (let row = 0; row < 8; row++) {
    const rank = flipped ? row + 1 : 8 - row
    const cells = []
    for (let column = 0; column < 8; column++) cells.push(squareView(fromScreen(row, column, flipped)))
    rows.push(
      <Box key={'rank' + String(rank)} flexDirection="row" height={size.height}>
        <Box width={LABEL} height={size.height} alignItems="center"><Text dimColor>{String(rank)}</Text></Box>
        {cells}
      </Box>,
    )
  }
  let files = ' '.repeat(LABEL)
  for (let column = 0; column < 8; column++) {
    const file = FILES.charAt(flipped ? 7 - column : column)
    const pad = size.width - 1
    files += ' '.repeat(Math.floor(pad / 2)) + file + ' '.repeat(pad - Math.floor(pad / 2))
  }

  const turnText = props.over
    ? props.status
    : props.thinking ? 'Engine is thinking…' : props.status
  const help = local.promotion !== null
    ? ['Promote to: q queen  r rook  b bishop  n knight']
    : keysActive
      ? ['←↑↓→ move  ⏎/space select', 'u undo  h hint  n new  f flip', 'g pieces/letters  +/- level  e engine']
      : []
  const panel = (
    <Box flexDirection="column" width={beside ? SIDE_PANEL - 2 : undefined} marginLeft={beside ? 2 : 0} marginTop={beside ? 0 : 1}>
      <Text bold wrap="wrap">{props.heading !== '' ? props.heading : 'Chess · level ' + String(props.level) + ' (' + props.levelName + ')'}</Text>
      {props.clocks !== undefined && props.clocks !== null && (['white', 'black'] as const).map(side => {
        const clocks = props.clocks as Clocks
        const running = clocks.running === side
        const low = side === 'white' ? clocks.whiteLow : clocks.blackLow
        return (
          <Text key={'clock:' + side}>
            <Text bold={running} color={running ? (low ? 'error' : 'success') : undefined} dimColor={!running}>{(running ? '▶ ' : '  ') + (side === 'white' ? clocks.white : clocks.black)}</Text>
            <Text dimColor>{'  ' + (side === 'white' ? 'White' : 'Black')}</Text>
          </Text>
        )
      })}
      {props.clocks !== undefined && props.clocks !== null && <Text dimColor>{props.clocks.control + ' · out of time loses'}</Text>}
      <Text color={props.over ? 'warning' : props.thinking ? 'suggestion' : undefined} bold={props.playerTurn || props.over} wrap="wrap">{turnText}</Text>
      {!props.online && <Text>
        <Text dimColor>Engine </Text>
        <Text bold color={props.engine === 'perry' && props.native !== 'missing' ? 'success' : undefined}>
          {props.engine === 'builtin' ? 'built-in JS' : props.native === 'missing' ? 'built-in JS (Perry not downloaded yet)' : 'Perry native'}
        </Text>
      </Text>}
      {props.stats !== '' && <Text dimColor wrap="truncate-end">{props.stats}</Text>}
      {props.message !== '' && <Text color="suggestion" wrap="wrap">{props.message}</Text>}
      <Box marginTop={1}><Text dimColor wrap="wrap">{props.moves === '' ? 'No moves yet.' : recent(props.moves)}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        {keysActive
          ? <Text color="success">● Board has the keys · Esc returns</Text>
          : props.room.focused
            ? <Text color="success">Type a move below, or Tab to the menu</Text>
            : <Text color="warning" bold>{props.room.docked ? 'Click the board, or ctrl+x tab for the menu' : 'ctrl+x tab: type moves below'}</Text>}
        {help.map(line => <Text key={line} dimColor>{line}</Text>)}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection={beside ? 'row' : 'column'}>
      <Box flexDirection="column">
        {rows}
        <Text dimColor>{files}</Text>
      </Box>
      {panel}
    </Box>
  )
}

export default Board
