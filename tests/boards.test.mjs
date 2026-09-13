/**
 * Bundled-catalog and random-generation tests.
 *
 * Run with: node --test tests
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addSavedBoard,
  generateRandomBoard,
  importCatalog,
  loadSavedBoards,
  openCount,
  presetBoards,
} from '../js/boards.js';
import { Cell, GameState } from '../js/engine.js';

// Resolve relative to this file so the suite works from any working directory.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON_PROJECT = resolve(webRoot, '..', '..', 'Python', 'Way Creating Chess');

test('only the project default board is bundled as a preset', () => {
  const boards = presetBoards();
  assert.equal(boards.length, 1, 'the board library ships with the initial board only');
  for (const board of boards) {
    assert.equal(board.content.length, board.height);
    assert.equal(board.content[0].length, board.width);
    assert.ok(openCount(board) > 0, `${board.name} has no playable square`);
    // A definition must be loadable by the rules engine.
    new GameState(board.content);
  }
  assert.equal(boards[0].id, '0');
  assert.match(boards[0].name, /默认棋盘/);
});

test('the bundled preset matches OrBds.json from the desktop project', { skip: !existsSync(PYTHON_PROJECT) }, () => {
  const read = (file) => JSON.parse(readFileSync(resolve(PYTHON_PROJECT, file), 'utf8')).boards;
  const source = read('OrBds.json');
  const bundled = presetBoards();
  assert.equal(bundled.length, source.length);
  source.forEach((original, index) => {
    assert.deepEqual(bundled[index].content, original.content, `board ${original.id} differs`);
  });
  assert.equal(bundled[0].width, 12);
  assert.equal(bundled[0].height, 9);
});

test('random boards guarantee playable cells on every edge', () => {
  for (let seed = 0; seed < 12; seed += 1) {
    const board = generateRandomBoard({ width: 12, height: 9, density: 0.3, seed });
    assert.equal(board.width, 12);
    assert.equal(board.height, 9);
    const edges = [
      board.content[0],
      board.content[board.height - 1],
      board.content.map((row) => row[0]),
      board.content.map((row) => row[board.width - 1]),
    ];
    for (const edge of edges) {
      assert.ok(edge.filter((value) => value === Cell.OPEN).length >= 2, `edge of seed ${seed} is unreachable`);
    }
    new GameState(board.content);
  }
});

test('the same seed reproduces the same random board', () => {
  const first = generateRandomBoard({ width: 10, height: 8, density: 0.35, seed: 42 });
  const second = generateRandomBoard({ width: 10, height: 8, density: 0.35, seed: 42 });
  assert.deepEqual(first.content, second.content);
  const other = generateRandomBoard({ width: 10, height: 8, density: 0.35, seed: 43 });
  assert.notDeepEqual(first.content, other.content);
});

test('boards imported from the desktop JSON format load correctly', () => {
  const definitions = importCatalog(
    JSON.stringify({ boards: [{ id: 7, name: '导入', content: [[1, 0], [0, 1]] }] }),
  );
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].width, 2);
  assert.equal(definitions[0].height, 2);

  const matrix = importCatalog(JSON.stringify([[1, 1], [1, 0]]));
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].name, '导入棋盘');
});

test('saved boards round-trip through the in-memory catalog', () => {
  // Node has no localStorage, so this exercises the fallback path.
  const definition = {
    id: 'saved-test-1',
    name: '测试棋盘',
    width: 2,
    height: 2,
    content: [[1, 0], [0, 1]],
  };
  addSavedBoard(definition);
  const saved = loadSavedBoards();
  assert.ok(saved.some((board) => board.id === 'saved-test-1'));
  assert.deepEqual(saved.find((board) => board.id === 'saved-test-1').content, definition.content);
});
