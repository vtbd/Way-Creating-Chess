/**
 * Online test build — page wiring.
 *
 * The page is intentionally thin: it polls the room's move list, replays it
 * with the shared rules engine, and appends one move when the local player
 * clicks a legal square. No local AI, no undo: those stay in the solo build.
 */

import { BoardView } from '../js/board-view.js';
import { clear, h, qs } from '../js/dom.js';
import { Cell } from '../js/engine.js';
import {
  buildInviteUrl,
  defaultBoard,
  describe,
  randomRoomCode,
  rebuild,
  sideLabel,
} from './online-core.js';
import { createLocalTransport, createSupabaseTransport } from './transports.js';

const CONFIG_KEY = 'wcc.online.config.v1';
const POLL_LOCAL_MS = 400;
const POLL_REMOTE_MS = 1200;

const app = {
  platform: 'local',
  url: '',
  key: '',
  room: '',
  mySide: null,
  transport: null,
  board: null,
  state: null,
  rows: [],
  serialized: null,
  timer: null,
  syncing: false,
  submitting: false,
  notice: '',
  error: '',
  lastSync: '',
};

const els = {};

function bindElements() {
  for (const id of [
    'platform',
    'url',
    'key',
    'room',
    'side',
    'join',
    'leave',
    'rotate-room',
    'remote-fields',
    'mode-hint',
    'status-line',
    'turn-chip',
    'stat-moves',
    'stat-side',
    'stat-result',
    'sync-line',
    'invite',
    'copy-invite',
    'sync',
    'clear-room',
    'board',
    'notice',
    'history',
    'error-line',
    'room-label',
    'transport-label',
  ]) {
    els[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = qs(`#${id}`);
  }
}

function saveConfig() {
  try {
    window.localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ platform: app.platform, url: app.url, key: app.key, room: app.room }),
    );
  } catch (error) {
    /* private mode: config simply is not remembered */
  }
}

function loadConfig() {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch (error) {
    /* ignore */
  }
  return {};
}

function setNotice(text) {
  app.notice = text;
  els.notice.textContent = text;
  els.notice.classList.toggle('is-visible', Boolean(text));
}

function setError(text) {
  app.error = text || '';
  els.errorLine.textContent = app.error;
  els.errorLine.classList.toggle('is-visible', Boolean(app.error));
}

function readForm() {
  app.platform = els.platform.value === 'supabase' ? 'supabase' : 'local';
  app.url = els.url.value.trim();
  app.key = els.key.value.trim();
  app.room = els.room.value.trim().toUpperCase();
  app.mySide = els.side.value === 'B' ? Cell.B : Cell.A;
}

function writeForm() {
  els.platform.value = app.platform;
  els.url.value = app.url;
  els.key.value = app.key;
  els.room.value = app.room;
  els.side.value = sideLabel(app.mySide);
  syncPlatformFields();
}

function syncPlatformFields() {
  const remote = els.platform.value === 'supabase';
  els.remoteFields.classList.toggle('hidden', !remote);
  els.modeHint.textContent = remote
    ? '云端模式：两位玩家都填同一个项目 URL、anon key 和房间号即可对战（约 1 秒同步一次）。'
    : '本地模式：不用任何账号。在同一个浏览器里再开一个标签页，填相同房间号、选另一方身份即可对战。';
}

function buildInvite() {
  if (!app.room) return '';
  const location = window.location;
  if (app.platform === 'local') {
    return buildInviteUrl({ origin: location.origin, pathname: location.pathname, room: app.room });
  }
  return buildInviteUrl({
    origin: location.origin,
    pathname: location.pathname,
    room: app.room,
    key: app.key,
  });
}

function renderBoard() {
  if (!app.state) return;
  const state = app.state;
  const legal = new Set();
  const myTurn = !state.isGameOver && state.sideToMove === app.mySide && !app.submitting;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (myTurn && state.cells[index] === Cell.OPEN) legal.add(index);
  }
  const created = new Set();
  const last = state.moveHistory[state.moveHistory.length - 1] || null;
  const lastIndex = last ? last.y * state.width + last.x : null;
  if (last) for (const [cx, cy] of last.created) created.add(cy * state.width + cx);
  const winning = new Set();
  if (state.winner !== null) {
    for (const [wx, wy] of state.winningLine()) winning.add(wy * state.width + wx);
  }
  app.view.render({
    width: state.width,
    height: state.height,
    cells: state.cells,
    legal,
    created,
    winning,
    lastIndex,
  });
}

function renderStatus() {
  const state = app.state;
  const joined = Boolean(app.transport);
  els.roomLabel.textContent = joined ? `房间 ${app.room}` : '未进入房间';
  els.transportLabel.textContent = joined ? app.transport.label : '—';
  if (!state) {
    els.statusLine.textContent = '选择平台与身份后点击“进入房间”。';
    els.turnChip.textContent = '—';
    els.turnChip.className = 'turn-chip';
  } else {
    els.statusLine.textContent = describe(state, app.mySide);
    const chipSide = state.isGameOver ? state.winner : state.sideToMove;
    els.turnChip.textContent = state.isGameOver
      ? state.winner !== null
        ? `${sideLabel(state.winner)} 方获胜`
        : '和棋'
      : `轮到 ${sideLabel(state.sideToMove)} 方`;
    els.turnChip.className = chipSide === null ? 'turn-chip' : `turn-chip chip-${sideLabel(chipSide).toLowerCase()}`;
  }
  els.statMoves.textContent = state ? String(state.moveHistory.length) : '0';
  els.statSide.textContent = app.mySide === null ? '—' : `${sideLabel(app.mySide)} 方`;
  els.statResult.textContent = state ? (state.winner !== null ? `${sideLabel(state.winner)} 胜` : state.isDraw ? '和棋' : '进行中') : '—';
  els.syncLine.textContent = app.lastSync ? `最近同步：${app.lastSync}${app.syncing ? ' · 同步中…' : ''}` : '尚未同步';
  els.invite.value = buildInvite();
  els.join.disabled = joined;
  els.leave.disabled = !joined;
  els.sync.disabled = !joined;
  els.clearRoom.disabled = !joined;
}

function renderHistory() {
  const list = clear(els.history);
  const moves = app.state ? app.state.moveHistory : [];
  if (moves.length === 0) {
    list.append(h('li', { class: 'history-empty', text: '尚无着法' }));
    return;
  }
  moves.forEach((move, index) => {
    list.append(
      h(
        'li',
        {},
        h(
          'span',
          { class: 'history-item' },
          h('span', { class: `move-dot dot-${sideLabel(move.player).toLowerCase()}` }),
          h('span', { class: 'move-notation', text: `${index + 1}. ${move.notation}` }),
          h('span', { class: 'move-created', text: move.created.length ? `+${move.created.length} 路` : '' }),
        ),
      ),
    );
  });
  els.history.scrollTop = els.history.scrollHeight;
}

function render() {
  renderBoard();
  renderStatus();
  renderHistory();
}

/* ------------------------------------------------------------------ room */

function createTransport() {
  if (app.platform === 'supabase') {
    return createSupabaseTransport({ url: app.url, key: app.key, room: app.room });
  }
  return createLocalTransport(app.room);
}

function join() {
  readForm();
  if (!app.room) {
    setError('请先填写房间号（可以点“换一个”随机生成）');
    return;
  }
  try {
    app.transport = createTransport();
  } catch (error) {
    setError(error.message);
    return;
  }
  app.board = defaultBoard();
  app.serialized = null;
  app.lastSync = '';
  setError('');
  saveConfig();
  syncPlatformFields();
  setNotice(
    app.platform === 'local'
      ? '已进入本地房间：再开一个标签页，用相同房间号、另一方身份加入。'
      : '已进入云端房间：把邀请链接发给对手即可。',
  );
  if (window.history && typeof window.history.replaceState === 'function') {
    try {
      const url = buildInvite();
      if (url) window.history.replaceState(null, '', url);
    } catch (error) {
      /* ignore */
    }
  }
  render();
  syncNow({ force: true });
  schedulePoll();
}

function leave() {
  stopPoll();
  if (app.transport) app.transport.close();
  app.transport = null;
  app.state = null;
  app.rows = [];
  app.serialized = null;
  app.mySide = null;
  setNotice('已退出房间。');
  render();
}

function stopPoll() {
  if (app.timer) {
    clearTimeout(app.timer);
    app.timer = null;
  }
}

function schedulePoll() {
  stopPoll();
  if (!app.transport) return;
  const delay = app.platform === 'local' ? POLL_LOCAL_MS : POLL_REMOTE_MS;
  app.timer = setTimeout(async () => {
    await syncNow();
    schedulePoll();
  }, delay);
}

async function syncNow({ force = false } = {}) {
  if (!app.transport || app.syncing) return;
  app.syncing = true;
  try {
    const rows = await app.transport.list();
    const serialized = JSON.stringify(rows);
    if (force || serialized !== app.serialized) {
      app.serialized = serialized;
      const { state, error, applied, rows: normalised } = rebuild(rows);
      app.state = state;
      app.rows = normalised.slice(0, applied);
      if (error) setError(`同步异常：${error}`);
      else setError('');
      render();
    }
    app.lastSync = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    renderStatus();
  } catch (error) {
    setError(error.message);
    app.lastSync = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    renderStatus();
  } finally {
    app.syncing = false;
  }
}

async function submit(x, y) {
  const state = app.state;
  if (!app.transport) {
    setNotice('请先进入房间。');
    return;
  }
  if (!state || state.isGameOver) {
    setNotice('对局已结束。');
    return;
  }
  if (app.mySide === null || state.sideToMove !== app.mySide) {
    setNotice('还没轮到你落子。');
    return;
  }
  if (!state.isLegalMove(x, y)) {
    setNotice('该格不可落子：只有浅色“可走”格能落子。');
    return;
  }
  app.submitting = true;
  renderBoard();
  const move = { move_index: state.moveHistory.length, side: app.mySide, x, y };
  try {
    const result = await app.transport.append(move);
    if (result.ok) {
      setNotice(`${sideLabel(app.mySide)}:${String.fromCharCode(97 + x)}${y + 1} 已提交`);
    } else {
      setNotice(result.reason || '提交失败');
    }
  } catch (error) {
    setNotice(`提交失败：${error.message}`);
  } finally {
    app.submitting = false;
    await syncNow({ force: true });
  }
}

async function clearRoom() {
  if (!app.transport) return;
  const result = await app.transport.clear();
  if (result.ok) {
    setNotice(`房间 ${app.room} 的着法已清空，可以重新开始测试。`);
    app.serialized = null;
    await syncNow({ force: true });
  } else {
    setNotice(result.reason || '清空失败');
  }
}

async function copyInvite() {
  const url = buildInvite();
  if (!url) {
    setNotice('请先进入房间，再复制邀请链接。');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    setNotice('邀请链接已复制，发给对手即可。');
  } catch (error) {
    els.invite.select();
    setNotice('浏览器未授权剪贴板，请手动复制下面输入框里的链接。');
  }
}

/* ------------------------------------------------------------------ boot */

function boot() {
  bindElements();
  app.view = new BoardView(els.board, {
    onDown: (x, y, event) => {
      if (event.button !== 0) return;
      submit(x, y);
    },
  });

  const params = new URLSearchParams(window.location.search || '');
  const stored = loadConfig();
  app.platform = params.get('platform') || stored.platform || 'local';
  app.url = params.get('url') || stored.url || '';
  app.key = params.get('key') || stored.key || '';
  app.room = (params.get('room') || stored.room || randomRoomCode()).toUpperCase();
  const side = params.get('side') || null;
  app.mySide = side === 'B' ? Cell.B : side === 'A' ? Cell.A : Cell.A;
  writeForm();

  els.platform.addEventListener('change', () => {
    syncPlatformFields();
  });
  els.rotateRoom.addEventListener('click', () => {
    els.room.value = randomRoomCode();
  });
  els.join.addEventListener('click', join);
  els.leave.addEventListener('click', leave);
  els.sync.addEventListener('click', () => syncNow({ force: true }));
  els.clearRoom.addEventListener('click', clearRoom);
  els.copyInvite.addEventListener('click', copyInvite);
  window.addEventListener('beforeunload', stopPoll);

  render();
  // Invite links join automatically so the other player only clicks one link.
  if (params.get('room')) join();
  window.__onlineBooted = true;
}

boot();
