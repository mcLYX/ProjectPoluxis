import type { RingPt } from './systems/geometry';
import { TAP_SIZE, TOUCH_SIZE, SLIDE_HALF } from './shared/gameplaySpec';

/**
 * R4-2：游戏常数单一来源的一部分。
 * 纯 *spec* 常量（音符尺寸 / 判定窗 / 计分基数等）已收敛到
 * src/shared/gameplaySpec.ts —— 本模块 `export *` 它们以保持既有导入路径不变；
 * 需要改这些数值时只改 src/shared/gameplaySpec.ts 一处即可（常规版与 Lite 版同步）。
 * 下面只保留 3D 渲染特有的几何数据（依赖 RingPt 类型），并就地 import 了
 * TAP_SIZE / TOUCH_SIZE / SLIDE_HALF 供 ring 顶点计算使用。
 */
export * from './shared/gameplaySpec';

/** Layer index used by SelectiveBloom — note meshes are added to this layer
 *  so the bloom camera (which only sees this layer) renders ONLY notes,
 *  not tunnel lines, projections, or burst outlines. */
export const BLOOM_LAYER = 1;

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
