/**
 * Core rules for Way Creating Chess.
 *
 * This is a dependency-free port of the desktop project's `game_engine.py`,
 * so the browser build and the Python build agree on every rule: playable
 * squares, road creation, four-in-a-row wins, draws and undo.
 *
 * Board storage is a flat `Int8Array` of `width * height` cells indexed with
 * `y * width + x`, which keeps cloning cheap for the AI search.
 */

/** Values stored in a board cell (identical to the JSON format). */
export const Cell = Object.freeze({
  CLOSED: 0,
  OPEN: 1,
  A: 2,
  B: 3,
});

export const PLAYERS = Object.freeze([Cell.A, Cell.B]);

/** The four orthogonal directions used when a move creates roads. */
export const ORTHOGONAL_DIRECTIONS = Object.freeze([
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
]);

/** The four axes scanned for four-in-a-row wins. */
export const WIN_DIRECTIONS = Object.freeze([
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]);

export const WIN_LENGTH = 4;

export function otherPlayer(player) {
  return player === Cell.A ? Cell.B : Cell.A;
}

export function playerLabel(player) {
  return player === Cell.A ? 'A' : 'B';
}

export function isPlayer(value) {
  return value === Cell.A || value === Cell.B;
}

/**
 * Validate a row-major matrix and flatten it into `{width, height, cells}`.
 * Accepts nested arrays of numbers (JSON) and of `Int8Array` rows.
 */
export function normalizeMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0] || rows[0].length === 0) {
    throw new Error('board must be a non-empty rectangular matrix');
  }
  const height = rows.length;
  const width = rows[0].length;
  const cells = new Int8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (!row || row.length !== width) {
      throw new Error('board must be a non-empty rectangular matrix');
    }
    for (let x = 0; x < width; x += 1) {
      const value = Number(row[x]);
      if (value !== Cell.CLOSED && value !== Cell.OPEN && value !== Cell.A && value !== Cell.B) {
        throw new Error(`unsupported cell value: ${row[x]}`);
      }
      cells[y * width + x] = value;
    }
  }
  return { width, height, cells };
}

/**
 * A complete, mutable Way Creating Chess position.
 *
 * A move may only be made on an `OPEN` cell. After a move, the closed cells
 * between the new stone and the nearest friendly stone in each orthogonal
 * direction become open; enemy stones block that effect.
 */
export class GameState {
  /**
   * @param {ArrayLike<ArrayLike<number>>} rows row-major board contents
   * @param {number} sideToMove `Cell.A` or `Cell.B`
   */
  constructor(rows, sideToMove = Cell.A) {
    const { width, height, cells } = normalizeMatrix(rows);
    if (sideToMove !== Cell.A && sideToMove !== Cell.B) {
      throw new Error('sideToMove must be Cell.A or Cell.B');
    }
    this.width = width;
    this.height = height;
    this.cells = cells;
    this.sideToMove = sideToMove;
    this.moveHistory = [];
    this.winner = this.findWinner();
    this._initialCells = cells.slice();
    this._initialSide = sideToMove;
    this._undoStack = [];
  }

  /** Build a state from a flat `Int8Array` (used when restoring a search). */
  static fromFlatCells(cells, width, height, sideToMove = Cell.A) {
    const rows = [];
    for (let y = 0; y < height; y += 1) {
      rows.push(Array.from(cells.slice(y * width, (y + 1) * width)));
    }
    return new GameState(rows, sideToMove);
  }

  clone() {
    const copy = Object.create(GameState.prototype);
    copy.width = this.width;
    copy.height = this.height;
    copy.cells = this.cells.slice();
    copy.sideToMove = this.sideToMove;
    copy.moveHistory = this.moveHistory.slice();
    copy.winner = this.winner;
    copy._initialCells = this._initialCells.slice();
    copy._initialSide = this._initialSide;
    copy._undoStack = this._undoStack.map((record) => ({
      move: record.move,
      changes: record.changes.slice(),
      side: record.side,
      winner: record.winner,
    }));
    return copy;
  }

  inside(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  cellAt(x, y) {
    if (!this.inside(x, y)) {
      throw new Error(`coordinate outside board: (${x}, ${y})`);
    }
    return this.cells[y * this.width + x];
  }

  /** Row-major copy of the board, suitable for JSON and workers. */
  toMatrix() {
    const rows = [];
    for (let y = 0; y < this.height; y += 1) {
      rows.push(Array.from(this.cells.slice(y * this.width, (y + 1) * this.width)));
    }
    return rows;
  }

  /** All legal moves for the current side, in row-major order. */
  legalMoves() {
    if (this.isGameOver) return [];
    const moves = [];
    for (let y = 0; y < this.height; y += 1) {
      const offset = y * this.width;
      for (let x = 0; x < this.width; x += 1) {
        if (this.cells[offset + x] === Cell.OPEN) moves.push([x, y]);
      }
    }
    return moves;
  }

  isLegalMove(x, y) {
    return !this.isGameOver && this.inside(x, y) && this.cells[y * this.width + x] === Cell.OPEN;
  }

  /**
   * Play `(x, y)` for the side to move and return its record entry.
   * @returns {{x: number, y: number, player: number, created: number[][], notation: string}}
   */
  makeMove(x, y) {
    if (!this.isLegalMove(x, y)) {
      throw new Error(`illegal move: (${x}, ${y})`);
    }
    const player = this.sideToMove;
    const previousSide = player;
    const previousWinner = this.winner;
    const changes = [];
    const changed = new Set();
    const setCell = (cx, cy, value) => {
      const index = cy * this.width + cx;
      if (!changed.has(index)) {
        changed.add(index);
        changes.push([index, this.cells[index]]);
      }
      this.cells[index] = value;
    };

    setCell(x, y, player);
    const created = [];
    const opponent = otherPlayer(player);
    for (const [dx, dy] of ORTHOGONAL_DIRECTIONS) {
      let cx = x + dx;
      let cy = y + dy;
      while (this.inside(cx, cy)) {
        const value = this.cells[cy * this.width + cx];
        if (value === opponent) break;
        if (value === player) {
          let px = x + dx;
          let py = y + dy;
          while (px !== cx || py !== cy) {
            if (this.cells[py * this.width + px] === Cell.CLOSED) {
              setCell(px, py, Cell.OPEN);
              created.push([px, py]);
            }
            px += dx;
            py += dy;
          }
          break;
        }
        cx += dx;
        cy += dy;
      }
    }

    const played = {
      x,
      y,
      player,
      created,
      notation: `${playerLabel(player)}:${String.fromCharCode(97 + x)}${y + 1}`,
    };
    this.winner = this.findWinner();
    this.sideToMove = opponent;
    this.moveHistory.push(played);
    this._undoStack.push({ move: played, changes, side: previousSide, winner: previousWinner });
    return played;
  }

  /** Undo the most recent move; returns it, or `null` when history is empty. */
  undoMove() {
    const record = this._undoStack.pop();
    if (!record) return null;
    for (let i = record.changes.length - 1; i >= 0; i -= 1) {
      const [index, value] = record.changes[i];
      this.cells[index] = value;
    }
    this.sideToMove = record.side;
    this.winner = record.winner;
    this.moveHistory.pop();
    return record.move;
  }

  /** Restore the position this game was created from. */
  reset() {
    this.cells = this._initialCells.slice();
    this.sideToMove = this._initialSide;
    this.winner = this.findWinner();
    this.moveHistory = [];
    this._undoStack = [];
  }

  /** Whether `player` has four or more contiguous stones on any axis. */
  winnerFor(player) {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.cells[y * this.width + x] !== player) continue;
        for (const [dx, dy] of WIN_DIRECTIONS) {
          let matched = true;
          for (let step = 1; step < WIN_LENGTH; step += 1) {
            const nx = x + step * dx;
            const ny = y + step * dy;
            if (!this.inside(nx, ny) || this.cells[ny * this.width + nx] !== player) {
              matched = false;
              break;
            }
          }
          if (matched) return true;
        }
      }
    }
    return false;
  }

  findWinner() {
    for (const player of PLAYERS) {
      if (this.winnerFor(player)) return player;
    }
    return null;
  }

  /**
   * Every cell of the winning run, so the UI can highlight it.
   * @param {number|null} player defaults to the recorded winner
   */
  winningLine(player = this.winner) {
    if (!isPlayer(player)) return [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        for (const [dx, dy] of WIN_DIRECTIONS) {
          let cx = x;
          let cy = y;
          const run = [];
          while (this.inside(cx, cy) && this.cells[cy * this.width + cx] === player) {
            run.push([cx, cy]);
            cx += dx;
            cy += dy;
          }
          if (run.length >= WIN_LENGTH) return run;
        }
      }
    }
    return [];
  }

  /** A draw is a non-winning position in which no open cell remains. */
  get isDraw() {
    if (this.winner !== null) return false;
    for (let i = 0; i < this.cells.length; i += 1) {
      if (this.cells[i] === Cell.OPEN) return false;
    }
    return true;
  }

  get isGameOver() {
    return this.winner !== null || this.isDraw;
  }

  /** Kept identical to the Python engine's wording for record export. */
  get result() {
    if (this.winner === Cell.A) return 'A wins';
    if (this.winner === Cell.B) return 'B wins';
    if (this.isDraw) return 'Draw';
    return 'In progress';
  }

  /** A compact key for comparing positions (history is intentionally absent). */
  positionKey() {
    let key = '';
    for (let i = 0; i < this.cells.length; i += 1) key += this.cells[i];
    return `${this.width}x${this.height}:${this.sideToMove}:${key}`;
  }

  /** A JSON-serialisable game record, matching the Python export. */
  exportRecord() {
    return {
      size: { width: this.width, height: this.height },
      moves: this.moveHistory.map((move, index) => ({
        number: index + 1,
        player: playerLabel(move.player),
        move: [move.x, move.y],
        notation: move.notation,
        created: move.created.map((square) => square.slice()),
      })),
      result: this.result,
    };
  }
}
