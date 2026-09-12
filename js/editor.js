/**
 * Mutable initial board used by the board editor.
 *
 * `content[y][x]` mirrors the game board: closed walls, playable squares and
 * optional starting A/B stones. Painting any of them is the same operation,
 * so the editor only has to track the active tool.
 */

import { MAX_DIMENSION, MIN_DIMENSION, createBoardId } from './boards.js';
import { Cell, normalizeMatrix } from './engine.js';

export class EditorModel {
  constructor(rows, tool = Cell.OPEN) {
    const { width, height, cells } = normalizeMatrix(rows);
    this.width = width;
    this.height = height;
    this.cells = cells;
    this.tool = tool;
  }

  inside(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  at(x, y) {
    return this.inside(x, y) ? this.cells[y * this.width + x] : Cell.CLOSED;
  }

  setTool(tool) {
    if (Cell.CLOSED <= tool && tool <= Cell.B) this.tool = tool;
  }

  /** Apply `value` (default: the active tool) to one cell. */
  paint(x, y, value = this.tool) {
    if (!this.inside(x, y)) return false;
    const index = y * this.width + x;
    if (this.cells[index] === value) return false;
    this.cells[index] = value;
    return true;
  }

  /** Resize the board, keeping the top-left region and padding with walls. */
  setSize(width, height) {
    const nextWidth = clampDimension(width);
    const nextHeight = clampDimension(height);
    const next = new Int8Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        next[y * nextWidth + x] = x < this.width && y < this.height ? this.cells[y * this.width + x] : Cell.CLOSED;
      }
    }
    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = next;
  }

  /** Set every cell to one value: used by “清空” and “全部可走”. */
  fill(value) {
    this.cells.fill(value);
  }

  /** Turn every stone into a playable square, keeping walls in place. */
  clearStones() {
    for (let i = 0; i < this.cells.length; i += 1) {
      if (this.cells[i] === Cell.A || this.cells[i] === Cell.B) this.cells[i] = Cell.OPEN;
    }
  }

  counts() {
    const totals = { closed: 0, open: 0, a: 0, b: 0 };
    for (let i = 0; i < this.cells.length; i += 1) {
      const value = this.cells[i];
      if (value === Cell.CLOSED) totals.closed += 1;
      else if (value === Cell.OPEN) totals.open += 1;
      else if (value === Cell.A) totals.a += 1;
      else totals.b += 1;
    }
    return totals;
  }

  toMatrix() {
    const rows = [];
    for (let y = 0; y < this.height; y += 1) {
      rows.push(Array.from(this.cells.slice(y * this.width, (y + 1) * this.width)));
    }
    return rows;
  }

  toDefinition(name) {
    return {
      id: createBoardId('edited'),
      name: name && name.trim() ? name.trim() : `编辑棋盘 ${new Date().toLocaleString('zh-CN')}`,
      width: this.width,
      height: this.height,
      content: this.toMatrix(),
    };
  }
}

export function clampDimension(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return MIN_DIMENSION;
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, number));
}
