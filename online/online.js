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
  CLOCK_DEFAULTS,
  CLOCK_LIMITS,
  COUNTDOWN_MS,
  EVENT,
  ROLE,
  ROLE_LABELS,
  SIDE_CHOICES,
  SIDE_CHOICE_LABELS,
  activeMembers,
  boardFromRoom,
  boardSummary,
  buildInviteUrl,
  clockState,
  clockTimeout,
  defaultBoard,
  describe,
  formatClock,
  formatStep,
  isHost,
  nicknameForSide,
  otherSide,
  pendingUndo,
  randomRoomCode,
  randomToken,
  readinessFor,
  rebuild,
  recordedTimeout,
  resolveHostSide,
  roleFor,
  rosterLocked,
  sideForRoleName,
  sideLabel,
  sideName,
  undoPlan,
} from './online-core.js';
import { createSupabaseStore } from './transports.js';

const CONFIG_KEY = 'wcc.online.config.v2';
const HOST_KEY = (room) => `wcc.online.host.${room}`;
const DEVICE_KEY = 'wcc.online.device.v1';
const NICKNAME_KEY = 'wcc.online.nickname.v1';
/** Clocks are derived from database timestamps, so a faster poll keeps both
    devices within a fraction of a second of each other. */
const POLL_MS = 700;
/** Presence heartbeat interval (multiples of the poll). */
const HEARTBEAT_EVERY = 2;
/** Local clock repaint interval (no network involved). */
const CLOCK_TICK_MS = 200;

const app = {
  phase: 'setup',
  url: '',
  key: '',
  room: '',
  urlToken: '',
  device: '',
  nickname: '',
  hostToken: '',
  role: null,
  members: [],
  serverTime: 0,
  meRow: null,
  roster: [],
  seenDevices: new Set(),
  lastNames: new Map(),
  presenceReady: false,
  pollCount: 0,
  serverOffset: 0,
  readiness: null,
  clock: null,
  outcome: null,
  frozenAt: null,
  readyGame: 0,
  timeoutPosted: false,
  postingTimeout: false,
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

/** Every device gets a private id so the room can tell who is who. */
function loadDevice() {
  const stored = readStorage(DEVICE_KEY);
  if (stored) return stored;
  const device = randomToken(20);
  writeStorage(DEVICE_KEY, device);
  return device;
}

function loadNickname() {
  return (readStorage(NICKNAME_KEY) || '').trim();
}

function saveNickname(nickname) {
  app.nickname = nickname.trim().slice(0, 12);
  writeStorage(NICKNAME_KEY, app.nickname);
  return app.nickname;
}

function suggestedNickname() {
  return `棋友${randomRoomCode(3)}`;
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

/* -------------------------------------------------------------- presence */

const ROLE_ORDER = { [ROLE.HOST]: 0, [ROLE.GUEST]: 1, [ROLE.SPECTATOR]: 2 };

function isHostDevice() {
  // The poll only fetches a few room fields, so the token is remembered from
  // the full row we read when entering (or creating) the room.
  return isHost({ room: { host_token: app.hostToken }, storedToken: loadHostToken(), urlToken: app.urlToken });
}

/**
 * Heartbeat this device, pick a seat and refresh the online list.
 *
 * The database keeps a single opponent seat, so a second invited device is
 * automatically pushed to "spectator" instead of both of them believing they
 * are the opponent.
 */
async function refreshPresence({ force = false } = {}) {
  if (!app.store || !app.roomRow) return;
  if (!force && app.pollCount % HEARTBEAT_EVERY !== 0) return;

  // Read first, decide second: the seat must be chosen from fresh rows, or a
  // spectator that just took the opponent seat would fall back to watching.
  const { members, serverTime } = await app.store.listMembers();
  app.members = members;
  app.serverOffset = serverTime - Date.now();
  const host = isHostDevice();
  let role = roleFor({
    room: app.roomRow,
    members,
    device: app.device,
    serverTimeMs: serverTime,
    isHostDevice: host,
  });
  let side = sideForRoleName(app.roomRow, role);
  // The heartbeat must carry the ready flag, otherwise it would clear it.
  let result = await app.store.heartbeat({
    device: app.device,
    nickname: app.nickname,
    role,
    side,
    readyGame: app.readyGame,
  });
  if (role === ROLE.KICKED) {
    applyRoster({ members, serverTime, role, side: null });
    return;
  }
  if (!result.ok && result.conflict) {
    role = ROLE.SPECTATOR;
    side = null;
    result = await app.store.heartbeat({
      device: app.device,
      nickname: app.nickname,
      role,
      side,
      readyGame: 0,
    });
  }
  if (!result.ok) {
    setError(result.reason);
    return;
  }

  applyRoster({ members, serverTime, role, side });
}

function applyRoster({ members, serverTime, role, side }) {
  app.serverOffset = serverTime - Date.now();
  app.members = members;
  app.serverTime = serverTime;
  app.role = role;
  app.mySide = side;
  const fetched = members.find((member) => member.device === app.device) || null;
  if (fetched) app.readyGame = Number(fetched.ready_game) || app.readyGame;
  const self = {
    device: app.device,
    nickname: app.nickname,
    role,
    side,
    joined_at: (app.meRow && app.meRow.joined_at) || new Date(serverTime).toISOString(),
    last_seen: new Date(serverTime).toISOString(),
    ready_game: app.readyGame,
    ready_at: (fetched && fetched.ready_at) || new Date(serverTime).toISOString(),
  };
  app.meRow = self;
  app.roster = activeMembers([...members.filter((member) => member.device !== app.device), self], serverTime).sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || Date.parse(a.joined_at) - Date.parse(b.joined_at),
  ).filter((member) => member.role !== ROLE.KICKED);
  for (const member of app.roster) app.lastNames.set(member.device, member.nickname);
  announcePresenceChanges();
}

/* ----------------------------------------------------------------- clock */

/** Server clock, extrapolated locally between polls for smooth countdowns. */
function estimatedServerNow() {
  return Date.now() + app.serverOffset;
}

/** Combine the engine result with a possible clock timeout. */
function outcomeOf(state, events) {
  const loser = recordedTimeout(events);
  if (loser !== null && loser !== undefined && !Number.isNaN(loser)) {
    return { over: true, winner: otherSide(loser), reason: 'timeout', loser };
  }
  if (state.winner !== null) return { over: true, winner: state.winner, reason: 'win', loser: null };
  if (state.isDraw) return { over: true, winner: null, reason: 'draw', loser: null };
  return { over: false, winner: null, reason: null, loser: null };
}

function refreshReadiness() {
  app.readiness = app.roomRow
    ? readinessFor({ members: app.members, serverTimeMs: estimatedServerNow(), game: app.game || 1 })
    : null;
  return app.readiness;
}

function updateClockUI() {
  if (app.phase !== 'room' || !app.roomRow) return;
  const readiness = refreshReadiness();
  const now = estimatedServerNow();
  const startAt = readiness.bothReady ? readiness.startAt : null;
  const clock = clockState({
    moves: app.moves,
    room: app.roomRow,
    startAt,
    serverTimeMs: now,
    frozenAt: app.outcome && app.outcome.over ? app.frozenAt : null,
  });
  app.clock = clock;
  renderClockBar(clock, readiness);
  renderCountdown(readiness, clock);
  maybeReportTimeout(clock, readiness);
}

function renderClockBar(clock, readiness) {
  const { hostSide, guestSide } = sideOrder();
  const names = {
    [hostSide]: (readiness.host && readiness.host.nickname) || '房主',
    [guestSide]: (readiness.guest && readiness.guest.nickname) || '等待对手',
  };
  const live = readiness.live;
  const over = Boolean(app.outcome && app.outcome.over);
  for (const side of [Cell.A, Cell.B]) {
    const parts = els.clocks[side];
    if (!parts || !parts.main) continue;
    const node = parts.node;
    const isTurn = live && !over && clock.sideToMove === side;
    node.classList.toggle('is-turn', isTurn);
    if (parts.name) parts.name.textContent = `${sideLabel(side)} 方 · ${names[side] || '—'}`;
    parts.main.textContent = formatClock(clock.remaining[side]);
    parts.main.classList.toggle('is-low', clock.remaining[side] <= 30000);
    if (parts.move) {
      parts.move.textContent = isTurn ? `步时 ${formatClock(clock.stepRemaining)}` : `步时 ${formatStep(clock.moveMs)}`;
    }
  }
  els.clockBar.classList.toggle('is-live', live);
}

function sideOrder() {
  const hostSide = Number(app.roomRow && app.roomRow.host_side) === Cell.B ? Cell.B : Cell.A;
  return { hostSide, guestSide: otherSide(hostSide) };
}

function renderCountdown(readiness, clock) {
  if (!els.countdown) return;
  const over = app.outcome && app.outcome.over;
  if (!readiness.bothReady || readiness.live || over) {
    els.countdown.classList.add('hidden');
    return;
  }
  const seconds = Math.ceil(readiness.countdownLeft / 1000);
  els.countdown.classList.remove('hidden');
  els.countdown.textContent = String(Math.max(1, seconds));
  void clock;
}

/** Any client may declare a timeout; the event log keeps it once. */
async function maybeReportTimeout(clock, readiness) {
  if (!app.store || app.postingTimeout || app.timeoutPosted) return;
  if (app.outcome && app.outcome.over) return;
  const loser = clockTimeout(clock, { live: readiness.live });
  if (loser === null) return;
  app.postingTimeout = true;
  try {
    const result = await app.store.appendEvent({
      game: app.game,
      kind: EVENT.CLOCK_TIMEOUT,
      side: loser,
      target: null,
    });
    if (result.ok) {
      app.timeoutPosted = true;
      setNotice(`${sideLabel(loser)} 方超时，${sideLabel(otherSide(loser))} 方获胜。`);
      await sync({ force: true });
    }
  } catch (error) {
    /* the next tick retries */
  } finally {
    app.postingTimeout = false;
  }
}

/** Ready / cancel-ready for the current game. */
async function toggleReady() {
  if (!app.store || app.role === ROLE.SPECTATOR) return;
  const next = app.readyGame >= (app.game || 1) ? 0 : app.game || 1;
  app.readyGame = next;
  const result = await app.store.heartbeat({
    device: app.device,
    nickname: app.nickname,
    role: app.role,
    side: app.mySide,
    readyGame: next,
  });
  if (!result.ok) {
    setNotice(result.reason);
    return;
  }
  setNotice(next ? '已准备完毕，等待对手…' : '已取消准备。');
  await refreshPresence({ force: true });
  syncRoomUI();
}

/**
 * A finished game clears both ready flags (each client clears its own), so the
 * 准备完毕 button comes back for the next round without anyone having to
 * un-ready manually.
 */
function maybeResetReady() {
  if (!app.store || app.readyGame < (app.game || 1)) return;
  if (app.role !== ROLE.HOST && app.role !== ROLE.GUEST) return;
  app.readyGame = 0;
  Promise.resolve(
    app.store.heartbeat({
      device: app.device,
      nickname: app.nickname,
      role: app.role,
      side: app.mySide,
      readyGame: 0,
    }),
  ).catch(() => {});
}

/* ------------------------------------------------- host: seat management */

async function kickMember(member) {
  if (!app.host || rosterLocked(app.readiness, app.outcome)) return;
  const result = await app.store.setMemberRole({
    device: member.device,
    role: ROLE.KICKED,
    side: null,
    readyGame: 0,
  });
  setNotice(result.ok ? `已将 ${member.nickname} 移出房间。` : result.reason);
  await refreshPresence({ force: true });
  syncRoomUI();
}

async function demoteOpponent(member) {
  if (!app.host || rosterLocked(app.readiness, app.outcome)) return;
  const result = await app.store.setMemberRole({
    device: member.device,
    role: ROLE.SPECTATOR,
    side: null,
    readyGame: 0,
  });
  setNotice(result.ok ? `${member.nickname} 已降为旁观。` : result.reason);
  await refreshPresence({ force: true });
  syncRoomUI();
}

async function promoteToOpponent(member) {
  if (!app.host || rosterLocked(app.readiness, app.outcome)) return;
  const current = activeMembers(app.members, app.serverTime || Date.now()).find(
    (entry) => entry.role === ROLE.GUEST && entry.device !== member.device,
  );
  if (current) {
    await app.store.setMemberRole({ device: current.device, role: ROLE.SPECTATOR, side: null, readyGame: 0 });
  }
  const side = sideForRoleName(app.roomRow, ROLE.GUEST);
  const result = await app.store.setMemberRole({
    device: member.device,
    role: ROLE.GUEST,
    side,
    readyGame: 0,
  });
  setNotice(result.ok ? `${member.nickname} 已成为对手（执${sideName(side)}）。` : result.reason);
  await refreshPresence({ force: true });
  syncRoomUI();
}

/** A device the host removed leaves on its own and must not re-create its row. */
function handleKicked() {
  if (app.role !== ROLE.KICKED) return false;
  stopPoll();
  leaveRoom({ cleanMember: false });
  setNotice('你已被房主移出房间。');
  return true;
}

/** Tell the table when somebody joins or leaves. */
function announcePresenceChanges() {
  const current = new Map(app.roster.map((member) => [member.device, member]));
  if (!app.presenceReady) {
    app.seenDevices = new Set(current.keys());
    app.presenceReady = true;
    const others = app.roster.filter((member) => member.device !== app.device);
    if (others.length) setNotice(`房间里还有 ${others.length} 位成员（${others.map((m) => m.nickname).join('、')}）。`);
    return;
  }
  for (const [device, member] of current) {
    if (app.seenDevices.has(device)) continue;
    setNotice(
      member.role === ROLE.SPECTATOR
        ? `${member.nickname} 进入观战`
        : `${member.nickname} 加入了房间（${ROLE_LABELS[member.role]}）`,
    );
  }
  for (const device of app.seenDevices) {
    if (current.has(device)) continue;
    setNotice(`${app.lastNames.get(device) || '有成员'} 离开了房间`);
  }
  app.seenDevices = new Set(current.keys());
}

/** A spectator can take the opponent seat once it is free (or its holder stale). */
async function takeSeat() {
  if (!app.store || app.role !== ROLE.SPECTATOR) return;
  const active = activeMembers(app.members, app.serverTime || Date.now());
  const busy = active.find((member) => member.role === ROLE.GUEST && member.device !== app.device);
  if (busy) {
    setNotice(`${busy.nickname} 正在对局中，暂时不能接替。`);
    return;
  }
  const stale = app.members.find((member) => member.role === ROLE.GUEST && member.device !== app.device);
  if (stale) await app.store.dropMember(stale.device);

  const side = sideForRoleName(app.roomRow, ROLE.GUEST);
  const result = await app.store.heartbeat({
    device: app.device,
    nickname: app.nickname,
    role: ROLE.GUEST,
    side,
    readyGame: 0, // taking a seat always starts un-ready
  });
  if (!result.ok) {
    await app.store.heartbeat({
      device: app.device,
      nickname: app.nickname,
      role: ROLE.SPECTATOR,
      side: null,
      readyGame: 0,
    });
    setNotice('对手座位刚被其他人坐上，你继续观战。');
  } else {
    setNotice(`已接替对手，你执${sideName(side)}。`);
  }
  await refreshPresence({ force: true });
  await sync({ force: true });
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

  const mainMinutes = h('input', {
    id: 'main-minutes',
    class: 'text-input small',
    type: 'number',
    min: '1',
    max: '120',
    step: '1',
    value: String(Math.round(CLOCK_DEFAULTS.mainMs / 60000)),
  });
  const moveSeconds = h('input', {
    id: 'move-seconds',
    class: 'text-input small',
    type: 'number',
    min: '10',
    max: '600',
    step: '5',
    value: String(Math.round(CLOCK_DEFAULTS.moveMs / 1000)),
  });

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
    h('p', { id: 'setup-nickname', class: 'hint' }),
    h('div', { class: 'row-gap' }, h('button', { id: 'change-nickname', type: 'button' }, '修改昵称')),
    details,
    h('h3', { text: '创建房间（房主）' }),
    h('label', { class: 'field' }, h('span', { text: '初始棋盘' }), boardSource),
    randomFields,
    jsonField,
    h('div', { class: 'preview-row' }, previewCanvas, previewInfo),
    h('label', { class: 'field' }, h('span', { text: '局时' }), mainMinutes, h('span', { class: 'hint', text: '分钟' })),
    h('label', { class: 'field' }, h('span', { text: '步时' }), moveSeconds, h('span', { class: 'hint', text: '秒' })),
    h('p', { class: 'hint', text: '局时用尽或单步超过步时都判负；房主创建后不能再改。' }),
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
  els.mainMinutes = mainMinutes;
  els.moveSeconds = moveSeconds;
  els.roomInput = roomInput;
  els.createRoom = sidebarCards.querySelector('#create-room');
  els.joinRoom = sidebarCards.querySelector('#join-room');
  els.setupNickname = sidebarCards.querySelector('#setup-nickname');
  els.changeNickname = sidebarCards.querySelector('#change-nickname');
  els.previewCanvas = previewCanvas;
  els.previewInfo = previewInfo;

  els.setupNickname.textContent = `当前昵称：${app.nickname || '（未设置）'}`;
  els.changeNickname.addEventListener('click', () => askNickname());
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

/** Read the host's clock fields, clamped to the documented ranges. */
function readClockFields() {
  const clamp = (value, { min, max }, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  const mainMinutes = clamp(els.mainMinutes && els.mainMinutes.value, { min: 1, max: 120 }, 10);
  const moveSeconds = clamp(els.moveSeconds && els.moveSeconds.value, { min: 10, max: 600 }, 90);
  const mainMs = Math.min(CLOCK_LIMITS.mainMs.max, Math.max(CLOCK_LIMITS.mainMs.min, mainMinutes * 60000));
  const moveMs = Math.min(CLOCK_LIMITS.moveMs.max, Math.max(CLOCK_LIMITS.moveMs.min, moveSeconds * 1000));
  if (els.mainMinutes) els.mainMinutes.value = String(Math.round(mainMs / 60000));
  if (els.moveSeconds) els.moveSeconds.value = String(Math.round(moveMs / 1000));
  return { mainMs, moveMs };
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
    h('p', { id: 'room-nickname', class: 'hint' }),
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
      h('button', { id: 'change-nickname-room', type: 'button' }, '修改昵称'),
      h('button', { id: 'leave', type: 'button' }, '退出房间'),
    ),
  );

  const rosterList = h('ul', { id: 'roster', class: 'roster' });
  const rosterHint = h('p', { id: 'roster-hint', class: 'hint' });
  const takeSeatButton = h('button', { id: 'take-seat', class: 'action-button wide hidden', type: 'button' }, '接替对手');
  const membersCard = h(
    'section',
    { class: 'card' },
    h('h2', { text: '房间成员' }),
    rosterList,
    rosterHint,
    takeSeatButton,
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
  const readyButton = h('button', { id: 'ready-button', class: 'action-button wide', type: 'button' }, '准备完毕');
  const readyHint = h('p', { id: 'ready-hint', class: 'hint' });
  const actionsCard = h(
    'section',
    { class: 'card' },
    h('h2', { text: '对局操作' }),
    readyButton,
    readyHint,
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
    membersCard,
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
    roomNickname: roomCard.querySelector('#room-nickname'),
    historyList,
    undoRequest,
    undoPrompt,
    undoText,
    undoStatus,
    undoHint,
    readyButton,
    readyHint,
    clearRoom,
    closeRoom,
    rosterList,
    rosterHint,
    takeSeatButton,
    invite,
  });

  roomCard.querySelector('#sync').addEventListener('click', () => sync({ force: true }));
  roomCard.querySelector('#leave').addEventListener('click', leaveRoom);
  roomCard.querySelector('#change-nickname-room').addEventListener('click', () => askNickname());
  takeSeatButton.addEventListener('click', takeSeat);
  undoRequest.addEventListener('click', requestUndo);
  readyButton.addEventListener('click', toggleReady);
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
    const { mainMs, moveMs } = readClockFields();
    const result = await store.createRoom({ board: toBoardPayload(board), hostToken, hostSide, mainMs, moveMs });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    app.store = store;
    app.urlToken = hostToken;
    app.hostToken = hostToken;
    saveHostToken(app.room, hostToken);
    saveConfig();
    setError('');
    setNotice(`房间 ${app.room} 已创建，把邀请链接发给对手吧。`);
    // Hand the freshly created row over so the host UI (and its controls)
    // renders before the first poll returns.
    await enterRoom({
      code: app.room,
      board: toBoardPayload(board),
      host_token: hostToken,
      host_side: hostSide,
      game: 1,
      main_ms: mainMs,
      move_ms: moveMs,
    });
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
    app.hostToken = roomRow.host_token || '';
    saveConfig();
    setError('');
    await enterRoom(roomRow);
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

async function enterRoom(roomRow = null) {
  app.roomRow = roomRow;
  app.game = null;
  app.moves = [];
  app.events = [];
  app.state = null;
  // The poll only returns a few room columns, so the board is captured here
  // from the full row (creator or joiner) and kept for the rest of the game.
  app.board = roomRow && roomRow.board ? boardFromRoom(roomRow) : defaultBoard();
  app.members = [];
  app.roster = [];
  app.seenDevices = new Set();
  app.lastNames = new Map();
  app.presenceReady = false;
  app.pollCount = 0;
  app.readiness = null;
  app.clock = null;
  app.outcome = null;
  app.frozenAt = null;
  app.readyGame = 0;
  app.timeoutPosted = false;
  app.host = Boolean(roomRow && isHost({ room: roomRow, storedToken: loadHostToken(), urlToken: app.urlToken }));
  app.role = app.host ? ROLE.HOST : null;
  app.mySide = app.host ? sideForRoleName(roomRow, ROLE.HOST) : null;
  renderRoom();
  updateOwnUrl();
  // Claim a seat (or land in spectator mode) before the first render of the
  // board, so the page never briefly shows the wrong side.
  try {
    await refreshPresence({ force: true });
  } catch (error) {
    setError(error.message);
  }
  await sync({ force: true });
  schedulePoll();
}

function leaveRoom({ cleanMember = true } = {}) {
  stopPoll();
  if (cleanMember && app.store && app.device) {
    // Best effort: free the seat (and the name) right away instead of waiting
    // for the presence timeout to expire.
    Promise.resolve(app.store.leaveRoom(app.device)).catch(() => {});
  }
  app.store = null;
  app.roomRow = null;
  app.board = null;
  app.state = null;
  app.moves = [];
  app.events = [];
  app.members = [];
  app.roster = [];
  app.seenDevices = new Set();
  app.lastNames = new Map();
  app.presenceReady = false;
  app.meRow = null;
  app.hostToken = '';
  app.readiness = null;
  app.clock = null;
  app.outcome = null;
  app.frozenAt = null;
  app.readyGame = 0;
  app.timeoutPosted = false;
  app.pollCount = 0;
  app.game = null;
  app.host = false;
  app.role = null;
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
  app.pollCount += 1;
  try {
    const [roomRow, moveRows, eventRows] = await Promise.all([
      app.store.getRoomState(),
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
    // Presence rides along with the poll: a heartbeat every other tick keeps
    // the online list fresh without hammering the free tier.
    await refreshPresence({ force });
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
  // The poll returns only a few columns, so the board is kept from the full
  // row read when joining; a full row (or a first sync) refreshes it.
  if (roomRow.board) app.board = boardFromRoom(roomRow);
  else if (!app.board) app.board = defaultBoard();
  app.host = isHostDevice();
  const previousSide = app.mySide;
  // The seat (host / opponent / spectator) comes from presence; only the side
  // has to be re-derived here, because “再来一局（交换先后手）” flips it.
  if (app.role) app.mySide = sideForRoleName(roomRow, app.role);
  else if (app.host) {
    app.role = ROLE.HOST;
    app.mySide = sideForRoleName(roomRow, ROLE.HOST);
  }
  const { state, rows, applied, error } = rebuild(moveRows, app.board);
  app.state = state;
  app.moves = rows.slice(0, applied);
  app.events = eventRows;
  app.outcome = outcomeOf(state, app.events);
  const last = app.moves[app.moves.length - 1] || null;
  app.frozenAt = app.outcome.over && last ? Date.parse(last.created_at) || null : null;
  if (restarted) {
    app.readyGame = 0;
    app.timeoutPosted = false;
  }
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
  if (app.role === ROLE.SPECTATOR) {
    setNotice('你正在观战：旁观者不能落子。');
    return;
  }
  if (!app.readiness || !app.readiness.live) {
    setNotice(
      app.readiness && app.readiness.opponentWaiting
        ? '还没有对手：等第二位玩家通过邀请链接加入后才能开始。'
        : '对局尚未开始：等双方都点“准备完毕”并在读秒结束后才能落子。',
    );
    return;
  }
  if (app.outcome && app.outcome.over) {
    setNotice('对局已结束，可以由房主开始新一局。');
    return;
  }
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
  const live = Boolean(app.readiness && app.readiness.live);
  const over = Boolean(app.outcome && app.outcome.over);
  const interactive = live && !over && !state.isGameOver && state.sideToMove === app.mySide && !app.submitting;
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

/* --------------------------------------------------------------- modals */

function showModal({ title, subtitle = '', body, footer = null, dismissible = true }) {
  const modal = clear(els.modal);
  modal.append(
    h(
      'header',
      { class: 'modal-header' },
      h('div', {}, h('h2', { text: title }), subtitle ? h('p', { class: 'modal-subtitle', text: subtitle }) : null),
      dismissible ? h('button', { type: 'button', class: 'icon-button', title: '关闭', onclick: () => closeModal() }, '✕') : null,
    ),
    body,
  );
  if (footer) modal.append(footer);
  els.modalRoot.dataset.dismissible = dismissible ? 'yes' : 'no';
  els.modalRoot.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal(force = false) {
  if (els.modalRoot.classList.contains('hidden')) return;
  if (!force && els.modalRoot.dataset.dismissible === 'no') return;
  els.modalRoot.classList.add('hidden');
  document.body.classList.remove('modal-open');
  clear(els.modal);
}

function modalOpen() {
  return !els.modalRoot.classList.contains('hidden');
}

function openRules() {
  const body = h('div', { class: 'modal-body help-body' });
  renderRuleSections(body, [...GAME_RULES, ...ONLINE_CONTROLS]);
  showModal({
    title: '游戏规则',
    subtitle: '与单机版共用同一份规则引擎',
    body,
    footer: h('footer', { class: 'modal-footer' }, h('button', { type: 'button', onclick: () => closeModal() }, '知道了')),
  });
}

/**
 * Nickname dialog. On a device's first visit it is mandatory (`required`), so
 * the room can always show who is online; afterwards it doubles as "rename".
 */
function askNickname({ required = false, onSaved = null } = {}) {
  const input = h('input', {
    id: 'nickname-input',
    class: 'text-input',
    type: 'text',
    maxlength: '12',
    placeholder: '例如 小明',
    value: app.nickname || suggestedNickname(),
  });
  const error = h('p', { id: 'nickname-error', class: 'notice notice-left' });
  const save = h('button', { id: 'nickname-save', class: 'primary', type: 'button' }, required ? '就用这个名字' : '保存昵称');

  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      error.textContent = '请输入 1-12 个字符的昵称';
      error.classList.add('is-visible');
      return;
    }
    saveNickname(value);
    closeModal(true);
    if (app.phase === 'room') {
      await refreshPresence({ force: true });
      syncRoomUI();
    } else {
      renderSetup();
    }
    if (onSaved) await onSaved();
  };

  save.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });

  showModal({
    title: required ? '先给自己起个名字' : '修改昵称',
    subtitle: '每台设备第一次进入时设置一次，之后随时可以改；不需要注册',
    body: h(
      'div',
      { class: 'modal-body' },
      h('label', { class: 'field' }, h('span', { text: '昵称' }), input),
      error,
      h('p', { class: 'hint', text: '昵称会显示在房间成员列表和“轮到你/对手落子”的提示里。' }),
    ),
    footer: h(
      'footer',
      { class: 'modal-footer' },
      h('p', { class: 'hint', text: required ? '设置昵称后才能进入房间' : '' }),
      save,
    ),
    dismissible: !required,
  });
  if (input.focus) input.focus();
  if (input.select) input.select();
}

function syncRoomUI() {
  // Refresh readiness and the clocks first: the board's interactivity and the
  // ready/clock widgets all read the values computed here.
  if (app.phase === 'room' && app.roomRow) updateClockUI();
  renderBoard();
  renderHistory();
  if (app.phase !== 'room') return;

  const state = app.state;
  const joined = Boolean(app.store && app.roomRow);
  const readiness = app.readiness || { live: false, bothReady: false, readyHost: false, readyGuest: false };
  const over = Boolean(app.outcome && app.outcome.over);
  if (over) maybeResetReady();
  const spectator = app.role === ROLE.SPECTATOR;
  if (handleKicked()) return;
  const otherSide = app.mySide === Cell.A ? Cell.B : Cell.A;
  els.roomTitle.textContent = `房间 ${app.room}`;
  els.roomNickname.textContent = `我的昵称：${app.nickname || '（未设置）'} · ${joined ? ROLE_LABELS[app.role] || '—' : '未进入房间'}`;
  els.roleLine.textContent = !joined
    ? '正在连接…'
    : !app.role
      ? '正在分配座位…'
      : spectator
        ? '观战中 · 旁观者可以看棋，但不能落子或悔棋'
        : `${ROLE_LABELS[app.role]} · 我执${sideName(app.mySide)} · 对手执${sideName(otherSide)}`;

  if (state) {
    const counting = readiness.bothReady && !readiness.live;
    // Before the game the clock is not running and nobody "moves"; after it,
    // the result lives in the banner, so the status simply says 游戏结束.
    els.statusLine.textContent = over ? '游戏结束' : readiness.live ? describe(state, app.mySide) : counting ? '读秒后开始' : '请准备';
    const chipSide = over ? app.outcome.winner : readiness.live ? state.sideToMove : null;
    const turnName = readiness.live && !over ? nicknameForSide(app.roster, app.roomRow, state.sideToMove) : '';
    els.turnChip.textContent = over
      ? '游戏结束'
      : !readiness.live
        ? counting
          ? '读秒中…'
          : '请准备'
        : state.sideToMove === app.mySide
          ? '轮到你落子'
          : `等待 ${sideLabel(state.sideToMove)} 方${turnName ? `（${turnName}）` : ''}落子`;
    els.turnChip.className = chipSide === null ? 'turn-chip' : `turn-chip chip-${sideLabel(chipSide).toLowerCase()}`;
    els.statMoves.textContent = String(state.moveHistory.length);
    els.statSide.textContent = spectator ? '观战' : sideName(app.mySide);
    els.statResult.textContent = app.outcome && app.outcome.over
      ? app.outcome.winner !== null
        ? `${sideLabel(app.outcome.winner)} 胜`
        : '和棋'
      : '进行中';
  } else {
    els.statusLine.textContent = '正在读取房间…';
  }
  els.boardInfo.textContent = app.board ? `棋盘：${boardSummary(app.board)}` : '';
  els.syncLine.textContent = app.syncAt ? `最近同步：${app.syncAt}${app.syncing ? ' · 同步中…' : ''}` : '尚未同步';
  els.invite.value = inviteUrl();
  renderRoster();

  const seatBusy = activeMembers(app.members, app.serverTime || Date.now()).some(
    (member) => member.role === ROLE.GUEST && member.device !== app.device,
  );
  els.takeSeatButton.classList.toggle('hidden', !(joined && spectator && !seatBusy));
  els.rosterHint.textContent = rosterLocked(readiness, app.outcome)
    ? '对局进行中：结束后才能更换对手或移出成员'
    : '';

  const request = joined && state ? pendingUndo(app.events, app.moves.length) : null;
  const mine = request && request.side === app.mySide;
  // Only the two players may answer an undo request; spectators just watch.
  const theirs = Boolean(request) && !spectator && request.side !== app.mySide;
  const plan = joined && state ? undoPlan(app.moves, app.mySide) : null;
  const canAsk = joined && !spectator && state && !state.isGameOver && Boolean(plan) && !request && !app.submitting;
  els.undoRequest.classList.toggle('hidden', !joined || spectator);
  els.undoRequest.disabled = !canAsk;
  els.undoHint.textContent = !joined || !state || mine || theirs
    ? ''
    : spectator
      ? '你正在观战：旁观者不能落子或悔棋。'
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
  els.undoStatus.textContent = mine ? '悔棋请求已发出，等待对手回应…' : '';

  const player = app.role === ROLE.HOST || app.role === ROLE.GUEST;
  const myReady = app.readyGame >= (app.game || 1);
  const opponentReady = app.role === ROLE.HOST ? readiness.readyGuest : readiness.readyHost;
  // The ready control belongs to the time between games: once the clock is
  // running it disappears, and a finished game clears both ready flags.
  els.readyButton.classList.toggle('hidden', !joined || !player || (readiness.live && !over));
  els.readyButton.disabled = !joined || !player;
  els.readyButton.textContent = myReady ? '取消准备' : '准备完毕';
  els.readyHint.textContent = !joined || !player
    ? ''
    : readiness.opponentWaiting
      ? '等待对手加入'
      : readiness.live && !over
        ? ''
        : `你：${myReady ? '已准备' : '未准备'} · 对手：${opponentReady ? '已准备' : '未准备'}`;

  els.resultBanner.classList.toggle('hidden', !over);
  if (over) {
    els.resultText.textContent =
      app.outcome.reason === 'timeout'
        ? `${sideLabel(app.outcome.loser)} 方超时，${sideLabel(app.outcome.winner)} 方获胜！`
        : app.outcome.reason === 'draw'
          ? '和棋：已经没有可落子格'
          : `${sideLabel(app.outcome.winner)} 方四连获胜！`;
  }
  els.resultHost.classList.toggle('hidden', !app.host);
  els.resultGuest.classList.toggle('hidden', app.host);
  updateClockUI();
}

/** The online-member list, newest heartbeat first within each role. */
function renderRoster() {
  if (!els.rosterList) return;
  const list = clear(els.rosterList);
  const now = app.serverTime || Date.now();
  const online = new Set(activeMembers(app.members, now).map((member) => member.device));
  const locked = rosterLocked(app.readiness, app.outcome);
  if (!app.roster.length) {
    list.append(h('li', { class: 'history-empty', text: '暂无成员' }));
    return;
  }
  for (const member of app.roster) {
    const isMe = member.device === app.device;
    const side = member.side === null || member.side === undefined ? null : Number(member.side);
    const badges = [ROLE_LABELS[member.role] || member.role];
    if (side !== null) badges.push(`${sideLabel(side)} 方`);
    const actions = [];
    if (app.host && !isMe && member.role !== ROLE.HOST) {
      if (member.role === ROLE.GUEST) {
        actions.push(
          h('button', { class: 'roster-action', type: 'button', disabled: locked, onclick: () => demoteOpponent(member) }, '降为旁观'),
        );
      } else if (member.role === ROLE.SPECTATOR) {
        actions.push(
          h('button', { class: 'roster-action', type: 'button', disabled: locked, onclick: () => promoteToOpponent(member) }, '选为对手'),
        );
      }
      actions.push(
        h('button', { class: 'roster-action danger', type: 'button', disabled: locked, onclick: () => kickMember(member) }, '移出'),
      );
    }
    list.append(
      h(
        'li',
        { class: `roster-item${isMe ? ' is-me' : ''}` },
        h('span', { class: `presence-dot${online.has(member.device) ? ' is-online' : ''}` }),
        h('span', { class: 'roster-name', text: `${member.nickname}${isMe ? '（你）' : ''}` }),
        h('span', { class: 'roster-role', text: badges.join(' · ') }),
        actions.length ? h('span', { class: 'roster-actions' }, ...actions) : null,
      ),
    );
  }
  for (const member of app.members) {
    if (member.device === app.device || online.has(member.device)) continue;
    if (app.roster.some((entry) => entry.device === member.device)) continue;
    if (member.role === ROLE.KICKED) continue;
    list.append(
      h(
        'li',
        { class: 'roster-item is-offline' },
        h('span', { class: 'presence-dot' }),
        h('span', { class: 'roster-name', text: member.nickname }),
        h('span', { class: 'roster-role', text: `${ROLE_LABELS[member.role] || member.role} · 离线` }),
      ),
    );
  }
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
  els.clockBar = qs('#clock-bar');
  els.countdown = qs('#countdown');
  els.clocks = {
    [Cell.A]: { node: qs('#clock-a'), name: qs('#clock-name-a'), main: qs('#clock-main-a'), move: qs('#clock-move-a') },
    [Cell.B]: { node: qs('#clock-b'), name: qs('#clock-name-b'), main: qs('#clock-main-b'), move: qs('#clock-move-b') },
  };

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
  app.device = loadDevice();
  app.nickname = loadNickname();

  renderSetup();
  renderBoard();

  // Opened from an invite link (or refreshed mid-game): join as soon as the
  // device has a nickname, which the room uses to show who is online.
  const continueToRoom = () => (params.room ? joinRoom() : undefined);
  if (!app.nickname) askNickname({ required: true, onSaved: continueToRoom });
  else continueToRoom();
  // The clock ticks locally between polls; no extra network traffic.
  window.setInterval(updateClockUI, CLOCK_TICK_MS);
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
