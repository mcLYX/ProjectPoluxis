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
  /**
   * 渲染帧率上限（0 = 不限帧）。高刷屏（90/120/144Hz）上把绘制帧数限制到
   * 目标值可显著降低功耗（实测手机端功耗明显下降），且音符流视觉平滑度
   * 影响很小。由各 rAF 渲染循环经 utils/frameLimiter 的相位累加器统一执行。
   */
  maxFps: number;
}

/**
 * 各预设对应的自定义项有效值（不含帧率上限，帧率独立于预设）。
 * 这是「预设 → 渲染参数」的唯一真相源：切换预设时 SettingsModal 据此把值
 * 同步写入 custom*，init() 在启动时也据此回填，使常驻展示与真实渲染一致。
 * 3D 渲染器只消费 custom*，不再按档位名分派。
 */
export type PresetCustom = {
  customAntialias: boolean;
  customBloom: boolean;
  customParticles: boolean;
  customDynamicLighting: boolean;
  customHitEffects: boolean;
  customRenderScale: number;
};
export const PRESET_VALUES: Record<Exclude<QualityMode, 'custom'>, PresetCustom> = {
  lite:     { customAntialias: false, customBloom: false, customParticles: false, customDynamicLighting: false, customHitEffects: false, customRenderScale: 1.0 },
  low:      { customAntialias: false, customBloom: false, customParticles: false, customDynamicLighting: false, customHitEffects: false, customRenderScale: 0.75 },
  standard: { customAntialias: true,  customBloom: false, customParticles: false, customDynamicLighting: false, customHitEffects: false, customRenderScale: 1.0 },
  high:     { customAntialias: true,  customBloom: true,  customParticles: true,  customDynamicLighting: false, customHitEffects: false, customRenderScale: 1.0 },
  ultra:    { customAntialias: true,  customBloom: true,  customParticles: true,  customDynamicLighting: true,  customHitEffects: true,  customRenderScale: 1.0 },
};

const DEFAULT_QUALITY: QualityState = {
  // 占位初值；init() 会按 qualityMode 从 PRESET_VALUES 回填 custom*，故此处与
  // 'standard' 预设保持一致即可（不依赖这些值生效）。
  qualityMode: 'standard',
  customAntialias: true,
  customBloom: false,
  customParticles: false,
  customDynamicLighting: false,
  customHitEffects: false,
  customRenderScale: 1.0,
  maxFps: 60,
};

let state: QualityState = { ...DEFAULT_QUALITY };
let initialized = false;
const listeners = new Set<() => void>();

/**
 * capability.js 在检测到无 WebGL 时置位该标记（WebGL 已不再阻断进入完整版）。
 * 此时必须走 'lite'（2D Canvas 渲染器、不加载 three），否则 three.js 场景创建
 * 失败、游戏进不去——完整版在无 WebGL 设备上是可用的，只是渲染器不同。
 */
function hasNoWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as unknown as { __POLUXIS_NO_WEBGL__?: boolean }).__POLUXIS_NO_WEBGL__;
}

function emit(): void {
  for (const l of listeners) l();
}

export const qualityStore = {
  /** 幂等初始化：仅首次调用生效（App 首渲染前以持久化设置调用）。 */
  init(initial: QualityState): void {
    if (initialized) return;
    initialized = true;
    const next: QualityState = { ...initial };
    // 无 WebGL 时强制 2D 渲染器：覆盖持久化设置里的 3D 档位（该档位在此设备上
    // 根本无法工作）。有 WebGL 时完全不改动用户设置。
    if (hasNoWebGL()) next.qualityMode = 'lite';
    // 已选预设（非「自定义」）的有效值回填到 custom*，使常驻展示与真实渲染一致；
    // 选定「自定义」时保留用户已存的 custom* 不变。
    if (next.qualityMode !== 'custom') {
      const p = PRESET_VALUES[next.qualityMode];
      if (p) {
        next.customAntialias = p.customAntialias;
        next.customBloom = p.customBloom;
        next.customParticles = p.customParticles;
        next.customDynamicLighting = p.customDynamicLighting;
        next.customHitEffects = p.customHitEffects;
        next.customRenderScale = p.customRenderScale;
      }
    }
    state = next;
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
