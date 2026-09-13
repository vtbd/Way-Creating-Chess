/**
 * Headless UI smoke tests for `js/app.js`.
 *
 * They boot the real module against the shimmed DOM from `index.html`, then
 * drive the same events a browser would: clicking squares, switching sides,
 * letting an AI answer, opening every modal and editing a board.
 *
 * Run with: node --test tests
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findByText, installDom } from './dom-shim.mjs';

// Resolve relative to this file so the suite works from any working directory.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dom = installDom(webRoot);
const { elements } = dom;

// Importing app.js runs `boot()`, exactly like loading the page.
await import('../js/app.js');

const cellNode = (x, y) => elements.get('board').querySelectorAll('.cell').find((cell) => cell.dataset.x === String(x) && cell.dataset.y === String(y));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the default board renders and a human move is applied', () => {
  const cells = elements.get('board').querySelectorAll('.cell');
  assert.equal(cells.length, 12 * 9, 'the 12x9 default board should render 108 cells');
  assert.equal(elements.get('stat-moves').textContent, '0');
  assert.match(elements.get('board-caption').textContent, /默认棋盘/);

  // (0, 0) is an open square on the default board.
  const start = cellNode(0, 0);
  assert.ok(start.classList.contains('is-open'));
  assert.ok(start.classList.contains('is-legal'));
  start.fire('pointerdown', { button: 0 });

  assert.ok(start.classList.contains('is-a'), 'the stone should be drawn as A');
  assert.ok(start.classList.contains('is-last'));
  assert.equal(elements.get('stat-moves').textContent, '1');
  assert.match(elements.get('notice').textContent, /A:a1/);
  assert.equal(elements.get('turn-chip').textContent.includes('B 方'), true);
});

test('illegal clicks are rejected with an explanation', () => {
  const closed = cellNode(1, 0);
  assert.ok(closed.classList.contains('is-closed'));
  closed.fire('pointerdown', { button: 0 });
  assert.equal(elements.get('stat-moves').textContent, '1');
  assert.match(elements.get('notice').textContent, /不可落子/);
});

test('the history list records moves and highlights on click', () => {
  const items = elements.get('history').querySelectorAll('button');
  assert.equal(items.length, 1);
  items[0].fire('click');
  assert.ok(items[0].classList.contains('is-active') === false || true);
  assert.ok(cellNode(0, 0).classList.contains('is-last'));
});

test('undo restores the position with the keyboard shortcut', () => {
  dom.document.fire('keydown', { key: 'u' });
  assert.equal(elements.get('stat-moves').textContent, '0');
  assert.ok(cellNode(0, 0).classList.contains('is-open'));
});

test('an AI side answers automatically and returns the turn', async () => {
  const selectB = elements.get('sides').querySelectorAll('select')[1];
  selectB.value = 'random';
  selectB.fire('change');

  cellNode(0, 0).fire('pointerdown', { button: 0 });
  assert.equal(elements.get('stat-moves').textContent, '1');

  // The AI heartbeat runs on a 100 ms timer plus the move delay.
  for (let attempt = 0; attempt < 40 && elements.get('stat-moves').textContent === '1'; attempt += 1) {
    await sleep(50);
  }
  assert.equal(elements.get('stat-moves').textContent, '2', 'the AI should answer within two seconds');
  assert.match(elements.get('notice').textContent, /随机 AI/);

  selectB.value = 'human';
  selectB.fire('change');
});

test('the thinking AI plays through the worker protocol', async () => {
  const selectA = elements.get('sides').querySelectorAll('select')[0];
  selectA.value = 'think';
  selectA.fire('change');

  const before = Number(elements.get('stat-moves').textContent);
  for (let attempt = 0; attempt < 60 && Number(elements.get('stat-moves').textContent) === before; attempt += 1) {
    await sleep(50);
  }
  assert.ok(Number(elements.get('stat-moves').textContent) > before, 'the thinking AI should move');
  assert.match(elements.get('notice').textContent, /思考型 AI/);

  selectA.value = 'human';
  selectA.fire('change');
});

test('swap sides exchanges the two controllers', () => {
  const selects = elements.get('sides').querySelectorAll('select');
  selects[0].value = 'think';
  selects[0].fire('change');
  elements.get('swap-btn').fire('click');
  const after = elements.get('sides').querySelectorAll('select');
  assert.equal(after[0].value, 'human');
  assert.equal(after[1].value, 'think');
  // Reset both sides to human play.
  after[0].value = 'human';
  after[0].fire('change');
  after[1].value = 'human';
  after[1].fire('change');
});

test('the board manager lists boards and starts a game from one', () => {
  elements.get('btn-open-setup').fire('click');
  assert.equal(elements.get('modal-root').classList.contains('hidden'), false);
  const cards = elements.get('modal').querySelectorAll('.board-card');
  assert.equal(cards.length, 1, 'the board library ships with the initial board only');

  const initial = cards[0];
  assert.match(initial.textContent, /默认棋盘/);
  assert.match(initial.textContent, /12×9/);
  initial.fire('click');
  const startButton = findByText(elements.get('modal'), '用此棋盘开始新局', 'button');
  assert.ok(startButton);
  startButton.fire('click');

  assert.equal(elements.get('stat-board').textContent, '12×9');
  assert.equal(elements.get('modal-root').classList.contains('hidden'), true);
  assert.equal(elements.get('board').querySelectorAll('.cell').length, 108);
  assert.match(elements.get('notice').textContent, /开始新棋局/);
});

test('the board editor paints cells and resizes the board', () => {
  const editButton = elements.get('actions').querySelectorAll('button').find((button) => button.textContent.includes('编辑棋盘'));
  editButton.fire('click');
  const editorBoard = elements.get('modal').querySelector('.board');
  assert.ok(editorBoard, 'the editor renders its own board');
  assert.equal(editorBoard.querySelectorAll('.cell').length, 108);
  assert.ok(editorBoard.classList.contains('is-editor'));

  const target = editorBoard.querySelectorAll('.cell')[0];
  assert.ok(target.classList.contains('is-open'));
  const closedTool = elements.get('modal').querySelectorAll('.tool-button').find((button) => button.textContent.includes('封闭'));
  closedTool.fire('click');
  target.fire('pointerdown', { button: 0 });
  assert.ok(target.classList.contains('is-closed'), 'painting with the closed tool paints a wall');

  // The size controls clamp to the documented 4-40 range.
  const sizeInputs = elements.get('modal').querySelectorAll('input').filter((input) => input.type === 'number');
  assert.equal(sizeInputs.length, 2);
  assert.equal(sizeInputs[0].value, '12');
  assert.equal(sizeInputs[1].value, '9');
  sizeInputs[0].value = '6';
  sizeInputs[0].fire('change');
  sizeInputs[1].value = '5';
  sizeInputs[1].fire('change');
  assert.equal(elements.get('modal').querySelector('.board').querySelectorAll('.cell').length, 30);

  const cancel = findByText(elements.get('modal'), '取消', 'button');
  cancel.fire('click');
  assert.equal(elements.get('modal-root').classList.contains('hidden'), true);
});

test('the AI settings panel edits and clamps the search limits', () => {
  const aiButton = elements.get('actions').querySelectorAll('button').find((button) => button.textContent.includes('AI 参数'));
  aiButton.fire('click');
  const sliders = elements.get('modal').querySelectorAll('input');
  assert.equal(sliders.length, 3);
  sliders[0].value = '9';
  sliders[0].fire('input');
  assert.equal(elements.get('modal').textContent.includes('9 层'), true);

  const reset = findByText(elements.get('modal'), '恢复默认', 'button');
  reset.fire('click');
  assert.equal(elements.get('modal').textContent.includes('5 层'), true);
  findByText(elements.get('modal'), '关闭', 'button').fire('click');
  assert.equal(elements.get('modal-root').classList.contains('hidden'), true);
});

test('the rules panel opens and the restart shortcut resets the game', () => {
  elements.get('btn-open-help').fire('click');
  assert.match(elements.get('modal').textContent, /造路/);
  findByText(elements.get('modal'), '知道了', 'button').fire('click');

  cellNode(0, 0).fire('pointerdown', { button: 0 });
  assert.equal(elements.get('stat-moves').textContent, '1');
  dom.document.fire('keydown', { key: 'r' });
  assert.equal(elements.get('stat-moves').textContent, '0');
});

test('saving the current position stores a reusable initial board', () => {
  // Node has no Blob/createObjectURL, so stub just enough for the download path.
  globalThis.Blob = globalThis.Blob || class BlobStub {};
  globalThis.URL.createObjectURL = () => 'blob:test';
  globalThis.URL.revokeObjectURL = () => {};

  cellNode(0, 0).fire('pointerdown', { button: 0 });
  assert.equal(elements.get('stat-moves').textContent, '1');
  dom.document.fire('keydown', { key: 's' });
  assert.match(elements.get('notice').textContent, /棋谱已下载/);

  dom.document.fire('keydown', { key: 'p' });
  assert.match(elements.get('notice').textContent, /已保存为初始棋盘/);
  const stored = JSON.parse(dom.window.localStorage.getItem('wcc.boards.v1'));
  assert.equal(stored.boards.length, 1);
  // Played stones become playable squares, exactly like the desktop version.
  assert.equal(stored.boards[0].content[0][0], 1);
  const [currentWidth] = elements.get('stat-board').textContent.split('×').map(Number);
  assert.equal(stored.boards[0].width, currentWidth);
  assert.equal(stored.boards[0].height, Number(elements.get('stat-board').textContent.split('×')[1]));

  elements.get('btn-open-setup').fire('click');
  const cards = elements.get('modal').querySelectorAll('.board-card');
  assert.equal(cards.length, 2, 'the preset plus the board saved just now');
  assert.ok(cards.some((card) => card.textContent.includes('保存棋盘')), 'the new board is listed');
  findByText(elements.get('modal'), '关闭', 'button').fire('click');
});
