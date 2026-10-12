import { HIT_WINDOW_MS, TAP_HIT_HALF, TOUCH_HIT_HALF } from '../gameplayConstants';
import { isWithinBox, withinHitWindow } from './judge';
import { evaluateJudgement } from '../utils/scoring';
import {
  createTouchJudgeState,
  judgeTapCore,
  processTouchCore,
  type TapHitDecision,
  type TapHitEnv,
  type TapJudgeDeps,
  type TapJudgeNote,
  type TouchDecision,
  type TouchJudgeEnv,
  type TouchJudgeState,
} from '../shared/tapJudge';

/**
 * tap / touch 判定核心的**完整版绑定层**。
 *
 * 规则面（常量 + 纯函数）在此绑定一次；环境面（音符合成位置 / 活跃指针查询 /
 * 已判定集合）因各端数据源不同，经 `TapHitEnv` / `TouchJudgeEnv` 由调用点注入。
 * Lite 侧因共享文件为构建期内联，直接用 `shared/tapJudge.ts` 的 `*Core` + 自带绑定。
 */
export const tapJudgeDeps: TapJudgeDeps = {
  hitWindowMs: HIT_WINDOW_MS,
  tapHitHalf: TAP_HIT_HALF,
  touchHitHalf: TOUCH_HIT_HALF,
  isWithinBox,
  withinHitWindow,
  evaluateJudgement,
};

export { createTouchJudgeState, judgeTapCore, processTouchCore };
export type { TapHitDecision, TapHitEnv, TapJudgeNote, TouchDecision, TouchJudgeEnv, TouchJudgeState };
