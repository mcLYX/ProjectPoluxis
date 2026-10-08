import type { StoryboardPointerBridge, StoryboardRawPointer } from '../types/storyboard';

/**
 * 指针桥工厂（§3.7 v3）。
 *
 * 桥是**3D 渲染器**与**故事板宿主**之间唯一的双向通道，刻意做成一个普通可变对象
 * 而不是事件/订阅：
 * - 游戏 → 故事板：每帧只读的指针集合与投影函数（挂上 refs，无需每帧回调）；
 * - 故事板 → 游戏：`blockedIds`（宿主每帧重写，游戏判定侧**同步**查询，故
 *   "碰到即拦"零延迟）与 `releaseBindings`（立即脱手命令）。
 *
 * 身份必须稳定（App 用 useState 惰性创建一次），否则每次重渲染都会让两端拿到
 * 不同的桥，故事板快照会莫名变空。
 */
export function createPointerBridge(): StoryboardPointerBridge {
  const empty: ReadonlyMap<number, StoryboardRawPointer> = new Map();
  return {
    pointers: empty,
    project: null,
    blockedIds: new Set<number>(),
    releaseBindings: () => undefined,
  };
}
