import { useSyncExternalStore } from 'react';

/**
 * 播放头时间的**单一真相源**（模块级单例，位于 React 树之外）。
 *
 * ## 为什么需要它
 * 编辑器预览播放时，App 的 HUD rAF 需要每 ~33ms 刷新一次「播放头时间」以驱动
 * 时间轴/拍号显示。原实现把该时间经 `setGameTime` 写进 App state，导致**整个 App
 * 每 30fps 全树重渲染**——而正常游玩完全不会重渲染（HUD 全走 ref 直写 DOM）。
 * 放大器是未 memo 的巨型组件 `VisualChartEditor`：每次渲染都跑多趟 O(n) 全谱遍历。
 *
 * 现改为：时间 `set()` 进本 store，只有订阅它的**微型组件**（拍号/秒数显示、
 * 时间轴拖拽条）会重渲染；`VisualChartEditor` 本体不再接收高频时间 prop，
 * 因而在预览播放期间不重渲染。
 *
 * ## 唯一的两个写入者（互斥，不冲突）
 * 1. **编辑器 HUD rAF**（`App.tsx` 的 HUD 帧回调）：仅当 `gameState === 'editor'`
 *    且预览播放中时每帧写入实时音频时间。此时 `gameTime` state **不变**。
 * 2. **低频同步 effect**（`App.tsx`）：随 `gameTime` 变化写入（seek / 暂停 /
 *    进出编辑器 / 曲终）。预览播放期间 `gameTime` 不变，故本路径不参与。
 *
 * 两者由「预览播放时 gameTime 不变」这一不变式分隔，永不争写。该不变式此前只写在
 * App 的注释里；现收口到本文件，使 store 成为唯一需要理解写入纪律的地方。
 *
 * ⚠️ 读取方若只是**事件式取值**（如 `handleSeekBeat`、滚轮逐格、新增 BPM 点），
 * 必须用 `getSnapshot()` 而非订阅 —— 否则会把 ~30fps 的重渲染引回主界面。
 *
 * 范式与 `qualityStore` / `liveDragStore` 一致：模块单例 + `useSyncExternalStore`。
 */
export interface PlayheadState {
  /** 谱面时间（秒），与 `globalAudio.getCurrentTime()` 同一坐标系。 */
  timeSec: number;
  /** 由 `timeSec` 按谱面 BPM/offset/bpmlist 换算出的拍号。 */
  beat: number;
}

const INITIAL: PlayheadState = { timeSec: 0, beat: 0 };
let state: PlayheadState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const playheadStore = {
  /** 返回当前快照（引用仅在 set 时更换，满足 useSyncExternalStore 的缓存要求）。 */
  getSnapshot: (): PlayheadState => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  /** 逐字段去重：无变化不 emit，避免订阅组件无谓重渲染。 */
  set: (next: PlayheadState): void => {
    if (state.timeSec === next.timeSec && state.beat === next.beat) return;
    state = next;
    emit();
  },
};

/** 订阅播放头（仅订阅方组件重渲染；事件式取值请改用 `getSnapshot()`）。 */
export function usePlayhead(): PlayheadState {
  return useSyncExternalStore(playheadStore.subscribe, playheadStore.getSnapshot);
}
