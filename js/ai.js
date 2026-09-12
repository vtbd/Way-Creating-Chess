/**
 * AI controllers for Way Creating Chess.
 *
 * A port of the desktop `ai.py`: `RandomAI` picks a legal move uniformly and
 * `AlphaBetaAI` runs iterative-deepening minimax with alpha-beta pruning.
 * Neither controller ever mutates the state it is given, so the same objects
 * work in a Web Worker and on the main thread.
 */

import { Cell, GameState, otherPlayer } from './engine.js';

/** User-editable limits for `AlphaBetaAI`, adjustable from the AI panel. */
export const DEFAULT_SEARCH_SETTINGS = Object.freeze({
  maxDepth: 5,
  timeLimitMs: 1500,
  candidateLimit: 400,
});

export const SEARCH_LIMITS = Object.freeze({
  maxDepth: { min: 1, max: 12, step: 1 },
  timeLimitMs: { min: 100, max: 60000, step: 100 },
  candidateLimit: { min: 100, max: 20000, step: 100 },
});

export function clampSettings(settings = {}) {
  const clamp = (value, { min, max }, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  return {
    maxDepth: clamp(settings.maxDepth, SEARCH_LIMITS.maxDepth, DEFAULT_SEARCH_SETTINGS.maxDepth),
    timeLimitMs: clamp(settings.timeLimitMs, SEARCH_LIMITS.timeLimitMs, DEFAULT_SEARCH_SETTINGS.timeLimitMs),
    candidateLimit: clamp(
      settings.candidateLimit,
      SEARCH_LIMITS.candidateLimit,
      DEFAULT_SEARCH_SETTINGS.candidateLimit,
    ),
  };
}

/** High-resolution clock where available (browsers and Node). */
export function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Deterministic 32-bit RNG so seeded AI games can be replayed. */
export function makeRandom(seed = null) {
  let state = seed === null || seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : Number(seed) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base class for a controller that selects a move for the current side. */
export class ChessAI {
  constructor(name) {
    this.name = name;
  }

  /** @returns {number[]} one legal `[x, y]` move without changing `state`. */
  chooseMove() {
    throw new Error('chooseMove must be implemented');
  }
}

/** Placeholder AI that uniformly chooses one of the legal moves. */
export class RandomAI extends ChessAI {
  constructor(seed = null) {
    super('随机 AI');
    this._random = makeRandom(seed);
  }

  chooseMove(state) {
    const moves = state.legalMoves();
    if (moves.length === 0) {
      throw new Error('cannot choose a move in a terminal position');
    }
    return moves[Math.floor(this._random() * moves.length) % moves.length];
  }
}

class SearchTimeout extends Error {}

/**
 * A tactical AI using iterative-deepening minimax and alpha-beta pruning.
 *
 * The evaluation favours immediate four-in-a-row threats, then open two- and
 * three-stone patterns. Move ordering gives priority to winning moves and to
 * moves that create new roads. Terminal scores are mate-distance adjusted, so
 * forced wins prefer the fastest line while a lost position prefers the
 * defence that delays the loss longest.
 */
export class AlphaBetaAI extends ChessAI {
  static WIN_SCORE = 1_000_000;
  static PATTERN_WEIGHTS = Object.freeze([0, 4, 28, 550, 1_000_000]);

  constructor(settings = {}) {
    super('思考型 AI');
    const limits = clampSettings({ ...DEFAULT_SEARCH_SETTINGS, ...settings });
    this.maxDepth = limits.maxDepth;
    this.timeLimitMs = limits.timeLimitMs;
    this.candidateLimit = limits.candidateLimit;
    this.lastCompletedDepth = 0;
    this.lastScore = 0;
    this.lastNodes = 0;
    this.lastElapsedMs = 0;
  }

  /** Push new search limits, e.g. after the user edits the AI panel. */
  applySettings(settings) {
    const limits = clampSettings({ ...this, ...settings });
    this.maxDepth = limits.maxDepth;
    this.timeLimitMs = limits.timeLimitMs;
    this.candidateLimit = limits.candidateLimit;
  }

  chooseMove(state) {
    const moves = state.legalMoves();
    if (moves.length === 0) {
      throw new Error('cannot choose a move in a terminal position');
    }

    // Search only a private copy, preserving the ChessAI contract.
    const position = state.clone();
    const perspective = position.sideToMove;
    const started = now();
    const deadline = started + this.timeLimitMs;
    this.lastCompletedDepth = 0;
    this.lastNodes = 0;
    let bestMove = moves[0];
    let bestScore = -AlphaBetaAI.WIN_SCORE;

    // Iterative deepening guarantees a sensible legal move even if a later
    // iteration reaches the time limit.
    for (let depth = 1; depth <= this.maxDepth; depth += 1) {
      let score;
      let move;
      try {
        [score, move] = this._search(position, depth, -AlphaBetaAI.WIN_SCORE * 2, AlphaBetaAI.WIN_SCORE * 2, perspective, deadline, 0);
      } catch (error) {
        if (error instanceof SearchTimeout) break;
        throw error;
      }
      if (move !== null) {
        bestMove = move;
        bestScore = score;
        this.lastCompletedDepth = depth;
      }
      // Losses are deliberately searched deeper: the most tenacious defence
      // is the one that delays the loss longest.
      if (score >= AlphaBetaAI.WIN_SCORE - this.maxDepth) break;
    }

    this.lastScore = bestScore;
    this.lastElapsedMs = Math.round(now() - started);
    return bestMove;
  }

  _search(state, depth, alpha, beta, perspective, deadline, plies) {
    this.lastNodes += 1;
    if (now() >= deadline) throw new SearchTimeout();
    if (state.winner !== null || state.isDraw) {
      return [this._terminalScore(state, perspective, plies), null];
    }
    if (depth === 0) return [this._evaluate(state, perspective), null];

    const moves = this._orderedMoves(state, perspective);
    if (moves.length === 0) return [this._evaluate(state, perspective), null];

    const win = AlphaBetaAI.WIN_SCORE;
    const maximizing = state.sideToMove === perspective;
    let bestMove = null;
    let bestScore = maximizing ? -win * 2 : win * 2;

    for (const [mx, my] of moves) {
      state.makeMove(mx, my);
      let score;
      try {
        [score] = this._search(state, depth - 1, alpha, beta, perspective, deadline, plies + 1);
      } finally {
        // A timeout must not leave the private search position altered.
        state.undoMove();
      }
      if (maximizing) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = [mx, my];
        }
        if (bestScore > alpha) alpha = bestScore;
      } else {
        if (score < bestScore) {
          bestScore = score;
          bestMove = [mx, my];
        }
        if (bestScore < beta) beta = bestScore;
      }
      if (beta <= alpha) break;
    }
    return [bestScore, bestMove];
  }

  /**
   * Score a terminal position, preferring faster wins and slower losses.
   * Encoding how many plies the outcome took lets tie-breaking distinguish
   * equally lost moves instead of falling back to move ordering.
   */
  _terminalScore(state, perspective, plies) {
    if (state.winner === perspective) return AlphaBetaAI.WIN_SCORE - plies;
    if (state.winner !== null) return plies - AlphaBetaAI.WIN_SCORE;
    return 0;
  }

  /** Order tactical moves first so alpha-beta can prune aggressively. */
  _orderedMoves(state, perspective) {
    const win = AlphaBetaAI.WIN_SCORE;
    const mover = state.sideToMove;
    const centerX = (state.width - 1) / 2;
    const centerY = (state.height - 1) / 2;
    const scored = [];
    for (const move of state.legalMoves()) {
      const [mx, my] = move;
      const played = state.makeMove(mx, my);
      let score;
      if (state.winner === mover) {
        score = win * 2;
      } else {
        score = this._evaluate(state, mover) + 35 * played.created.length;
        score -= Math.trunc(Math.abs(mx - centerX) + Math.abs(my - centerY));
      }
      state.undoMove();
      scored.push([score, move]);
    }
    // `list.sort(reverse=True)` on (score, move) tuples also orders ties by
    // descending coordinates; matching it keeps the port bit-for-bit equal.
    scored.sort((a, b) => b[0] - a[0] || b[1][0] - a[1][0] || b[1][1] - a[1][1]);
    return scored.slice(0, this.candidateLimit).map(([, move]) => move);
  }

  /** Evaluate every consecutive four-cell window from `perspective`. */
  _evaluate(state, perspective) {
    if (state.winner === perspective) return AlphaBetaAI.WIN_SCORE;
    if (state.winner !== null) return -AlphaBetaAI.WIN_SCORE;
    const opponent = otherPlayer(perspective);
    const width = state.width;
    const height = state.height;
    let score = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const endX = x + 3 * dx;
          const endY = y + 3 * dy;
          if (!state.inside(endX, endY)) continue;
          let own = 0;
          let enemy = 0;
          let closed = 0;
          for (let step = 0; step < 4; step += 1) {
            const value = state.cells[(y + step * dy) * width + (x + step * dx)];
            if (value === perspective) own += 1;
            else if (value === opponent) enemy += 1;
            else if (value === Cell.CLOSED) closed += 1;
          }
          score += this._windowScore(own, enemy, closed);
        }
      }
    }
    return score;
  }

  _windowScore(own, enemy, closed) {
    if (own && enemy) return 0;
    // Closed cells may become roads later, but cannot be played immediately;
    // discount rather than discard those longer-term possibilities.
    const discount = closed === 0 ? 1 : Math.pow(4, -closed);
    const weights = AlphaBetaAI.PATTERN_WEIGHTS;
    if (enemy === 0) return Math.trunc(weights[own] * discount);
    if (own === 0) return -Math.trunc(weights[enemy] * discount);
    return 0;
  }
}
