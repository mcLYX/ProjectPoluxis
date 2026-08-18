import { useEffect, type MutableRefObject } from 'react';

/**
 * 批量同步 prop → ref 镜像。R4-3：把 GameCanvas 中数十个
 * `useEffect(() => { xRef.current = x; }, [x])` 纯镜像合并为单个 effect，
 * 降低样板与重渲染噪音。带副作用的镜像（如 skinTextures/defaultSkin 变更时
 * dispose 并重建网格）不在此合并，保留独立 effect。
 *
 * @param props 需镜像到 ref 的 prop 集合（key 为逻辑名）。
 * @param refs  与 props 同 key 的 MutableRefObject 集合。
 */
export function usePropRefs<P extends Record<string, unknown>>(
  props: P,
  refs: { [K in keyof P]: MutableRefObject<P[K]> },
): void {
  const keys = Object.keys(props) as Array<keyof P>;
  // 依赖项为各 prop 的当前值；任一变化即同步对应 ref。
  const values = keys.map((k) => props[k]);
  useEffect(() => {
    for (const k of keys) {
      refs[k].current = props[k];
    }
    // 同步逻辑仅依赖各 prop 值，禁用 exhaustive-deps 以免把 props/refs 字面量纳入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, values);
}
