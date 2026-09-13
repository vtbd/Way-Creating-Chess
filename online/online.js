/**
 * Online build — page wiring.
 *
 * The host creates a room (choosing the starting board and who moves first),
 * shares an invite link that already carries the project URL, the anon key and
 * the room code, and both clients poll the room every ~1.2 s. Turn order,
 * undo requests and rematches all travel through the same tiny REST store.
 *
 * The page never trusts its own local position: every sync replays the move
 * list with the shared rules engine, so a refresh or a late join is simply
 * "fetch again".
 */

import { BoardView } from '../js/board-view.js';
import { generateRandomBoard, normalizeBoardDefinition } from '../js/boards.js';
import { clear, h, qs } from '../js/dom.js';
import { Cell } from '../js/engine.js';
import { drawMiniBoard } from '../js/preview.js';
import { GAME_RULES, ONLINE_CONTROLS, renderRuleSections } from '../js/rules.js';
import {
  EVENT,
  SIDE_CHOICES,
  SIDE_CHOICE_LABELS,
  boardFromRoom,
  boardSummary,
  buildInviteUrl,
  defaultBoard,
  describe,
  isHost,
  pendingUndo,
  randomRoomCode,
  randomToken,
  rebuild,
  resolveHostSide,
  sideForRole,
  sideLabel,
  sideName,
  undoPlan,
} from './online-core.js';
import { createSupabaseStore } from './transports.js';

const CONFIG_KEY = 'wcc.online.config.v2';
const HOST_KEY = (room) => `wcc.online.host.${room}`;
const POLL_MS = 1200;

const app = {
  phase: 'setup',
  url: '',
  key: '',
  room: '',
  urlToken: '',
  store: null,
  roomRow: null,
  board: null,
  state: null,
  moves: [],
  events: [],
  game: null,
  host: false,
  mySide: null,
  notice: '',
  error: '',
  syncAt: '',
  syncing: false,
  submitting: false,
  busy: false,
  timer: null,
};

const els = {};

/* ------------------------------------------------------------- utilities */

function setNotice(text) {
  app.notice = text;
  els.notice.textContent = text;
  els.notice.classList.toggle('is-visible', Boolean(text));
}

function setError(text) {
  app.error = text || '';
  if (els.errorLine) {
    els.errorLine.textContent = app.error;
    els.errorLine.classList.toggle('is-visible', Boolean(app.error));
  }
  if (app.phase !== 'room' && app.error) setNotice(app.error);
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    /* private mode: settings are simply not remembered */
  }
}

function loadConfig() {
  try {
    const raw = readStorage(CONFIG_KEY);
    return raw ? JSON.parse(raw) || {} : {};
  } catch (error) {
    return {};
  }
}

function saveConfig() {
  writeStorage(CONFIG_KEY, JSON.stringify({ url: app.url, key: app.key, room: app.room }));
}

function loadHostToken(room = app.room) {
  return readStorage(HOST_KEY(room)) || '';
}

function saveHostToken(room, token) {
  writeStorage(HOST_KEY(room), token);
}

function readParams() {
  const params = new URLSearchParams(window.location.search || '');
  return {
    room: (params.get('room') || '').toUpperCase(),
    url: params.get('url') || '',
    key: params.get('key') || '',
    host: params.get('host') || '',
  };
}

function updateOwnUrl() {
  if (!window.history || typeof window.history.replaceState !== 'function') return;
  try {
    const url = buildInviteUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      room: app.room,
      url: app.url,
      key: app.key,
      hostToken: app.host ? app.urlToken : null,
    });
    if (url) window.history.replaceState(null, '', url);
  } catch (error) {
    /* ignore */
  }
}

function inviteUrl() {
  if (!app.room) return '';
  return buildInviteUrl({
    origin: window.location.origin,
    pathname: window.location.pathname,
    room: app.room,
    url: app.url,
    key: app.key,
  });
}

function storeOptions() {
  return { url: app.url, key: app.key, room: app.room };
}

/* ---------------------------------------------------------- setup screen */

function renderSetup() {
  app.phase = 'setup';
  const sidebar = clear(els.sidebar);

  const connectOpen = !(app.url && app.key);
  const details = h(
    'details',
    { class: 'connect' },
    h('summary', { text: connectOpen ? '连接设置（Supabase 项目）' : '连接信息（已自动填入）' }),
    h(
      'label',
      { class: 'field' },
      h('span', { text: '项目 URL' }),
      h('input', { id: 'url', class: 'text-input', type: 'text', placeholder: 'https://xxxx.supabase.co', value: app.url }),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { text: 'anon key' }),
      h('input', { id: 'key', class: 'text-input', type: 'text', placeholder: 'anon public / publishable key', value: app.key }),
    ),
    h('p', {
      class: 'hint',
      text: '房主需要填写这两项（只需一次，之后会记住）。用邀请链接打开时，它们会随链接自动填好。',
    }),
  );
  if (connectOpen) details.setAttribute('open', '');

  const boardSource = h(
    'select',
    { id: 'board-source', class: 'select' },
    h('option', { value: 'default', text: '默认棋盘（12×9）' }),
    h('option', { value: 'random', text: '随机棋盘' }),
    h('option', { value: 'json', text: '粘贴棋盘 JSON' }),
  );

  const numberField = (id, label, value, { min, max, step }) =>
    h(
      'label',
      { class: 'field' },
      h('span', { text: label }),
      h('input', { id, class: 'text-input small', type: 'number', min: String(min), max: String(max), step: String(step), value: String(value) }),
    );

  const randomFields = h(
    'div',
    { id: 'random-fields', class: 'stack hidden' },
    numberField('board-width', '宽度', 12, { min: 4, max: 40, step: 1 }),
    numberField('board-height', '高度', 9, { min: 4, max: 40, step: 1 }),
    numberField('board-density', '可走密度', 0.3, { min: 0.05, max: 1, step: 0.05 }),
    h(
      'label',
      { class: 'field' },
      h('span', { text: '随机种子' }),
      h('input', { id: 'board-seed', class: 'text-input', type: 'number', placeholder: '留空即随机' }),
    ),
  );

  const jsonField = h(
    'div',
    { id: 'json-field', class: 'stack hidden' },
    h('textarea', {
      id: 'board-json',
      class: 'text-input textarea',
      rows: '4',
      placeholder: '把棋盘 JSON 粘到这里，例如 {"content": [[1,0],[0,1]]}',
    }),
    h('p', { class: 'hint', text: '单机版“保存当前棋盘/导出我的棋盘”得到的 JSON 可以直接粘贴。' }),
  );

  const previewCanvas = h('canvas', { class: 'board-preview' });
  const previewInfo = h('p', { class: 'hint' });

  const hostSide = h(
    'select',
    { id: 'host-side', class: 'select' },
    ...SIDE_CHOICES.map((choice) => h('option', { value: choice, text: SIDE_CHOICE_LABELS[choice] })),
  );

  const roomInput = h('input', { id: 'room-input', class: 'text-input', type: 'text', maxlength: '8', value: app.room, placeholder: '例如 AB12' });

  const sidebarCards = h(
    'section',
    { class: 'card' },
    h('h2', { text: '创建 / 加入房间' }),
    details,
    h('h3', { text: '创建房间（房主）' }),
    h('label', { class: 'field' }, h('span', { text: '初始棋盘' }), boardSource),
    randomFields,
    jsonField,
    h('div', { class: 'preview-row' }, previewCanvas, previewInfo),
    h('label', { class: 'field' }, h('span', { text: '先后手' }), hostSide),
    h(
      'div',
      { class: 'row-gap' },
      h('button', { id: 'create-room', class: 'primary', type: 'button' }, '创建房间'),
    ),
    h('p', { class: 'hint', text: '创建后会生成邀请链接；对手打开链接时，先后手自动取另一方。' }),
    h('hr', { class: 'divider' }),
    h('h3', { text: '加入房间' }),
    h('label', { class: 'field' }, h('span', { text: '房间号' }), roomInput),
    h('div', { class: 'row-gap' }, h('button', { id: 'join-room', type: 'button' }, '加入房间')),
    h('p', { class: 'hint', text: '有邀请链接时直接打开链接即可，无需手动填写。' }),
  );
  sidebar.append(sidebarCards);

  els.url = details.querySelector('#url');
  els.key = details.querySelector('#key');
  els.boardSource = boardSource;
  els.randomFields = randomFields;
  els.jsonField = jsonField;
  els.boardWidth = randomFields.querySelector('#board-width');
  els.boardHeight = randomFields.querySelector('#board-height');
  els.boardDensity = randomFields.querySelector('#board-density');
  els.boardSeed = randomFields.querySelector('#board-seed');
  els.boardJson = jsonField.querySelector('#board-json');
  els.hostSide = hostSide;
  els.roomInput = roomInput;
  els.createRoom = sidebarCards.querySelector('#create-room');
  els.joinRoom = sidebarCards.querySelector('#join-room');
  els.previewCanvas = previewCanvas;
  els.previewInfo = previewInfo;

  els.boardSource.addEventListener('change', () => {
    els.randomFields.classList.toggle('hidden', els.boardSource.value !== 'random');
    els.jsonField.classList.toggle('hidden', els.boardSource.value !== 'json');
    updatePreview();
  });
  for (const field of [els.boardWidth, els.boardHeight, els.boardDensity, els.boardSeed, els.boardJson]) {
    field.addEventListener('input', updatePreview);
  }
  els.createRoom.addEventListener('click', () => createRoom());
  els.joinRoom.addEventListener('click', () => joinRoom());

  els.randomFields.classList.add('hidden');
  els.jsonField.classList.add('hidden');
  updatePreview();
  syncBoardUI();
}

/** The board the host currently has selected in the setup form. */
function chosenBoard({ report = true } = {}) {
  const source = els.boardSource.value;
  try {
    if (source === 'random') {
      return generateRandomBoard({
        width: Number(els.boardWidth.value),
        height: Number(els.boardHeight.value),
        density: Number(els.boardDensity.value),
        seed: els.boardSeed.value === '' ? null : Number(els.boardSeed.value),
      });
    }
    if (source === 'json') {
      const text = els.boardJson.value.trim();
      if (!text) throw new Error('还没有粘贴棋盘 JSON');
      return normalizeBoardDefinition(JSON.parse(text), '自定义棋盘');
    }
    return defaultBoard();
  } catch (error) {
    if (report) {
      els.previewInfo.textContent = `棋盘不可用：${error.message}`;
      els.previewInfo.classList.add('is-error');
    }
    return null;
  }
}

function updatePreview() {
  const board = chosenBoard({ report: false });
  els.previewInfo.classList.remove('is-error');
  if (!board) {
    els.previewInfo.textContent = '等待有效的棋盘设置…';
    clearCanvas(els.previewCanvas);
    return;
  }
  drawMiniBoard(els.previewCanvas, board);
  els.previewInfo.textContent = boardSummary(board);
}

function clearCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

function readConnectFields() {
  if (els.url) app.url = els.url.value.trim();
  if (els.key) app.key = els.key.value.trim();
}

function syncBoardUI() {
  if (app.phase !== 'setup') return;
  if (els.createRoom) els.createRoom.disabled = app.busy;
  if (els.joinRoom) els.joinRoom.disabled = app.busy;
}

/* ----------------------------------------------------------- room screen */

function renderRoom() {
  app.phase = 'room';
  const sidebar = clear(els.sidebar);

  const turnChip = h('div', { id: 'turn-chip', class: 'turn-chip' });
  const statusLine = h('p', { id: 'status-line', class: 'status-line' });
  const roleLine = h('p', { id: 'role-line', class: 'hint' });
  const boardInfo = h('p', { id: 'board-info', class: 'hint' });
  const syncLine = h('p', { id: 'sync-line', class: 'hint' });
  const errorLine = h('p', { id: 'error-line', class: 'notice notice-left' });
  const stats = h(
    'dl',
    { class: 'stats' },
    h('div', {}, h('dt', { text: '已走' }), h('dd', { id: 'stat-moves', text: '0' })),
    h('div', {}, h('dt', { text: '我的身份' }), h('dd', { id: 'stat-side', text: '—' })),
    h('div', {}, h('dt', { text: '结果' }), h('dd', { id: 'stat-result', text: '—' })),
  );

  const historyList = h('ol', { id: 'history', class: 'history' });

  const roomCard = h(
    'section',
    { class: 'card' },
    h('h2', { id: 'room-title' }),
    roleLine,
    turnChip,
    statusLine,
    stats,
    boardInfo,
    syncLine,
    errorLine,
    h(
      'div',
      { class: 'row-gap' },
      h('button', { id: 'sync', type: 'button' }, '立即同步'),
      h('button', { id: 'leave', type: 'button' }, '退出房间'),
    ),
  );

  const undoRequest = h('button', { id: 'undo-request', class: 'action-button wide', type: 'button' }, '悔棋');
  const undoHint = h('p', { id: 'undo-hint', class: 'hint' });
  const undoText = h('p', { id: 'undo-text' });
  const undoPrompt = h(
    'div',
    { id: 'undo-prompt', class: 'undo-prompt hidden' },
    undoText,
    h(
      'div',
      { class: 'row-gap' },
      h('button', { id: 'undo-accept', class: 'primary', type: 'button' }, '同意撤销'),
      h('button', { id: 'undo-decline', type: 'button' }, '拒绝'),
    ),
  );
  const undoStatus = h('p', { id: 'undo-status', class: 'hint' });
  const actionsCard = h(
    'section',
    { class: 'card' },
    h('h2', { text: '对局操作' }),
    undoRequest,
    undoHint,
    undoPrompt,
    undoStatus,
  );

  // Host-only controls are not even created for guests.
  let clearRoom = null;
  let closeRoom = null;
  if (app.host) {
    clearRoom = h('button', { id: 'clear-room', class: 'danger-button', type: 'button' }, '清空房间');
    closeRoom = h('button', { id: 'close-room', class: 'danger-button', type: 'button' }, '关闭房间');
    actionsCard.append(
      h('hr', { class: 'divider' }),
      h('p', {
        class: 'hint',
        text: '房主专属：清空 = 保留房间号，清掉全部着法与悔棋请求并回到第 1 局；关闭 = 删除房间，房间号被释放（对手会看到房间已不存在）。',
      }),
      h('div', { class: 'row-gap' }, clearRoom, closeRoom),
    );
  }

  const invite = h('input', { id: 'invite', class: 'text-input', type: 'text', readonly: true });
  sidebar.append(
    roomCard,
    actionsCard,
    h(
      'section',
      { class: 'card' },
      h('h2', { text: '邀请链接' }),
      invite,
      h('div', { class: 'row-gap' }, h('button', { id: 'copy-invite', type: 'button' }, '复制邀请链接')),
      h('p', {
        class: 'hint',
        text: app.host
          ? '链接里带着项目 URL、key 和房间号，对手打开即可加入（房主权限不在链接里）。'
          : '把这条链接转发给其他人都可以观战式加入——本测试版只区分先后手，不区分观战。',
      }),
    ),
    h('section', { class: 'card' }, h('h2', { text: '棋谱' }), historyList),
  );

  Object.assign(els, {
    turnChip,
    statusLine,
    roleLine,
    boardInfo,
    syncLine,
    errorLine,
    statMoves: roomCard.querySelector('#stat-moves'),
    statSide: roomCard.querySelector('#stat-side'),
    statResult: roomCard.querySelector('#stat-result'),
    roomTitle: roomCard.querySelector('#room-title'),
    historyList,
    undoRequest,
    undoPrompt,
    undoText,
    undoStatus,
    undoHint,
    clearRoom,
    closeRoom,
    invite,
  });

  roomCard.querySelector('#sync').addEventListener('click', () => sync({ force: true }));
  roomCard.querySelector('#leave').addEventListener('click', leaveRoom);
  undoRequest.addEventListener('click', requestUndo);
  undoPrompt.querySelector('#undo-accept').addEventListener('click', () => answerUndo(true));
  undoPrompt.querySelector('#undo-decline').addEventListener('click', () => answerUndo(false));
  if (clearRoom) clearRoom.addEventListener('click', clearRoomHistory);
  if (closeRoom) closeRoom.addEventListener('click', closeRoomForEveryone);
  invite.parentNode.querySelector('#copy-invite').addEventListener('click', copyInvite);
}

/* --------------------------------------------------------------- actions */

async function createRoom() {
  if (app.busy) return;
  readConnectFields();
  if (!app.url || !app.key) {
    setError('创建房间需要先填 Supabase 项目 URL 和 anon key（在“连接设置”里）。');
    return;
  }
  const board = chosenBoard();
  if (!board) {
    setError('请先修正棋盘设置（见预览提示）。');
    return;
  }
  app.room = (els.roomInput.value || '').trim().toUpperCase() || randomRoomCode();
  els.roomInput.value = app.room;
  app.busy = true;
  syncBoardUI();
  try {
    const store = createSupabaseStore(storeOptions());
    const hostToken = randomToken();
    const hostSide = resolveHostSide(els.hostSide.value);
    const result = await store.createRoom({ board: toBoardPayload(board), hostToken, hostSide });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    app.store = store;
    app.urlToken = hostToken;
    saveHostToken(app.room, hostToken);
    saveConfig();
    setError('');
    setNotice(`房间 ${app.room} 已创建，把邀请链接发给对手吧。`);
    // Hand the freshly created row over so the host UI (and its controls)
    // renders before the first poll returns.
    enterRoom({ code: app.room, board: toBoardPayload(board), host_token: hostToken, host_side: hostSide, game: 1 });
  } catch (error) {
    setError(error.message);
  } finally {
    app.busy = false;
    syncBoardUI();
  }
}

async function joinRoom() {
  if (app.busy) return;
  readConnectFields();
  app.room = ((els.roomInput && els.roomInput.value) || app.room || '').trim().toUpperCase();
  if (!app.room) {
    setError('请填写房间号，或直接用邀请链接打开。');
    return;
  }
  if (!app.url || !app.key) {
    setError('缺少项目 URL / anon key：请让房主重新发一次邀请链接，或在“连接设置”里手动填写。');
    return;
  }
  app.busy = true;
  syncBoardUI();
  try {
    const store = createSupabaseStore(storeOptions());
    const roomRow = await store.getRoom();
    if (!roomRow) {
      setError(`房间 ${app.room} 不存在：确认房间号，或让房主重新复制邀请链接。`);
      return;
    }
    app.store = store;
    saveConfig();
    setError('');
    enterRoom(roomRow);
  } catch (error) {
    setError(error.message);
  } finally {
    app.busy = false;
    syncBoardUI();
  }
}

function toBoardPayload(board) {
  return { id: board.id, name: board.name, width: board.width, height: board.height, content: board.content };
}

function enterRoom(roomRow = null) {
  app.roomRow = roomRow;
  app.game = null;
  app.moves = [];
  app.events = [];
  app.state = null;
  app.host = Boolean(roomRow && isHost({ room: roomRow, storedToken: loadHostToken(), urlToken: app.urlToken }));
  renderRoom();
  updateOwnUrl();
  sync({ force: true }).then(schedulePoll);
}

function leaveRoom() {
  stopPoll();
  app.store = null;
  app.roomRow = null;
  app.board = null;
  app.state = null;
  app.moves = [];
  app.events = [];
  app.game = null;
  app.host = false;
  app.mySide = null;
  app.lastEventId = null;
  els.errorLine = null;
  els.historyList = null;
  setError('');
  setNotice('已退出房间。');
  renderSetup();
}

function stopPoll() {
  if (app.timer) {
    clearTimeout(app.timer);
    app.timer = null;
  }
}

function schedulePoll() {
  stopPoll();
  if (!app.store) return;
  app.timer = setTimeout(async () => {
    await sync();
    schedulePoll();
  }, POLL_MS);
}

async function sync({ force = false } = {}) {
  if (!app.store || app.syncing) return;
  app.syncing = true;
  try {
    const [roomRow, moveRows, eventRows] = await Promise.all([
      app.store.getRoom(),
      app.store.listMoves(app.game || 1),
      app.store.listEvents(app.game || 1),
    ]);
    if (!roomRow) {
      stopPoll();
      setError(`房间 ${app.room} 已不存在：房主可能关闭了房间。点“退出房间”回到初始界面。`);
      return;
    }
    const game = Number(roomRow.game) || 1;
    const restarted = app.game !== null && game !== app.game;
    const rows = restarted ? await app.store.listMoves(game) : moveRows;
    const events = restarted ? await app.store.listEvents(game) : eventRows;
    applySnapshot({ roomRow, game, moveRows: rows, eventRows: events, restarted });
  } catch (error) {
    setError(error.message);
  } finally {
    app.syncing = false;
    app.syncAt = nowLabel();
    syncRoomUI();
  }
}

function applySnapshot({ roomRow, game, moveRows, eventRows, restarted }) {
  app.roomRow = roomRow;
  app.game = game;
  app.board = boardFromRoom(roomRow);
  app.host = isHost({ room: roomRow, storedToken: loadHostToken(), urlToken: app.urlToken });
  const previousSide = app.mySide;
  app.mySide = sideForRole(roomRow, app.host);
  const { state, rows, applied, error } = rebuild(moveRows, app.board);
  app.state = state;
  app.moves = rows.slice(0, applied);
  app.events = eventRows;
  if (error) setError(`同步异常：${error}`);
  else setError('');
  const lastEvent = app.events.length ? app.events[app.events.length - 1] : null;
  if (lastEvent && lastEvent.id !== app.lastEventId) {
    if (lastEvent.kind === EVENT.UNDO_DONE) setNotice('悔棋请求已被同意。');
    else if (lastEvent.kind === EVENT.UNDO_DECLINED) setNotice('悔棋请求已被拒绝。');
    app.lastEventId = lastEvent.id;
  }
  if (restarted) {
    setNotice(previousSide !== null && previousSide !== app.mySide
      ? `新的一局开始了，你改执${sideName(app.mySide)}。`
      : '新的一局开始了。');
  }
  syncRoomUI();
}

async function submit(x, y) {
  const state = app.state;
  if (!app.store || !state) {
    setNotice('请先创建或加入房间。');
    return;
  }
  if (app.submitting) return;
  if (state.isGameOver) {
    setNotice('对局已结束，可以由房主开始新一局。');
    return;
  }
  if (state.sideToMove !== app.mySide) {
    setNotice('还没轮到你落子。');
    return;
  }
  if (!state.isLegalMove(x, y)) {
    setNotice('该格不可落子：只有浅色“可走”格能落子。');
    return;
  }
  app.submitting = true;
  syncRoomUI();
  try {
    const result = await app.store.appendMove({
      game: app.game,
      moveIndex: app.moves.length,
      side: app.mySide,
      x,
      y,
    });
    setNotice(result.ok
      ? `${sideLabel(app.mySide)}:${String.fromCharCode(97 + x)}${y + 1} 已提交`
      : result.reason);
  } catch (error) {
    setNotice(`提交失败：${error.message}`);
  } finally {
    app.submitting = false;
    await sync({ force: true });
  }
}

async function requestUndo() {
  if (!app.store) return;
  const plan = undoPlan(app.moves, app.mySide);
  if (!plan) {
    setNotice('你还没有落子，暂时无法悔棋。');
    return;
  }
  const result = await app.store.appendEvent({ game: app.game, kind: EVENT.UNDO_REQUEST, side: app.mySide, target: plan.target });
  setNotice(
    result.ok
      ? plan.removeCount === 2
        ? '已请求悔棋（撤回双方各一手），等待对手回应…'
        : '已请求悔棋（撤回你刚下的一手），等待对手回应…'
      : result.reason,
  );
  await sync({ force: true });
}

async function answerUndo(accept) {
  const request = pendingUndo(app.events, app.moves.length);
  if (!request || request.side === app.mySide) return;
  if (accept) {
    const deleted = await app.store.deleteMovesFrom(app.game, request.target);
    if (!deleted.ok) {
      setNotice(deleted.reason);
      return;
    }
  }
  const result = await app.store.appendEvent({
    game: app.game,
    kind: accept ? EVENT.UNDO_DONE : EVENT.UNDO_DECLINED,
    side: app.mySide,
    target: request.target,
  });
  setNotice(result.ok ? (accept ? '已同意悔棋。' : '已拒绝悔棋请求。') : result.reason);
  await sync({ force: true });
}

async function rematch(swap) {
  if (!app.host || !app.roomRow) return;
  const game = Number(app.roomRow.game || 1) + 1;
  const hostSide = swap ? (Number(app.roomRow.host_side) === Cell.A ? Cell.B : Cell.A) : Number(app.roomRow.host_side) || Cell.A;
  const result = await app.store.updateRoom({ game, host_side: hostSide });
  setNotice(result.ok ? (swap ? '新的一局开始了（已交换先后手）。' : '新的一局开始了。') : result.reason);
  await sync({ force: true });
}

async function clearRoomHistory() {
  if (!app.host) return;
  const result = await app.store.resetRoom();
  setNotice(result.ok ? '房间已清空（房间号保留，回到第 1 局）。' : result.reason);
  await sync({ force: true });
}

/** Host-only: delete the room so the code can be reused by someone else. */
async function closeRoomForEveryone() {
  if (!app.host || !app.store) return;
  const result = await app.store.closeRoom();
  if (!result.ok) {
    setNotice(result.reason);
    return;
  }
  const code = app.room;
  leaveRoom();
  setNotice(`房间 ${code} 已关闭，房间号已释放。`);
}

async function copyInvite() {
  const url = inviteUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    setNotice('邀请链接已复制，发给对手即可。');
  } catch (error) {
    if (els.invite) els.invite.select();
    setNotice('浏览器未授权剪贴板，请手动复制邀请链接输入框里的内容。');
  }
}

/* -------------------------------------------------------------- painting */

function renderBoard() {
  const state = app.state;
  if (!state) {
    app.view.render({ width: 12, height: 9, cells: new Int8Array(12 * 9), legal: new Set() });
    return;
  }
  const legal = new Set();
  const interactive = !state.isGameOver && state.sideToMove === app.mySide && !app.submitting;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (interactive && state.cells[index] === Cell.OPEN) legal.add(index);
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

function renderHistory() {
  if (!els.historyList) return;
  const list = clear(els.historyList);
  const moves = app.state ? app.state.moveHistory : [];
  if (!moves.length) {
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
  els.historyList.scrollTop = els.historyList.scrollHeight;
}

/* --------------------------------------------------------------- UI sync */

/* ------------------------------------------------------------ rules modal */

function openRules() {
  const body = h('div', { class: 'modal-body help-body' });
  renderRuleSections(body, [...GAME_RULES, ...ONLINE_CONTROLS]);
  body.append(h('footer', { class: 'modal-footer' }, h('button', { type: 'button', onclick: closeModal }, '知道了')));
  const modal = clear(els.modal);
  modal.append(
    h(
      'header',
      { class: 'modal-header' },
      h('div', {}, h('h2', { text: '游戏规则' }), h('p', { class: 'modal-subtitle', text: '与单机版共用同一份规则引擎' })),
      h('button', { type: 'button', class: 'icon-button', title: '关闭', onclick: closeModal }, '✕'),
    ),
    body,
  );
  els.modalRoot.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal() {
  if (els.modalRoot.classList.contains('hidden')) return;
  els.modalRoot.classList.add('hidden');
  document.body.classList.remove('modal-open');
  clear(els.modal);
}

function modalOpen() {
  return !els.modalRoot.classList.contains('hidden');
}

function syncRoomUI() {
  renderBoard();
  renderHistory();
  if (app.phase !== 'room') return;

  const state = app.state;
  const joined = Boolean(app.store && app.roomRow);
  els.roomTitle.textContent = `房间 ${app.room}`;
  els.roleLine.textContent = joined
    ? `${app.host ? '房主' : '受邀方'} · 我执${sideName(app.mySide)} · 对手执${sideName(app.mySide === Cell.A ? Cell.B : Cell.A)}`
    : '正在连接…';
  if (state) {
    els.statusLine.textContent = describe(state, app.mySide);
    const chipSide = state.isGameOver ? state.winner : state.sideToMove;
    els.turnChip.textContent = state.isGameOver
      ? state.winner !== null
        ? `${sideLabel(state.winner)} 方获胜`
        : '和棋'
      : state.sideToMove === app.mySide
        ? '轮到你落子'
        : `等待 ${sideLabel(state.sideToMove)} 方落子`;
    els.turnChip.className = chipSide === null ? 'turn-chip' : `turn-chip chip-${sideLabel(chipSide).toLowerCase()}`;
    els.statMoves.textContent = String(state.moveHistory.length);
    els.statSide.textContent = sideName(app.mySide);
    els.statResult.textContent = state.winner !== null ? `${sideLabel(state.winner)} 胜` : state.isDraw ? '和棋' : '进行中';
  } else {
    els.statusLine.textContent = '正在读取房间…';
  }
  els.boardInfo.textContent = app.board ? `棋盘：${boardSummary(app.board)}` : '';
  els.syncLine.textContent = app.syncAt
    ? `最近同步：${app.syncAt}${app.syncing ? ' · 同步中…' : ''}${app.host ? ' · 房主' : ''}`
    : '尚未同步';
  els.invite.value = inviteUrl();

  const request = joined && state ? pendingUndo(app.events, app.moves.length) : null;
  const mine = request && request.side === app.mySide;
  const theirs = request && request.side !== app.mySide;
  const plan = joined && state ? undoPlan(app.moves, app.mySide) : null;
  els.undoRequest.disabled = !joined || !state || state.isGameOver || !plan || Boolean(request) || app.submitting;
  els.undoHint.textContent = !joined || !state || mine || theirs
    ? ''
    : state.isGameOver
      ? '对局已结束，可以由房主开始新一局。'
      : plan
        ? plan.removeCount === 2
          ? '悔棋会撤回双方各一手，回到你上一手之前（需要对手同意）。'
          : '悔棋会撤回你刚下的一手（需要对手同意）。'
        : '你还没有落子，暂时无法悔棋。';
  els.undoPrompt.classList.toggle('hidden', !theirs);
  if (theirs) {
    const what = request.removeCount === 2 ? '撤回双方各一手' : '撤回最后一手';
    els.undoText.textContent = `${sideLabel(request.side)} 方请求悔棋：${what}（回到第 ${request.target + 1} 手之前），是否同意？`;
  }
  els.undoStatus.textContent = mine
    ? '悔棋请求已发出，等待对手回应…'
    : !joined || !state
      ? ''
      : '';

  const over = Boolean(state && state.isGameOver);
  els.resultBanner.classList.toggle('hidden', !over);
  if (over) els.resultText.textContent = describe(state, app.mySide);
  els.resultHost.classList.toggle('hidden', !app.host);
  els.resultGuest.classList.toggle('hidden', app.host);
}

/* ------------------------------------------------------------------ boot */

function boot() {
  els.sidebar = qs('#sidebar');
  els.notice = qs('#notice');
  els.resultBanner = qs('#result-banner');
  els.resultText = qs('#result-text');
  els.resultHost = qs('#result-host');
  els.resultGuest = qs('#result-guest');
  els.modalRoot = qs('#modal-root');
  els.modal = qs('#modal');
  els.openRules = qs('#open-rules');

  app.view = new BoardView(qs('#board'), {
    onDown: (x, y, event) => {
      if (event.button !== 0) return;
      submit(x, y);
    },
  });

  qs('#rematch').addEventListener('click', () => rematch(false));
  qs('#rematch-swap').addEventListener('click', () => rematch(true));
  els.openRules.addEventListener('click', openRules);
  els.modalRoot.addEventListener('pointerdown', (event) => {
    if (event.target === els.modalRoot) closeModal();
  });
  window.addEventListener('keydown', (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'Escape') closeModal();
    else if (event.key === 'h' || event.key === 'H') openRules();
  });

  const params = readParams();
  const config = loadConfig();
  app.url = params.url || config.url || '';
  app.key = params.key || config.key || '';
  app.room = params.room || '';
  app.urlToken = params.host || '';

  renderSetup();
  renderBoard();

  if (params.room) {
    // Opened from an invite link (or refreshed mid-game): join straight away.
    joinRoom();
  }
  notifyReady();
}

/** Tells the inline boot-warning script (see index.html) that the page loaded. */
function notifyReady() {
  window.__wayChessBooted = true;
  window.__onlineBooted = true;
  if (window.__wayChessBanner && typeof window.__wayChessBanner.ready === 'function') {
    window.__wayChessBanner.ready();
  }
}

try {
  boot();
} catch (error) {
  if (window.__wayChessBanner && typeof window.__wayChessBanner.show === 'function') {
    window.__wayChessBanner.show(
      '启动失败',
      error && error.message ? error.message : String(error),
      '按 F12 打开控制台查看完整堆栈。',
    );
  }
  throw error;
}
