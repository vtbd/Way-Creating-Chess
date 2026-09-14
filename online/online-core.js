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
  CLOCK_TIMEOUT: 'clock_timeout',
};

/** Chess clock defaults: 10 minutes of main time and 90 s per move. */
export const CLOCK_DEFAULTS = { mainMs: 10 * 60 * 1000, moveMs: 90 * 1000 };
export const CLOCK_LIMITS = {
  mainMs: { min: 60 * 1000, max: 120 * 60 * 1000 },
  moveMs: { min: 10 * 1000, max: 10 * 60 * 1000 },
};
/** Both players ready -> a short countdown, then the clocks start running. */
export const COUNTDOWN_MS = 3000;

/** Roles inside a room. Only the host and the guest play; everyone else watches. */
export const ROLE = { HOST: 'host', GUEST: 'guest', SPECTATOR: 'spectator', KICKED: 'kicked' };
export const ROLE_LABELS = { host: '房主', guest: '对手', spectator: '观战', kicked: '已移出' };
/** A device counts as online while its heartbeat is younger than this. */
export const PRESENCE_TIMEOUT_MS = 5000;

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

/** The side a role plays, or `null` for spectators. */
export function sideForRoleName(room, role) {
  const hostSide = Number(room && room.host_side) === Cell.B ? Cell.B : Cell.A;
  if (role === ROLE.HOST) return hostSide;
  if (role === ROLE.GUEST) return otherSide(hostSide);
  return null;
}

/**
 * The opponent seat may only be changed between games: while a game is live
 * (clock running) the host cannot swap, demote or remove the opponent.
 */
export function rosterLocked(readiness, outcome) {
  const live = Boolean(readiness && readiness.live);
  const over = Boolean(outcome && outcome.over);
  return live && !over;
}

/* ------------------------------------------------------------- presence */

/** Members whose heartbeat is fresh enough to count as online. */
export function activeMembers(members, serverTimeMs, timeoutMs = PRESENCE_TIMEOUT_MS) {
  return (members || []).filter((member) => {
    const seen = Date.parse(member.last_seen);
    if (!Number.isFinite(seen)) return false;
    return serverTimeMs - seen <= timeoutMs;
  });
}

/**
 * Which role this device should hold.
 *
 * The host keeps their seat through the host token; the first other device to
 * arrive becomes the opponent, and everybody after that watches — the
 * database additionally enforces a single guest seat, so a race cannot make
 * two devices believe they are the opponent.
 */
export function roleFor({ room, members, device, serverTimeMs, isHostDevice }) {
  const active = activeMembers(members, serverTimeMs);
  const mine = (members || []).find((member) => member.device === device) || null;
  // A device the host removed stays removed until somebody clears the row.
  if (mine && mine.role === ROLE.KICKED) return ROLE.KICKED;
  if (isHostDevice) return ROLE.HOST;
  if (active.some((member) => member.role === ROLE.GUEST && member.device !== device)) return ROLE.SPECTATOR;
  // A device keeps whatever seat it already holds; only a first-time arrival
  // (no member row yet) takes the free opponent seat. That is what makes the
  // second invitee a spectator instead of a second "opponent", and it stops a
  // spectator from silently being promoted when the seat frees up.
  if (mine) return mine.role;
  return ROLE.GUEST;
}

/** Nicknames keyed by side, used to label whose turn it is. */
export function nicknameForSide(members, room, side) {
  if (side === null || side === undefined) return '';
  const hostSide = Number(room && room.host_side) === Cell.B ? Cell.B : Cell.A;
  const role = Number(side) === hostSide ? ROLE.HOST : ROLE.GUEST;
  const member = (members || []).find((entry) => entry.role === role);
  return member ? member.nickname : '';
}

/* ----------------------------------------------------------------- clock */

export function clockSettings(room) {
  const mainMs = Number(room && room.main_ms);
  const moveMs = Number(room && room.move_ms);
  return {
    mainMs: Number.isFinite(mainMs) && mainMs > 0 ? mainMs : CLOCK_DEFAULTS.mainMs,
    moveMs: Number.isFinite(moveMs) && moveMs > 0 ? moveMs : CLOCK_DEFAULTS.moveMs,
  };
}

/** `mm:ss` (or `h:mm:ss` for long games). */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(rest)}`;
  return `${minutes}:${pad(rest)}`;
}

export function formatStep(ms) {
  return `${Math.round(Number(ms) / 1000)} 秒`;
}

/**
 * Readiness for a specific game.
 *
 * A member is ready when their `ready_game` is at least the current game
 * number, which also means a rematch (game + 1) automatically clears both
 * ready flags. `ready_at` is stamped by the database, so every client derives
 * the same start time and the same countdown.
 */
export function readinessFor({ members, serverTimeMs, game }) {
  const active = activeMembers(members, serverTimeMs);
  const host = active.find((member) => member.role === ROLE.HOST) || null;
  const guest = active.find((member) => member.role === ROLE.GUEST) || null;
  const readyHost = Boolean(host && Number(host.ready_game) >= game);
  const readyGuest = Boolean(guest && Number(guest.ready_game) >= game);
  const bothReady = readyHost && readyGuest;
  const startAt = bothReady
    ? Math.max(Date.parse(host.ready_at) || 0, Date.parse(guest.ready_at) || 0)
    : null;
  const liveAt = startAt === null ? null : startAt + COUNTDOWN_MS;
  const countdownLeft = liveAt === null ? 0 : Math.max(0, liveAt - serverTimeMs);
  return {
    host,
    guest,
    readyHost,
    readyGuest,
    bothReady,
    opponentWaiting: !guest,
    startAt,
    liveAt,
    live: liveAt !== null && serverTimeMs >= liveAt,
    countdownLeft,
  };
}

/**
 * Derive both clocks from the shared timestamps.
 *
 * Each turn starts when the previous stone appeared in the database, so the
 * two devices always compute the same remaining main time and step time.
 *
 * @param {object} options
 * @param {number|null} options.startAt game start (ms, database clock)
 * @param {number|null} options.frozenAt stop the clock here (game over)
 */
export function clockState({ moves, room, startAt, serverTimeMs, frozenAt = null }) {
  const { mainMs, moveMs } = clockSettings(room);
  const list = sortMoves(moves);
  const spent = { [Cell.A]: 0, [Cell.B]: 0 };
  let turnStart = startAt === null || startAt === undefined ? null : startAt + COUNTDOWN_MS;
  let side = Cell.A;
  for (const move of list) {
    const at = Date.parse(move.created_at);
    if (Number.isFinite(at)) {
      if (turnStart !== null) spent[side] += Math.max(0, at - turnStart);
      turnStart = at;
      side = otherSide(side);
    }
  }
  const now = frozenAt !== null && frozenAt !== undefined ? frozenAt : serverTimeMs;
  const running = Number.isFinite(now) && turnStart !== null;
  const currentElapsed = running ? Math.max(0, now - turnStart) : 0;
  const turnSpent = currentElapsed;
  const remaining = {
    [Cell.A]: mainMs - spent[Cell.A] - (side === Cell.A ? turnSpent : 0),
    [Cell.B]: mainMs - spent[Cell.B] - (side === Cell.B ? turnSpent : 0),
  };
  return {
    mainMs,
    moveMs,
    sideToMove: side,
    turnStart,
    currentElapsed,
    stepRemaining: Math.max(0, moveMs - currentElapsed),
    remaining,
    running,
  };
}

/** The side that has just run out of main time or step time, if any. */
export function clockTimeout(clock, { live }) {
  if (!live || !clock || !clock.running) return null;
  if (clock.stepRemaining <= 0) return clock.sideToMove;
  if (clock.remaining[clock.sideToMove] <= 0) return clock.sideToMove;
  return null;
}

/** The clock that already expired in this game, taken from the event log. */
export function recordedTimeout(events) {
  const found = sortEvents(events).find((event) => event.kind === EVENT.CLOCK_TIMEOUT);
  if (!found) return null;
  return Number(found.side);
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
      // Keep extra fields (notably the database `created_at` the clocks need).
      ...row,
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
