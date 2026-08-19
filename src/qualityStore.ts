import { useSyncExternalStore } from 'react';
import type { QualityMode } from './types/game';

/**
 * R4-6：quality 渲染设置切片（qualityMode + 5 个 custom*），从 App 根 state 下沉。
 *
 * 设计要点：
 * - 模块级单例 + `useSyncExternalStore` 订阅，与 liveDragStore 同范式；store 完全
 *   位于 React 树之外，只有订阅的组件（SettingsModal / App）才会随设置变化重渲染，
 *   GameCanvas 通过 React.memo 保持隔离。
 * - `set` 逐字段去重：无变化不 emit，避免订阅组件无谓重渲染。
 * - `init` 幂等：App 首渲染前以 loadSettings() 结果初始化一次，之后不再覆盖
 *   （保持与持久化设置一致）。
 * - 取值全部为低频稳定项（仅设置弹窗修改），游戏过程中不变化，因此无性能风险。
 */
export interface QualityState {
  qualityMode: QualityMode;
  customAntialias: boolean;
  customBloom: boolean;
  customParticles: boolean;
  customDynamicLighting: boolean;
  customHitEffects: boolean;
  customRenderScale: number;
}

const DEFAULT_QUALITY: QualityState = {
  qualityMode: 'standard',
  customAntialias: true,
  customBloom: true,
  customParticles: true,
  customDynamicLighting: false,
  customHitEffects: true,
  customRenderScale: 1.0,
};

let state: QualityState = { ...DEFAULT_QUALITY };
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const qualityStore = {
  /** 幂等初始化：仅首次调用生效（App 首渲染前以持久化设置调用）。 */
  init(initial: QualityState): void {
    if (initialized) return;
    initialized = true;
    state = { ...initial };
  },
  /** 返回当前快照（对象引用仅在 set 时更换，满足 useSyncExternalStore 缓存要求）。 */
  getSnapshot: (): QualityState => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  /** 逐字段去重更新：无字段变化则不 emit（订阅组件不重渲染）。 */
  set: (patch: Partial<QualityState>): void => {
    let changed = false;
    const keys = Object.keys(patch) as (keyof QualityState)[];
    for (const k of keys) {
      if (state[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    emit();
  },
};

/** 订阅 quality 切片（仅订阅方组件重渲染）。 */
export function useQuality(): QualityState {
  return useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
}
