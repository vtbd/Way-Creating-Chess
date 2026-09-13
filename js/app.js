/**
 * Way Creating Chess — browser front end.
 *
 * Responsibilities, mirroring the desktop `main.py`: own the live
 * `GameState`, route clicks, schedule AI turns, and drive the modals for
 * board setup, the board editor and the search settings. Rules live in
 * `engine.js`, AI in `ai.js`, board catalogs in `boards.js`.
 */

import { AlphaBetaAI, DEFAULT_SEARCH_SETTINGS, RandomAI, SEARCH_LIMITS, clampSettings } from './ai.js';
import { BoardView } from './board-view.js';
import {
  MAX_DIMENSION,
  MIN_DIMENSION,
  addSavedBoard,
  catalogToJson,
  cloneDefinition,
  createBoardId,
  definitionMatrix,
  generateRandomBoard,
  importCatalog,
  loadSavedBoards,
  openCount,
  presetBoards,
  removeSavedBoard,
  stoneCount,
} from './boards.js';
import { clear, downloadText, h, qs, timestamp } from './dom.js';
import { EditorModel, clampDimension } from './editor.js';
import { Cell, GameState, playerLabel } from './engine.js';
import { drawMiniBoard } from './preview.js';

const AI_MOVE_DELAY_MS = 320;
const SETTINGS_KEY = 'wcc.ai-settings.v1';

/** Who plays a side. */
const KIND = Object.freeze({ HUMAN: 'human', RANDOM: 'random', THINK: 'think' });
const KIND_ORDER = [KIND.HUMAN, KIND.RANDOM, KIND.THINK];
const KIND_LABELS = { [KIND.HUMAN]: '玩家', [KIND.RANDOM]: '随机 AI', [KIND.THINK]: '思考型 AI' };
const TOOL_LABELS = {
  [Cell.CLOSED]: '封闭（擦除）',
  [Cell.OPEN]: '可走',
  [Cell.A]: 'A 方棋子',
  [Cell.B]: 'B 方棋子',
};

const randomAI = new RandomAI();

/* ------------------------------------------------------------------ state */

const app = {
  state: null,
  boardLabel: '',
  boardSource: null,
  kinds: { [Cell.A]: KIND.HUMAN, [Cell.B]: KIND.HUMAN },
  settings: { ...DEFAULT_SEARCH_SETTINGS },
  boards: [],
  panel: null,
  editor: null,
  editorView: null,
  editorTool: Cell.OPEN,
  editingBoardName: '',
  painting: false,
  selectedBoardId: null,
  randomPreview: null,
  setup: { width: 12, height: 9, density: 0.3, seed: '' },
  highlight: null,
  notice: '',
  pending: null,
  nextAiAt: 0,
  searchStats: null,
  worker: null,
  workerBroken: false,
  requestSeq: 0,
};

const els = {};

/* ------------------------------------------------------------- utilities */

function countOpen(state) {
  let total = 0;
  for (let i = 0; i < state.cells.length; i += 1) if (state.cells[i] === Cell.OPEN) total += 1;
  return total;
}

function controllerKind(side) {
  return app.kinds[side] || KIND.HUMAN;
}

function sideIsAi(side) {
  return controllerKind(side) !== KIND.HUMAN;
}

function setNotice(text) {
  app.notice = text;
  els.notice.textContent = text;
  els.notice.classList.toggle('is-visible', Boolean(text));
}

function boardIndex(x, y, width) {
  return y * width + x;
}

/** Rebuild the selectable board list: bundled presets plus saved boards. */
function refreshBoards() {
  app.boards = [
    ...presetBoards().map((board) => ({ ...board, preset: true })),
    ...loadSavedBoards().map((board) => ({ ...board, preset: false })),
  ];
  if (!app.selectedBoardId || !app.boards.some((board) => board.id === app.selectedBoardId)) {
    app.selectedBoardId = app.boards.length ? app.boards[0].id : null;
  }
}

function findBoard(id) {
  return app.boards.find((board) => board.id === id) || null;
}

/* --------------------------------------------------------------- lifecycle */

function startGame(definition, { notice } = {}) {
  app.state = new GameState(definitionMatrix(definition));
  app.boardSource = cloneDefinition(definition);
  app.boardLabel = `${definition.name} · ${definition.width}×${definition.height} · 初始可走 ${openCount(definition)} 格`;
  app.highlight = null;
  app.searchStats = null;
  cancelPendingSearch();
  scheduleAi(420);
  setNotice(notice || `已开始新棋局：${definition.name}`);
  if (app.panel) closePanel();
  refresh();
}

function restartGame() {
  app.state.reset();
  app.highlight = null;
  app.searchStats = null;
  cancelPendingSearch();
  scheduleAi(AI_MOVE_DELAY_MS);
  setNotice('已恢复到初始棋盘');
  refresh();
}

function playMove(x, y, actor) {
  const state = app.state;
  if (state.isGameOver) {
    setNotice('对局已结束：请重开或选择新棋盘');
    return;
  }
  if (!state.isLegalMove(x, y)) {
    setNotice('该格不可落子：只有浅色“可走”格能落子');
    return;
  }
  const played = state.makeMove(x, y);
  app.highlight = null;
  const prefix = actor ? `${actor}：` : '';
  const roads = played.created.length ? `造路 ${played.created.length} 格` : '未造路';
  setNotice(`${prefix}${played.notation} · ${roads}`);
  scheduleAi(AI_MOVE_DELAY_MS);
  refresh();
}

function undoMove() {
  const state = app.state;
  if (state.moveHistory.length === 0) {
    setNotice('没有可撤销的着法');
    return;
  }
  const humanPlays = !sideIsAi(Cell.A) || !sideIsAi(Cell.B);
  let steps = 1;
  const undone = state.undoMove();
  // Hand the turn back to a human side so undo does not look like a no-op.
  while (humanPlays && state.moveHistory.length > 0 && sideIsAi(state.sideToMove) && steps < 2) {
    state.undoMove();
    steps += 1;
  }
  app.highlight = null;
  cancelPendingSearch();
  scheduleAi(AI_MOVE_DELAY_MS + 200);
  setNotice(`已撤销 ${steps} 手${undone ? `（${undone.notation}）` : ''}`);
  refresh();
}

function saveRecord() {
  const state = app.state;
  if (state.moveHistory.length === 0) {
    setNotice('还没有着法可以保存');
    return;
  }
  const record = { board: app.boardLabel, ...state.exportRecord() };
  downloadText(`way-chess-record-${timestamp()}.json`, JSON.stringify(record, null, 2));
  setNotice('棋谱已下载为 JSON 文件');
}

/** Store the live position as a reusable initial board (stones become roads). */
function saveCurrentBoard() {
  const state = app.state;
  const definition = {
    id: createBoardId('saved'),
    name: `保存棋盘 ${timestamp()}`,
    width: state.width,
    height: state.height,
    content: state.toMatrix().map((row) => row.map((value) => (value === Cell.CLOSED ? Cell.CLOSED : Cell.OPEN))),
  };
  addSavedBoard(definition);
  refreshBoards();
  app.selectedBoardId = definition.id;
  setNotice(`当前局面已保存为初始棋盘：${definition.name}`);
  if (app.panel === 'setup') renderModal();
}

/* ------------------------------------------------------------ AI control */

function setKind(side, kind) {
  if (!KIND_LABELS[kind]) return;
  app.kinds[side] = kind;
  cancelPendingSearch();
  scheduleAi(AI_MOVE_DELAY_MS);
  setNotice(`${playerLabel(side)} 方：${KIND_LABELS[kind]}`);
  syncSidebar();
}

function cycleKind(side) {
  const index = KIND_ORDER.indexOf(controllerKind(side));
  setKind(side, KIND_ORDER[(index + 1) % KIND_ORDER.length]);
}

/** 双方身份切换：swap which controller plays A and which plays B. */
function swapSides() {
  const a = app.kinds[Cell.A];
  app.kinds[Cell.A] = app.kinds[Cell.B];
  app.kinds[Cell.B] = a;
  cancelPendingSearch();
  scheduleAi(AI_MOVE_DELAY_MS);
  setNotice(
    `已交换双方身份：A 方 ${KIND_LABELS[app.kinds[Cell.A]]} · B 方 ${KIND_LABELS[app.kinds[Cell.B]]}`,
  );
  syncSidebar();
}

function applyPreset(kinds, label) {
  app.kinds = { [Cell.A]: kinds[0], [Cell.B]: kinds[1] };
  cancelPendingSearch();
  scheduleAi(420);
  setNotice(label);
  syncSidebar();
}

function scheduleAi(delay = AI_MOVE_DELAY_MS) {
  app.nextAiAt = Date.now() + delay;
}

function createWorker() {
  if (app.workerBroken) return;
  try {
    const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', onWorkerMessage);
    worker.addEventListener('error', () => {
      app.workerBroken = true;
      if (app.worker) app.worker.terminate();
      app.worker = null;
      const pending = app.pending;
      if (pending) runInlineSearch(pending);
    });
    app.worker = worker;
  } catch (error) {
    app.workerBroken = true;
    app.worker = null;
  }
}

function restartWorker() {
  if (app.worker) app.worker.terminate();
  app.worker = null;
  createWorker();
}

/** Drop an in-flight search, e.g. after an undo or a board change. */
function cancelPendingSearch() {
  if (app.pending && app.worker && !app.workerBroken) restartWorker();
  app.pending = null;
  updateThinkingBadge();
}

function startThink() {
  const state = app.state;
  const side = state.sideToMove;
  const settings = { ...app.settings };
  const id = (app.requestSeq += 1);
  const pending = { id, key: state.positionKey(), side, settings, startedAt: Date.now() };
  app.pending = pending;
  if (app.worker && !app.workerBroken) {
    app.worker.postMessage({ id, board: state.toMatrix(), sideToMove: side, settings });
  } else {
    // No worker available: search on the main thread with a tighter budget.
    pending.inline = true;
    pending.settings = { ...settings, timeLimitMs: Math.min(settings.timeLimitMs, 900), maxDepth: Math.min(settings.maxDepth, 4) };
    setTimeout(() => runInlineSearch(pending), 30);
  }
  updateThinkingBadge();
}

function runInlineSearch(pending) {
  if (app.pending !== pending) return;
  let move = null;
  let stats = null;
  let error = null;
  try {
    const ai = new AlphaBetaAI(pending.settings);
    move = ai.chooseMove(app.state);
    stats = {
      depth: ai.lastCompletedDepth,
      score: ai.lastScore,
      nodes: ai.lastNodes,
      elapsedMs: ai.lastElapsedMs,
    };
  } catch (caught) {
    error = String((caught && caught.message) || caught);
  }
  finishSearch(pending.id, move, stats, error);
}

function onWorkerMessage(event) {
  const data = event.data || {};
  const pending = app.pending;
  if (!pending || data.id !== pending.id) return;
  finishSearch(pending.id, data.move, data.stats, data.error);
}

function finishSearch(id, move, stats, error) {
  const pending = app.pending;
  if (!pending || pending.id !== id) return;
  app.pending = null;
  if (error) {
    setNotice(`AI 思考失败：${error}`);
    scheduleAi(800);
    refresh();
    return;
  }
  const state = app.state;
  if (!Array.isArray(move) || state.positionKey() !== pending.key || !state.isLegalMove(move[0], move[1])) {
    // The position changed while the AI was thinking; drop the result.
    refresh();
    return;
  }
  app.searchStats = stats || null;
  playMove(move[0], move[1], KIND_LABELS[KIND.THINK]);
  if (stats) {
    setNotice(`${app.notice} · 深度 ${stats.depth}/${app.settings.maxDepth} · ${stats.nodes} 节点 · ${stats.elapsedMs} ms`);
  }
  refresh();
}

/** The AI heartbeat: runs a move whenever an AI side owns the turn. */
function tick() {
  const state = app.state;
  if (!state || app.panel) {
    updateThinkingBadge();
    return;
  }
  // Watchdog: never leave the game waiting on a worker that went silent.
  if (app.pending && Date.now() - app.pending.startedAt > app.settings.timeLimitMs + 4000) {
    const stuck = app.pending;
    app.pending = null;
    if (app.worker && !app.workerBroken) restartWorker();
    runInlineSearch(stuck);
    return;
  }
  if (state.isGameOver || app.pending) {
    updateThinkingBadge();
    return;
  }
  const side = state.sideToMove;
  const kind = controllerKind(side);
  if (kind === KIND.HUMAN || Date.now() < app.nextAiAt) {
    updateThinkingBadge();
    return;
  }
  if (kind === KIND.RANDOM) {
    const move = randomAI.chooseMove(state);
    playMove(move[0], move[1], KIND_LABELS[KIND.RANDOM]);
    return;
  }
  startThink();
}

function updateThinkingBadge() {
  const state = app.state;
  if (!state || state.isGameOver || app.panel) {
    els.thinking.classList.add('hidden');
    return;
  }
  const side = state.sideToMove;
  if (!sideIsAi(side)) {
    els.thinking.classList.add('hidden');
    return;
  }
  els.thinking.classList.remove('hidden');
  els.thinking.textContent = app.pending
    ? `${playerLabel(side)} 方 ${KIND_LABELS[controllerKind(side)]} 正在思考…`
    : `${playerLabel(side)} 方 ${KIND_LABELS[controllerKind(side)]} 准备落子`;
}

/* -------------------------------------------------------------- rendering */

function buildBoardView() {
  app.view = new BoardView(els.board, {
    onDown: (x, y, event) => {
      if (event.button !== 0) return;
      handleBoardClick(x, y);
    },
  });
}

function handleBoardClick(x, y) {
  if (app.panel) return;
  const state = app.state;
  if (state.isGameOver) {
    setNotice('对局已结束：请重开或选择新棋盘');
    return;
  }
  if (sideIsAi(state.sideToMove)) {
    setNotice(`${playerLabel(state.sideToMove)} 方由${KIND_LABELS[controllerKind(state.sideToMove)]}行棋，请稍候`);
    return;
  }
  playMove(x, y, '');
}

function renderBoard() {
  const state = app.state;
  const legal = new Set();
  const interactive = !state.isGameOver && !sideIsAi(state.sideToMove);
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index] === Cell.OPEN && interactive) legal.add(index);
  }
  const created = new Set();
  const shown = app.highlight || state.moveHistory[state.moveHistory.length - 1] || null;
  let lastIndex = null;
  if (shown) {
    lastIndex = boardIndex(shown.x, shown.y, state.width);
    for (const [cx, cy] of shown.created) created.add(boardIndex(cx, cy, state.width));
  }
  const winning = new Set();
  if (state.winner !== null) {
    for (const [wx, wy] of state.winningLine()) winning.add(boardIndex(wx, wy, state.width));
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
  const side = state.sideToMove;
  els.turnChip.className = `turn-chip chip-${playerLabel(side).toLowerCase()}`;
  els.turnChip.textContent = state.isGameOver
    ? '对局结束'
    : `轮到 ${playerLabel(side)} 方（${side === Cell.A ? '蓝' : '红'}）`;
  if (state.winner !== null) {
    els.statusLine.textContent = `${playerLabel(state.winner)} 方达成四连，获胜！`;
  } else if (state.isDraw) {
    els.statusLine.textContent = '和棋：已经没有可落子的格子';
  } else {
    els.statusLine.textContent = `A 方：${KIND_LABELS[controllerKind(Cell.A)]} · B 方：${KIND_LABELS[controllerKind(Cell.B)]}`;
  }
  els.statMoves.textContent = String(state.moveHistory.length);
  els.statOpen.textContent = String(countOpen(state));
  els.statBoard.textContent = `${state.width}×${state.height}`;
  els.boardCaption.textContent = app.boardLabel;
}

function renderHistory() {
  const list = clear(els.history);
  const moves = app.state.moveHistory;
  if (moves.length === 0) {
    list.append(h('li', { class: 'history-empty', text: '尚无着法' }));
    return;
  }
  moves.forEach((move, index) => {
    const active = app.highlight === move;
    const button = h(
      'button',
      {
        type: 'button',
        class: `history-item${active ? ' is-active' : ''}`,
        onclick: () => {
          app.highlight = active ? null : move;
          renderBoard();
          renderHistory();
        },
      },
      h('span', { class: `move-dot dot-${playerLabel(move.player).toLowerCase()}` }),
      h('span', { class: 'move-notation', text: `${index + 1}. ${move.notation}` }),
      h('span', { class: 'move-created', text: move.created.length ? `+${move.created.length} 路` : '' }),
    );
    list.append(h('li', {}, button));
  });
  els.history.scrollTop = els.history.scrollHeight;
}

function syncSidebar() {
  els.sideA.value = controllerKind(Cell.A);
  els.sideB.value = controllerKind(Cell.B);
  els.undoBtn.disabled = app.state.moveHistory.length === 0;
  els.recordBtn.disabled = app.state.moveHistory.length === 0;
}

function refresh() {
  renderBoard();
  renderStatus();
  renderHistory();
  syncSidebar();
  updateThinkingBadge();
}

/* ----------------------------------------------------------------- modals */

function openPanel(name) {
  app.panel = name;
  cancelPendingSearch();
  els.modalRoot.classList.remove('hidden');
  document.body.classList.add('modal-open');
  renderModal();
}

function closePanel() {
  app.panel = null;
  app.painting = false;
  app.editorView = null;
  clear(els.modal);
  els.modalRoot.classList.add('hidden');
  document.body.classList.remove('modal-open');
  scheduleAi(AI_MOVE_DELAY_MS);
  refresh();
}

function renderModal() {
  clear(els.modal);
  if (app.panel === 'setup') renderSetupPanel();
  else if (app.panel === 'editor') renderEditorPanel();
  else if (app.panel === 'ai') renderAiPanel();
  else if (app.panel === 'help') renderHelpPanel();
}

function modalHeader(title, subtitle) {
  return h(
    'header',
    { class: 'modal-header' },
    h('div', {}, h('h2', { text: title }), subtitle ? h('p', { class: 'modal-subtitle', text: subtitle }) : null),
    h('button', { type: 'button', class: 'icon-button', title: '关闭', onclick: closePanel }, '✕'),
  );
}

/* --- new board / initial board manager ---------------------------------- */

function renderSetupPanel() {
  const listHost = h('div', { class: 'board-list' });
  const detail = h('div', { class: 'setup-detail' });

  const renderList = () => {
    clear(listHost);
    for (const board of app.boards) {
      const isSelected = board.id === app.selectedBoardId;
      const preview = h('canvas', { class: 'board-preview' });
      drawMiniBoard(preview, board);
      const item = h(
        'button',
        {
          type: 'button',
          class: `board-card${isSelected ? ' is-selected' : ''}`,
          onclick: () => {
            app.selectedBoardId = board.id;
            renderList();
            renderDetail();
          },
          ondblclick: () => startGame(board),
        },
        preview,
        h(
          'span',
          { class: 'board-card-body' },
          h('span', { class: 'board-card-name', text: board.name }),
          h('span', {
            class: 'board-card-meta',
            text: `${board.width}×${board.height} · 可走 ${openCount(board)} · A ${stoneCount(board, Cell.A)} / B ${stoneCount(
              board,
              Cell.B,
            )}`,
          }),
        ),
      );
      listHost.append(item);
    }
  };

  const renderDetail = () => {
    clear(detail);
    const board = findBoard(app.selectedBoardId);
    if (!board) {
      detail.append(h('p', { class: 'hint', text: '请选择左侧的棋盘。' }));
      return;
    }
    const saved = isUserBoard(board);
    const preview = h('canvas', { class: 'board-detail-preview' });
    drawMiniBoard(preview, board);
    detail.append(
      h('h3', { text: board.name }),
      h('div', { class: 'detail-preview' }, preview),
      h('dl', { class: 'detail-stats' },
        h('div', {}, h('dt', { text: '尺寸' }), h('dd', { text: `${board.width}×${board.height}` })),
        h('div', {}, h('dt', { text: '可走格' }), h('dd', { text: String(openCount(board)) })),
        h('div', {}, h('dt', { text: 'A/B 棋子' }), h('dd', { text: `${stoneCount(board, Cell.A)} / ${stoneCount(board, Cell.B)}` })),
      ),
      h('div', { class: 'row-gap' },
        h('button', { type: 'button', class: 'primary', onclick: () => startGame(board) }, '用此棋盘开始新局'),
        h('button', { type: 'button', onclick: () => openEditorFrom(board) }, '编辑此棋盘'),
        saved
          ? h('button', {
              type: 'button',
              class: 'danger',
              onclick: () => {
                removeSavedBoard(board.id);
                refreshBoards();
                renderList();
                renderDetail();
                setNotice(`已删除棋盘：${board.name}`);
              },
            }, '删除')
          : null,
      ),
      h('p', { class: 'hint', text: '双击左侧列表中的棋盘也可以直接开始。' }),
    );
  };

  const randomHost = h('div', { class: 'random-form' });
  const previewCanvas = h('canvas', { class: 'board-detail-preview' });

  const syncRandom = () => {
    const preview = generateRandomBoard({ ...app.setup });
    app.randomPreview = preview;
    drawMiniBoard(previewCanvas, preview);
    randomSeed.textContent = `${preview.width}×${preview.height} · 可走 ${openCount(preview)} 格`;
  };
  const randomSeed = h('span', { class: 'hint' });

  const numberField = (label, key, { min, max, step }) => {
    const value = h('span', { class: 'field-value', text: String(app.setup[key]) });
    const input = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(app.setup[key]),
      oninput: (event) => {
        app.setup[key] = Number(event.target.value);
        value.textContent = String(event.target.value);
        syncRandom();
      },
    });
    return h('label', { class: 'field' }, h('span', { text: label }), input, value);
  };

  randomHost.append(
    h('h3', { text: '随机生成棋盘' }),
    numberField('宽度', 'width', { min: MIN_DIMENSION, max: MAX_DIMENSION, step: 1 }),
    numberField('高度', 'height', { min: MIN_DIMENSION, max: MAX_DIMENSION, step: 1 }),
    numberField('可走格密度', 'density', { min: 0.05, max: 1, step: 0.01 }),
    h('label', { class: 'field' },
      h('span', { text: '随机种子（可留空）' }),
      h('input', {
        type: 'number',
        class: 'text-input',
        placeholder: '例如 42',
        value: app.setup.seed === '' ? '' : String(app.setup.seed),
        oninput: (event) => {
          app.setup.seed = event.target.value === '' ? '' : Number(event.target.value);
          syncRandom();
        },
      }),
    ),
    h('div', { class: 'detail-preview' }, previewCanvas, randomSeed),
    h('div', { class: 'row-gap' },
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => startGame(generateRandomBoard({ ...app.setup })),
      }, '生成并开始新局'),
      h('button', {
        type: 'button',
        onclick: () => {
          const definition = generateRandomBoard({ ...app.setup });
          app.editor = new EditorModel(definitionMatrix(definition), app.editorTool);
          app.editingBoardName = definition.name;
          openPanel('editor');
        },
      }, '生成并编辑'),
    ),
    h('p', { class: 'hint', text: '生成器保证四条边各至少有两个可落子格；相同种子可复现同一棋盘。' }),
  );

  const importInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'hidden',
    onchange: async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const definitions = importCatalog(await file.text());
        for (const definition of definitions) addSavedBoard(definition);
        refreshBoards();
        app.selectedBoardId = definitions[definitions.length - 1].id;
        renderList();
        renderDetail();
        setNotice(`已导入 ${definitions.length} 个棋盘`);
      } catch (error) {
        setNotice(`导入失败：${error.message}`);
      }
      event.target.value = '';
    },
  });

  renderList();
  renderDetail();
  syncRandom();

  els.modal.append(
    modalHeader('新棋盘 / 初始棋盘管理', '选择初始棋盘、随机生成，或编辑自己的棋盘'),
    h('div', { class: 'modal-body setup-body' },
      h('section', { class: 'setup-column' },
        h('h3', { text: `棋盘库（${app.boards.length}）` }),
        listHost,
        h('div', { class: 'row-gap' },
          h('button', { type: 'button', onclick: () => importInput.click() }, '导入 JSON'),
          h('button', {
            type: 'button',
            onclick: () => {
              const saved = app.boards.filter(isUserBoard);
              if (saved.length === 0) {
                setNotice('还没有保存过自己的棋盘');
                return;
              }
              downloadText(`way-chess-boards-${timestamp()}.json`, catalogToJson(saved));
              setNotice('我的棋盘已导出为 JSON 文件');
            },
          }, '导出我的棋盘'),
          importInput,
        ),
      ),
      h('section', { class: 'setup-column' }, detail, h('hr', { class: 'divider' }), randomHost),
    ),
    h('footer', { class: 'modal-footer' },
      h('p', { class: 'hint', text: '提示：游戏中按 P 可以把当前局面存成新的初始棋盘。' }),
      h('button', { type: 'button', onclick: closePanel }, '关闭'),
    ),
  );
}

function isUserBoard(board) {
  return !board.preset;
}

/* --- board editor -------------------------------------------------------- */

function openEditorFrom(definition) {
  app.editor = new EditorModel(definitionMatrix(definition), app.editorTool);
  app.editingBoardName = definition.name;
  openPanel('editor');
}

function openEditorFromCurrentGame() {
  openEditorFrom({
    id: 'current',
    name: app.boardSource ? app.boardSource.name : '当前局面',
    width: app.state.width,
    height: app.state.height,
    content: app.state.toMatrix(),
  });
}

function renderEditorPanel() {
  const editor = app.editor;
  const gridHost = h('div', { class: 'board' });
  const frame = h('div', { class: 'board-frame editor-frame' }, gridHost);
  const countsLine = h('p', { class: 'counts-line' });

  app.editorView = new BoardView(gridHost, {
    onDown: (x, y, event) => {
      app.painting = true;
      paintEditor(x, y, event.button === 2);
    },
    onOver: (x, y, event) => {
      if (app.painting) paintEditor(x, y, event.buttons === 2);
    },
    onLeave: () => {
      app.painting = false;
    },
  });

  const toolButtons = new Map();
  const toolRow = h('div', { class: 'tool-row' });
  for (const tool of [Cell.CLOSED, Cell.OPEN, Cell.A, Cell.B]) {
    const button = h('button', {
      type: 'button',
      class: 'tool-button',
      onclick: () => setEditorTool(tool),
    }, TOOL_LABELS[tool]);
    toolButtons.set(tool, button);
    toolRow.append(button);
  }

  const dimensionField = (label, key) => {
    const input = h('input', {
      type: 'number',
      class: 'text-input small',
      min: String(MIN_DIMENSION),
      max: String(MAX_DIMENSION),
      value: String(editor[key]),
      onchange: (event) => {
        editor.setSize(
          key === 'width' ? clampDimension(event.target.value) : editor.width,
          key === 'height' ? clampDimension(event.target.value) : editor.height,
        );
        event.target.value = String(editor[key]);
        renderEditorBoard();
        renderEditorCounts();
      },
    });
    return h('label', { class: 'inline-field' }, h('span', { text: label }), input);
  };

  const nameInput = h('input', {
    type: 'text',
    class: 'text-input',
    placeholder: '棋盘名称',
    value: app.editingBoardName,
    oninput: (event) => {
      app.editingBoardName = event.target.value;
    },
  });

  const widthField = dimensionField('宽', 'width');
  const heightField = dimensionField('高', 'height');

  const renderEditorBoard = () => {
    const model = {
      width: editor.width,
      height: editor.height,
      cells: editor.cells,
      toolClass: `tool-${editor.tool}`,
    };
    app.editorView.render(model);
    for (const [tool, button] of toolButtons) button.classList.toggle('is-active', tool === editor.tool);
    widthField.querySelector('input').value = String(editor.width);
    heightField.querySelector('input').value = String(editor.height);
  };
  const renderEditorCounts = () => {
    const totals = editor.counts();
    countsLine.textContent = `封闭 ${totals.closed} · 可走 ${totals.open} · A 棋子 ${totals.a} · B 棋子 ${totals.b}`;
  };

  const paintEditor = (x, y, erase) => {
    const changed = editor.paint(x, y, erase ? Cell.CLOSED : editor.tool);
    if (!changed) return;
    renderEditorBoard();
    renderEditorCounts();
  };
  app.paintEditor = paintEditor;
  app.renderEditorBoard = renderEditorBoard;

  const applySize = (dw, dh) => {
    editor.setSize(editor.width + dw, editor.height + dh);
    renderEditorBoard();
    renderEditorCounts();
  };

  renderEditorBoard();
  renderEditorCounts();

  els.modal.append(
    modalHeader('棋盘编辑器', '左键涂抹当前工具，右键擦除；1-4 可切换工具'),
    h('div', { class: 'modal-body editor-body' },
      h('div', { class: 'editor-main' },
        frame,
        countsLine,
      ),
      h('aside', { class: 'editor-side' },
        h('h3', { text: '工具' }),
        toolRow,
        h('h3', { text: `尺寸（${MIN_DIMENSION} - ${MAX_DIMENSION}）` }),
        h('div', { class: 'row-gap' },
          widthField,
          heightField,
          h('button', { type: 'button', onclick: () => applySize(-1, 0) }, '宽 −'),
          h('button', { type: 'button', onclick: () => applySize(1, 0) }, '宽 +'),
          h('button', { type: 'button', onclick: () => applySize(0, -1) }, '高 −'),
          h('button', { type: 'button', onclick: () => applySize(0, 1) }, '高 +'),
        ),
        h('h3', { text: '批量操作' }),
        h('div', { class: 'row-gap' },
          h('button', {
            type: 'button',
            onclick: () => {
              editor.fill(Cell.CLOSED);
              renderEditorBoard();
              renderEditorCounts();
            },
          }, '全部封闭'),
          h('button', {
            type: 'button',
            onclick: () => {
              editor.fill(Cell.OPEN);
              renderEditorBoard();
              renderEditorCounts();
            },
          }, '全部可走'),
          h('button', {
            type: 'button',
            onclick: () => {
              editor.clearStones();
              renderEditorBoard();
              renderEditorCounts();
            },
          }, '清除棋子'),
        ),
        h('h3', { text: '保存' }),
        h('label', { class: 'field' }, h('span', { text: '名称' }), nameInput),
        h('div', { class: 'row-gap' },
          h('button', {
            type: 'button',
            class: 'primary',
            onclick: () => {
              const definition = editor.toDefinition(app.editingBoardName);
              addSavedBoard(definition);
              refreshBoards();
              app.selectedBoardId = definition.id;
              startGame(definition, { notice: `已保存并开始：${definition.name}` });
            },
          }, '保存并开始新局'),
          h('button', {
            type: 'button',
            onclick: () => {
              const definition = editor.toDefinition(app.editingBoardName);
              addSavedBoard(definition);
              refreshBoards();
              app.selectedBoardId = definition.id;
              setNotice(`棋盘已保存到“我的棋盘”：${definition.name}`);
            },
          }, '保存到我的棋盘'),
        ),
        h('p', { class: 'hint', text: '棋子占据的格子不能再落子；编辑器允许放置 A/B 起始棋子。' }),
      ),
    ),
    h('footer', { class: 'modal-footer' },
      h('p', { class: 'hint', text: 'Enter：保存并开始（在棋盘上按 Enter）· Esc：取消' }),
      h('button', { type: 'button', onclick: closePanel }, '取消'),
    ),
  );
}

function setEditorTool(tool) {
  if (!app.editor) return;
  app.editor.setTool(tool);
  app.editorTool = tool;
  if (app.renderEditorBoard) app.renderEditorBoard();
}

/* --- AI settings --------------------------------------------------------- */

function renderAiPanel() {
  const body = h('div', { class: 'modal-body ai-body' });
  const statsLine = h('p', { class: 'hint', text: '尚无搜索记录。' });

  const slider = (label, key, describe) => {
    const readout = h('span', { class: 'field-value', text: describe(app.settings[key]) });
    const input = h('input', {
      type: 'range',
      min: String(SEARCH_LIMITS[key].min),
      max: String(SEARCH_LIMITS[key].max),
      step: String(SEARCH_LIMITS[key].step),
      value: String(app.settings[key]),
      oninput: (event) => {
        app.settings = clampSettings({ ...app.settings, [key]: Number(event.target.value) });
        readout.textContent = describe(app.settings[key]);
        persistSettings();
        cancelPendingSearch();
        scheduleAi(AI_MOVE_DELAY_MS);
        refresh();
      },
    });
    return h('label', { class: 'field' }, h('span', { text: label }), input, readout);
  };

  const stats = app.searchStats;
  if (stats) {
    statsLine.textContent = `上次搜索：完成深度 ${stats.depth} · 节点 ${stats.nodes} · 评分 ${stats.score} · 用时 ${stats.elapsedMs} ms`;
  }

  body.append(
    h('p', { class: 'hint', text: '参数立即应用到之后（或正在重新开始的）思考型 AI 搜索。' }),
    slider('搜索深度', 'maxDepth', (value) => `${value} 层`),
    slider('思考时间上限', 'timeLimitMs', (value) => `${(value / 1000).toFixed(1)} 秒`),
    slider('候选着法上限', 'candidateLimit', (value) => String(value)),
    h('div', { class: 'row-gap' },
      h('button', {
        type: 'button',
        onclick: () => {
          app.settings = { ...DEFAULT_SEARCH_SETTINGS };
          persistSettings();
          renderModal();
        },
      }, '恢复默认'),
      h('button', { type: 'button', onclick: closePanel }, '关闭'),
    ),
    statsLine,
  );

  els.modal.append(modalHeader('思考型 AI 参数', 'Alpha-Beta 搜索的深度、时间与候选上限'), body);
}

/* --- rules --------------------------------------------------------------- */

function renderHelpPanel() {
  els.modal.append(
    modalHeader('游戏规则', '与桌面版 game_engine.py 完全一致的判定逻辑'),
    h('div', { class: 'modal-body help-body' },
      h('ul', { class: 'rule-list' },
        h('li', { text: '棋盘由三种格子组成：深色“封闭”格不能落子，浅色“可走”格可以落子，圆形棋子占据的格子不能再落子。' }),
        h('li', { text: 'A 方（蓝）先手，双方轮流在任意“可走”格落子。' }),
        h('li', { text: '每次落子后自动“造路”：以新棋子为起点，向上、下、左、右四个方向扫描；若在遇到对手棋子之前先遇到己方棋子，两者之间的所有封闭格都变成“可走”格。' }),
        h('li', { text: '对手棋子会阻断该方向；斜向不会造路；每个方向只使用遇到的第一枚己方棋子。' }),
        h('li', { text: '任意一方在水平、垂直或两条对角线上连成四子（含五连及以上）即获胜。' }),
        h('li', { text: '当棋盘上不再有“可走”格且无人四连时为和棋。造路机制意味着双方既要防守对手的四连，也要为自己打开新的落点。' }),
      ),
      h('h3', { text: '操作' }),
      h('ul', { class: 'rule-list' },
        h('li', { text: '左键点击浅色格落子；侧栏可切换 A/B 方由“玩家 / 随机 AI / 思考型 AI”控制。' }),
        h('li', { text: '“交换双方”按钮可互换 A、B 两方的身份；也可以一键套用“双人对战 / 我执 A / 我执 B / AI 自对弈”预设。' }),
        h('li', { text: '快捷键：U 撤销 · R 重开 · N 新棋盘 · E 编辑 · T AI 参数 · S 棋谱 · P 保存当前棋盘 · H 规则 · 1/2 切换 A/B 方控制。' }),
        h('li', { text: '棋盘编辑器：1-4 切换工具（封闭 / 可走 / A 棋子 / B 棋子），左键涂抹、右键擦除，可调整尺寸到 4-40。' }),
      ),
      h('footer', { class: 'modal-footer' }, h('button', { type: 'button', onclick: closePanel }, '知道了')),
    ),
  );
}

/* ------------------------------------------------------------- keyboard */

function onKeyDown(event) {
  const tag = event.target && event.target.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (event.key === 'Escape') {
    if (app.panel) closePanel();
    return;
  }
  if (tag === 'INPUT' && event.key === 'Enter' && app.panel === 'editor') {
    event.preventDefault();
    saveEditorAndStart();
    return;
  }
  if (typing) return;
  if (app.panel === 'editor') {
    const index = Number(event.key);
    if (index >= 1 && index <= 4) setEditorTool(index - 1);
    return;
  }
  if (app.panel === 'ai') {
    if (event.key === 'r') {
      app.settings = { ...DEFAULT_SEARCH_SETTINGS };
      persistSettings();
      renderModal();
      refresh();
    }
    return;
  }
  if (app.panel) return;
  const key = event.key.toLowerCase();
  if (key === 'u' || event.key === 'Backspace') {
    event.preventDefault();
    undoMove();
  } else if (key === 'r') restartGame();
  else if (key === 'n') openPanel('setup');
  else if (key === 'e') openEditorFromCurrentGame();
  else if (key === 't') openPanel('ai');
  else if (key === 's') saveRecord();
  else if (key === 'p') saveCurrentBoard();
  else if (key === 'h') openPanel('help');
  else if (key === '1') cycleKind(Cell.A);
  else if (key === '2') cycleKind(Cell.B);
}

function saveEditorAndStart() {
  if (!app.editor) return;
  const definition = app.editor.toDefinition(app.editingBoardName);
  addSavedBoard(definition);
  refreshBoards();
  app.selectedBoardId = definition.id;
  startGame(definition, { notice: `已保存并开始：${definition.name}` });
}

/* ------------------------------------------------------------------- boot */

function persistSettings() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
  } catch (error) {
    /* Storage may be unavailable; the in-memory settings still apply. */
  }
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) app.settings = clampSettings({ ...DEFAULT_SEARCH_SETTINGS, ...JSON.parse(raw) });
  } catch (error) {
    app.settings = { ...DEFAULT_SEARCH_SETTINGS };
  }
}

function buildSidebar() {
  const sideRow = (side) => {
    const select = h('select', { class: 'select', 'aria-label': `${playerLabel(side)} 方控制者` });
    for (const kind of KIND_ORDER) select.append(h('option', { value: kind, text: KIND_LABELS[kind] }));
    select.addEventListener('change', () => setKind(side, select.value));
    els[side === Cell.A ? 'sideA' : 'sideB'] = select;
    return h(
      'div',
      { class: 'side-row' },
      h('span', { class: `chip chip-${playerLabel(side).toLowerCase()}`, text: `${playerLabel(side)} 方` }),
      select,
    );
  };

  els.sides.append(sideRow(Cell.A), sideRow(Cell.B));
  els.swapBtn.addEventListener('click', swapSides);

  const presets = [
    { label: '双人对战', kinds: [KIND.HUMAN, KIND.HUMAN] },
    { label: '我执 A（人机）', kinds: [KIND.HUMAN, KIND.THINK] },
    { label: '我执 B（人机）', kinds: [KIND.THINK, KIND.HUMAN] },
    { label: 'AI 自对弈', kinds: [KIND.THINK, KIND.THINK] },
    { label: '随机 AI 演示', kinds: [KIND.RANDOM, KIND.RANDOM] },
  ];
  for (const preset of presets) {
    els.presets.append(
      h('button', {
        type: 'button',
        class: 'preset-button',
        onclick: () => applyPreset(preset.kinds, `已切换为：${preset.label}`),
      }, preset.label),
    );
  }

  const actions = [
    { label: '撤销 (U)', run: undoMove, ref: 'undoBtn' },
    { label: '重开当前棋盘 (R)', run: restartGame },
    { label: '新棋盘 / 自定义 (N)', run: () => openPanel('setup') },
    { label: '编辑棋盘 (E)', run: openEditorFromCurrentGame },
    { label: 'AI 参数 (T)', run: () => openPanel('ai') },
    { label: '保存棋谱 (S)', run: saveRecord, ref: 'recordBtn' },
    { label: '保存当前棋盘 (P)', run: saveCurrentBoard },
    { label: '规则说明 (H)', run: () => openPanel('help') },
  ];
  for (const action of actions) {
    const button = h('button', { type: 'button', class: 'action-button', onclick: action.run }, action.label);
    if (action.ref) els[action.ref] = button;
    els.actions.append(button);
  }
}

function boot() {
  for (const id of [
    'board',
    'board-caption',
    'turn-chip',
    'status-line',
    'stat-moves',
    'stat-open',
    'stat-board',
    'thinking',
    'sides',
    'swap-btn',
    'presets',
    'actions',
    'history',
    'notice',
    'modal-root',
    'modal',
  ]) {
    els[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = qs(`#${id}`);
  }

  loadSettings();
  refreshBoards();
  createWorker();
  buildSidebar();
  buildBoardView();

  const initial = findBoard('0') || app.boards[0];
  startGame(initial, { notice: '左键点击浅色格落子；按 H 查看规则。' });

  qs('#btn-open-setup').addEventListener('click', () => openPanel('setup'));
  qs('#btn-open-help').addEventListener('click', () => openPanel('help'));
  els.modalRoot.addEventListener('pointerdown', (event) => {
    if (event.target === els.modalRoot) closePanel();
  });
  window.addEventListener('pointerup', () => {
    if (app.painting) {
      app.painting = false;
      if (app.panel === 'editor' && app.renderEditorBoard) app.renderEditorBoard();
    }
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', () => {
    if (app.worker) app.worker.terminate();
  });

  window.setInterval(tick, 100);
  notifyReady();
}

/** Tells the inline boot-warning script (see index.html) that the app loaded. */
function notifyReady() {
  window.__wayChessBooted = true;
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
