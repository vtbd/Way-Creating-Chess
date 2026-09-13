/**
 * Tests for the online build.
 *
 * Part 1 covers the room logic (replay, roles, turn order, undo, invite
 * links). Part 2 runs the real page against an in-memory Supabase stand-in:
 * the host creates a room and plays, the guest joins from an invite link,
 * undo goes through request → approval, and a rematch swaps the sides.
 *
 * Run with: node --test tests/*.test.mjs
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Cell } from '../js/engine.js';
import {
  EVENT,
  boardFromRoom,
  buildInviteUrl,
  defaultBoard,
  isHost,
  nextMove,
  pendingUndo,
  randomRoomCode,
  rebuild,
  resolveHostSide,
  sideForRole,
  undoTargetFor,
} from '../online/online-core.js';
import { createSupabaseStore } from '../online/transports.js';
import { installDom } from './dom-shim.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fake = createFakeSupabase();
globalThis.fetch = fake.fetchImpl;

const settle = async (turns = 10) => {
  for (let i = 0; i < turns; i += 1) await new Promise((done) => setTimeout(done, 0));
};

let dom = null;
let el = () => null;

/** Install a fresh DOM and boot a fresh copy of the page module. */
async function startPage({ search = '', tag } = {}) {
  dom = installDom(webRoot, { page: 'online/index.html', search });
  el = (id) => dom.document.querySelector(`#${id}`);
  await import(`../online/online.js?instance=${tag}`);
  await settle();
  return dom;
}

const cellAt = (x, y) =>
  el('board')
    .querySelectorAll('.cell')
    .find((cell) => cell.dataset.x === String(x) && cell.dataset.y === String(y));

after(() => {
  if (el('leave')) el('leave').fire('click');
});

/* ------------------------------------------------------------------ core */

test('a move list replays into the same position as the solo engine', () => {
  const rows = [
    { move_index: 0, side: Cell.A, x: 0, y: 0 },
    { move_index: 1, side: Cell.B, x: 5, y: 0 },
  ];
  const { state, error, applied } = rebuild(rows);
  assert.equal(error, null);
  assert.equal(applied, 2);
  assert.equal(state.sideToMove, Cell.A);
  assert.equal(state.cellAt(0, 0), Cell.A);
  assert.equal(state.cellAt(5, 0), Cell.B);
  assert.equal(nextMove(rows).move.move_index, 2);
});

test('out-of-order rows are sorted, illegal rows are reported', () => {
  const { state, error } = rebuild([
    { move_index: 1, side: Cell.B, x: 5, y: 0 },
    { move_index: 0, side: Cell.A, x: 0, y: 0 },
  ]);
  assert.equal(error, null);
  assert.equal(state.sideToMove, Cell.A);
  assert.match(rebuild([{ move_index: 1, side: Cell.A, x: 0, y: 0 }]).error, /手数不连续/);
  assert.match(rebuild([{ move_index: 0, side: Cell.B, x: 0, y: 0 }]).error, /应由 A 方落子/);
  assert.match(rebuild([{ move_index: 0, side: Cell.A, x: 1, y: 0 }]).error, /不是可落子格/);
});

test('room codes are short, invite links carry url, key and room', () => {
  const code = randomRoomCode();
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.ok(!/[IO01]/.test(code));

  const invite = buildInviteUrl({
    origin: 'https://me.github.io',
    pathname: '/chess/online/',
    room: code,
    url: 'https://demo.supabase.co',
    key: 'anon-key',
  });
  assert.match(invite, /^https:\/\/me\.github\.io\/chess\/online\/\?room=/);
  assert.match(invite, /url=https%3A%2F%2Fdemo\.supabase\.co/);
  assert.match(invite, /key=anon-key/);
  assert.equal(/host=/.test(invite), false, 'the shared invite never carries host rights');

  const own = buildInviteUrl({
    origin: 'https://me.github.io',
    pathname: '/chess/online/',
    room: code,
    url: 'https://demo.supabase.co',
    key: 'anon-key',
    hostToken: 'secret',
  });
  assert.match(own, /host=secret/);
});

test('the host picks the first move and the joiner gets the other side', () => {
  assert.equal(resolveHostSide('first'), Cell.A);
  assert.equal(resolveHostSide('second'), Cell.B);
  assert.equal(resolveHostSide('random', () => 0.1), Cell.A);
  assert.equal(resolveHostSide('random', () => 0.9), Cell.B);
  assert.equal(resolveHostSide('anything-else'), Cell.A);

  assert.equal(sideForRole({ host_side: Cell.A }, true), Cell.A);
  assert.equal(sideForRole({ host_side: Cell.A }, false), Cell.B);
  assert.equal(sideForRole({ host_side: Cell.B }, true), Cell.B);
  assert.equal(sideForRole({ host_side: Cell.B }, false), Cell.A);
});

test('host rights require the token, and the board survives the round trip', () => {
  const room = { host_token: 'abc123', host_side: Cell.B, board: { content: [[1, 0], [0, 1]], name: '小棋盘' } };
  assert.equal(isHost({ room, storedToken: 'abc123' }), true);
  assert.equal(isHost({ room, urlToken: 'abc123' }), true);
  assert.equal(isHost({ room, storedToken: 'nope' }), false);
  assert.equal(isHost({ room }), false);
  assert.deepEqual(boardFromRoom(room).content, [[1, 0], [0, 1]]);
});

test('undo requests expire when somebody plays instead of answering', () => {
  const stored = { move_index: 0, side: Cell.A, x: 0, y: 0 };
  const request = { id: 7, kind: EVENT.UNDO_REQUEST, side: Cell.A, target: 0 };
  assert.equal(pendingUndo([], 1), null);
  assert.deepEqual(pendingUndo([request], 1), { id: 7, side: Cell.A, target: 0 });
  assert.equal(pendingUndo([request], 2), null, 'a follow-up move makes the request stale');
  assert.equal(pendingUndo([request, { id: 8, kind: EVENT.UNDO_DONE, side: Cell.B, target: 0 }], 1), null);
  assert.equal(undoTargetFor(3), 2);
  assert.equal(undoTargetFor(0), 0);
  assert.equal(stored.side, Cell.A);
});

test('the store speaks the documented REST dialect', async () => {
  const shape = createFakeSupabase();
  const store = createSupabaseStore({ url: 'https://demo.supabase.co/', key: 'eyJtest', room: 'ab12', fetchImpl: shape.fetchImpl });
  await store.createRoom({ board: { width: 1, height: 1, content: [[1]] }, hostToken: 'tok', hostSide: Cell.A });
  await store.listMoves(1);
  await store.appendMove({ game: 1, moveIndex: 0, side: Cell.A, x: 0, y: 0 });
  await store.appendEvent({ game: 1, kind: EVENT.UNDO_REQUEST, side: Cell.B, target: 0 });

  assert.equal(shape.calls[0].table, 'rooms');
  assert.equal(shape.calls[0].headers.apikey, 'eyJtest');
  assert.equal(shape.calls[0].headers.Authorization, 'Bearer eyJtest');
  assert.equal(shape.calls[0].body[0].code, 'AB12', 'room codes are upper-cased');
  assert.equal(shape.calls[1].params.get('order'), 'move_index.asc');
  assert.equal(shape.calls[1].params.get('game'), 'eq.1');
  assert.equal(shape.calls[2].headers.Prefer, 'return=minimal');

  const duplicate = await store.createRoom({ board: { width: 1, height: 1, content: [[1]] }, hostToken: 'tok', hostSide: Cell.A });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /已被占用/);
});

/* ------------------------------------------------------------- the page */

const SUPABASE_URL = 'https://demo.supabase.co';
const SUPABASE_KEY = 'eyJtest-key';

test('the host creates a room, keeps host controls and plays a move', async () => {
  await startPage({ tag: 'host' });

  // No local/offline mode any more: the setup card only offers cloud rooms.
  assert.match(el('sidebar').textContent, /创建房间/);
  assert.equal(el('sidebar').textContent.includes('本地标签页'), false);

  el('url').value = SUPABASE_URL;
  el('key').value = SUPABASE_KEY;
  el('room-input').value = 'HOST1';
  el('host-side').value = 'first';
  el('create-room').fire('click');
  await settle();

  const room = fake.room('HOST1');
  assert.ok(room, 'the room row is created');
  assert.equal(room.host_side, Cell.A);
  assert.equal(room.game, 1);
  assert.equal(room.board.width, 12);
  assert.ok(room.host_token);

  assert.match(el('role-line').textContent, /房主/);
  assert.match(el('role-line').textContent, /先手/);
  assert.ok(el('clear-room'), 'the host keeps the destructive controls');
  assert.ok(el('rematch'), 'the host has the rematch controls');

  const invite = el('invite').value;
  assert.match(invite, /room=HOST1/);
  assert.match(invite, /url=https%3A%2F%2Fdemo\.supabase\.co/);
  assert.match(invite, /key=eyJtest-key/, 'the joiner gets the connection info from the link');
  assert.equal(/host=/.test(invite), false, 'host rights are never shared');

  assert.ok(cellAt(0, 0).classList.contains('is-legal'));
  cellAt(0, 0).fire('pointerdown', { button: 0 });
  await settle();
  assert.equal(fake.movesOf('HOST1').length, 1);
  assert.equal(fake.movesOf('HOST1')[0].side, Cell.A);
  assert.equal(el('stat-moves').textContent, '1');
});

test('a move by the other player is picked up on sync', async () => {
  fake.injectMove({ room: 'HOST1', moveIndex: 1, side: Cell.B, x: 5, y: 0 });
  el('sync').fire('click');
  await settle();

  assert.equal(el('stat-moves').textContent, '2');
  assert.match(el('status-line').textContent, /轮到你落子/);
  assert.equal(el('history').querySelectorAll('.history-item').length, 2);
});

test('the host can approve an undo request from the opponent', async () => {
  fake.injectEvent({ room: 'HOST1', kind: EVENT.UNDO_REQUEST, side: Cell.B, target: 1 });
  el('sync').fire('click');
  await settle();

  assert.equal(el('undo-prompt').classList.contains('hidden'), false, 'the prompt is shown to the other side');
  assert.match(el('undo-text').textContent, /请求撤销/);
  el('undo-accept').fire('click');
  await settle();

  assert.equal(fake.movesOf('HOST1').length, 1, 'the last move is removed');
  assert.equal(el('stat-moves').textContent, '1');
  assert.match(el('notice').textContent, /同意撤销|已被同意/);
});

test('the invited side joins from the link, gets the other side and no host controls', async () => {
  el('leave').fire('click');
  const search = `?room=HOST1&url=${encodeURIComponent(SUPABASE_URL)}&key=${SUPABASE_KEY}`;
  await startPage({ tag: 'guest', search });

  assert.match(el('role-line').textContent, /受邀方/);
  assert.match(el('role-line').textContent, /后手/, 'the joiner automatically takes the other side');
  assert.equal(el('clear-room'), null, 'the joiner has no destructive controls');
  assert.equal(el('url'), null, 'the joiner never sees the project URL input');
  assert.equal(el('key'), null, 'the joiner never sees the anon key input');
  assert.equal(el('result-host').classList.contains('hidden'), true, 'rematch stays with the host');
  assert.equal(el('stat-moves').textContent, '1');

  // It is B's turn, so the joiner may play.
  const target = cellAt(5, 0);
  assert.ok(target.classList.contains('is-legal'));
  target.fire('pointerdown', { button: 0 });
  await settle();
  assert.equal(fake.movesOf('HOST1').length, 2);
  assert.equal(fake.movesOf('HOST1')[1].side, Cell.B);

  // And they can ask for an undo, which the host has to approve.
  const before = fake.eventsOf('HOST1').filter((event) => event.kind === EVENT.UNDO_REQUEST).length;
  el('undo-request').fire('click');
  await settle();
  const requests = fake.eventsOf('HOST1').filter((event) => event.kind === EVENT.UNDO_REQUEST);
  assert.equal(requests.length, before + 1, 'the joiner can file an undo request');
  assert.equal(requests[requests.length - 1].side, Cell.B);
  assert.equal(requests[requests.length - 1].target, 1);
  assert.match(el('undo-status').textContent, /等待对手回应/);
});

test('a custom board, a finished game and a rematch that swaps sides', async () => {
  el('leave').fire('click');
  await startPage({ tag: 'host2' });

  el('url').value = SUPABASE_URL;
  el('key').value = SUPABASE_KEY;
  el('room-input').value = 'JSON1';
  el('board-source').value = 'json';
  el('board-source').fire('change');
  el('board-json').value = JSON.stringify({
    id: 'custom-4',
    name: '4×4 测试棋盘',
    content: [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
  });
  el('board-json').fire('input');
  el('host-side').value = 'first';
  el('create-room').fire('click');
  await settle();

  const room = fake.room('JSON1');
  assert.ok(room);
  assert.equal(room.board.width, 4, 'the pasted board is stored in the room');
  assert.equal(el('board').querySelectorAll('.cell').length, 16);

  // A wins row 0 while B answers on row 3.
  const play = async (x, y) => {
    cellAt(x, y).fire('pointerdown', { button: 0 });
    await settle();
  };
  await play(0, 0);
  fake.injectMove({ room: 'JSON1', moveIndex: 1, side: Cell.B, x: 0, y: 3 });
  el('sync').fire('click');
  await settle();
  await play(1, 0);
  fake.injectMove({ room: 'JSON1', moveIndex: 3, side: Cell.B, x: 1, y: 3 });
  el('sync').fire('click');
  await settle();
  await play(2, 0);
  fake.injectMove({ room: 'JSON1', moveIndex: 5, side: Cell.B, x: 2, y: 3 });
  el('sync').fire('click');
  await settle();
  await play(3, 0);

  assert.equal(el('result-banner').classList.contains('hidden'), false, 'the result banner appears');
  assert.match(el('result-text').textContent, /A 方四连获胜/);
  assert.equal(el('result-host').classList.contains('hidden'), false, 'the host may start a new game');
  assert.equal(el('stat-result').textContent, 'A 胜');

  el('rematch-swap').fire('click');
  await settle();

  assert.equal(fake.room('JSON1').game, 2, 'the rematch bumps the game number');
  assert.equal(fake.room('JSON1').host_side, Cell.B, 'the sides are swapped');
  assert.equal(el('stat-moves').textContent, '0');
  assert.match(el('role-line').textContent, /房主/);
  assert.match(el('role-line').textContent, /后手/, 'the host now plays second');
  assert.equal(el('result-banner').classList.contains('hidden'), true);
  assert.ok(cellAt(0, 0).classList.contains('is-legal') === false, 'it is A\'s turn, not the host\'s');
});
