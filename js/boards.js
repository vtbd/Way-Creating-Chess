/**
 * Initial-board definitions: the bundled catalog, boards saved in the
 * browser, JSON import/export, and random board generation.
 *
 * The JSON shape matches the desktop project's `saved_boards.json` and
 * `OrBds.json`, so boards can be moved between the two builds.
 */

import { makeRandom } from './ai.js';
import { BOARD_CATALOG } from './boards-data.js';
import { Cell, normalizeMatrix } from './engine.js';

export const STORAGE_KEY = 'wcc.boards.v1';
export const MAX_DIMENSION = 40;
export const MIN_DIMENSION = 4;

/** Cells copied into a plain cache-friendly matrix. */
function rowsFromFlat(cells, width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Array.from(cells.slice(y * width, (y + 1) * width)));
  }
  return rows;
}

/**
 * Validate one board description and return a normalised definition.
 * Accepts `{content}` as well as a bare matrix.
 */
export function normalizeBoardDefinition(data, fallbackName = '未命名棋盘') {
  const content = data && (data.content ?? data.matrix ?? data.cells);
  const { width, height, cells } = normalizeMatrix(content);
  const id = data && data.id !== undefined && data.id !== null ? String(data.id) : createBoardId('board');
  const name = data && typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName;
  return { id, name, width, height, content: rowsFromFlat(cells, width, height) };
}

export function cloneDefinition(definition) {
  return {
    id: definition.id,
    name: definition.name,
    width: definition.width,
    height: definition.height,
    content: definition.content.map((row) => row.slice()),
  };
}

/** A fresh mutable matrix for `new GameState(...)`. */
export function definitionMatrix(definition) {
  return definition.content.map((row) => row.slice());
}

/** Timestamp-based id, mirroring the desktop naming scheme. */
export function createBoardId(prefix = 'saved') {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  return `${prefix}-${stamp}`;
}

/** Bundled boards shipped with the site (default board plus presets). */
export function presetBoards() {
  return (BOARD_CATALOG.boards || []).map((board) => normalizeBoardDefinition(board));
}

let memoryFallback = null;

function readStorage() {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

/** Boards the player saved in this browser (or edited and saved). */
export function loadSavedBoards() {
  const storage = readStorage();
  if (!storage) return memoryFallback ? memoryFallback.map(cloneDefinition) : [];
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.boards;
    if (!Array.isArray(list)) return [];
    return list.map((board, index) => normalizeBoardDefinition(board, `我的棋盘 ${index + 1}`));
  } catch (error) {
    return [];
  }
}

export function storeSavedBoards(definitions) {
  const clean = definitions.map(cloneDefinition);
  memoryFallback = clean;
  const storage = readStorage();
  if (!storage) return clean;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ boards: clean }));
  } catch (error) {
    /* Quota or privacy mode: the in-memory copy still works for this session. */
  }
  return clean;
}

export function addSavedBoard(definition) {
  const list = loadSavedBoards();
  const stored = cloneDefinition(definition);
  const existing = list.findIndex((board) => board.id === stored.id);
  if (existing >= 0) list[existing] = stored;
  else list.push(stored);
  storeSavedBoards(list);
  return stored;
}

export function removeSavedBoard(id) {
  const list = loadSavedBoards().filter((board) => board.id !== id);
  storeSavedBoards(list);
  return list;
}

export function openCount(definition) {
  let count = 0;
  for (const row of definition.content) {
    for (const value of row) if (value === Cell.OPEN) count += 1;
  }
  return count;
}

export function stoneCount(definition, player) {
  let count = 0;
  for (const row of definition.content) {
    for (const value of row) if (value === player) count += 1;
  }
  return count;
}

/** Uniform sample without replacement, seeded for reproducible boards. */
function sample(items, count, random) {
  const pool = items.slice();
  const picked = [];
  const wanted = Math.min(count, pool.length);
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.floor(random() * pool.length) % pool.length;
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/** The minimum cells needed to make every outer edge usable. */
function requiredEdgeSquares(width, height, random) {
  const edges = [
    Array.from({ length: width }, (_, x) => [x, 0]),
    Array.from({ length: width }, (_, x) => [x, height - 1]),
    Array.from({ length: height }, (_, y) => [0, y]),
    Array.from({ length: height }, (_, y) => [width - 1, y]),
  ];
  const key = ([x, y]) => `${x},${y}`;
  const required = new Map();
  for (const edge of edges) {
    const target = Math.min(2, edge.length);
    const available = edge.filter((square) => !required.has(key(square)));
    for (const square of sample(available, target, random)) required.set(key(square), square);
    const current = edge.filter((square) => required.has(key(square))).length;
    if (current < target) {
      const rest = edge.filter((square) => !required.has(key(square)));
      for (const square of sample(rest, target - current, random)) required.set(key(square), square);
    }
  }
  return required;
}

/**
 * Create a random initial board with the requested dimensions and density.
 * At least two cells are guaranteed on each outer row and column, so no edge
 * is made permanently unreachable by an entirely closed boundary.
 */
export function generateRandomBoard({ width, height, density = 0.3, seed = null, name = null }) {
  const w = Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(Number(width))));
  const h = Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(Number(height))));
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('width and height must be numbers');
  const ratio = Number(density);
  if (!(ratio > 0 && ratio <= 1)) throw new Error('density must be in (0, 1]');

  const random = makeRandom(seed === '' || seed === null || seed === undefined ? null : seed);
  const squares = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) squares.push([x, y]);
  }
  const required = requiredEdgeSquares(w, h, random);
  const requiredKeys = new Set(required.keys());
  const total = Math.max(1, required.size, Math.min(squares.length, Math.round(squares.length * ratio)));
  const remaining = squares.filter(([x, y]) => !requiredKeys.has(`${x},${y}`));
  const open = new Set(requiredKeys);
  for (const [x, y] of sample(remaining, total - required.size, random)) open.add(`${x},${y}`);

  const content = [];
  for (let y = 0; y < h; y += 1) {
    const row = [];
    for (let x = 0; x < w; x += 1) row.push(open.has(`${x},${y}`) ? Cell.OPEN : Cell.CLOSED);
    content.push(row);
  }
  const suffix = seed === null || seed === undefined || seed === '' ? 'new' : String(seed);
  return {
    id: `random-${w}x${h}-${suffix}-${Date.now().toString(36)}`,
    name: name || `随机棋盘 ${w}×${h}`,
    width: w,
    height: h,
    content,
  };
}

/**
 * Parse a boards file. Accepts `{boards: [...]}`, a single board object, or a
 * bare matrix, so hand-written files and desktop exports both load.
 */
export function importCatalog(text) {
  const parsed = JSON.parse(text);
  const isBareMatrix = Array.isArray(parsed) && Array.isArray(parsed[0]) && typeof parsed[0][0] === 'number';
  const list = isBareMatrix
    ? [{ content: parsed, name: '导入棋盘' }]
    : Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.boards)
        ? parsed.boards
        : [parsed];
  const definitions = [];
  list.forEach((entry, index) => {
    const data = Array.isArray(entry) ? { content: entry, name: `导入棋盘 ${index + 1}` } : entry;
    definitions.push(normalizeBoardDefinition(data, `导入棋盘 ${index + 1}`));
  });
  if (definitions.length === 0) throw new Error('文件中没有棋盘');
  return definitions;
}

/** Serialise boards in the desktop project's catalog format. */
export function catalogToJson(definitions) {
  return JSON.stringify(
    {
      boards: definitions.map((board) => ({
        id: board.id,
        name: board.name,
        width: board.width,
        height: board.height,
        content: board.content,
      })),
    },
    null,
    2,
  );
}
