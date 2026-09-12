/**
 * AI controller tests — the JavaScript counterparts of the desktop project's
 * `test_ai.py`. They also prove that the browser search picks the same
 * tactical moves as the Python implementation.
 *
 * Run with: node --test tests
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AlphaBetaAI, RandomAI } from '../js/ai.js';
import { Cell, GameState } from '../js/engine.js';

test('the random AI returns a legal move without mutating the state', () => {
  const state = new GameState([[Cell.OPEN, Cell.CLOSED, Cell.OPEN]]);
  const before = state.positionKey();
  const move = new RandomAI(7).chooseMove(state);
  assert.ok(state.legalMoves().some(([x, y]) => x === move[0] && y === move[1]));
  assert.equal(state.positionKey(), before);
});

test('the search AI takes an immediate win', () => {
  const state = new GameState([[Cell.A, Cell.A, Cell.A, Cell.OPEN]], Cell.A);
  const move = new AlphaBetaAI({ maxDepth: 2, timeLimitMs: 2000 }).chooseMove(state);
  assert.deepEqual(move, [3, 0]);
});

test('the search AI blocks an immediate loss', () => {
  const state = new GameState(
    [
      [Cell.B, Cell.B, Cell.B, Cell.OPEN],
      [Cell.OPEN, Cell.CLOSED, Cell.CLOSED, Cell.CLOSED],
    ],
    Cell.A,
  );
  const move = new AlphaBetaAI({ maxDepth: 2, timeLimitMs: 2000 }).chooseMove(state);
  assert.deepEqual(move, [3, 0]);
});

test('the search AI prefers a tenacious defence in a lost position', () => {
  // A is lost no matter what, but blocking (3, 3) delays B's forced win to a
  // second move (a fork with three winning replies), while every other move
  // lets B win immediately. The move (2, 7), which creates two open threes
  // for A, is statically most attractive, so a search that ties all losses
  // together would wrongly pick it.
  const board = Array.from({ length: 9 }, () => new Array(12).fill(Cell.CLOSED));
  // B's immediate threat: row 3 is B B B + open at (3, 3).
  board[3][0] = board[3][1] = board[3][2] = Cell.B;
  board[3][3] = Cell.OPEN;
  // B's fork material: row 1 = OPEN B OPEN B OPEN and column 2 = OPEN B B,
  // so playing (2, 1) creates winning squares (0, 1), (4, 1) and (2, 0).
  board[1][1] = board[1][3] = Cell.B;
  board[1][0] = board[1][2] = board[1][4] = Cell.OPEN;
  board[2][2] = Cell.B;
  board[3][2] = Cell.B;
  board[0][2] = Cell.OPEN;
  // A's tempting (but blundering) move: playing (2, 7) creates two open
  // threes along row 7 and column 2.
  board[7][1] = board[7][3] = Cell.A;
  board[5][2] = board[6][2] = Cell.A;
  board[7][0] = board[7][2] = board[7][4] = Cell.OPEN;
  board[4][2] = board[8][2] = Cell.OPEN;

  const state = new GameState(board, Cell.A);
  const move = new AlphaBetaAI({ maxDepth: 4, timeLimitMs: 10000, candidateLimit: 4000 }).chooseMove(state);
  assert.deepEqual(move, [3, 3]);
});

test('the search AI respects a tight candidate limit', () => {
  const state = new GameState(Array.from({ length: 9 }, () => new Array(12).fill(Cell.OPEN)), Cell.A);
  const ai = new AlphaBetaAI({ maxDepth: 3, timeLimitMs: 3000, candidateLimit: 100 });
  const move = ai.chooseMove(state);
  assert.ok(state.isLegalMove(move[0], move[1]));
  assert.ok(ai.lastNodes > 0);
  assert.ok(ai.lastNodes < 200000, `unexpectedly large search: ${ai.lastNodes} nodes`);
});

test('search settings are clamped to the documented ranges', () => {
  const ai = new AlphaBetaAI({ maxDepth: 99, timeLimitMs: 1, candidateLimit: 10 });
  assert.equal(ai.maxDepth, 12);
  assert.equal(ai.timeLimitMs, 100);
  assert.equal(ai.candidateLimit, 100);
});
