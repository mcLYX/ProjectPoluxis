/**
 * Single source of truth for gameplay *spec* constants shared by the full
 * (React / Three.js) app and the Lite (Canvas-2D, ES5) build.
 *
 * Rules for this file:
 *  - Pure data only (no DOM, no TS-only runtime features). Everything here must
 *    survive an esbuild ES5 transpile so the Lite build can inline it verbatim
 *    into its shared-scope IIFE.
 *  - Declarations use `var` (not `const`/`let`) on purpose: the Lite build runs
 *    esbuild `transform` with an `es5` target, which does not lower block-scoped
 *    declarations. Keeping them `var` means the build only has to strip `export`.
 *  - If you change a value here, BOTH versions update — no manual resync.
 *
 * The Lite build strips the `export` keywords and prepends the result at the
 * top of its IIFE; the full app imports the same symbols via ESM.
 */

/* ---- Note sizes / hit geometry (mirrors full version gameplayConstants.ts) ---- */
export var TAP_SIZE = 1.6;
export var TOUCH_SIZE = TAP_SIZE * 0.707;
export var SLIDE_SIZE = TAP_SIZE * 0.707; // slide diamond edge = 0.707x tap
export var SLIDE_HALF = (SLIDE_SIZE * Math.SQRT2) / 2; // half-diagonal of the 45°-rotated square
export var JUDGE_Z = 0;
export var TAP_HIT_HALF = 1.2;
export var TOUCH_HIT_HALF = 1.0;
export var SLIDE_HIT_HALF = 1.2;
export var HIT_WINDOW_MS = 160;

/* ---- Chart spec ----
 * NOTE: EASING_TYPES is the single source of truth in src/shared/chartSchema.ts
 * (inlined into this build by scripts/build-lite.mjs). 04-chart.js's resolveChart
 * reads the inlined EASING_TYPES global — do not redefine it here. */

/* ---- Judgement spec (absolute timing error, milliseconds) ---- */
export var JUDGE_THRESH = { S_PERFECT: 40, PERFECT: 80, GOOD: 160 };

/** Burst / hit-feedback colours per judgement (hex). */
export var JUDGE_COLORS = {
  'S-Perfect': '#ff8c00',
  'Perfect': '#ffd700',
  'Good': '#38bdf8',
  'Miss': '#ef4444',
};

/** Burst animation growth factor per judgement (1.0 = no growth). */
export var JUDGE_SCALE = {
  'S-Perfect': 1.2,
  'Perfect': 1.1,
  'Good': 1.05,
  'Miss': 1.0,
};

/* ---- Scoring spec ---- */
/** Base score before per-note division: 10,000,000 / totalNotes. */
export var SCORE_BASE = 10000000;

/** Rank cut-offs by cumulative score. */
export var RANK_THRESHOLDS = {
  EX_PLUS: 9900000,
  EX: 9500000,
  S: 9000000,
  A: 8000000,
  B: 7000000,
  C: 6000000,
};
