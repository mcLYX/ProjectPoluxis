/**
 * Single source of truth for gameplay *spec* constants shared by the full
 * (React / Three.js) app and the Lite (Canvas-2D, ES5) build.
 *
 * Rules for this file:
 *  - Spec data + the pure helpers **derived from** that data — no DOM, no TS-only
 *    runtime features. Everything here must survive an esbuild ES5 transpile so
 *    the Lite build can inline it verbatim into its shared-scope IIFE.
 *  - **No runtime `import`s** (only `import type`, which is erased): the Lite build
 *    runs esbuild `transform`, not `build`, so an ESM import would survive into the
 *    IIFE as an illegal top-level import. That is exactly why the scoring /
 *    judgement helpers live in THIS file — they need the constants above and
 *    nothing else.
 *  - Declarations use `var` (not `const`/`let`) on purpose: the Lite build runs
 *    esbuild `transform` with an `es5` target, which does not lower block-scoped
 *    declarations. Keeping them `var` means the build only has to strip `export`.
 *  - If you change a value here, BOTH versions update — no manual resync.
 *
 * The Lite build strips the `export` keywords and prepends the result at the
 * top of its IIFE; the full app imports the same symbols via ESM.
 */

import type { GameStats, JudgementType } from '../types/game';

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

/* ============================================================================
 * Pure rules derived from the spec above.
 *
 * 三端（完整版 3D / 完整版 2D / Lite 单文件）判定与计分的**单一真相**：Lite 原先在
 * `lite/components/04-chart.js` 手抄了一份，语义一旦漂移就会静默分叉，故收口到这里。
 *
 * 放在本文件（而非另建 `shared/scoring.ts`）的原因见文件头第 2 条：共享模块之间
 * 不能用 runtime import 互相引用，而它们恰好只需要上面这几组常量。
 * 声明一律用 `var` / 函数声明（ES5 transform 不降级块级声明）。
 * ========================================================================== */

/**
 * 由**绝对**时间误差 Δt（毫秒）判定档位；`null` = 落在所有窗口之外（过早/过晚）。
 * 与 `utils/scoring.ts` 旧实现逐字等价。
 */
export function evaluateJudgement(deltaTMs: number): JudgementType | null {
  var absDelta = Math.abs(deltaTMs);
  if (absDelta < JUDGE_THRESH.S_PERFECT) return 'S-Perfect';
  if (absDelta < JUDGE_THRESH.PERFECT) return 'Perfect';
  if (absDelta < JUDGE_THRESH.GOOD) return 'Good';
  return null;
}

/**
 * 单音符得分：`base = SCORE_BASE / totalNotes`；
 * S-Perfect = base + 1，Perfect = base，Good = base * 0.5，Miss = 0。
 */
export function calculateNoteScore(judgement: JudgementType, totalNotes: number): number {
  if (totalNotes <= 0) return 0;
  var base = SCORE_BASE / totalNotes;
  if (judgement === 'S-Perfect') return base + 1;
  if (judgement === 'Perfect') return base;
  if (judgement === 'Good') return base * 0.5;
  return 0;
}

/** 由累计得分评级。 */
export function calculateRank(score: number): GameStats['rank'] {
  if (score >= RANK_THRESHOLDS.EX_PLUS) return 'EX+';
  if (score >= RANK_THRESHOLDS.EX) return 'EX';
  if (score >= RANK_THRESHOLDS.S) return 'S';
  if (score >= RANK_THRESHOLDS.A) return 'A';
  if (score >= RANK_THRESHOLDS.B) return 'B';
  if (score >= RANK_THRESHOLDS.C) return 'C';
  return 'F';
}

/** 轴对齐命中盒：(px,py) 是否落在中心 (cx,cy)、半宽 `half` 的盒内。 */
export function isWithinBox(px: number, py: number, cx: number, cy: number, half: number): boolean {
  return Math.abs(px - cx) < half && Math.abs(py - cy) < half;
}

/** 判定窗口（毫秒）内：|dt| <= window。 */
export function withinHitWindow(deltaTMs: number, windowMs: number): boolean {
  return Math.abs(deltaTMs) <= windowMs;
}
