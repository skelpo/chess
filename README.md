# Plain TypeScript Chess

Two projects, zero runtime packages:

- [`engine/src/chess.ts`](engine/src/chess.ts): a standalone computing engine. Copy this one file into another project. It imports nothing and uses no I/O, clocks, randomness, Node globals, or external data.
- [`tui/src`](tui/src): an ANSI terminal interface with keyboard selection, typed moves, computer opponents, and local two-player play. Only the entry point uses host APIs: `process` and timers.

All source, tooling and tests are TypeScript. Imports are static. There is no `any`, `eval`, generated code, reflection, dynamic import, runtime plugin loading, JavaScript fallback, or dependency on a chess library. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and the other checks in `tsconfig.json` are enabled. The engine is also checked without Node or DOM types.

## Install: `tuichess` on npm

```sh
npm install -g tuichess     # or: npx tuichess
tuichess --level 5          # play the engine
tuichess --online           # play people, with high scores at https://tuichess.dev
tuichess mcp                # the chess tools for AI agents (MCP over stdio)
```

`tuichess` is one native binary per platform, compiled from `tui/src/main.ts` with Perry: macOS (Apple silicon and Intel) and Linux x64/arm64. Intel macOS builds with `PERRY_CODEGEN_UNITS=1`: Perry 0.5.1664 splits large modules into units and then needs a cross-unit subtraction relocation that x86-64 Mach-O can't encode. Windows x64 waits on Perry: the runner's clang 20 can't assemble LLVM 22's `.seh_*epilogue` directives, and `app.ts` hits an `addrspace(256)` IR construction error. The `tuichess` package is a small launcher; npm installs only the matching `tuichess-<os>-<cpu>` package (optional dependencies picked by `os`/`cpu`, the layout Perry's own npm package uses).

**Online in the terminal:** type `online` (or start with `--online`), then a username (3 to 20 letters, digits, `_` or `-`). `play` meets the next player who is waiting; `challenge <name>`, `accept <name>` and `decline <name>` handle challenges; `resign`, `draw` (claim), `lobby` and `offline` do what they say. The account is kept in `~/.config/tuichess/accounts.json` (`$TUICHESS_HOME` overrides; `%APPDATA%\tuichess` on Windows). `--server <url>` or `$TUICHESS_SERVER` picks another server.

**Releases** run in GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)): each platform builds on its own runner with the pinned Perry, then runs the smoke, output-parity, terminal and online tests against its binary. Pushing a tag `vX.Y.Z` publishes all packages to npm with provenance (npm trusted publishing); running the workflow by hand without "publish" only builds. [`scripts/npm-pack.ts`](scripts/npm-pack.ts) lays out the packages from the binaries.

## Codex and opencode

The chess tools (`tuichess mcp`) work in any agent that speaks MCP. The game lives in the chat: the agent shows the board after each move and plays through the tools, never inventing moves.

- **Codex** (plugin with the MCP server and a `chess` skill, [`codex/`](codex)):
  ```sh
  codex plugin marketplace add skelpo/chess
  codex plugin add chess@skelpo-chess
  ```
  Then start a new session and say "let's play chess". The plugin marks the chess tools as approved, since they only touch the game held inside the chess MCP server.
- **opencode:** the MCP server, plus a `/chess` command ([`opencode/commands/chess.md`](opencode/commands/chess.md)):
  ```sh
  mkdir -p ~/.config/opencode/commands
  curl -fsSL https://raw.githubusercontent.com/skelpo/chess/main/opencode/commands/chess.md -o ~/.config/opencode/commands/chess.md
  opencode mcp add chess --global -- npx -y tuichess mcp
  ```
- **Anything else:** run `npx -y tuichess mcp` as a stdio MCP server.

## Play from source

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

## Claude Code plugin

This repository is also a Claude Code plugin marketplace. Install the plugin from inside Claude Code (2.1.316 or later; the board pane uses the plugin hooks API, which is in early access):

```
/plugin install chess --marketplace skelpo/chess
```

On older Claude Code versions, run `/plugin marketplace add skelpo/chess` first, then `/plugin install chess@skelpo-chess`.

Type `/chess` to open the board in a pane beside the chat. **Click the board once** to give it the keyboard (the panel says "Keys active"), then use the arrow keys and Enter or Space to pick a piece and its destination, or click the squares. Until you click, arrow keys go to Claude Code's prompt. Esc hands the keys back to the prompt. Without a mouse, play from the prompt: `/chess e2e4`, `/chess undo`, `/chess hint`.

| Key | Action |
| --- | --- |
| Arrows, Enter/Space | Move the cursor, select, play |
| `q` `r` `b` `n` | Choose a promotion piece |
| Backspace or `x` | Drop the selection |
| `u` / `n` / `h` | Undo, new game, hint |
| `f` / `g` | Flip the board, switch between chess glyphs and letters |
| `+` / `-` | Engine level |

The pane also has a menu (New game, Undo, Hint, Flip, Easier, Harder, Engine, Play online) and a move field that takes moves and the same words. In Claude Code's normal layout the terminal doesn't pass clicks through, so use **ctrl+x tab** to focus the pane and type in the move field, or Tab through the menu. In the fullscreen layout (`/tui fullscreen`) the board docks beside the chat instead of below it, and you can click it and use the arrow keys.

`/chess black 7` starts a new game as Black at level 7, `/chess both` is two-player, and `/chess fen <FEN>` starts from a position. Claude sees the same game through its tools, so you can ask "what should I play here?" or "why was that a mistake?" in the chat, or ask Claude to play moves for you. The game survives plugin reloads within a session. Square size adapts to the pane: 7×3, 5×2 or 3×1 cells per square. The pane needs a terminal with true color for the board colors.

| Claude's tool | Purpose |
| --- | --- |
| `chess_new_game` | New game: `player` white/black/both, `level`, optional `fen` |
| `chess_move` | Play a coordinate move; the engine replies when it has the other side |
| `chess_show` | Board, status, move list, FEN |
| `chess_legal_moves` | All legal moves, or those from one square |
| `chess_hint` | Engine suggestion, evaluation and line, not played (default level 7) |
| `chess_engine_move` | Let the engine move for the side to move |
| `chess_undo` | Take back your move and the engine's reply |
| `chess_claim_draw` | Threefold or fifty-move claim, optionally with an announced move |
| `chess_settings` | Change level or side mid-game |

### Perry native engine

The pane's engine moves and hints come from a native executable compiled by Perry from the same TypeScript: [`cli/src/main.ts`](cli/src/main.ts), built into `plugin/bin/chess-engine-<os>-<arch>` by `npm run build:plugin:engine`. The plugin runs it once per engine move with `$.process.run`. The binary reads `{"start": "<FEN>", "moves": [...], "level": n}` on stdin, prints the move, score, depth, node count, line and time as one line of JSON, and exits. Starting a fresh process per move is practical only because native startup is about 10 ms. The search also runs outside Claude Code's worker, so it never stalls the session. The panel shows which engine answered and how (`Perry native · depth 4 · 12,785 nodes · 278 ms`), and `e` switches to the built-in engine for a direct comparison. Without a binary for the platform, or if it fails, the built-in engine plays and the panel says so.

```sh
echo '{"start":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","moves":["e2e4"],"level":5}' \
  | plugin/bin/chess-engine-darwin-arm64 move
plugin/bin/chess-engine-darwin-arm64 mcp   # the same tools as mcp/src/server.ts, without Node
```

The same binary's `mcp` mode is a stdio MCP server, so other agents can use the engine without Node. `npm run test:mcp` checks that the binary's answers match the source engine's exactly, when the binary is present. Only macOS ARM64 has been built and tested.

### Online play

**Play online** in the pane's menu (or `online` in its move field) connects to a chess server. Pick a username: 3 to 20 letters, digits, `_` or `-`, first come, first served. There's no password; the plugin keeps a random token for the name in its store on this computer. The lobby offers **Play anyone**, which pairs you with the next waiting player (who waited longer plays White), and a list of who's online to **Challenge** by name. Incoming challenges show **Accept** and **Decline**. There are no clocks and no chat. A player who's been gone from a game for 10 minutes loses it. No takebacks or hints online, and Claude's chess tools refuse to touch an online game while it's in progress.

The **high scores** list the top 20 players by wins (then fewer losses, then more draws). Only games of at least 10 half-moves count, so instant resignations don't farm wins. Usernames are free, so someone can still play two of their own accounts against each other; the table is for fun, not a rating.

The hosted server is `https://api.tuichess.dev`, with high scores, install steps and docs at [tuichess.dev](https://tuichess.dev). The URL is the plugin's `server` setting (Claude Code's plugin config); set it to `http://127.0.0.1:8787` to test against a local server.

### Running the server

[`server/src/main.ts`](server/src/main.ts) is the server: HTTP and JSON with long polling, no packages. [`server/src/lobby.ts`](server/src/lobby.ts) holds every rule and validates moves with the engine. Perry compiles it unchanged into one native binary:

```sh
npm run build:server:perry                  # dist/chess-server (about 16 MB)
PORT=8787 HOST=127.0.0.1 CHESS_DATA=/var/lib/chess/data.json ./dist/chess-server
# or without Perry: node server/src/main.ts (Node 22.18+), or bun server/src/main.ts
```

Players, scores and games in progress are saved to `CHESS_DATA` at most once a second, through a temporary file. Tokens are stored in that file as issued, so keep it private. New usernames are limited to 10 per hour per address (the first `X-Forwarded-For` entry behind a proxy). Run it behind an HTTPS reverse proxy that allows requests to stay open longer than 25 seconds, for example with Caddy:

```
chess.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/register` `{"name"}` | Claim a username; returns `{"name", "token"}` |
| `GET /v1/state?since=<version>` | Everything one player sees; held up to 25 s until something changes |
| `POST /v1/action` | `queue`, `unqueue`, `challenge`/`accept`/`decline` with `name`, `cancel`, `move` with `uci`, `resign`, `draw`, `leave` |
| `GET /v1/leaderboard` | The high scores, without a token |
| `GET /health` | `ok` |

`deploy/deploy.sh` deploys tuichess.dev: it uploads the sources, builds the server with Perry on the host (a pinned Perry release in `/opt/tuichess/perry`), runs `tests/server.ts` against that binary, installs it as the `tuichess` systemd service on 127.0.0.1:8787, copies [`site/`](site) to the web root, and sets up nginx: `tuichess.dev` for the site, `api.tuichess.dev` for the server, and `tuichess.com` and `www.` redirecting to `tuichess.dev`. It issues Let's Encrypt certificates once each domain's DNS points at the host, so it is safe to re-run.

`npm run test:server` checks the rules and the HTTP server under Node; `npm run test:server:perry` runs the same checks against the Perry binary.

The installed plugin is only the [`plugin/`](plugin) folder. [`plugin/hooks/register.tsx`](plugin/hooks/register.tsx) registers `/chess`, the tools, and the pane; [`plugin/hooks/board.tsx`](plugin/hooks/board.tsx) draws the board and handles keys and clicks. `plugin/lib/` holds generated copies of the engine and of [`mcp/src/tools.ts`](mcp/src/tools.ts), so the plugin stays self-contained: run `npm run plugin:sync` after changing either, and `npm run test:mcp` fails while the copies are stale. Engine searches run in the plugin's hooks worker after the pane has drawn your move; level 10 can take several seconds.

For other agents (opencode, Cursor, and anything else that speaks MCP), [`mcp/src/server.ts`](mcp/src/server.ts) serves the same tools as a stdio [Model Context Protocol](https://modelcontextprotocol.io) server with no packages, run from source by Node 22.18+: `node mcp/src/server.ts`.

To try local changes, run `claude --plugin-dir plugin`. `npm run test:plugin` drives the pane with keys and clicks, `npm run test:mcp` tests the tools and the stdio protocol, and `npm run plugin:validate` checks the manifests.

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

## Performance measurements

Measured on 2026-11-01: Apple M1 Max, 64 GiB RAM, macOS 26.5 ARM64; Node 26.5.1, Bun 1.3.14, Perry 0.5.1663. The application source was unchanged. [Raw samples, environment, fingerprints and binary/source hashes](benchmarks/macos-arm64-2026-11-01.json) are saved for comparison, not as portable performance guarantees.

Perry has the smallest runtime-inclusive payload and lowest RSS. Node and Bun run substantial searches about 6–7 times faster in this application. Compiling TypeScript to JavaScript reduces Node's startup and memory costs without materially changing its search speed.

| Measurement | Node TS | Node JS | Bun TS | Perry native |
| --- | ---: | ---: | ---: | ---: |
| Startup to first board, batch medians | 76–112 ms | 43–58 ms | 26–94 ms | 8.5–12.8 ms |
| Idle RSS after first board | 91.6 MiB | 53.9 MiB | 37.5 MiB | 18.0 MiB |
| Peak RSS, level-5 opening session | 142.3 MiB | 119.8 MiB | 128.5 MiB | 26.4 MiB |
| Peak RSS, level-10 opening session | 238.1 MiB | 179.1 MiB | 272.3 MiB | 84.3 MiB |
| Local `e2e4`, validate + render | 0.107 ms | 0.103 ms | 0.123 ms | 0.117 ms |
| Opening search, level 1 | 0.54 ms | 0.38 ms | 0.61 ms | 0.81 ms |
| Opening search, level 5 | 45.1 ms | 48.6 ms | 43.4 ms | 278.6 ms |
| Opening search, level 7 | 174 ms | 175 ms | 175 ms | 1,186 ms |
| Opening search, level 10 | 5.76 s | 5.73 s | 5.89 s | 39.12 s |
| Middlegame search, level 5 | 111.6 ms | 113.0 ms | 114.9 ms | 819.1 ms |
| Endgame search, level 5 | 23.4 ms | 22.8 ms | 22.6 ms | 137.5 ms |

Search times are repeated-search medians through the actual plain-mode CLI's `hint` command, including pipe transport and rendering, excluding startup. They measure choosing a move without playing it. Searches clear the transposition table each time. The level-5 opening visits 12,785 nodes; level 7 visits 49,090; level 10 exhausts 1,500,000 nodes and completes depth 8. The middlegame is the Kiwipete test position and exhausts its 20,000-node budget before completing depth one; every runtime returns the same legal fallback. Exact FENs are in the raw data.

First searches are slower on the JIT runtimes: the level-5 opening took 85.0 / 90.7 / 76.0 / 282.7 ms respectively. These are single observations, not medians. Repeated samples use five measured searches after two initial searches; level 10 uses just two measured repeats after its first search because it is expensive. All complete result frames, including move, depth, node count and displayed principal variation, must match across runtimes and repeats.

Startup uses a parent monotonic clock, from spawning the process to receiving the complete first board. There are three discarded launches and 25 measured launches per target, with target order rotated. Three batches showed substantial host variability, particularly for Bun, so the table reports the range of batch medians. These are fresh processes with warm filesystem caches, not cold-boot measurements. Idle RSS is the median of five `ps` readings from the initial batch; later harness versions collect RSS in separate launches after startup timing. Peak RSS is macOS `/usr/bin/time -l`'s maximum resident set size over each complete search session. RSS includes runtime/JIT memory, not just the engine heap, and peak values depend on session length and GC behavior.

### Distribution payload

| Delivery format | Uncompressed payload | Gzip payload |
| --- | ---: | ---: |
| TypeScript app, Node/Bun already installed | 58.0 KiB | 16.3 KiB |
| Compiled JavaScript app, Node already installed | 64.3 KiB | 15.8 KiB |
| Node executable + compiled JavaScript app | 138.60 MiB | 43.22 MiB |
| Bun executable + TypeScript app | 60.23 MiB | 23.20 MiB |
| Perry native executable | 9.79 MiB | 4.22 MiB |

These are actual file bytes, excluding development dependencies, compiler binaries, declarations, source maps, documentation and packaging overhead. Gzip is the sum of individually compressed files at level 9, not the size of a signed installer or archive. Runtime-inclusive Node/Bun rows are executable-plus-app folders, not single-file compiled bundles. All three executables link only to operating-system libraries on this host. If the runtime is already available, the Node/Bun incremental download is much smaller than Perry's native binary.

### Why Perry is slower here

An optimized release binary with symbols retained was sampled during the full level-10 opening search. Of 35,519 main-thread samples, 31.7% were in runtime helpers, 61.8% in compiled engine functions, 2.9% in thread-local lookup, and the remainder in other functions. Compiled engine code also contains runtime guards, so its share is not equivalent to pure chess arithmetic. Only 2.6% of samples had collector frames; garbage collection is not the dominant cost. The idle signal thread is excluded.

The largest individual self-time sites were attack detection (17.9%), evaluation (11.1%), board-bound checks (7.6%, combining both entries), make (6.9%), unmake (6.3%), and pseudo-legal generation (5.6%). Array iterator/prototype checks, property access and write barriers recur inside the hot paths. An isolated numeric bounds-check loop ran essentially at Node speed, so the full gap cannot be attributed to bitwise arithmetic alone.

Diagnostic copies of the engine tested a 250,000-node search plus a depth-three perft check. Replacing three attack-detection `for...of` loops with indexed loops reduced Perry's median process wall time from 6.426 s to 5.678 s, about 12%. Inlining bounds checks alone showed no clear gain; combining both changes took 5.584 s. All variants returned identical complete search results. These are three-run exploratory medians with an initial baseline outlier; the original engine remains unchanged.

The more tightly controlled [standalone reproducer](scripts/repro-perry-board.ts) scans a short `number[]` through a typed class and returns early on a match. With five million probes and 100,000 warmup probes:

| Runtime | `for...of` | Indexed loop |
| --- | ---: | ---: |
| Node | 58.58 ms | 46.77 ms |
| Bun | 57.22 ms | 51.60 ms |
| Perry | 608.00 ms | 311.01 ms |

Every run returned checksum `2109378` and warmup checksum `42188`. Perry's whole-process instruction count fell from 8.410 billion to 5.279 billion. The standalone release profile attributed 16.1% of self samples to `array_record_close_is_absent`, which walks iterator prototype shapes to establish whether early-return IteratorClose can skip a `return` method. Iterator entry and prototype lookup added further overhead. This is evidence for repeated iterator/prototype work as one contributor, not an explanation of the entire application's slowdown.

Filed upstream as [Perry #13645](https://github.com/PerryTS/perry/issues/13645), with the complete synthetic reproducer, commands, measurements and profile. It is a performance issue, not a chess correctness failure. The public report does not publish this repository's engine source.

### Reproduce

```sh
npm run benchmark                 # builds JS/native; runs serial app measurements
npm run benchmark:startup         # repeats startup/RSS; requires existing builds
npm run profile:variants          # builds and measures diagnostic engine copies
node scripts/profile-variants.ts --run-only # reuse the diagnostic binaries

perry compile scripts/repro-perry-board.ts -o dist/repro-perry-board \
  --strict-eval --strict-dynamic-import --strict-unimplemented
node scripts/repro-perry-board.ts forof 5000000
bun scripts/repro-perry-board.ts forof 5000000
dist/repro-perry-board forof 5000000
# Repeat those three commands with "indexed" instead of "forof".
```

The app harness uses macOS `ps`, `time -l`, `otool` and `sw_vers`; it is not yet a cross-platform benchmark driver. Fresh raw app results go to `dist/benchmarks/`, and diagnostic copies/results to `dist/profiles/variants/`. The standalone reproducer needs only its single TypeScript file. Profile with `PERRY_KEEP_SYMBOLS=1` to retain release symbols; `--debug-symbols` adds call-location instrumentation and was excluded from the reported profile.

## ScriptC and Porffor compilation trials

The latest published releases checked on 2026-11-01 were [ScriptC 0.4.7](https://github.com/vercel-labs/scriptc/releases/tag/v0.4.7) (2026-10-31) and [Porffor alpha 19](https://github.com/CanadaHonk/porffor/releases/tag/alpha-19) (2026-10-21, compiler reports `0c135ce`). Their official macOS ARM64 archives were downloaded into `dist/toolchains/` and verified against the SHA-256 digests published with the release assets. No global installations or production-source changes were made. [Recorded diagnostics, validation results, release metadata and artifact hashes](benchmarks/compiler-trials-macos-arm64-2026-11-01.json) accompany these trials.

| Target | Original terminal app | Engine and UI-logic suite |
| --- | --- | --- |
| ScriptC 0.4.7 | Build rejected at `process.stdout.on("error", onError)` with SC2020 | Original TypeScript compiles; all 875 assertions pass, matching Node's output |
| ScriptC compatibility copy | Builds after omitting that single stdout listener; all nine CLI scenarios match Node | Engine source is unchanged |
| Porffor alpha 19, TypeScript | Emits a binary, but even `--help` fails with `ReferenceError: process is not defined` | Emits a binary, then fails with `TypeError: value is not a constructor` |
| Porffor alpha 19, bundled JavaScript | The missing Node host APIs still block this terminal entry point | All 875 assertions pass, with output identical to Node and ScriptC |

ScriptC's compatibility executable is **810,312 bytes (791.3 KiB)** with default release optimization and links only to macOS `libSystem`. Its one-line adaptation is generated by [`scripts/prepare-scriptc.ts`](scripts/prepare-scriptc.ts), which copies the sources under `dist/compiler-trials/scriptc-adapted/`. It lacks the original stdout-error/EPIPE listener registration; stdin error handling is retained. The nine matching CLI cases cover help, invalid arguments/FEN, local play, EOF without a newline, promotion, undo with a computer reply, and level-5/level-10 opening searches. A pseudo-terminal check also exercised typed moves, undo, quit, alternate-screen restoration and terminal-mode restoration. All original terminal settings were restored except the macOS `PENDIN` status bit, which remains set in ScriptC's run but not Node's; canonical input, echo and signal flags were restored.

Porffor's original app output is **696,720 bytes**, but it is not a working distribution. Importing `node:process` explicitly also fails: `porffor: node builtin modules are not supported (node:process)`. A constructor probe narrows the TypeScript failure to `new Array<number>(128)`: after erasing types, `Array`, `Map` and a class containing both construct successfully. Bundling the existing test suite with Bun and compiling that JavaScript with Porffor produces a **763,216-byte** executable that passes all 875 assertions. This verifies the headless engine and UI logic, not the Node-based terminal host. Porting that host to Porffor's runtime APIs would be separate work.

To repeat with the same releases on macOS ARM64:

```sh
mkdir -p dist/toolchains/scriptc-0.4.7 dist/toolchains/porffor-alpha-19
gh release download v0.4.7 --repo vercel-labs/scriptc \
  --pattern 'scriptc-0.4.7-darwin-arm64.tar.gz' --dir dist/toolchains
gh release download alpha-19 --repo CanadaHonk/porffor \
  --pattern 'porffor-darwin-arm64.tar.gz' --dir dist/toolchains
shasum -a 256 dist/toolchains/*darwin-arm64.tar.gz
# Expected ScriptC: f3f9d0074ebecc67931a71b72b43be4819597b602261a01c6f9bb16816b5a37b
# Expected Porffor: 2009205e80f1318f3ed610bdf591ac6054c0314a72ea546115adf2e8b168b5e1
tar -xzf dist/toolchains/scriptc-0.4.7-darwin-arm64.tar.gz -C dist/toolchains/scriptc-0.4.7
tar -xzf dist/toolchains/porffor-darwin-arm64.tar.gz -C dist/toolchains/porffor-alpha-19

npm run build:scriptc:trial
./dist/compiler-trials/chess-scriptc-adapted --plain
npm run test:scriptc:trial
npm run test:porffor:trial
```

The original-source build attempts, before adaptation or type erasure, were:

```sh
dist/toolchains/scriptc-0.4.7/bin/scriptc build tui/src/main.ts \
  --tier static-only --node-islands off -o dist/compiler-trials/chess-scriptc
dist/toolchains/porffor-alpha-19/porf native --module tui/src/main.ts \
  -o dist/compiler-trials/chess-porffor
```

ScriptC was tested with `--tier static-only`; its `--node-islands off` setting is report-only in 0.4.7, and the executable's actual linkage was checked. No dynamic-engine fallback or replacement chess implementation was used. The four-way follow-up below adds ScriptC to the timing/RSS comparison; Porffor remains excluded because its terminal host is not working.

## Four-way comparison and Perry size diagnosis

The follow-up compares Node JS 26.5.1, Bun TS 1.3.14, Perry 0.5.1663 and ScriptC 0.4.7 on the same M1 Max. ScriptC uses the single stdout-listener omission described above; its engine is unchanged. [Raw app samples, engine counters, Mach-O analysis, hashes and diagnostic parity results](benchmarks/four-way-macos-arm64-2026-11-01.json) are retained.

This run had substantial background host load (an observed load average was 30.58 / 26.94 / 20.52 on ten logical CPUs). Treat wall times as descriptive and use instruction counts to assess the extra work. The tests themselves ran serially, without overlapping compilation or profiling. All app search frames and all headless workload fingerprints matched across the four runtimes.

| Measurement | Node JS | Bun TS | Perry | ScriptC |
| --- | ---: | ---: | ---: | ---: |
| Startup to first board, median of 25 | 57.88 ms | 46.24 ms | 13.36 ms | 5.03 ms |
| Local move + render, median of 25 | 0.346 ms | 0.439 ms | 0.462 ms | 0.067 ms |
| Idle RSS, median of five launches | 53.75 MiB | 37.56 MiB | 17.98 MiB | 2.69 MiB |
| Opening level 10, repeated median | 7.20 s | 6.91 s | 40.41 s | 18.92 s |
| Opening level 10, repeat range | 6.75–7.66 s | 6.71–7.12 s | 40.31–40.51 s | 14.17–23.68 s |
| Peak RSS, complete level-10 session | 195.97 MiB | 280.39 MiB | 84.34 MiB | 21.56 MiB |
| Default runtime-inclusive distribution | 138.60 MiB | 60.23 MiB | 9.79 MiB | 0.773 MiB |
| Same distribution, gzip | 43.22 MiB | 23.20 MiB | 4.22 MiB | 0.388 MiB |

Level 10 returns the same move, depth eight and 1.5 million nodes, with only two measured repeats per runtime. Its ScriptC median is especially uncertain. Sub-millisecond input timings are also sensitive to scheduling. Distribution means executable plus app for Node/Bun and a native executable for Perry/ScriptC; with Node/Bun preinstalled, incremental app size is only about 59–65 KiB. RSS is resident memory, not an allocation count or retained-heap measurement.

### Search cost persists without the terminal

[`compare-workload.ts`](scripts/compare-workload.ts) imports the unchanged engine, warms it up, times only the requested work and verifies that FEN/history are restored. [`compare-runtimes.ts`](scripts/compare-runtimes.ts) runs three fresh processes per workload and runtime, rotating order and verifying complete result fingerprints. The timer excludes startup/warmup; macOS instruction counters include the entire process, including startup/warmup. These short runs are not equivalent to a fully warmed long-lived JIT session.

| Headless workload, median inner wall time | Node JS | Bun TS | Perry | ScriptC |
| --- | ---: | ---: | ---: | ---: |
| 100,000 evaluations | 161.72 ms | 117.83 ms | 948.81 ms | 94.42 ms |
| 10,000 legal-move generations | 72.44 ms | 54.25 ms | 235.01 ms | 60.01 ms |
| Opening perft(4), 197,281 leaves | 73.26 ms | 62.33 ms | 193.15 ms | 27.66 ms |
| 250,000-node search | 2.116 s | 1.465 s | 8.179 s | 1.361 s |

| Same workloads, whole-process instructions retired (billions) | Node JS | Bun TS | Perry | ScriptC |
| --- | ---: | ---: | ---: | ---: |
| Evaluation | 2.440 | 2.059 | 8.518 | 1.488 |
| Legal moves | 1.188 | 1.199 | 2.784 | 0.769 |
| Perft | 1.186 | 1.444 | 2.759 | 0.434 |
| Search | 18.886 | 17.898 | 105.936 | 16.733 |

Perry executes roughly **5.6–6.3 times as many instructions** for that search. Its three instruction counts are nearly identical despite wall-time variation. The terminal and renderer cannot explain this difference. The earlier release profile and controlled iterator experiment above locate concrete contributors: repeated iterator/prototype validation, dynamic property/shape lookup, array guards and write barriers inside attack detection, evaluation and make/unmake. Compiled engine functions also contain inline guards. Collector stacks account for only 2.6% of sampled execution; collection alone cannot explain the gap. The indexed-loop engine experiment recovered about 12%, so iterator handling is one contributor rather than the whole explanation.

### Fixed runtime retention and generated code growth

To compare native file sizes consistently, copies of both compilers' outputs were stripped and ad-hoc signed. Symbol-preserving originals were kept for attribution. Signing/alignment can make a tiny already-stripped program larger; these are normalized file sizes, not compiler defaults.

| Program | Perry stripped/signed | ScriptC stripped/signed |
| --- | ---: | ---: |
| `console.log("hello")` | 51,808 B | 103,152 B |
| `process.stdout.write("hello\n")` | 6,229,552 B | 103,632 B |
| Headless engine workload driver | 7,557,808 B | 471,024 B |
| Terminal app | 10,225,648 B | 740,208 B |
| Terminal app with renderer increment workaround | 9,339,168 B | — |

Perry's trivial console program uses a special tiny-output path, with just 976 bytes of machine code. Accessing stdout brings in the general stream/object machinery: the one-line stdout program already contains 5,428,900 bytes of machine code, including object, GC, stream, array and promise implementation code. Its symbols also contain global-object population and web-storage functions. Perry's stream builder installs a broad stream object with methods, closures and TTY hooks. This identifies a substantial fixed dependency footprint; it does not prove that every retained helper can be removed safely. Link roots and feature specialization are the next places to investigate.

The full Perry app has **8,807,472 bytes of machine code**, versus **570,864** for ScriptC. Perry's largest mutually exclusive attribution groups are:

| Retained machine-code group | Bytes |
| --- | ---: |
| Runtime object implementation | 1,815,292 |
| Generated terminal code | 1,083,696 |
| Other libraries/support | 1,021,548 |
| Runtime C ABI helpers | 857,580 |
| GC implementation, including barriers | 760,856 |
| Generated engine code | 480,020 |
| Node stream implementation | 285,896 |
| Array implementation | 231,168 |

[`analyze-native-size.ts`](scripts/analyze-native-size.ts) measures address extents within Mach-O `__text`, counts aliases once and keeps zero-fill sections out of file bytes. Symbol extents include alignment padding. Generated engine and terminal code together account for about 17.8% of the machine code; runtime/library/support code accounts for the rest. GC's code size is not its execution-time share. Embedded function source and string sections are about 110 KiB combined, and the size report's duplicate-body estimate is only about 18 KiB: neither explains a multi-megabyte gap. The 512 KiB dense subclass cache is zero-fill memory, not 512 KiB of distributed file contents.

### Confirmed unrolling pathology

`ChessApp.render` occupies **904,784 bytes** of Perry machine code (about 226,000 ARM64 instructions), compared with **9,396 bytes** in ScriptC. Its Perry stack frame is roughly 170 KiB. Perry's HIR unroller expands literal-bound loops with at most eight iterations and a `++` update; its eligibility logic has no body-size or cumulative nested-expansion budget. This runs before the native optimization stage, whose default is already `-Os`.

In a diagnostic source copy, changing only the two renderer loop updates from `row++` / `col++` to `row += 1` / `col += 1` bypasses that pass. The renderer shrinks to **56,776 bytes**, and the stripped/signed executable shrinks by **886,480 bytes (8.7%)**. Generated engine bytes and the large runtime groups stay identical. Output matches Node and the original Perry binary for help, local play/undo/flip, Unicode, promotion and a level-five search. This validates the exercised paths; it is not an exhaustive equivalence proof. Production source remains unchanged.

Filed as [Perry #13649](https://github.com/PerryTS/perry/issues/13649), with the complete [standalone synthetic reproducer](scripts/repro-perry-unroll.ts). That smaller example reproduces a 33× method-size difference (73,592 versus 2,236 bytes per implementation), 140,608 fewer machine-code bytes and 147,744 fewer stripped/signed file bytes. All eight seed/color combinations match Node, Bun and both Perry variants. The issue contains exact reproduction commands and no private application source.

The compiler fix should budget unrolling by estimated expanded body size, account for nested loops and honor size optimization. The two-update workaround demonstrates the effect but is not a robust compiler fix. Its size benefit should not be presented as a search-speed improvement: the headless search remains slow independently.

### Reproduce the follow-up

Install the pinned toolchains using the compilation-trial instructions above, then run from the repository root:

```sh
sh scripts/build-comparison.sh      # serial builds, probes, stripped copies, size attribution
node scripts/benchmark.ts --four-way
node scripts/compare-runtimes.ts    # run after app timings finish
```

Fresh results go to `dist/benchmarks-four-way/` and `dist/comparison/`. Do not run compilation, profiling or other benchmarks concurrently with timing. For performance work, prioritize typed hot-path guards/iterator handling; for distribution size, prioritize runtime dependency retention and the demonstrated unrolling explosion. These are distinct costs with separate evidence.

## Smallest measured complete Perry build

**Research artifact, not a performance-preserving preset:** the minimum-size build below regresses search speed. Do not use that configuration as the basis of a performance-sensitive PR. The follow-up at the end of this document separates the original Perry overhead from this additional regression.

The size work produced a **4.43 MiB native executable**, down from **9.79 MiB** for the original build (54.7% smaller). This uses a local compiler patch; the smallest verified configuration with the unchanged compiler is **5.03 MiB**. The engine, search budgets, terminal controls, colors, Unicode, help, error handling and signal restoration are retained. Original application sources are unchanged; the size builds use generated copies. These results apply to Perry **0.5.1663**, source commit `b384cd7be035899e80908c5013baf8e88f08c892`, on macOS ARM64.

This is the smallest verified configuration found in these experiments, not a theoretical lower bound. It trades substantial search speed for size:

| Build | Executable | 250,000-node search, median of three |
| --- | ---: | ---: |
| Original Perry | 9.79 MiB | 5.91 s |
| Smaller app, stock runtime | 8.64 MiB | 10.91 s |
| Smaller app and size-built runtime | 5.03 MiB | 18.43 s |
| Same, specialized ABI entries disabled | 5.03 MiB | 18.36 s |
| Patched compiler, regex-free size build | 4.43 MiB | 18.46 s |

The two 5.03 MiB configurations differ by only 128 bytes in the diagnostic builds; their timing difference is noise. The presets disable specialized ABI entries. All timed searches returned identical fingerprints. Native compilation and profiling did not overlap the accepted serial timing trials. The original, smaller-app and smaller-runtime runs retired roughly 106, 122 and 150 billion whole-process instructions respectively; size optimization increases execution work and reduces throughput. The ordinary `build:perry` remains available for performance comparisons.

The final regex-free configuration was timed separately against the original in three alternating rounds: **18.46 s versus 5.93 s**, about **3.1× slower**, with matching search fingerprints. Whole-process median instruction counts were 151.06 versus 105.90 billion; peak RSS was 21.27 versus 23.72 MiB. Removing the regex dependency reduces file size without curing the execution overhead of the size-oriented compiler settings. The raw samples are recorded in the size experiment JSON.

The useful changes were:

1. Change five literal-bound loop updates from `++` to `+= 1` in a generated copy, avoiding the compiler unrolling pathology described above. This covers the two board-rendering loops and three engine loops.
2. Compile app code with `PERRY_LL_OPT_LEVEL=z` and `--function-source header`. The program does not inspect function source bodies. Strip all remaining symbols and ad-hoc sign the final Mach-O executable.
3. Rebuild the runtime and stdlib with Rust `opt-level = "z"`, full LTO and just `keepalive-anchors`, `regex-engine` and `async-bridge`. The last feature is essential: omitting it produced a smaller binary that drew the board and exited without reading moves. That candidate was rejected despite its engine tests passing. This app-specific runtime uses the system allocator and retains Perry's release panic/unwind configuration.

The size runtime's GC-effects analyzer encounters one destructor that fat LTO has eliminated as a standalone function. The build helper checks for that exact diagnostic and omits only the unmatched `Arena::drop` teardown cut in a copied rules file, then reruns the analyzer against the actual archive bytes. This is conservative: no GC seed, unknown-call check or archive fingerprint check is disabled. The installed compiler/runtime and source checkout are not changed.

Validation covers the existing **875 assertions**, nine Node/native CLI comparisons including the **1.5-million-node level-10 search**, **95 additional CLI text commands** with 23 whitespace characters, and PTY checks for color, Unicode, move/undo, resize, quit, Ctrl-C and SIGTERM. Terminal modes, cursor and alternate screen are restored. Tests run against the generated engine/UI sources and the actual native candidate, so a passing original-source suite alone cannot approve a reduced runtime.

### Build and verify

For the smaller app using your existing runtime:

```sh
npm run build:perry:small
npm run test:perry:small
./dist/chess-small
```

For the 5.03 MiB build using the unchanged compiler, provide a Perry source checkout matching the compiler and its built `perry-gc-effects` tool. The helper uses a separate Cargo target directory and selects the required runtime features; it does not edit that checkout:

```sh
# /path/to/perry must match the pinned compiler source revision above.
# Its target/release/perry-gc-effects is used by default; GC_EFFECTS_BIN can override it.
sh scripts/build-perry-small-runtime.sh /path/to/perry
npm run build:perry:min
npm run test:perry:min
./dist/chess-small
```

That artifact is 5,273,648 bytes; its executable-preserving tar/gzip package is `dist/chess-small-macos-arm64.tar.gz` (2,745,180 bytes, 2.62 MiB). The package was unpacked in memory and checked against the tested binary byte-for-byte.

Both app build modes write `dist/chess-small`, so the most recent mode determines its contents. The minimum mode uses archives in `dist/perry-small/runtime/`; compiler and build dependencies are not distributed with the executable. First-time runtime compilation takes several minutes. The configuration is in [`scripts/perry-small-runtime.toml`](scripts/perry-small-runtime.toml), source-copy preparation in [`scripts/prepare-perry-small.ts`](scripts/prepare-perry-small.ts), and runtime build/provenance recording in [`scripts/build-perry-small-runtime.sh`](scripts/build-perry-small-runtime.sh). These commands use macOS `strip`, `codesign`, PTYs and Mach-O tooling.

### Regex-free build with a local compiler patch

The additional reduction to **4,647,120 bytes (4.43 MiB)** removes **626,528 bytes** from the executable. It combines equivalent string operations for the app's seven simple regex operations, a generated-only `Chess.search` → `findMove` rename to avoid Perry's property-name regex detection, and narrower process-listener feature selection. The original compiler requests the regex installer even for a two-line program that registers a `SIGINT` arrow callback and writes to stdout. IPC deserialization can create regex objects, so conservatively selecting IPC also selects the regex engine.

The [compiler patch](scripts/patches/perry-signal-ipc.patch) exempts only discarded direct listener calls for `SIGINT`, `SIGTERM`, `exit` and `beforeExit` with explicit arrow callbacks. Unknown events, escaping return values, chained calls, namespace escapes and ordinary/unknown callbacks retain IPC support. Ordinary event callbacks can access `process` through `this`; the generated main program uses arrow wrappers and retains their identities for `removeListener`. Signal handling and OS hooks remain enabled. All 18 compiler feature-detection unit tests pass, including new regression cases for these distinctions.

To reproduce, create a separate checkout rather than patching your installed compiler. These commands assume Homebrew LLVM 22 and the Rust toolchain pinned by Perry's `rust-toolchain.toml`:

```sh
chess_dir="$PWD"
perry_repo=/path/to/matching/perry-source
git -C "$perry_repo" worktree add --detach "$chess_dir/dist/perry-small/compiler-source" b384cd7be035899e80908c5013baf8e88f08c892
git -C "$chess_dir/dist/perry-small/compiler-source" apply "$chess_dir/scripts/patches/perry-signal-ipc.patch"
(
  cd "$chess_dir/dist/perry-small/compiler-source"
  set -e
  export LLVM_SYS_221_PREFIX=/opt/homebrew/opt/llvm@22
  cargo --config 'profile.release.package.perry.opt-level=0' test --release --locked -j 3 \
    -p perry --bin perry --no-default-features --features dev-cli \
    feature_detect::tests -- --test-threads=1
  cargo --config 'profile.release.package.perry.opt-level=0' build --release --locked -j 3 \
    -p perry --bin perry --no-default-features --features dev-cli
)
mkdir -p dist/perry-small/compiler
cp dist/perry-small/compiler-source/target/release/perry dist/perry-small/compiler/perry
PERRY_SMALL_NO_REGEX=1 \
  PERRY_SMALL_TARGET_DIR="$chess_dir/dist/perry-small/compiler-source/target" \
  GC_EFFECTS_BIN="$perry_repo/target/release/perry-gc-effects" \
  sh scripts/build-perry-small-runtime.sh "$chess_dir/dist/perry-small/compiler-source"
npm run build:perry:min:no-regex
npm run test:perry:min:no-regex
python3 scripts/package-perry-min.py
./dist/chess-min
```

The compiler package's `opt-level=0` makes building the development CLI faster; the LLVM backend and generated app still use the intended optimization settings. `PERRY_SMALL_COMPILER` can point the build/test wrapper to another build of this patched compiler. Runtime archives live separately in `dist/perry-small/runtime-no-regex`; their feature list is `keepalive-anchors` plus `async-bridge`. The reproducibility run produced byte-identical runtime/stdlib archives and GC-effects metadata to those used for the validated candidate.

The regex-free native app passes the same 875 assertions, nine CLI comparisons including the full level-10 search, 95 text cases and three terminal-exit scenarios described above. Its retained machine code is **3,585,644 bytes**. The largest groups are object machinery (700,528 bytes), runtime C entry points (308,540), generated engine (286,976), GC (252,072) and generated TUI (162,740); another 860,280 bytes fall into other libraries/support. These groups describe retention, not code proven safe to remove. The remaining size is predominantly shared runtime implementation and data.

The final executable is `dist/chess-min`. Two executable-preserving packages are available: `dist/chess-min-macos-arm64.tar.gz`, **2,460,450 bytes (2.35 MiB)**, and `dist/chess-min-macos-arm64.tar.xz`, **1,840,388 bytes (1.76 MiB)**. Packaging verifies the Mach-O signature, checks both archives' extracted bytes against the tested binary, and records hashes in `dist/chess-min-package.json`. Extract the smaller archive with `tar -xJf dist/chess-min-macos-arm64.tar.xz`.

### What did not help, and remaining opportunities

- Relaxing three runtime keep-alive anchors saved only **16 bytes** in the app. The rest of the reference graph still retained the implementations.
- Disabling hot-small-function inlining saved **zero bytes** in this `-Oz` build. Disabling specialized ABI entries saved about 32 KiB with the stock archives, but only 128 bytes with the size runtime.
- In the final regex-free build, app `-Os` produced 4,808,336 bytes and enabling specialized ABI entries produced 4,663,696 bytes. Both were larger than the selected `-Oz`/ABI-off build, so they were rejected on size and not promoted to fully validated artifacts.
- Replacing the seven regex operations alone made the stock-runtime executable slightly larger. Removing the regex engine still failed to link until the compiler feature-detection issue above was fixed. Renaming `Chess.search` alone also did not suffice. No installer stubs or missing-API workarounds were added.
- `--no-auto-optimize` / the advertised automatic minimal-runtime rebuild do not control this release's runtime selection: the implementation links prebuilt archives. Runtime size optimization therefore requires the explicit rebuild above.

Further large reductions would require more precise runtime dependency separation and less generated guard/dispatch code. The checked-in [size experiment record](benchmarks/perry-size-macos-arm64-2026-11-01.json) includes successful and rejected configurations, exact artifact hashes, validation evidence and measured speed tradeoffs.


## Why Perry is slow, and which size savings survive

The original slowdown predates the size experiments. On the identical 250,000-node headless search, Perry retires about **106 billion instructions**, versus **17–19 billion** for Node, Bun and ScriptC. The original profile puts 61.8% of main-thread self samples in generated engine functions (including inline runtime checks), 31.7% in runtime functions and 2.9% in TLS lookup. Collector code appears on 2.6% of sampled stacks; that figure does not include all inline barriers or rooting work. Neither terminal rendering nor collector pauses alone explains the gap.

The generated hot paths repeatedly admit values into optimized representations: checking numeric tags, normalizing array indices, validating array layout/prototypes, and maintaining stack/GC state. Even `onBoard(number)` contains boxed-number tests, a stack/TLS guard and generic comparison fallbacks. The existence of fallback calls in assembly does **not** mean every probe executes those calls. The cost includes the guards and representation handling on the successful path.

A new [standalone reduction](scripts/repro-perry-access.ts) tests nine access forms with identical square visits, early-return behavior and checksums. Three serial rounds of five million probes produced these medians (milliseconds):

| Probe | Node | Bun | Perry | ScriptC |
| --- | ---: | ---: | ---: | ---: |
| Method reads board cell | 47.74 | 54.96 | 319.15 | 66.45 |
| Cached board field, indexed directions | 47.11 | 53.83 | 327.73 | 64.43 |
| Same, fixed direction-loop bound | 45.24 | 56.23 | 256.38 | 68.12 |
| Fixed bound and typed direction array | 46.29 | 53.08 | 277.66 | 91.79 |
| Arithmetic directions, ordinary board array | 54.02 | 75.27 | 133.61 | 38.13 |
| Arithmetic-only immutable-fixture control | 54.59 | 79.07 | 187.81 | 14.13 |

Removing the method, caching the field, or using `Int32Array` for the board does not close the gap. Changing both the update spelling and loop bound reduces Perry's instruction count from 5.03 to 3.44 billion; replacing direction reads with arithmetic reduces it further to 2.13 billion. The issue follow-up below separates the update and bound effects. These are diagnostic reductions, not a claim that the mutable chess board can be replaced with arithmetic. The arithmetic-only control performs different work and remains slow; its timing cannot be subtracted to assign an exact cost to board access.

A separate eight-second sample of the method probe puts 82.2% of self samples in the generated scan and about 13.6% in the packed-array admission/numeric-layout helper chain. The runtime already caches numeric layout in a header bit: it is **not** rescanning the entire numeric array on every call. It still validates pointer/header/layout state repeatedly. This points to preserving compiler-derived numeric and integer-range facts, and moving stable checks out of repeated short probes. Declared TypeScript types alone cannot justify removing checks for holes, prototype changes, accessors, unexpected values or moving-GC effects.

### Additional regression caused by the size preset

Controlled builds kept source, runtime features and allocator fixed while varying optimization settings. Changing only app optimization from Oz to O2 cuts search from 18.91 to 11.89 seconds; changing the Rust runtime from Oz to O2 then restores approximately six-second search. Restoring mimalloc to the Oz runtime improves the controlled search median by only about 1.2%. Reverting the three engine loop rewrites does not repair the Oz regression.

In a fresh profile, the app-O2/runtime-Oz build spends 20.7% of self samples in LLVM-outlined fragments, versus one sample out of 5,942 in the original build. Examples are two-instruction register-restore/return and constant-return helpers. Outlining shares code to reduce bytes but adds control transfers; the fragments also perform necessary work, so 20.7% is not an exact estimate of removable overhead. Different search speeds sample different search phases. Together with the controlled instruction/cycle measurements, this supports lost inlining and excessive hot-path outlining as mechanisms of the size regression.

A final three-round comparison covered evaluation, legal moves, perft and search:

| Configuration | Full executable | Search median | Evaluation median |
| --- | ---: | ---: | ---: |
| Original | 9.79 MiB | 5.988 s | 457.66 ms |
| Original engine optimization and stock runtime; smaller UI/dependencies/source metadata | 8.04 MiB | 5.925 s | 458.65 ms |
| App O2, runtime O2, minimal features, specialized ABI enabled | 7.43 MiB | 5.993 s | 465.79 ms |
| App O2, runtime Os, minimal features, specialized ABI enabled | 6.23 MiB | 6.044 s | 476.18 ms |

All 48 workload fingerprints matched. The 8.04 MiB control has essentially unchanged instruction counts and timing across the four workloads; this is not a claim of a statistically significant speedup. It also passes the 875-assertion native/Node fingerprint comparison, nine CLI scenarios including the 1.5-million-node search, 95 text commands and all three PTY exit/restoration cases. It is at `dist/perry-speed-size/chess-speed-control`. The 7.43/6.23 MiB candidates still add instructions and regress evaluation, so they are research candidates, not approved performance-preserving presets. The 4.43 MiB artifact remains a rejected speed tradeoff.

### Direction for compiler work

1. Preserve construction/assignment-derived numeric facts and integer ranges across array reads and helper calls; specialize the short attack/bounds loops after sound admission, with correct invalidation and fallback behavior. Reduce redundant pointer/header validation inside an already-admitted region.
2. Remove unnecessary iterator protocol work. The prior three-loop indexed rewrite improves full search by only about 12%, so iterator work is one contributor. Related upstream work: [#13653](https://github.com/PerryTS/perry/pull/13653) is merged and [#13655](https://github.com/PerryTS/perry/pull/13655) remains open as checked on 2026-11-01. Their complete effect on this app has not been measured here.
3. Keep hot runtime code optimized for speed; retain dependency pruning, source-metadata removal and the [merged bounded-unrolling fix #13650](https://github.com/PerryTS/perry/pull/13650). Investigate profile-guided inlining/layout and size optimization of cold paths rather than blanket Oz. [Rust PGO](https://doc.rust-lang.org/rustc/profile-guided-optimization.html) supplies execution frequencies to these optimizations; it has not been tested in this experiment. [Cargo's documentation](https://doc.rust-lang.org/cargo/reference/profiles.html) also cautions that optimization-level tradeoffs must be measured.

No PR was opened for this investigation, the size preset, or the local signal/IPC patch. Recovering the full 4.43 MiB size with original performance has **not** been demonstrated. Gate any proposed change on unchanged results and repeated evaluation/legal/perft/search timings, then the complete CLI and terminal suite.

The [research record](benchmarks/perry-speed-size-research-macos-arm64-2026-11-01.json) contains raw timing/counter samples, build fingerprints, profile summaries, limitations and reproduction commands. Original engine and UI sources remain unchanged. Profiling, builds and timing trials ran separately. The access experiment is reproducible with the pinned Perry/ScriptC binaries and `python3 scripts/benchmark-perry-access.py`; its native binaries must first be rebuilt from the current reduction source.


### Quantified upstream issues

The follow-up isolates a concrete compiler defect: stable-packed lowering emits its admission helper before it decides whether the generated fast clone is safe. If the clone is rejected, the ordinary loop still pays for the unused admission. An independent minimal synthetic scan confirms `j++` → `j += 1` reduces **1,001.44 → 809.98 instructions/probe** and **320.18 → 266.16 ms**; Node remains ~45 ms. This is separate from literal-bound unrolling.

The expanded access fixture now includes `live-bound`, with `j += 1` and `STEPS.length`. It resolves the prior comparison's confound:

| Paired reduction | Perry instructions/probe | Median time at 5M |
| --- | ---: | ---: |
| Cached field, `j++`, live bound | 980.08 | 318.19 ms |
| Same, `j += 1` | 784.03 | 266.64 ms |
| Same increment, fixed bound | 667.31 | 246.42 ms |
| Same fixed loop, arithmetic directions | 410.00 | 131.27 ms |

Instruction costs use `(median I(10M) - median I(5M)) / 5M`, with three serial rounds, to subtract fixed startup/warmup overhead. These are synthetic reductions, not additive allocations of full search time. The independent minimal increment fixture uses slightly different code and therefore has a different absolute instruction budget.

All findings and remaining attribution work are now public:

- [#13663 — complete accounting and integration tracker](https://github.com/PerryTS/perry/issues/13663).
- [#13660 — unused admission after fast-loop rejection](https://github.com/PerryTS/perry/issues/13660), with the [minimal source](scripts/repro-perry-increment.ts).
- [#13661 — remaining indexed numeric-loop costs](https://github.com/PerryTS/perry/issues/13661), with the [expanded source](scripts/repro-perry-access.ts).
- [#13662 — custom Oz runtime throughput cliff](https://github.com/PerryTS/perry/issues/13662): independently reproduced on the public scan, 1.65–1.78× slower than runtime O2; 20.24% of self samples in outlined fragments versus 0%.
- [#13659 — unnecessary regex/IPC retention](https://github.com/PerryTS/perry/issues/13659): 673,856 bytes from an unrelated method name; 1,365,792 bytes recoverable in the signal example with the stock speed runtime.

[Existing iterator issue #13645 was updated](https://github.com/PerryTS/perry/issues/13645#issuecomment-6559026657); the tracker links the already-fixed unrolling issue #13649. Every new report includes public reproduction code, measurement methodology, source locations or investigation targets, limitations, and acceptance checks. The generated-engine profile share remains partly unattributed; the tracker explicitly carries that work rather than calling all of it waste. No PR for the slow size preset was opened.

The [issue manifest](benchmarks/perry-issues/issues.json) records links, source/binary hashes and measurement exclusions. Raw [paired instruction measurements](benchmarks/perry-issues/measurements.json), [minimal increment measurements](benchmarks/perry-issues/increment-results.json), [feature-size measurements](benchmarks/perry-issues/feature-retention.json), and copies of the published bodies are retained beside it.

### Reassessment after the upstream fixes

Retested on 2026-11-01 with a freshly built compiler **and matching runtime** at `2359699bee1ec7b98478a0db44f195a5a086b30d`, against the original `b384cd7be035899e80908c5013baf8e88f08c892` artifacts. The production engine and UI sources are unchanged. The isolated build keeps app Os, specialized ABI, default release runtime/stdlib features and optimization, and the repository's unwind configuration. It does not use the rejected blanket-Oz preset. Current main also includes changes beyond these four tickets, including the now-merged iterator PR #13655; integrated results cannot be attributed exclusively to one PR.

Three tickets are closed and their targeted changes reproduce:

- [#13659 / PR #13669](https://github.com/PerryTS/perry/pull/13669): an isolated user `.search()` now has the same 5,568,912-byte executable size as its renamed control. A directly supplied signal arrow also prunes regex/IPC.
- [#13660 / PR #13670](https://github.com/PerryTS/perry/pull/13670): the rejected fast clone no longer leaves an admission call in the minimal scan. On integrated main, `j++` and `j += 1` now both cost about 499 instructions/probe. The original pair was about 1,002 versus 810. Part of the combined reduction also comes from the numeric-array fix.
- [#13661 / PR #13675](https://github.com/PerryTS/perry/pull/13675): live-bound access drops **783.86 → 494.56 instructions/probe**, fixed-bound **667.33 → 494.68**, and method access **1,028.82 → 630.26**. These are substantial improvements, but Node's corresponding probes remain about 174–176 instructions/probe.

[#13662 remains open](https://github.com/PerryTS/perry/issues/13662). Its merged [PR #13677](https://github.com/PerryTS/perry/pull/13677) size-optimizes four cold builtin installers. The PR's controlled O2/fat-LTO experiment saves 16,256 application bytes without a measured search regression. That is incremental progress; it does not establish the 4.43 MiB/original-performance target or qualify blanket Oz.

The fresh end-to-end comparison shows why the overall task remains open:

| Measurement | Original Perry | Current Perry | Current pruned copy |
| --- | ---: | ---: | ---: |
| Stripped/signed executable | 10,267,192 B / 9.79 MiB | 9,306,320 B / 8.88 MiB | 9,257,088 B / 8.83 MiB |
| Search, 250K nodes | 5,876.10 ms | 5,808.81 ms | 5,772.00 ms |
| Search retired instructions | 105.946 G | 105.665 G | 105.673 G |
| Evaluation, 100K iterations | 455.73 ms | 529.73 ms | 531.31 ms |
| Legal moves | 148.51 ms | 138.43 ms | 139.73 ms |
| Perft | 145.48 ms | 136.54 ms | 136.05 ms |
| Warm-filesystem startup | 8.38 ms | 8.02 ms | 8.00 ms |
| Idle RSS | 18.00 MiB | 17.05 MiB | 16.84 MiB |
| Search peak RSS | 23.72 MiB | 23.66 MiB | 23.27 MiB |

Engine figures are medians of three serial, rotated rounds after all builds completed. Search is only about **1% faster**, with essentially unchanged instruction counts; this small timing difference is not evidence of a statistically significant gain. Node/Bun/ScriptC search takes **950.73 / 908.80 / 1,017.19 ms**, respectively: Perry still takes roughly six times as long. The public for-of repro improves **590.33 → 315.33 ms**, but this does not translate into a comparable full-search improvement.

Evaluation is about **16% slower**. A separate three-pair, one-million-evaluation confirmation gives **4,578.62 → 5,308.61 ms**, **83.826 → 86.911 billion instructions**, and **14.211 → 16.529 billion cycles**, with identical checksums. Thus both instruction count and cycles per instruction worsen. The responsible change is not yet isolated; the observation is an integrated regression, not an attribution to a specific ticket.

The pruned copy also remains larger than the earlier **8,434,960-byte / 8.04 MiB** speed control. A standalone follow-up reveals that `process.on("SIGINT", callback = () => {})`, used to preserve callback identity for removal, still selects IPC/regex. It costs **1,365,776 extra bytes** compared with direct-arrow controls on the same current compiler/runtime. Filed as [#13679](https://github.com/PerryTS/perry/issues/13679). This controlled fixture demonstrates missed pruning; other compiler/runtime/source-copy differences prevent attributing the entire 822,128-byte application gap to it. The pruned source copy removes all five old increment-spelling workarounds and retains the prior regex-free helpers, signal wrappers and source-header setting.

Both current app variants pass the 875-assertion native/Node fingerprint, all nine CLI scenarios including full-strength search, 95 text cases, and quit/Ctrl-C/SIGTERM terminal restoration. Typechecking passes. All 72 headless benchmark samples and 150 microbenchmark samples match their expected results. Short startup and local-move timings remain noisy; local-move medians are 0.106 ms original, 0.085 ms current and 0.083 ms pruned.

The [reassessment record](benchmarks/perry-reassessment-macos-arm64-2026-11-01.json) retains raw samples, hashes, build settings, validation logs and exclusions. In particular, an early new-compiler/old-runtime arm was discarded after discovering an ABI change; every accepted current measurement uses matching current archives. The [integration tracker #13663](https://github.com/PerryTS/perry/issues/13663) carries the remaining search attribution, evaluation regression and size work. No slow size preset was promoted or put in a PR, and the installed compiler remains unchanged.

### Remaining blockers: profiles and controlled diagnostics

A further pass at the same `2359699` pin profiles the remaining work and tests source copies. Other builds were active on the host: **retired instructions, output parity and binary extents are the evidence; these wall times are not qualified speedup measurements**. The production engine/UI and installed compiler remain unchanged.

The sampled search spends 27.4% inclusive in attack detection, 21.2% in evaluation, 19.0% in making moves and 12.8% in move generation. Inclusive shares overlap. A separately instrumented Node run of the exact 250K-node search counts **218.5 million board reads**, **146.1 million bounds checks**, **6.74 million attack scans**, and **6.49 million make/unmake pairs**. These are semantic helper invocations; native inlining may remove call boundaries.

Counted attack loops remove about **12% of search instructions**, and inlining bounds expressions about **6%**, measured separately. However, the counted-loop version adds **381,888 bytes of machine code**: its smaller attack helper becomes eligible for forced pre-statepoint inlining and is copied into many callers. The compiler admits a larger lowered-IR budget for bodies with few top-level source statements, even when those statements contain loops.

The combined diagnostic copy uses counted attacks, inline bounds and explicit pawn-edge guards. A paired experiment changes only `PERRY_GUARDED_PREINLINE_MAX_IR_BYTES` from its default 65536 to 16384:

| Headless build | Stripped/signed bytes | Search instructions | Evaluation instructions |
| --- | ---: | ---: | ---: |
| Untouched source, default budget | 7,475,792 | 105.844 G | 8.859 G |
| Combined diagnostic, default budget | 7,902,608 | 88.271 G | 6.878 G |
| Combined diagnostic, 16 KiB budget | **7,262,384** | **85.101 G** | **6.857 G** |

The lower ceiling saves **640,224 bytes and 3.6% of search instructions** on the same combined source. Relative to untouched source, the combination is **213,408 bytes smaller and uses 19.6% fewer search instructions**. This is a headless experiment, not a new full-app distribution. The compiler-only cap on untouched source saves the same bytes but leaves search instructions approximately flat/slightly higher (+0.23%). Neither setting is promoted: full acceptance and quiet-machine performance qualification remain outstanding.

Two additional public reductions identify narrower opportunities:

- [#13687](https://github.com/PerryTS/perry/issues/13687): negative numeric array reads format and allocate property-key strings, then traverse generic property/prototype machinery. This path occupies 25.4% inclusive of the evaluation profile. Explicit pawn-edge guards reduce evaluation instructions by 22.3% and search by 3.9%. The public mutable-array probe uses 1,381 versus 148 instructions/iteration for plain versus bounded reads. Those controls assume untouched prototypes and are not general semantic rewrites. This cost predates the recent evaluation regression.
- [#13688](https://github.com/PerryTS/perry/issues/13688): equivalent ordinary/`$pshape` bodies survive across module boundaries. The public fixture retains an extra 5,156 bytes; the app has twelve equal-extent pairs totaling 110,736 bytes on one side. Sharing requires proof about site identities, entry contracts and GC/unwind metadata; these are potential savings, not implemented removals.

The full app's 9,306,320 bytes include **7,924,764 bytes of machine code (85.2%)**. Object machinery contributes 1,788,220 bytes and GC 764,144, with C ABI entries counted separately. Generated engine and UI together contribute only 690,600 bytes. Linker retention chains show stdin retaining async-iterator/Promise support, IPC retaining JSON, and typed-array hooks retaining generic property machinery. The largest size opportunity therefore requires finer runtime dependency boundaries as well as efficient generated code; cold or unsampled code is not automatically removable.

The [full tracking update](https://github.com/PerryTS/perry/issues/13663#issuecomment-6562797933) ranks these findings and acceptance requirements. The [blockers record](benchmarks/perry-blockers-macos-arm64-2026-11-01.json) includes exact source patches, hashes, summaries and limitations; [raw profiles and observations](benchmarks/perry-blockers/) are retained separately. The recent evaluation regression still requires a bisect. No production rewrite, slow size preset or PR was introduced.
