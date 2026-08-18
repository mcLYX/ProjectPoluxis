/** 将 v 限制在 [min, max] 闭区间内（等价于 Math.min(max, Math.max(min, v))）。 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 与 clamp 相同，但先四舍五入（用于 0–255 的 RGB 通道等整数区间）。 */
export function clampInt(v: number, min: number, max: number): number {
  return Math.round(clamp(v, min, max));
}
