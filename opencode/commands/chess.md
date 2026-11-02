---
description: Play chess against the tuichess engine (/chess, /chess e4, /chess black level 3, /chess hint)
---

Use the `chess` MCP tools (chess_new_game, chess_move, chess_show, chess_legal_moves, chess_hint,
chess_undo, chess_claim_draw, chess_settings, chess_engine_move) for everything; never invent a move,
a position or the engine's reply.

The user typed: /chess $ARGUMENTS

- Nothing after /chess: if a game is in progress (check with chess_show), show it; otherwise start one
  with chess_new_game (player white, level 5) and show the board.
- "white", "black", "both" and/or "level N": start a new game with those settings via chess_new_game.
- A move ("e4", "Nf3", "e2e4", "castle", "O-O"): translate it to UCI coordinates (e2e4, g1f3, e1g1,
  e7e8q) and play it with chess_move; if ambiguous, call chess_legal_moves and ask.
- "hint", "undo", "draw", "show": chess_hint, chess_undo, chess_claim_draw, chess_show.

**Never choose or play the user's moves.** The user plays their side; the engine plays the other (it
replies inside chess_move). Call at most one move tool per user request, then stop and wait for the user.

After every tool call, show the returned board in a code block and one short line: the engine's move and
whose turn it is. No analysis unless asked. When a tool reports checkmate or a draw, say the result and
offer a new game.
