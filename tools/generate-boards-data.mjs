/**
 * Regenerates `js/boards-data.js` from the desktop project's `OrBds.json`.
 *
 * Only the initial board is bundled: the board library starts with one
 * preset, and everything else comes from random generation, the board editor,
 * or an imported catalog (the desktop build's own `saved_boards.json` can be
 * loaded through “导入 JSON”).
 *
 * Usage:
 *   node tools/generate-boards-data.mjs                 # writes js/boards-data.js
 *   node tools/generate-boards-data.mjs --stdout        # prints instead
 *   node tools/generate-boards-data.mjs <python-project-dir> [--out <file>]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const toStdout = argv.includes('--stdout');
const outIndex = argv.indexOf('--out');
const outPath = outIndex >= 0 ? resolve(argv[outIndex + 1]) : resolve(webRoot, 'js', 'boards-data.js');
const positional = argv.filter((arg, index) => !arg.startsWith('--') && index !== outIndex + 1);
const pythonRoot = positional[0]
  ? resolve(positional[0])
  : resolve(webRoot, '..', '..', 'Python', 'Way Creating Chess');

const sources = ['OrBds.json'].map((file) => resolve(pythonRoot, file));

function readBoards(path) {
  if (!existsSync(path)) {
    console.warn(`跳过（未找到）：${path}`);
    return [];
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(data.boards) ? data.boards : [];
}

/** Give the bundled board a readable name, keeping any name it already has. */
function friendlyName(board, index) {
  if (board.id === 0) return `默认棋盘（${board.width}×${board.height}）`;
  const base = String(board.name || `初始棋盘 ${index}`).trim();
  return `${base}（${board.width}×${board.height}）`;
}

const boards = [];
let index = 0;
for (const source of sources) {
  for (const board of readBoards(source)) {
    index += 1;
    boards.push({
      id: String(board.id),
      name: friendlyName(board, index),
      width: board.content[0].length,
      height: board.content.length,
      content: board.content,
    });
  }
}

const body = boards
  .map((board) => {
    const rows = board.content.map((row) => `        [${row.join(', ')}],`).join('\n');
    return [
      '  {',
      `    id: ${JSON.stringify(board.id)},`,
      `    name: ${JSON.stringify(board.name)},`,
      `    width: ${board.width},`,
      `    height: ${board.height},`,
      '    content: [',
      rows,
      '    ],',
      '  },',
    ].join('\n');
  })
  .join('\n');

const output = `/**
 * Bundled initial boards. GENERATED FILE — do not edit by hand.
 *
 * Source: ${pythonRoot}\\OrBds.json
 * Regenerate with: node tools/generate-boards-data.mjs
 *
 * Cell values: 0 closed (不可落子), 1 open (可落子), 2 A 方棋子, 3 B 方棋子.
 */

export const BOARD_CATALOG = {
  boards: [
${body}
  ],
};
`;

if (toStdout) {
  process.stdout.write(output);
} else {
  writeFileSync(outPath, output, 'utf8');
  console.log(`已写入 ${outPath}：${boards.length} 个棋盘（来源 ${pythonRoot}）`);
}
