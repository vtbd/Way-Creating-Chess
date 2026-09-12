/**
 * Rules-engine regression tests — the JavaScript counterparts of the desktop
 * project's `test_game_engine.py`, so both builds prove the same behaviour.
 *
 * Run with: node --test tests
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Cell, GameState } from '../js/engine.js';

test('a move opens the road between two friendly stones, and undo restores it', () => {
  const state = new GameState([[Cell.A, Cell.CLOSED, Cell.CLOSED, Cell.CLOSED, Cell.OPEN]]);
  const played = state.makeMove(4, 0);

  assert.deepEqual(played.created, [
    [3, 0],
    [2, 0],
    [1, 0],
  ]);
  assert.deepEqual([...state.cells], [Cell.A, Cell.OPEN, Cell.OPEN, Cell.OPEN, Cell.A]);
  assert.equal(state.sideToMove, Cell.B);

  assert.equal(state.undoMove(), played);
  assert.deepEqual([...state.cells], [Cell.A, Cell.CLOSED, Cell.CLOSED, Cell.CLOSED, Cell.OPEN]);
  assert.equal(state.sideToMove, Cell.A);
});

test('an enemy stone blocks road creation', () => {
  const state = new GameState([[Cell.A, Cell.CLOSED, Cell.B, Cell.CLOSED, Cell.OPEN]]);
  const played = state.makeMove(4, 0);
  assert.deepEqual(played.created, []);
  assert.equal(state.cellAt(3, 0), Cell.CLOSED);
});

test('four in a row wins and stops future moves', () => {
  const state = new GameState([[Cell.A, Cell.A, Cell.A, Cell.OPEN]], Cell.A);
  state.makeMove(3, 0);
  assert.equal(state.winner, Cell.A);
  assert.equal(state.isGameOver, true);
  assert.deepEqual(state.legalMoves(), []);
  assert.equal(state.result, 'A wins');
  assert.deepEqual(state.winningLine(), [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
});

test('a five-stone line also counts as a win', () => {
  const state = new GameState([[Cell.A, Cell.A, Cell.A, Cell.A, Cell.A]]);
  assert.equal(state.winner, Cell.A);
  assert.equal(state.winningLine().length, 5);
});

test('the last open cell is a draw when it does not win', () => {
  const state = new GameState([[Cell.OPEN]]);
  state.makeMove(0, 0);
  assert.equal(state.isDraw, true);
  assert.equal(state.result, 'Draw');
  assert.equal(state.isGameOver, true);
});

test('clones are independent and the AI contract holds', () => {
  const state = new GameState([[Cell.OPEN, Cell.OPEN]]);
  const clone = state.clone();
  clone.makeMove(0, 0);
  assert.equal(state.cellAt(0, 0), Cell.OPEN);
  assert.equal(clone.cellAt(0, 0), Cell.A);
  assert.notEqual(state.positionKey(), clone.positionKey());
});

test('reset restores the initial position and clears history', () => {
  const state = new GameState([[Cell.OPEN, Cell.OPEN], [Cell.CLOSED, Cell.OPEN]]);
  state.makeMove(0, 0);
  state.makeMove(1, 0);
  state.reset();
  assert.equal(state.moveHistory.length, 0);
  assert.equal(state.sideToMove, Cell.A);
  assert.equal(state.winner, null);
  assert.equal(state.cellAt(0, 0), Cell.OPEN);
  assert.equal(state.cellAt(1, 0), Cell.OPEN);
});

test('diagonal neighbours never create roads', () => {
  const state = new GameState([
    [Cell.A, Cell.CLOSED],
    [Cell.CLOSED, Cell.OPEN],
  ]);
  const played = state.makeMove(1, 1);
  // The friendly stone at (0, 0) is diagonal, so nothing is opened; only the
  // four orthogonal directions can create roads.
  assert.deepEqual(played.created, []);
  assert.equal(state.cellAt(0, 1), Cell.CLOSED);
  assert.equal(state.cellAt(1, 0), Cell.CLOSED);
});

test('the exported record matches the desktop JSON layout', () => {
  const state = new GameState([[Cell.OPEN, Cell.OPEN]]);
  state.makeMove(0, 0);
  const record = state.exportRecord();
  assert.deepEqual(record.size, { width: 2, height: 1 });
  assert.equal(record.result, 'In progress');
  assert.deepEqual(record.moves, [
    { number: 1, player: 'A', move: [0, 0], notation: 'A:a1', created: [] },
  ]);
});
