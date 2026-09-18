// split-lite.mjs
// One-time extraction: turn the monolithic public/lite/index.html into
// modular source under src/lite/ (components/*.js + styles/*.css + template).
//
// The legacy Lite build is a single ES5 IIFE with heavily shared closure state,
// so the "engineering" step here is a *verbatim, concern-based split*: each
// section of the original <script> becomes its own file, and the build step
// concatenates them back into one IIFE (preserving the shared scope) before
// transpiling to ES5 + minifying + inlining into a single HTML file.
//
// Run order:  node scripts/split-lite.mjs   (reads public/lite/index.html)
//             node scripts/build-lite.mjs   (writes public/lite/index.html)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'public', 'lite', 'index.html');
const OUT_DIR = path.join(root, 'src', 'lite');
const COMP_DIR = path.join(OUT_DIR, 'components');
const STYLE_DIR = path.join(OUT_DIR, 'styles');
const TPL = path.join(OUT_DIR, 'index.template.html');

const html = fs.readFileSync(SRC, 'utf8');

/* ---------- 1. Capture the big inline <script> (the one without attributes) ---------- */
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('big inline <script> not found');
const js = scriptMatch[1];

/* ---------- 2. Split prelude (before the IIFE) from the IIFE body ---------- */
const IIFE_OPEN = '(function () {';
const iifeStart = js.indexOf(IIFE_OPEN);
if (iifeStart < 0) throw new Error('IIFE start not found');
const prelude = js.slice(0, iifeStart); // Object.assign polyfill + header comment
const iifeEnd = js.lastIndexOf('})();');
if (iifeEnd < 0) throw new Error('IIFE end not found');
let body = js.slice(iifeStart + IIFE_OPEN.length, iifeEnd);
body = body.replace(/^\s*'use strict';\s*/, '');

/* Section markers, in source order. Each fragment runs from its marker to the
 * next marker (the final one runs to end-of-body, i.e. past the Init block). */
const markers = [
  ['/* === 0.5 i18n', '01-i18n.js'],
  ['/* === 1. Polyfill', '02-polyfills.js'],
  ['/* === 2. Constants', '03-constants.js'],
  ['/* === 3. Core logic', '04-chart.js'],
  ['/* === 3.5 Color helpers', '05-colors.js'],
  ['/* === 3.6 Theme', '06-theme.js'],
  ['/* === 4. LiteAudio', '07-audio.js'],
  ['/* === 5. Renderer', '08-renderer.js'],
  ['/* === 6. Game loop', '09-engine.js'],
  ['/* === 7. UI wiring', '10-ui.js'],
  ['/* === Init ===', '11-init.js'],
];
const idxs = markers.map(([m]) => {
  const i = body.indexOf(m);
  if (i < 0) throw new Error('marker not found: ' + m);
  return i;
});
for (let k = 1; k < idxs.length; k++) {
  if (idxs[k] < idxs[k - 1]) throw new Error('markers out of order near: ' + markers[k][0]);
}

fs.mkdirSync(COMP_DIR, { recursive: true });
fs.mkdirSync(STYLE_DIR, { recursive: true });

fs.writeFileSync(path.join(COMP_DIR, '00-prelude.js'), prelude.trim() + '\n');
for (let k = 0; k < markers.length; k++) {
  const start = idxs[k];
  const end = k + 1 < idxs.length ? idxs[k + 1] : body.length;
  const frag = body.slice(start, end).trim() + '\n';
  fs.writeFileSync(path.join(COMP_DIR, markers[k][1]), frag);
}

/* ---------- 3. Extract the two <style> blocks ---------- */
const baseMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!baseMatch) throw new Error('base <style> not found');
fs.writeFileSync(path.join(STYLE_DIR, 'base.css'), baseMatch[1].trim() + '\n');

const ie9Match = html.match(/<!--\[if IE 9\]>([\s\S]*?)<!\[endif\]-->/);
if (!ie9Match) throw new Error('IE9 conditional block not found');
const ie9Inner = ie9Match[1].match(/<style>([\s\S]*?)<\/style>/);
if (!ie9Inner) throw new Error('IE9 inner <style> not found');
fs.writeFileSync(path.join(STYLE_DIR, 'ie9.css'), ie9Inner[1].trim() + '\n');

/* ---------- 4. Produce the HTML template (placeholders for build step) ---------- */
let tpl = html;
tpl = tpl.replace(/<style>[\s\S]*?<\/style>/, '<!--LITE_BASE_CSS-->');
tpl = tpl.replace(/<!--\[if IE 9\]>[\s\S]*?<!\[endif\]-->/, '<!--LITE_IE9_CSS-->');
tpl = tpl.replace(/<script>[\s\S]*?<\/script>/, '<!--LITE_APP_JS-->');
fs.writeFileSync(TPL, tpl);

console.log('split:lite complete');
console.log('  components -> ' + path.relative(root, COMP_DIR));
console.log('  styles     -> ' + path.relative(root, STYLE_DIR));
console.log('  template   -> ' + path.relative(root, TPL));
