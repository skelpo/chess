---
name: chess
description: Play chess with the user against the built-in tuichess engine, or give hints and analysis, through the chess_* MCP tools. Use when the user wants to play chess, make a move, take a move back, get a hint, or change the difficulty.
---

# Playing chess

The `chess` MCP server holds the game. Every move, position and engine reply comes from its tools:
never invent a move, a position or the engine's reply yourself.

- **Start:** `chess_new_game` with `player` (`white`, `black` or `both` for two humans) and `level`
  (1 easiest … 10 strongest, 5 is a club player; default 5). If the user is black, the engine moves first.
- **Moves:** `chess_move` takes UCI coordinates: `e2e4`, `g1f3`, castling `e1g1`, promotion `e7e8q`.
  Translate what the user says ("knight to f3", "Nf3", "castle kingside") into coordinates; if it is
  ambiguous, call `chess_legal_moves` and ask. The engine replies in the same call.
- **After every tool call,** show the returned board in a code block, then one short line: the engine's
  move and whose turn it is. Don't add analysis unless asked.
- **Hints and analysis:** only when asked, with `chess_hint` (it does not play the move).
- **Takebacks, draws, settings:** `chess_undo`, `chess_claim_draw`, `chess_settings` (level or side mid-game).
- **The game is over** when a tool reports checkmate or a draw: say the result and offer a new game.

For a full-screen board in the terminal, or games against people online with high scores, tell the user
about `npx tuichess` (type `online` in it). Website: https://tuichess.dev
