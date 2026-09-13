/**
 * Platform-independent logic for the online build.
 *
 * The rules engine (`../js/engine.js`) is reused unchanged: the backend only
 * stores the room definition plus the ordered list of moves, and every client
 * rebuilds the position by replaying that list. Late joins, refreshes and
 * reconnects therefore need no special handling — and the client can never
 * disagree with the rules, because there is only one implementation.
 */

import { normalizeBoardDefinition, openCount, presetBoards } from '../js/boards.js';
import { Cell, GameState } from '../js/engine.js';

/** Rooms start from the bundled initial board unless the host picks another. */
export const ONLINE_BOARD_ID = '0';
export const SIDES = [Cell.A, Cell.B];

/** Who gets the first move: `first` = A (blue, moves first). */
export const SIDE_CHOICES = ['first', 'second', 'random'];
export const SIDE_CHOICE_LABELS = {
  first: '我执先手（A 方 · 蓝）',
  second: '我执后手（B 方 · 红）',
  random: '随机决定',
};

export const EVENT = {
  UNDO_REQUEST: 'undo_request',
  UNDO_DONE: 'undo_done',
  UNDO_DECLINED: 'undo_declined',
};

export function defaultBoard() {
  const boards = presetBoards();
  return boards.find((board) => board.id === ONLINE_BOARD_ID) || boards[0];
}

export function sideLabel(side) {
  return Number(side) === Cell.A ? 'A' : 'B';
}

export function otherSide(side) {
  return Number(side) === Cell.A ? Cell.B : Cell.A;
}

export function sideName(side) {
  return Number(side) === Cell.A ? '先手（A · 蓝）' : '后手（B · 红）';
}

/* --------------------------------------------------------------- identity */

/** Short, unambiguous room code (no I/O/0/1 to avoid typos when read aloud). */
export function randomRoomCode(length = 4) {
  return randomFromAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', length);
}

/** Secret that marks the room creator; only their link/storage carries it. */
export function randomToken(length = 24) {
  return randomFromAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', length);
}

function randomFromAlphabet(alphabet, length) {
  const values = new Uint32Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < length; i += 1) values[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let text = '';
  for (let i = 0; i < length; i += 1) text += alphabet[values[i] % alphabet.length];
  return text;
}

/** The host picks who moves first; the joiner always gets the other side. */
export function resolveHostSide(choice, random = Math.random) {
  if (choice === 'second') return Cell.B;
  if (choice === 'random') return random() < 0.5 ? Cell.A : Cell.B;
  return Cell.A;
}

export function isHost({ room, storedToken = null, urlToken = null } = {}) {
  const token = room && room.host_token;
  if (!token) return false;
  return Boolean((storedToken && storedToken === token) || (urlToken && urlToken === token));
}

export function sideForRole(room, host) {
  const hostSide = Number(room && room.host_side) === Cell.B ? Cell.B : Cell.A;
  return host ? hostSide : otherSide(hostSide);
}

export function boardFromRoom(room) {
  const raw = room && room.board;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return normalizeBoardDefinition(data, '房间棋盘');
}

export function boardSummary(board) {
  return `${board.name} · ${board.width}×${board.height} · 可走 ${openCount(board)} 格`;
}

/* ------------------------------------------------------------------ moves */

/** Normalise whatever the backend returned into ordered move objects. */
export function sortMoves(list) {
  return (list || [])
    .map((row) => ({
      move_index: Number(row.move_index),
      side: Number(row.side),
      x: Number(row.x),
      y: Number(row.y),
    }))
    .filter((row) => Number.isInteger(row.move_index) && Number.isInteger(row.x) && Number.isInteger(row.y))
    .sort((a, b) => a.move_index - b.move_index);
}

/**
 * Replay a move list into a `GameState`.
 *
 * @returns {{state: GameState, rows: object[], applied: number, error: string|null}}
 *   On error, `state` holds the position after the last valid move.
 */
export function rebuild(list, board = defaultBoard()) {
  const rows = sortMoves(list);
  const state = new GameState(board.content);
  let applied = 0;
  for (const row of rows) {
    if (row.move_index !== applied) {
      return { state, rows, applied, error: `手数不连续：期望第 ${applied + 1} 手，收到第 ${row.move_index + 1} 手` };
    }
    if (row.side !== state.sideToMove) {
      return { state, rows, applied, error: `第 ${applied + 1} 手应由 ${sideLabel(state.sideToMove)} 方落子` };
    }
    if (!state.isLegalMove(row.x, row.y)) {
      return { state, rows, applied, error: `第 ${applied + 1} 手 (${row.x}, ${row.y}) 不是可落子格` };
    }
    state.makeMove(row.x, row.y);
    applied += 1;
  }
  return { state, rows, applied, error: null };
}

/** The move the given history is waiting for (index + side to play). */
export function nextMove(list, board = defaultBoard()) {
  const { state, applied, error } = rebuild(list, board);
  return { state, error, move: { move_index: applied, side: state.sideToMove } };
}

/* ----------------------------------------------------------------- events */

export function sortEvents(list) {
  return (list || [])
    .map((row) => ({
      id: Number(row.id),
      kind: String(row.kind || ''),
      side: Number(row.side),
      target: row.target === null || row.target === undefined ? null : Number(row.target),
    }))
    .sort((a, b) => a.id - b.id);
}

export function latestEvent(list) {
  const events = sortEvents(list);
  return events.length ? events[events.length - 1] : null;
}

/**
 * The undo request waiting for an answer, if any.
 *
 * The requester always asks while it is their own turn, so the request keeps
 * exactly one or two moves (their own move, or the opponent's reply plus their
 * own move). Anything else means somebody played instead of answering, and the
 * request is stale.
 */
export function pendingUndo(list, moveCount) {
  const last = latestEvent(list);
  if (!last || last.kind !== EVENT.UNDO_REQUEST) return null;
  if (!Number.isInteger(last.target) || last.target < 0) return null;
  const removeCount = Number(moveCount) - last.target;
  if (removeCount !== 1 && removeCount !== 2) return null;
  return { id: last.id, side: last.side, target: last.target, removeCount };
}

/**
 * What a fair undo means for the side asking.
 *
 * 悔棋 always returns the turn to the requester:
 *   - requester just moved (opponent to move) -> take back that single move;
 *   - opponent already answered (requester to move) -> take back both plies,
 *     so the requester is back at the position where they blundered.
 *
 * @returns {{target: number, removeCount: number, moveCount: number}|null}
 *   `null` when the requester has no move of their own yet.
 */
export function undoPlan(moves, requester) {
  const list = sortMoves(moves);
  if (!list.length) return null;
  const own = list.filter((move) => move.side === Number(requester)).length;
  if (own === 0) return null;
  const last = list[list.length - 1];
  const removeCount = last.side === Number(requester) ? 1 : 2;
  return {
    target: Math.max(0, list.length - removeCount),
    removeCount,
    moveCount: list.length,
  };
}

/* ---------------------------------------------------------------- display */

export function buildInviteUrl({ origin, pathname, room, url = null, key = null, hostToken = null }) {
  const invite = new URL(pathname, origin);
  invite.searchParams.set('room', room);
  if (url) invite.searchParams.set('url', url);
  if (key) invite.searchParams.set('key', key);
  if (hostToken) invite.searchParams.set('host', hostToken);
  return invite.toString();
}

/** Human-readable summary used by the status bar. */
export function describe(state, mySide) {
  if (state.winner !== null) return `${sideLabel(state.winner)} 方四连获胜！`;
  if (state.isDraw) return '和棋：已经没有可落子格';
  if (mySide === null) return `轮到 ${sideLabel(state.sideToMove)} 方落子`;
  if (state.sideToMove === mySide) return '轮到你落子';
  return `等待 ${sideLabel(state.sideToMove)} 方落子…`;
}
