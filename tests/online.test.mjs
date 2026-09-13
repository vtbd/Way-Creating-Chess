/**
 * Tests for the online test build: room logic, both transports, and a
 * headless run of `online/index.html` against the DOM shim (two players in
 * one process, using the local tab-to-tab transport).
 *
 * Run with: node --test tests/*.test.mjs
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Cell } from '../js/engine.js';
import { buildInviteUrl, defaultBoard, nextMove, randomRoomCode, rebuild } from '../online/online-core.js';
import { createLocalTransport, createSupabaseTransport } from '../online/transports.js';
import { installDom } from './dom-shim.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dom = installDom(webRoot, { page: 'online/index.html' });
const { elements } = dom;

// Importing the page module runs its boot sequence against the shimmed DOM.
await import('../online/online.js');

// Leaving the room stops the page's polling timer so the test process exits.
after(() => {
  elements.get('leave').fire('click');
});

const settle = async (turns = 6) => {
  for (let i = 0; i < turns; i += 1) await new Promise((done) => setTimeout(done, 0));
};
const cellAt = (x, y) =>
  elements.get('board')
    .querySelectorAll('.cell')
    .find((cell) => cell.dataset.x === String(x) && cell.dataset.y === String(y));

/* ------------------------------------------------------------------ core */

test('a move list replays into the same position as the solo engine', () => {
  const rows = [
    { move_index: 0, side: Cell.A, x: 0, y: 0 },
    { move_index: 1, side: Cell.B, x: 5, y: 0 },
  ];
  const { state, error, applied } = rebuild(rows);
  assert.equal(error, null);
  assert.equal(applied, 2);
  assert.equal(state.moveHistory.length, 2);
  assert.equal(state.sideToMove, Cell.A);
  assert.equal(state.cellAt(0, 0), Cell.A);
  assert.equal(state.cellAt(5, 0), Cell.B);
  assert.equal(nextMove(rows).move.move_index, 2);
});

test('out-of-order rows are sorted before replay', () => {
  const rows = [
    { move_index: 1, side: Cell.B, x: 5, y: 0 },
    { move_index: 0, side: Cell.A, x: 0, y: 0 },
  ];
  const { state, error, applied } = rebuild(rows);
  assert.equal(error, null);
  assert.equal(applied, 2);
  assert.equal(state.sideToMove, Cell.A);
});

test('illegal, misplaced or wrong-side moves are reported', () => {
  assert.match(rebuild([{ move_index: 1, side: Cell.A, x: 0, y: 0 }]).error, /手数不连续/);
  assert.match(rebuild([{ move_index: 0, side: Cell.B, x: 0, y: 0 }]).error, /应由 A 方落子/);
  assert.match(rebuild([{ move_index: 0, side: Cell.A, x: 1, y: 0 }]).error, /不是可落子格/);
});

test('room codes stay short and unambiguous, invite links carry the room', () => {
  const code = randomRoomCode();
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.ok(!/[IO01]/.test(code), 'room codes avoid look-alike characters');

  const url = buildInviteUrl({
    origin: 'https://me.github.io',
    pathname: '/chess/online/',
    room: code,
    key: 'anon-key',
    side: Cell.B,
  });
  assert.match(url, /^https:\/\/me\.github\.io\/chess\/online\/\?room=/);
  assert.match(url, /side=B/);
  assert.match(url, /key=anon-key/);
});

test('the online room starts from the bundled initial board', () => {
  const board = defaultBoard();
  assert.equal(board.id, '0');
  assert.equal(board.width, 12);
  assert.equal(board.height, 9);
});

/* ------------------------------------------------------------ transports */

test('local transport appends, rejects duplicates and clears', async () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const transport = createLocalTransport('ROOM', { storage });
  assert.deepEqual(await transport.list(), []);
  assert.equal((await transport.append({ move_index: 0, side: Cell.A, x: 0, y: 0 })).ok, true);
  assert.equal((await transport.append({ move_index: 0, side: Cell.B, x: 1, y: 0 })).ok, false);
  assert.equal((await transport.list()).length, 1);
  await transport.clear();
  assert.deepEqual(await transport.list(), []);
});

test('supabase transport builds the documented REST calls', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return { ok: true, status: 201, text: async () => '' };
    return {
      ok: true,
      status: 200,
      json: async () => [{ move_index: 0, side: 2, x: 3, y: 1 }],
      text: async () => '',
    };
  };
  const transport = createSupabaseTransport({ url: 'https://demo.supabase.co/', key: 'eyJtest', room: 'AB12', fetchImpl });

  const rows = await transport.list();
  assert.equal(rows.length, 1);
  assert.equal(
    calls[0].url,
    'https://demo.supabase.co/rest/v1/moves?room=eq.AB12&select=move_index,side,x,y&order=move_index.asc',
  );
  assert.equal(calls[0].options.headers.apikey, 'eyJtest');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer eyJtest');

  const appended = await transport.append({ move_index: 1, side: Cell.B, x: 4, y: 5 });
  assert.equal(appended.ok, true);
  assert.deepEqual(JSON.parse(calls[1].options.body), [
    { room: 'AB12', move_index: 1, side: Cell.B, x: 4, y: 5 },
  ]);
  assert.equal(calls[1].options.headers.Prefer, 'return=minimal');
});

test('supabase transport reports conflicts and errors', async () => {
  const conflict = createSupabaseTransport({
    url: 'https://x.supabase.co',
    key: 'sb_publishable_x',
    room: 'R',
    fetchImpl: async () => ({ ok: false, status: 409, text: async () => 'duplicate key value' }),
  });
  const result = await conflict.append({ move_index: 0, side: Cell.A, x: 0, y: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /已被占用/);

  const failing = createSupabaseTransport({
    url: 'https://x.supabase.co',
    key: 'sb_publishable_x',
    room: 'R',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }),
  });
  await assert.rejects(() => failing.list(), /401.*invalid api key/);

  // Publishable keys (not JWTs) must not be sent as a Bearer token.
  let headers;
  const publishable = createSupabaseTransport({
    url: 'https://x.supabase.co',
    key: 'sb_publishable_x',
    room: 'R',
    fetchImpl: async (url, options) => {
      headers = options.headers;
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    },
  });
  await publishable.list();
  assert.equal(headers.apikey, 'sb_publishable_x');
  assert.equal(headers.Authorization, undefined);
});

/* --------------------------------------------------------------- the page */

test('the online page joins a local room and plays a move', async () => {
  elements.get('platform').value = 'local';
  elements.get('platform').fire('change');
  elements.get('room').value = 'TEST';
  elements.get('side').value = 'A';
  elements.get('join').fire('click');
  await settle();

  assert.match(elements.get('room-label').textContent, /房间 TEST/);
  assert.equal(elements.get('board').querySelectorAll('.cell').length, 108);
  assert.match(elements.get('status-line').textContent, /轮到你落子/);
  assert.match(elements.get('invite').value, /room=TEST/);
  assert.match(elements.get('transport-label').textContent, /本地/);

  const target = cellAt(0, 0);
  assert.ok(target.classList.contains('is-legal'));
  target.fire('pointerdown', { button: 0 });
  await settle();

  assert.equal(elements.get('stat-moves').textContent, '1');
  const stored = JSON.parse(dom.window.localStorage.getItem('wcc-online-room-TEST'));
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0] }, { move_index: 0, side: Cell.A, x: 0, y: 0 });
  assert.match(elements.get('status-line').textContent, /等待 B 方/);
});

test('a move made by the other player is picked up on sync', async () => {
  const key = 'wcc-online-room-TEST';
  const rows = JSON.parse(dom.window.localStorage.getItem(key));
  rows.push({ move_index: 1, side: Cell.B, x: 5, y: 0 });
  dom.window.localStorage.setItem(key, JSON.stringify(rows));

  elements.get('sync').fire('click');
  await settle();

  assert.equal(elements.get('stat-moves').textContent, '2');
  assert.match(elements.get('status-line').textContent, /轮到你落子/);
  assert.equal(elements.get('history').querySelectorAll('.history-item').length, 2);
  assert.equal(cellAt(5, 0).className.includes('is-b'), true);
});

test('clicking out of turn is refused, and the invite link can be copied', async () => {
  const key = 'wcc-online-room-TEST';
  const rows = JSON.parse(dom.window.localStorage.getItem(key));
  // Only A replies, so it becomes B's turn and A's clicks must be refused.
  rows.push({ move_index: 2, side: Cell.A, x: 11, y: 0 });
  dom.window.localStorage.setItem(key, JSON.stringify(rows));
  elements.get('sync').fire('click');
  await settle();

  // It is B's turn, so A's clicks are ignored with an explanation.
  cellAt(0, 1).fire('pointerdown', { button: 0 });
  await settle();
  assert.match(elements.get('notice').textContent, /还没轮到/);

  let copied = '';
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { copied = text; } } },
    configurable: true,
    writable: true,
  });
  elements.get('copy-invite').fire('click');
  await settle(3);
  assert.match(copied, /room=TEST/);
  assert.match(elements.get('notice').textContent, /已复制/);
});

test('clearing the room resets the board and leaving stops polling', async () => {
  elements.get('clear-room').fire('click');
  await settle();
  assert.equal(elements.get('stat-moves').textContent, '0');
  assert.match(elements.get('notice').textContent, /已清空/);

  elements.get('leave').fire('click');
  assert.match(elements.get('room-label').textContent, /未进入房间/);
  assert.equal(elements.get('stat-moves').textContent, '0');
});
