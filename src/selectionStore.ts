import { useSyncExternalStore } from 'react';

/**
 * 编辑器选中态的**单一真相源**（模块级单例，位于 React 树之外）。
 *
 * ## 为什么需要它
 * 原实现是四个东西拼出来的：`selectedNoteIds` state（集合）+ `selectedNoteId`
 * state（单选焦点）+ `selectedNoteIdsRef`（ref 镜像，供事件回调避免闭包过期）+
 * 散落在各处的「手动同时清两处」。三者的一致性只靠注释维持，任何新增写入点都得
 * 记得同步 —— 这正是架构审查里点出的「多写入者 + 引用镜像」。
 *
 * 现收口为单一 store：集合与焦点同处一个快照，写入只有 `setIds` / `setFocus` /
 * `clear` 三个入口，清空不再是「记得同时清两处」而是一次 `clear()`。
 *
 * ## 语义（与收口前逐字一致）
 * - `ids` 是**唯一数据源**，元素可为头节点 id 或子节点 id（`head#2`）。
 * - `focus` 仅在集合长度为 1 时作为单选焦点；它是**派生视图**，不是第二个数据源。
 * - 多选模式下取消选中某音符时，若它恰是焦点则焦点同步清空。
 *
 * ## 与 React 的关系
 * store 不感知组件。`App.tsx` 用 `useSelection()` 订阅，再把值**原样以 props
 * 下发**给 3D / 2D / 编辑器画布 —— 后者仍走既有的 props 契约与 `React.memo`
 * 比较，渲染链路零改动。这样收口只发生在「谁拥有这个状态」，不波及下游。
 *
 * 范式与 `playheadStore` / `qualityStore` / `liveDragStore` 一致：模块单例 +
 * `useSyncExternalStore`。
 */
export interface SelectionState {
  /** 选中的 id 集合（唯一数据源；可含 `head#idx` 形式的子节点 id）。 */
  ids: string[];
  /** 单选焦点；仅当 `ids.length === 1` 时非空。 */
  focus: string | null;
}

const EMPTY: string[] = [];

const INITIAL: SelectionState = { ids: EMPTY, focus: null };
let state: SelectionState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 逐元素比较（集合是小数组，线性比较足够，且避免无变化时无谓 emit）。 */
function sameIds(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const selectionStore = {
  /** 返回当前快照（引用仅在真正变化时更换）。 */
  getSnapshot: (): SelectionState => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  /** 设置选中集合（支持函数式更新，与原 setState 用法一一对应）。 */
  setIds(next: string[] | ((prev: string[]) => string[])): void {
    const ids = typeof next === 'function' ? next(state.ids) : next;
    if (sameIds(ids, state.ids)) return;
    state = { ids, focus: state.focus };
    emit();
  },

  /** 设置单选焦点（支持函数式更新）。 */
  setFocus(next: string | null | ((prev: string | null) => string | null)): void {
    const focus = typeof next === 'function' ? next(state.focus) : next;
    if (focus === state.focus) return;
    state = { ids: state.ids, focus };
    emit();
  },

  /**
   * 清空选中（集合 + 焦点）。
   *
   * 取代原先散落在各处的「先 `setFocus(null)` 再 `setIds([])`」双写 —— 那种写法
   * 每加一个清空点就多一次漏写风险，且两次 emit 会让订阅方多渲染一轮。
   */
  clear(): void {
    if (state.ids.length === 0 && state.focus === null) return;
    state = INITIAL;
    emit();
  },
};

/** 订阅选中态（仅订阅方组件重渲染）。 */
export function useSelection(): SelectionState {
  return useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
}
