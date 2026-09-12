/**
 * Web Worker wrapper around `AlphaBetaAI`.
 *
 * The search runs off the main thread so a deep or long think never freezes
 * the page. The protocol is intentionally tiny: send a snapshot, receive one
 * legal move (or an error) tagged with the same request id.
 */

import { AlphaBetaAI } from './ai.js';
import { GameState } from './engine.js';

self.addEventListener('message', (event) => {
  const { id, board, sideToMove, settings } = event.data || {};
  try {
    const state = new GameState(board, sideToMove);
    const ai = new AlphaBetaAI(settings);
    const move = ai.chooseMove(state);
    self.postMessage({
      id,
      move,
      stats: {
        depth: ai.lastCompletedDepth,
        score: ai.lastScore,
        nodes: ai.lastNodes,
        elapsedMs: ai.lastElapsedMs,
      },
    });
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
});
