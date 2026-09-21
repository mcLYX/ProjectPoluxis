import { useSyncExternalStore } from 'react';

/**
 * 编辑器预览播放时间源（模块级单例，位于 React 树之外）。
 *
 * ## 为什么需要它
 * 编辑器预览播放时，App 的 HUD rAF 需要每 ~33ms 刷新一次「播放头时间」以驱动
 * 时间轴/拍号显示。原实现把该时间经 `setGameTime` 写进 App state，导致**整个 App
 * 每 30fps 全树重渲染**——而正常游玩完全不会重渲染（HUD 全走 ref 直写 DOM）。
 * 放大器是未 memo 的巨型组件 `VisualChartEditor`：每次渲染都跑多趟 O(n) 全谱遍历。
 *
 * 现改为：App 的 rAF 把时间 `set()` 进本 store，只有订阅它的**微型组件**（拍号/秒数
 * 显示、时间轴拖拽条）会重渲染；`VisualChartEditor` 本体不再接收高频时间 prop，
 * 因而在预览播放期间不重渲染。时间真正的「跳转 / 定格」仍走高（低）频的
 * `gameTime` state（seek / 暂停 / 进出编辑器）。
 *
 * 范式与 `qualityStore` / `liveDragStore` 一致：模块单例 + `useSyncExternalStore`。
 */
export interface EditorTimeState {
  /** 谱面时间（秒），与 `globalAudio.getCurrentTime()` 同一坐标系。 */
  timeSec: number;
  /** 由 `timeSec` 按谱面 BPM/offset/bpmlist 换算出的拍号。 */
  beat: number;
}

const INITIAL: EditorTimeState = { timeSec: 0, beat: 0 };
let state: EditorTimeState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const editorTimeStore = {
  /** 返回当前快照（引用仅在 set 时更换，满足 useSyncExternalStore 的缓存要求）。 */
  getSnapshot: (): EditorTimeState => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  /** 逐字段去重：无变化不 emit，避免订阅组件无谓重渲染。 */
  set: (next: EditorTimeState): void => {
    if (state.timeSec === next.timeSec && state.beat === next.beat) return;
    state = next;
    emit();
  },
};

/** 订阅编辑播放头时间（仅订阅方组件重渲染）。 */
export function useEditorTime(): EditorTimeState {
  return useSyncExternalStore(editorTimeStore.subscribe, editorTimeStore.getSnapshot);
}
