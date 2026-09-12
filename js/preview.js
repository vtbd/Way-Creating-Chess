/** Tiny canvas thumbnails of initial boards, used in the board manager. */

import { Cell } from './engine.js';

const COLORS = {
  [Cell.CLOSED]: '#333a44',
  [Cell.OPEN]: '#ddcba4',
  [Cell.A]: '#3e89d3',
  [Cell.B]: '#d95b55',
};

const MAX_SIDE = 132;

/** Draw `definition` into `canvas`, scaled to fit inside the preview box. */
export function drawMiniBoard(canvas, definition) {
  const { width, height, content } = definition;
  const cell = Math.max(2, Math.floor(Math.min(MAX_SIDE / width, MAX_SIDE / height)));
  const gap = cell >= 8 ? 1 : 0;
  const cssWidth = width * cell;
  const cssHeight = height * cell;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * ratio));
  canvas.height = Math.max(1, Math.round(cssHeight * ratio));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = '#222730';
  context.fillRect(0, 0, cssWidth, cssHeight);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = content[y][x];
      context.fillStyle = COLORS[value] || COLORS[Cell.CLOSED];
      const size = cell - gap;
      if (value === Cell.A || value === Cell.B) {
        const radius = Math.max(1, size / 2);
        context.beginPath();
        context.arc(x * cell + cell / 2, y * cell + cell / 2, radius, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(x * cell, y * cell, size, size);
      }
    }
  }
  return canvas;
}
