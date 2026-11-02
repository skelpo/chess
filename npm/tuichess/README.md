# tuichess

Chess in your terminal: play the built-in engine (10 levels) or people online, with high scores at
[tuichess.dev](https://tuichess.dev). One native binary, compiled from TypeScript with
[Perry](https://github.com/PerryTS/perry). No runtime dependencies.

```sh
npm install -g tuichess
tuichess            # play the engine
tuichess --online   # play people (or type "online" in the game)
```

Or without installing: `npx tuichess`.

## Playing

Move with the arrow keys and Space, or type a move such as `e2e4` and press Enter.
Type `help` in the game for every command.

```
tuichess --level 1..10 --side white|black|both --unicode --plain --no-color
```

## Online

Type `online`, pick a username (3 to 20 letters, digits, `_` or `-`) and type `play` to meet the next
player who is waiting, or `challenge <name>`. No password: your computer keeps the account in
`~/.config/tuichess/accounts.json`. Games of 10 or more half-moves count for the high scores.

## For AI agents

`tuichess mcp` serves the chess tools over stdio (Model Context Protocol), for Codex, opencode or any MCP client:

```sh
codex mcp add chess -- npx -y tuichess mcp
```

Builds: macOS (Apple silicon), Linux (x64, arm64). Intel Macs and Windows are waiting on a Perry fix; on Windows, use WSL. Source and the Claude Code plugin:
[github.com/skelpo/chess](https://github.com/skelpo/chess). MIT license.
