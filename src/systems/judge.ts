/**
 * 每 1x 秒对应的世界单位数（note 滚动速度缩放因子）。
 * 原定义在 GameCanvas.tsx，现集中到纯逻辑层供判定/z 推导复用。
 */
export const WORLD_UNITS_PER_SECOND = 36;

/**
 * 轴对齐命中盒判定：点 (px,py) 是否落在中心 (cx,cy)、半宽 half 的盒内。
 * 等价替换 GameCanvas 中 `Math.abs(px - cx) < half && Math.abs(py - cy) < half`。
 */
export function isWithinBox(px: number, py: number, cx: number, cy: number, half: number): boolean {
  return Math.abs(px - cx) < half && Math.abs(py - cy) < half;
}

/**
 * 命中瞬间音符的 z 坐标：noteZ = JUDGE_Z + (dtMs/1000) * 36 * speed + 0.05。
 * JUDGE_Z = 0，故简化为 (dtMs/1000) * (WORLD_UNITS_PER_SECOND * speed) + 0.05。
 * 等价替换 commitJudgement / commitSlideNode 中的 hitSpeed 计算。
 */
export function noteHitZ(deltaTMs: number, speed: number): number {
  return (deltaTMs / 1000) * (WORLD_UNITS_PER_SECOND * speed) + 0.05;
}

/** 判定窗口（毫秒）内判定：|dt| <= window。 */
export function withinHitWindow(deltaTMs: number, windowMs: number): boolean {
  return Math.abs(deltaTMs) <= windowMs;
}
