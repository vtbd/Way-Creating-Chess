/**
 * DOM board renderer.
 *
 * Cells are grid items sized by CSS, so the board scales to any viewport and
 * supports the editor's 40×40 maximum. Stones are drawn with a pseudo element,
 * which keeps the DOM to one node per cell.
 */

import { Cell } from './engine.js';

const STATE_CLASS = {
  [Cell.CLOSED]: 'is-closed',
  [Cell.OPEN]: 'is-open',
  [Cell.A]: 'is-a',
  [Cell.B]: 'is-b',
};

export class BoardView {
  constructor(element, handlers = {}) {
    this.element = element;
    // The grid layout lives in the `.board` class; make sure it is present
    // whether the caller supplied the page container or built a fresh node.
    element.classList.add('board');
    this.handlers = handlers;
    this.width = 0;
    this.height = 0;
    this.nodes = [];
    this._bind();
  }

  _bind() {
    const locate = (event) => {
      const target = event.target instanceof Element ? event.target.closest('.cell') : null;
      if (!target || !this.element.contains(target)) return null;
      return { x: Number(target.dataset.x), y: Number(target.dataset.y) };
    };
    this.locate = locate;
    this.element.addEventListener('pointerdown', (event) => {
      const spot = locate(event);
      if (spot && this.handlers.onDown) this.handlers.onDown(spot.x, spot.y, event);
    });
    this.element.addEventListener('pointerover', (event) => {
      const spot = locate(event);
      if (spot && this.handlers.onOver) this.handlers.onOver(spot.x, spot.y, event);
    });
    this.element.addEventListener('pointerleave', () => {
      if (this.handlers.onLeave) this.handlers.onLeave();
    });
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  _build(width, height) {
    this.width = width;
    this.height = height;
    this.element.style.setProperty('--cols', String(width));
    this.element.style.setProperty('--rows', String(height));
    const area = width * height;
    this.element.style.setProperty('--gap', area >= 400 ? '1px' : area >= 150 ? '2px' : '4px');
    this.element.classList.toggle('is-dense', area >= 400);
    const fragment = document.createDocumentFragment();
    this.nodes = new Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        this.nodes[y * width + x] = cell;
        fragment.append(cell);
      }
    }
    this.element.replaceChildren(fragment);
  }

  /**
   * @param {object} model
   * @param {number} model.width
   * @param {number} model.height
   * @param {ArrayLike<number>} model.cells flat `y * width + x` values
   * @param {Set<number>} [model.legal] indices that can be played now
   * @param {Set<number>} [model.created] indices opened by the shown move
   * @param {Set<number>} [model.winning] indices of the winning run
   * @param {number} [model.lastIndex] index of the shown move
   * @param {string} [model.toolClass] cursor hint for the editor
   */
  render(model) {
    const { width, height } = model;
    if (width !== this.width || height !== this.height) this._build(width, height);
    const legal = model.legal || new Set();
    const created = model.created || new Set();
    const winning = model.winning || new Set();
    const lastIndex = model.lastIndex;
    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index];
      const value = model.cells[index];
      let classes = `cell ${STATE_CLASS[value] || 'is-closed'}`;
      if (legal.has(index)) classes += ' is-legal';
      if (created.has(index)) classes += ' is-created';
      if (winning.has(index)) classes += ' is-winning';
      if (index === lastIndex) classes += ' is-last';
      if (node.className !== classes) node.className = classes;
      const x = index % width;
      const y = Math.floor(index / width);
      const label = value === Cell.CLOSED ? '封闭' : value === Cell.OPEN ? '可落子' : value === Cell.A ? 'A 方棋子' : 'B 方棋子';
      const description = `${String.fromCharCode(97 + x)}${y + 1} ${label}`;
      if (node.dataset.label !== description) {
        node.dataset.label = description;
        node.title = description;
      }
    }
    this.element.classList.toggle('is-editor', Boolean(model.toolClass));
    if (model.toolClass) this.element.dataset.tool = model.toolClass;
    else delete this.element.dataset.tool;
  }
}
