export type RingPt = [number, number];

/**
 * 默认外观描边加粗：将闭合环点按最大半径外扩 `width`（保持形状比例）。
 * 等价替换 GameCanvas ensureSlideMeshes 默认分支：
 *   const maxR = Math.max(...hypot(pts));
 *   pts.map(([x,y]) => [x*((maxR+w)/maxR), y*((maxR+w)/maxR)]);
 */
export function expandRing(pts: RingPt[], width: number): RingPt[] {
  const maxR = pts.reduce((m, [x, y]) => Math.max(m, Math.hypot(x, y)), 0);
  if (maxR === 0) return pts.map(([x, y]) => [x, y] as RingPt);
  const k = (maxR + width) / maxR;
  return pts.map(([x, y]) => [x * k, y * k] as RingPt);
}
