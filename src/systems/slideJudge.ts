import { evaluateJudgement } from '../utils/scoring';
import { isWithinBox, withinHitWindow } from './judge';
import { HIT_WINDOW_MS, SLIDE_HIT_HALF } from '../gameplayConstants';
import {
  processSlideCore as coreProcessSlideCore,
  type SlideBinding,
  type SlideJudgeDeps,
  type SlideJudgeInput,
} from '../shared/slideJudge';

/**
 * 完整版（3D / 2D）侧的 slide 判定入口。
 *
 * 纯逻辑核心已下沉到 `src/shared/slideJudge.ts` —— 三端（3D / 2D / Lite）单一真相，
 * 并随 Lite 构建被内联。本文件只保留**完整版专属**的两件事：
 *
 *  1. **依赖绑定**：核心禁用运行时 import，故「判定窗口 / 命中盒半宽 / 档位评定」
 *     这些外部能力必须由这里注入（见 `DEPS`）。
 *  2. **容器适配器**：`Set` / `Record` 两个适配器用 WeakMap 按容器缓存，而 WeakMap
 *     在 Lite 的目标环境（IE9）不存在，不能下沉到共享文件。
 *
 * 对外导出面与下沉前**逐字一致**：`useJudgeSystem` / `GameCanvas2D` 以及既有单测
 * （`useJudgeSystem.test.ts`）都无需改动。
 */

export type {
  SlideBinding,
  SlideJudgeDeps,
  SlideJudgeInput,
  SlideJudgeNode,
  SlideJudgeNodeRt,
  SlideJudgePointer,
  SlideJudgeState,
} from '../shared/slideJudge';
export { createSlideJudgeNodes } from '../shared/slideJudge';

/** 完整版的依赖绑定（全部是模块级常量，故只需构造一份）。 */
const DEPS: SlideJudgeDeps = {
  hitWindowMs: HIT_WINDOW_MS,
  slideHitHalf: SLIDE_HIT_HALF,
  evaluateJudgement,
  isWithinBox,
  withinHitWindow,
};

/** 逐帧推进一条 slide 的判定（消费方签名与下沉前一致）。 */
export function processSlideCore<TId>(input: SlideJudgeInput<TId>): void {
  coreProcessSlideCore(input, DEPS);
}

/* ---------------------------------------------------------------------------
 * 容器适配器。
 * 按容器缓存（WeakMap）：原实现每次调用都新建适配器对象 + 5 个闭包，而调用点是
 * 「每个活跃 slide 每帧」——是主要 GC 源之一。同一容器复用同一适配器。
 * ------------------------------------------------------------------------- */

const _setAdapters = new WeakMap<object, SlideBinding<unknown>>();

/** `Set<T>` 的绑定适配器（3D 端用）。 */
export function setBinding<T>(set: Set<T>): SlideBinding<T> {
  const key = set as unknown as object;
  let b = _setAdapters.get(key) as SlideBinding<T> | undefined;
  if (!b) {
    b = {
      has: (id) => set.has(id),
      add: (id) => { set.add(id); },
      delete: (id) => { set.delete(id); },
      size: () => set.size,
      ids: () => [...set],
      idsInto: (out) => { out.length = 0; for (const v of set) out.push(v); },
    };
    _setAdapters.set(key, b as unknown as SlideBinding<unknown>);
  }
  return b;
}

const _recAdapters = new WeakMap<Record<string, boolean>, SlideBinding<string>>();

/** `Record<string, boolean>` 的绑定适配器（2D 端用；Lite 侧自带内置实现）。 */
export function recordBinding(rec: Record<string, boolean>): SlideBinding<string> {
  let b = _recAdapters.get(rec);
  if (!b) {
    b = {
      has: (id) => !!rec[id],
      add: (id) => { rec[id] = true; },
      delete: (id) => { delete rec[id]; },
      size: () => Object.keys(rec).length,
      ids: () => Object.keys(rec),
      idsInto: (out) => {
        out.length = 0;
        for (const k in rec) if (Object.prototype.hasOwnProperty.call(rec, k)) out.push(k);
      },
    };
    _recAdapters.set(rec, b);
  }
  return b;
}
