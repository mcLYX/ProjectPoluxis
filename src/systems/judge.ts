/**
 * 每 1x 秒对应的世界单位数（note 滚动速度缩放因子）。
 * 原定义在 GameCanvas.tsx，现集中到纯逻辑层供判定/z 推导复用。
 */
export const WORLD_UNITS_PER_SECOND = 36;

/**
 * 命中瞬间音符的 z 坐标：noteZ = JUDGE_Z + (dtMs/1000) * 36 * speed + 0.05。
 * JUDGE_Z = 0，故简化为 (dtMs/1000) * (WORLD_UNITS_PER_SECOND * speed) + 0.05。
 * 等价替换 commitJudgement / commitSlideNode 中的 hitSpeed 计算。
 */
export function noteHitZ(deltaTMs: number, speed: number): number {
  return (deltaTMs / 1000) * (WORLD_UNITS_PER_SECOND * speed) + 0.05;
}

/* `isWithinBox` / `withinHitWindow` 是纯规则，已下沉到 `shared/gameplaySpec.ts`
 * （三端单一真相）。此处原样重新导出，保持本模块既有导出面不变。 */
export { isWithinBox, withinHitWindow } from '../shared/gameplaySpec';
