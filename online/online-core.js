/**
 * Platform-independent logic for the online test build.
 *
 * The rules engine (`../js/engine.js`) is reused unchanged: the backend only
 * stores an ordered list of moves, and every client rebuilds the position by
 * replaying that list. Late joins, refreshes and reconnects therefore need no
 * special handling — and client and "server" can never disagree about the
 * rules, because it is literally the same code.
 */

import { presetBoards } from '../js/boards.js';
import { Cell, GameState } from '../js/engine.js';

/** The online test always starts from the bundled initial board. */
export const ONLINE_BOARD_ID = '0';
export const SIDES = [Cell.A, Cell.B];

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

/** Short, unambiguous room code (no I/O/0/1 to avoid typos when read aloud). */
export function randomRoomCode(length = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < length; i += 1) values[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let code = '';
  for (let i = 0; i < length; i += 1) code += alphabet[values[i] % alphabet.length];
  return code;
}

/** Invite link carrying the room code (and optionally the public API key). */
export function buildInviteUrl({ origin, pathname, room, key, side = null }) {
  const url = new URL(pathname, origin);
  url.searchParams.set('room', room);
  if (side !== null) url.searchParams.set('side', sideLabel(side));
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

/** Human-readable summary used by the status bar. */
export function describe(state, mySide) {
  if (state.winner !== null) return `${sideLabel(state.winner)} 方四连获胜！`;
  if (state.isDraw) return '和棋：已经没有可落子格';
  if (mySide === null) return `轮到 ${sideLabel(state.sideToMove)} 方落子`;
  if (state.sideToMove === mySide) return '轮到你落子';
  return `等待 ${sideLabel(state.sideToMove)} 方落子…`;
}
