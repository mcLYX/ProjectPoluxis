// build-lite.mjs
// Build the Lite single-file HTML from modular source under src/lite/.
//
// Pipeline:
//   1. concatenate src/lite/components/*.js (sorted, shared-scope IIFE)
//   2. esbuild: transpile to ES5 + minify  (IE11-compatible syntax)
//   3. inline minified JS + base.css + IE9.css into src/lite/index.template.html
//   4. write public/lite/index.html  (one self-contained file)
//
// Env: LITE_MINIFY=false  -> skip minification (for debugging the bundle)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT_DIR = path.join(root, 'src', 'lite');
const COMP_DIR = path.join(OUT_DIR, 'components');
const STYLE_DIR = path.join(OUT_DIR, 'styles');
const TPL = path.join(OUT_DIR, 'index.template.html');
const OUT = path.join(root, 'public', 'lite', 'index.html');

const minify = process.env.LITE_MINIFY !== 'false';

/* 0. Shared modules — single source of truth shared by the full app and the
 *    Lite build. Each is transpiled to ES5, its `export` keywords stripped (so
 *    each `var`/`function` becomes a plain shared-scope binding), and prepended
 *    to the IIFE. Editing any of these updates BOTH versions.
 *    - gameplaySpec.ts : gameplay *spec* constants (judge windows, scoring, …)
 *    - chartSchema.ts   : chart validation / normalization (one rule set for both)
 *    - demoCharts.ts    : built-in demo charts (one dataset for both)
 *    - beatTime.ts      : chart *resolution* (beat→sec, slide/node expansion, …)
 *    - easing.ts        : EASING_FNS (slide pipe easing)
 *    Order only affects readability; all are in scope before the components run. */
const SHARED_FILES = ['gameplaySpec.ts', 'chartSchema.ts', 'demoCharts.ts', 'beatTime.ts', 'easing.ts'];
let sharedFragment = '';
for (const f of SHARED_FILES) {
  const res = await transform(fs.readFileSync(path.join(root, 'src', 'shared', f), 'utf8'), {
    loader: 'ts',
    target: ['es5'],
  });
  let frag = res.code.replace(/export\s+/g, '');
  if (/\bexport\b/.test(frag)) {
    throw new Error('shared module still contained `export` after stripping: ' + f);
  }
  sharedFragment += '\n/* ===== shared: ' + f + ' ===== */\n' + frag + '\n';
}

/* 1. Concatenate component files in order (numeric prefixes guarantee order). */
const files = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith('.js')).sort();
if (files.length === 0) throw new Error('no component files found in ' + COMP_DIR);
let bundle =
  '/* ===== shared modules (single source of truth) ===== */\n' +
  sharedFragment +
  '\n';
for (const f of files) {
  bundle += '\n/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(COMP_DIR, f), 'utf8');
}
/* Shared scope: wrap all components in one IIFE, same as the original. */
const wrapped = '(function(){"use strict";' + bundle + '})();';

/* 2. esbuild: ES5 + optional minify. Source is already ES5, so this is mostly
 *    a safety down-level + minify pass that guarantees no ES2015+ leaks. */
const result = await transform(wrapped, {
  loader: 'js',
  target: ['es5'],
  minify,
  legalComments: 'none',
});
let appJs = result.code;
/* Guard against a literal </script> inside the bundle breaking the HTML. */
appJs = appJs.replace(/<\/script>/gi, '<\\/script>');

/* 3. Read styles. */
const baseCss = fs.readFileSync(path.join(STYLE_DIR, 'base.css'), 'utf8');
const ie9Css = fs.readFileSync(path.join(STYLE_DIR, 'ie9.css'), 'utf8');
const ie9Block =
  '<!--[if IE 9]>\n<style>\n' + ie9Css + '\n</style>\n<![endif]-->';

/* 4. Inline into the template. */
let tpl = fs.readFileSync(TPL, 'utf8');
if (tpl.includes('<!--LITE_BASE_CSS-->') === false) {
  throw new Error('template missing <!--LITE_BASE_CSS--> placeholder');
}
/* Replace with FUNCTIONS (not strings) so `$&`/`$'`/`$$` sequences inside the
 * minified JS / CSS are treated literally and never as replacement patterns. */
tpl = tpl.replace('<!--LITE_BASE_CSS-->', () => '<style>\n' + baseCss + '\n</style>');
tpl = tpl.replace('<!--LITE_IE9_CSS-->', () => ie9Block);
tpl = tpl.replace('<!--LITE_APP_JS-->', () => '<script>\n' + appJs + '\n</script>');

fs.writeFileSync(OUT, tpl);

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
console.log('build:lite complete');
console.log('  out : ' + path.relative(root, OUT));
console.log('  js  : ' + kb(appJs) + (minify ? ' (minified)' : ' (unminified)'));
console.log('  css : ' + kb(baseCss) + ' + ' + kb(ie9Css) + ' (IE9)');
