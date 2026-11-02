# tuichess

Chess in your terminal, and right beside your AI coding agent: play a ten-level engine or people online,
with clocks and a public high-score table at **[tuichess.dev](https://tuichess.dev)**.
The engine and the terminal game are plain TypeScript, compiled to one native binary with [Perry](https://github.com/PerryTS/perry).

| Where | What you get | Install |
|---|---|---|
| **Claude Code** | A board pane beside the chat; Claude sees the game and can comment; online play | `/plugin install chess --marketplace skelpo/chess`, then `/chess` |
| **opencode** | A full-screen board (`/chess`), a sidebar board, the agent sees the game; online play | [three commands](#codex-and-opencode), then `/chess` |
| **Codex** | Chess in the chat: Codex plays through the engine's tools and shows the board | `codex plugin marketplace add skelpo/chess` and `codex plugin add chess@skelpo-chess` |
| **Any terminal** | The full game, online play included; macOS and Linux | `npm install -g tuichess` or `npx tuichess` |

Online games are 10 minutes per player plus 5 seconds per move; running out of time loses. Pick any free
username (no password, no email); games of 10 or more half-moves count for the high scores. No chat.

## How it's built

Two projects, zero runtime packages:

- [`engine/src/chess.ts`](engine/src/chess.ts): a standalone computing engine. Copy this one file into another project. It imports nothing and uses no I/O, clocks, randomness, Node globals, or external data.
- [`tui/src`](tui/src): an ANSI terminal interface with keyboard selection, typed moves, computer opponents, and local two-player play. Only the entry point uses host APIs: `process` and timers.

All source, tooling and tests are TypeScript. Imports are static. There is no `any`, `eval`, generated code, reflection, dynamic import, runtime plugin loading, JavaScript fallback, or dependency on a chess library. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and the other checks in `tsconfig.json` are enabled. The engine is also checked without Node or DOM types.

Also here: the Claude Code plugin ([`plugin/`](plugin)), the opencode plugin ([`opencode/plugin/`](opencode/plugin)), the Codex plugin ([`codex/`](codex)), the MCP server ([`mcp/src`](mcp/src)), the online server ([`server/src`](server/src)), the site ([`site/`](site)) and its deployment ([`deploy/`](deploy)).

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
- **opencode, text in the chat:** the MCP server, plus a `/board-plain` command ([`opencode/commands/board-plain.md`](opencode/commands/board-plain.md)):
  ```sh
  mkdir -p ~/.config/opencode/commands
  curl -fsSL https://raw.githubusercontent.com/skelpo/chess/main/opencode/commands/board-plain.md -o ~/.config/opencode/commands/board-plain.md
  opencode mcp add chess --global -- npx -y tuichess mcp
  ```
- **opencode graphical board** (opencode 2.0.20 or later; a plugin, [`opencode/plugin/`](opencode/plugin)): `/chess` (or `/board`) opens a full-screen board with big pieces, like the Claude Code pane. Use the arrow keys and Enter or Space, or type a move like `e2e4`. The other keys are `u` undo, `i` hint, `t` flip, `+`/`-` level, `l` letters, `m` menu and Esc back. While a game is on, the session sidebar shows a small board. The agent sees and plays the same game through its `chess_board` tool, so you can ask "how's my position?" in the chat. To install it:
  ```sh
  mkdir -p ~/.config/opencode/plugins/tuichess
  curl -fsSL https://codeload.github.com/skelpo/chess/tar.gz/main | tar -xz -C ~/.config/opencode/plugins/tuichess --strip-components=3 chess-main/opencode/plugin
  opencode reload
  ```
  Then start opencode and type `/chess`. From a clone, `ln -s "$PWD/opencode/plugin" ~/.config/opencode/plugins/tuichess` works too. The board's game is saved in `~/.local/state/tuichess/opencode-board.json`, separate from the `/board-plain` game in the chat.
  To play people online, press `o` on the board (or type `/chess-online`). You get the same lobby, play-anyone queue, challenges and high scores as the terminal game, and the same username, kept in `~/.config/tuichess/accounts.json`. In the lobby, `p` plays anyone, `y`/`x` accept or decline a challenge, `m` opens the menu (challenge, resign, claim a draw), `r` resigns and `o` goes back to the engine game. The board shows both clocks (10 min + 5 s per move; out of time loses). In an online game the agent can read the board and the clocks, but won't give hints or move for you.
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

**Play online** in the pane's menu (or `online` in its move field) connects to a chess server. Pick a username: 3 to 20 letters, digits, `_` or `-`, first come, first served. There's no password; the plugin keeps a random token for the name in its store on this computer. The lobby offers **Play anyone**, which pairs you with the next waiting player (who waited longer plays White), and a list of who's online to **Challenge** by name. Incoming challenges show **Accept** and **Decline**. Every online game has a clock: 10 minutes per player plus 5 seconds per move. Running out of time loses, unless the opponent has only a king, or a king and one bishop or knight, which makes it a draw. There's no chat. A player who's been gone from a game for 10 minutes loses it. No takebacks or hints online, and Claude's chess tools refuse to touch an online game while it's in progress.

The **high scores** list the top 20 players by wins (then fewer losses, then more draws). Only games of at least 10 half-moves count, so instant resignations don't farm wins. Usernames are free, so someone can still play two of their own accounts against each other; the table is for fun, not a rating.

The hosted server is `https://api.tuichess.dev`, with high scores, install steps and docs at [tuichess.dev](https://tuichess.dev). To test against a local server, start Claude Code with `TUICHESS_SERVER=http://127.0.0.1:8787` (the terminal game reads the same variable).

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

## Performance

Node, Bun, Perry and other TypeScript-to-native compilers were measured on this engine and terminal game: startup, memory, search speed and binary size, and where Perry's generated code is slower than JIT-compiled JavaScript. The full write-up, with reproduction steps, is in [`docs/perry-research.md`](docs/perry-research.md).
