/**
 * 帧率上限门控（供各 rAF 渲染循环使用）。
 *
 * 目标：把「每秒真正渲染/绘制的帧数」限制到 maxFps，用于高刷屏（90/120/144Hz）
 * 与省电场景。被跳过的那一帧**完全不进入绘制**（不执行 render()/tick()），
 * 因此省下的是真正的 CPU/GPU 工作 —— 实测手机上降低刷新率功耗明显下降。
 *
 * 实现要点（为什么不用 setTimeout 延迟调度，也不用「与上一帧实际时间比较」）：
 *  - setTimeout 会拆断 rAF 链，恢复延迟不可控、易抖动；
 *  - 「距上一帧实际时间不足 interval 就跳过」在 90/144Hz 这类**非整数倍**刷新率上
 *    会系统性偏慢（例如 144Hz 想跑 60fps 会掉到 48fps，90Hz 会掉到 45fps）。
 *    这里改用**相位累加器**：维护一个理想的“下一次允许渲染时刻”，以固定步长
 *    即 `1000/maxFps` 推进 —— 平均帧率精确等于 maxFps，且与显示器刷新率解耦
 *    （120/144/165Hz 都稳定落在目标帧率）。长时间停摆后也不会连发多帧。
 *
 * 用法（在 rAF 回调里取到 now 之后立即判断，跳过时仍要继续排下一帧）：
 *   if (!gate(performance.now(), maxFps)) { raf = requestAnimationFrame(loop); return; }
 *
 * `maxFps <= 0` 或非有限值 = 不限帧（永远放行）。
 *
 * 补充（相对朴素相位累加器的一处改进）：门控会顺带估计**显示器自身的帧周期**
 * （EWMA），当「上限不低于实际刷新率」时直接放行。否则 60 上限 + 60Hz 屏时，
 * 理想步长 16.67ms 与真实 tick 的取整差异会让约 1/10 的帧落进 0.5ms 保护带而
 * 被误跳过 —— 实测只有 ~54fps（而非 60）。门控只应“降低”帧率，不应“削”帧率。
 * 与 Lite 版 `src/lite/components/09-engine.js` 的 frameGateAllows 保持一致。
 */
export interface FrameGate {
  /** 返回 true 表示本帧应渲染；false 表示跳过这一帧。 */
  (now: number, maxFps: number): boolean;
}

export function createFrameGate(): FrameGate {
  let interval = -1; // -1 = 未初始化
  let next = 0;
  let lastTick = 0;
  let tickMs = 0; // 显示器帧周期估计（EWMA，ms）
  return (now: number, maxFps: number): boolean => {
    // 估计显示器帧周期。>100ms 的空档（后台标签页、长任务）忽略，否则会把
    // 估计值拉偏、进而让下面的放行判断失效。
    if (lastTick > 0) {
      const d = now - lastTick;
      if (d > 0 && d < 100) tickMs = tickMs ? tickMs * 0.9 + d * 0.1 : d;
    }
    lastTick = now;

    const iv = Number.isFinite(maxFps) && maxFps > 0 ? 1000 / maxFps : 0;
    // 不限帧；或上限不低于实际刷新率 → 无需节流，直接放行。
    if (iv === 0 || (tickMs > 0 && iv <= tickMs * 1.05)) {
      interval = 0;
      return true;
    }
    if (iv !== interval) {
      // 首次进入节流 / 上限变化：重置相位，本帧放行、下一帧起按新上限节流。
      interval = iv;
      next = now + iv;
      return true;
    }
    if (now < next - 0.5) return false;
    // 以固定步长推进到“未来”，保证平均帧率恒定、也不在停顿后连发。
    do {
      next += iv;
    } while (next <= now);
    return true;
  };
}
