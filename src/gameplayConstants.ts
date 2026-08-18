import type { RingPt } from './systems/geometry';

/**
 * R4-2：判定/特效/编辑器 hook 与 GameCanvas 共享的游戏常数，单一来源。
 * GameCanvas 从本模块导入后不再重复定义；如需调整取值，只改这里即可。
 * （原 `export const` 曾位于 GameCanvas.tsx，为消除 react-refresh
 *  only-export-components 警告与 hook→组件 循环依赖而收敛到此。）
 */
export const TAP_SIZE = 1.6;
export const TOUCH_SIZE = TAP_SIZE * 0.707;
export const SLIDE_SIZE = TAP_SIZE * 0.707; // slide diamond edge = 0.707x tap
export const SLIDE_HALF = (SLIDE_SIZE * Math.SQRT2) / 2; // half-diagonal of the 45°-rotated square

/** Layer index used by SelectiveBloom — note meshes are added to this layer
 *  so the bloom camera (which only sees this layer) renders ONLY notes,
 *  not tunnel lines, projections, or burst outlines. */
export const BLOOM_LAYER = 1;
export const JUDGE_Z = 0;
export const TAP_HIT_HALF = 1.2;
export const SLIDE_HIT_HALF = 1.2;
export const HIT_WINDOW_MS = 160;

export const TAP_RING_OUTER: RingPt[] = [
  [-TAP_SIZE / 2, -TAP_SIZE / 2],
  [TAP_SIZE / 2, -TAP_SIZE / 2],
  [TAP_SIZE / 2, TAP_SIZE / 2],
  [-TAP_SIZE / 2, TAP_SIZE / 2],
];
export const TOUCH_RING_OUTER: RingPt[] = (() => {
  const rad = TOUCH_SIZE / 2;
  const pts: RingPt[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  return pts;
})();
export const SLIDE_RING_OUTER: RingPt[] = [
  [0, -SLIDE_HALF],
  [SLIDE_HALF, 0],
  [0, SLIDE_HALF],
  [-SLIDE_HALF, 0],
];
