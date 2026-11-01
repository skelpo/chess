# Plain TypeScript Chess

Two projects, zero runtime packages:

- [`engine/src/chess.ts`](engine/src/chess.ts): a standalone computing engine. Copy this one file into another project. It imports nothing and uses no I/O, clocks, randomness, Node globals, or external data.
- [`tui/src`](tui/src): an ANSI terminal interface with keyboard selection, typed moves, computer opponents, and local two-player play. Only the entry point uses host APIs: `process` and timers.

All source, tooling and tests are TypeScript. Imports are static. There is no `any`, `eval`, generated code, reflection, dynamic import, runtime plugin loading, JavaScript fallback, or dependency on a chess library. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and the other checks in `tsconfig.json` are enabled. The engine is also checked without Node or DOM types.

## Play

From this directory:

```sh
# Node with native TypeScript support (22.18+)
node tui/src/main.ts --level 5

# Bun
bun tui/src/main.ts --level 5

# Perry: compile directly to a native binary
npm install
npm run build:perry
./dist/chess --level 5
```

Node and Bun can run the source without installing packages. `npm install` installs TypeScript and Node type definitions for development; there are no production npm dependencies. Perry must already be installed. Builds use Perry's strict configuration and no JavaScript runtime fallback.

For ordinary compiled JavaScript output:

```sh
npm install
npm run build
node dist/tui/src/main.js
```

Options:

| Option | Purpose |
| --- | --- |
| `--level 1..10` | Computer difficulty; default 5 |
| `--side white\|black\|both` | Your color, or local two-player; default white |
| `--fen "<FEN>"` | Start from a custom position |
| `--plain` | Line input, no screen control or colors |
| `--no-color` | Keep interactive controls with uncolored output |
| `--unicode` | Use chess glyphs; ASCII pieces are the portable default |
| `--help` | Print command-line help |

Pipes and `TERM=dumb` automatically select plain mode. `NO_COLOR` disables colors. Interactive mode uses the alternate screen, restores terminal settings on exit, and handles resize events. A terminal of at least 40 columns and 26 rows is recommended; the side panel moves below the board below 78 columns. White pieces are uppercase, black pieces lowercase.

Use arrows to move the cursor and Space or Enter to select a piece and destination. Legal destinations are highlighted. Promotion asks for `q`, `r`, `b`, or `n`; Escape cancels selection or input. You can instead type a coordinate move such as `e2e4` or `a7a8n` and press Enter.

| Command | Action |
| --- | --- |
| `undo` | Take back your move and the computer's reply, or one move in local mode |
| `hint` | Search for a suggested move without playing it |
| `level 1..10` | Change the computer's difficulty |
| `side white`, `side black`, `side both` | Change sides or enter local mode |
| `new` | Restart the initial position, including the last loaded FEN |
| `flip` | Rotate the board |
| `fen` | Show the current position |
| `load <FEN>` | Load a validated position and clear history |
| `moves`, `moves e2` | List all legal moves, or moves from one square |
| `draw`, `draw f6g8` | Claim an eligible draw, optionally announcing a move |
| `help` | Toggle in-game help |
| `quit` | Exit; Ctrl-C and Ctrl-D also exit |

Moves use UCI **coordinate notation**, including `e1g1` for castling. This is not a UCI protocol server or a SAN/PGN parser.

## Use the engine

```ts
import { Chess } from "./engine/src/chess.ts";

const game = new Chess();
const played = game.play("e2e4"); // Move | null; null means illegal or game over
const reply = game.search({ level: 7 });

if (reply.claimDraw) {
  game.claimDraw();
} else if (reply.move !== null) {
  game.play(reply.move.uci);
}

const position = game.fen();
const outcome = game.status();
const available = game.legalMoves();
game.undo();
```

The engine file itself contains **no imports**. The example import belongs to the consumer. Its exported types include `Color`, `Piece`, `Move`, `Level`, `SearchOptions`, `SearchResult`, and `GameStatus`.

| API | Contract |
| --- | --- |
| `new Chess(fen?)` | Standard starting position or a validated six-field FEN |
| `load(fen)` | Replace position atomically; invalid FEN throws and leaves the old game intact |
| `fen()` / `turn()` / `pieceAt("e4")` | Position access; invalid square names throw |
| `legalMoves()` | Detached legal move objects, including special-move flags |
| `play("e2e4")` | Validate and play; promotion suffix is required |
| `undo()` / `history()` | Undo one ply; retrieve a detached coordinate move history |
| `inCheck()` / `status()` | Check, game outcome, and currently available draw claims |
| `claimDraw(intendedMove?)` | Claim now or with an announced legal move; announced move is not played |
| `evaluate()` | Static centipawn evaluation from the side to move |
| `search(options?)` | Synchronous search without changing the game |
| `perft(depth)` | Count legal move sequences at depth 0–8, ignoring game-ending draw rules |
| `levelSettings(level)` / `parseLevel(number)` | Read a preset or validate a numeric level |

`legalMoves()` is a position-level query and remains available after an adjudicated draw; `play()` enforces the game outcome. `undo()` also clears a claimed draw. Loading FEN clears move and repetition history: FEN cannot encode earlier repetitions.

Search returns the selected move, score, completed depth, visited nodes, principal variation and a draw-claim decision. A positive score favors the side that was to move before search. Mate scores approach ±30,000; shorter wins and longer losses are preferred. Search never mutates the game position or its history. If the node budget expires during an iteration, the last completed iteration is returned. A budget too small for depth one returns a legal fallback with depth zero and a static position score. `completed` means the search stopped normally rather than exhausting its node budget.

```ts
const result = game.search({ level: 10, maxDepth: 8, maxNodes: 250_000 });
```

The budget counts alpha-beta and quiescence nodes, not every generated move. It is deterministic, not a wall-clock limit. The caller controls scheduling; large searches block the calling thread. An embedding application can put the engine in its own worker. Independent `Chess` instances share no mutable state.

## Difficulty and design

| Level | Name | Maximum depth | Node budget | Inaccuracy (centipawns) |
| --- | --- | ---: | ---: | ---: |
| 1 | Kids | 1 | 300 | 650 |
| 2 | Beginner | 2 | 1,000 | 350 |
| 3 | Learner | 2 | 3,000 | 180 |
| 4 | Casual | 3 | 8,000 | 90 |
| 5 | Club | 4 | 20,000 | 40 |
| 6 | Advanced | 5 | 50,000 | 15 |
| 7 | Expert | 6 | 120,000 | 0 |
| 8 | Challenger | 7 | 300,000 | 0 |
| 9 | Elite | 8 | 700,000 | 0 |
| 10 | Master | 10 | 1,500,000 | 0 |

These are difficulty presets, **not measured Elo ratings**. Level 10 is the strongest configuration; master-level playing strength is not yet established by tournament testing. Lower levels use shallower searches and a deterministic positional handicap to make mistakes without a random-number service. Increasing levels increases resources and reduces handicaps, but does not guarantee a better move in every position.

The engine uses a 0x88 mailbox board, incremental make/unmake, two 32-bit Zobrist hashes, iterative deepening, negamax alpha-beta, quiescence with check evasions, a bounded transposition table, capture ordering, killer moves and history ordering. The table identity includes reversible-history context and the halfmove clock to avoid reusing scores across ordinary draw-context differences. Hashing has the usual theoretical collision risk. Evaluation covers material, piece placement, pawn structure, passed pawns, bishop pairs, rook files and tapered king safety. There is no opening book, neural model, tablebase, or external engine.

The rule layer covers check, mate, stalemate, pins, castling, en passant, all promotions, standard insufficient-material draws, threefold/fifty-move claims, and automatic fivefold/seventy-five-move draws. Mate takes precedence over the seventy-five-move limit. Repetition ignores en passant targets unless a legal en passant capture exists. Draw claims are explicit, following the distinction in [FIDE articles 9.2–9.6](https://handbook.fide.com/chapter/e012023).

Limitations: orthodox chess only; no Chess960, clocks, resignation/agreement protocol, SAN/PGN, or general proof of every dead position (such as permanently locked pawn structures). FEN validation checks structure and basic legality, not retrograde reachability. These are computation and terminal projects, not a tournament arbiter.

## Verify

```sh
npm run check          # strict types, including engine without ambient runtime types
npm test               # engine and UI logic under Node
npm run test:bun       # identical suite under Bun
npm run test:perry     # compile and run identical suite natively
npm run build          # JavaScript + declarations + source maps
npm run build:perry    # native terminal executable
npm run test:integration # compare CLI output across runtimes; build both outputs first
npm run verify        # all of the above
```

The suite includes six [reference perft positions](https://www.chessprogramming.org/Perft_Results), special-move edge cases, draw claims, invalid FEN rollback, a 160-ply make/unmake exercise, mating search, all ten levels, hard budget limits, principal variation legality, deterministic search, and terminal interaction logic.

Verified on macOS ARM64 with Node 26.5.1, Bun 1.3.14, and Perry 0.5.1663: 875 shared assertions and identical deterministic fingerprints. Integration checks compare source Node, Bun, native Perry, and compiled Node output, including the full level-10 opening search. Pseudo-terminal checks also verified raw input, computer replies, undo, Ctrl-C, screen restoration and restoration of the original terminal modes on all three runtimes. Other operating systems have not been exercised here. Perry compatibility uses the global `process` binding and a signed-safe handicap calculation; it does not select a different implementation at runtime.
