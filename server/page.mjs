// The board page is kept as small source files so each stays under the plugin directory's per-file size limit:
// page.html (markup), the style pieces in board/css and the script pieces in board/js. The server joins them
// into the one self-contained document.
import { readFile } from 'node:fs/promises';

const PIECES = new URL('./board/', import.meta.url);

// The pieces, in the order they are joined. The order is part of the page (CSS rules cascade, and the script is one
// scope that runs top to bottom), so it is listed here and a file in the folders that is not listed is left out.
// A new piece must be added here; test/page.test.mjs fails when a file in the folders is missing from these lists.
export const CSS_PIECES = [
  'css/base.css',
  'css/shell.css',
  'css/shapes.css',
  'css/board-view.css',
  'css/home.css',
  'css/milestones-view.css',
  'css/list.css',
  'css/summary.css',
  'css/issue.css',
  'css/thread.css',
  'css/responsive.css',
];
export const JS_PIECES = [
  'js/base.js',
  'js/model.js',
  'js/fields.js',
  'js/routes.js',
  'js/runtime.js',
  'js/shell.js',
  'js/milestones.js',
  'js/summary.js',
  'js/list.js',
  'js/milestones-view.js',
  'js/home.js',
  'js/board-view.js',
  'js/content.js',
  'js/panel.js',
  'js/issue.js',
  'js/copy.js',
  'js/waits.js',
  'js/thread.js',
  'js/start.js',
];

// A piece's lines are joined to the next piece's with nothing in between (each piece ends with its own newline), and
// the joined text sits on its own line between the tags, so its final newline is dropped. The script pieces are the
// body of the function that page.html opens and closes around the placeholder.
const joined = (parts) => parts.join('').replace(/\n$/, '');

// Throws when a piece is missing or page.html lost a placeholder, so the server answers 503 instead of a page with no style or script.
export async function assembleBoardPage(dir = PIECES) {
  const read = (name) => readFile(new URL(name, dir), 'utf8');
  const [page, css, js] = await Promise.all([
    read('page.html'),
    Promise.all(CSS_PIECES.map(read)),
    Promise.all(JS_PIECES.map(read)),
  ]);
  for (const mark of ['/*__BOARD_CSS__*/', '/*__BOARD_JS__*/']) {
    if (!page.includes(mark)) throw new Error(`page.html has no ${mark} placeholder`);
  }
  return page
    .replace('/*__BOARD_CSS__*/', () => joined(css))
    .replace('/*__BOARD_JS__*/', () => joined(js));
}
