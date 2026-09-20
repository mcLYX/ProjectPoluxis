/**
 * 谱面运行时预处理层（CPU 优化）。
 *
 * ## 为什么需要它
 *
 * 两条渲染路径（3D `GameCanvas` / 2D `GameCanvas2D`）原本都**每帧对每个可见音符**
 * 调用一次 `getScrollDistance(note.timeSec, speedPoints)`。该函数对 speedPoints 做
 * 线性扫描，于是每帧开销为 **O(可见音符数 × 变速点数)**；而 `note.timeSec` 在一局内
 * 恒定，结果完全可以只算一次。同理，窗口计算每帧还要再全扫两遍 speedPoints 去求
 * `hasNegativeSpeed` / `minSpeed`。
 *
 * 本模块在谱面进入时一次性完成：
 *  - 解析谱面（notes / events / speedPoints），与 `GameCanvas` 现有 `useMemo` 同构；
 *  - 预计算每个音符与 slide 子节点的滚动距离，写回 `scrollDist`（运行期查表）；
 *  - 为 speedPoints 建立前缀和，使「任意时刻 t 的滚动距离」可 O(log N) 求得；
 *  - 预计算 `hasNegativeSpeed` / `minSpeed` / `totalNotes` / `lastNoteTime` /
 *    `maxSlideSpan`，消除每帧重复扫描。
 *
 * ## 判定等价性（硬红线）
 *
 * 优化只能削减「重复计算」，不能改变任何数值语义：
 *  - `scrollDist` 直接用**原** `getScrollDistance` 计算，逐位一致；
 *  - 前缀和版本**仅在 speedPoints 已按 timeSec 升序、且无退化数据时启用**，
 *    否则回退原函数 —— 原函数按数组顺序迭代，未排序谱面下两者语义不同，不能互换；
 *  - `totalNotes` / `lastNoteTime` / `maxSlideSpan` 的计算与 `GameCanvas.resetPlayState`
 *    逐行同构。
 *
 * ## 缓存策略
 *
 * `WeakMap<ChartData, ChartRuntime>`：纯内存、随谱面对象一起被 GC；
 * 同一谱面重复进入（重试）零成本；**不做任何持久化**。谱面对象变化（切歌 / 编辑器
 * 改动生成新对象）自然失效。
 */
import type { ChartData, ResolvedNote } from '../types/game';
import {
  extractSpeedPoints,
  getScrollDistance,
  resolveChart,
  resolveEvents,
  type SpeedPoint,
} from './beatTime';

/** 变速点前缀表：用于 O(log N) 求任意时刻的滚动距离。 */
export interface SpeedPrefix {
  /**
   * 是否可用二分 + 前缀和。false 时 `scrollDistanceAt` 回退到原
   * `getScrollDistance`（保证与旧行为逐位一致）。
   */
  sorted: boolean;
  /** timeSec > 0 的变速点时刻（升序）。长度 m。 */
  times: Float64Array;
  /** 累计滚动距离，长度 m+1：`cum[k]` = 走完前 k 段的距离。 */
  cum: Float64Array;
  /** 分段速度，长度 m+1：`segSpeed[k]` = 第 k 段（times[k-1] → times[k]）所用速度。 */
  segSpeed: Float64Array;
}

export interface ChartRuntime {
  /** 解析后的音符（按 timeSec 升序）。 */
  notes: ResolvedNote[];
  events: ReturnType<typeof resolveEvents>;
  speedPoints: SpeedPoint[];
  prefix: SpeedPrefix;
  /** 谱面是否含负速度事件（原窗口逻辑据此退化为全谱遍历）。 */
  hasNegativeSpeed: boolean;
  /** min(1, 所有变速点速度)。 */
  minSpeed: number;
  /** 可判定音符总数（头 + slide 子节点）。 */
  totalNotes: number;
  /** 最后一个音符（含 slide 子节点）的时间。 */
  lastNoteTime: number;
  /** 最长 slide 的首尾时间跨度。 */
  maxSlideSpan: number;
}

/**
 * 依据 speedPoints 建立前缀表。
 *
 * 复刻 `getScrollDistance` 的语义：
 *  - `timeSec <= 0` 的点只设定「起始速度」（取最后一个），不产生距离；
 *  - 其余点按数组顺序推进：区间 [上一点, 本点) 用**进入该点之前**的速度。
 */
function buildSpeedPrefix(sp: SpeedPoint[]): SpeedPrefix {
  const times: number[] = [];
  const pointSpeeds: number[] = [];
  let speed0 = 1;
  let sorted = true;
  let seenPositive = false;
  let prevT = -Infinity;

  for (let i = 0; i < sp.length; i++) {
    const p = sp[i];
    if (p.timeSec <= 0) {
      // 原始实现里这类点只改速度；若出现在正时间点之后，前缀模型不再等价 → 回退。
      if (seenPositive) sorted = false;
      speed0 = p.speed;
      continue;
    }
    if (!Number.isFinite(p.timeSec)) {
      sorted = false;
      continue;
    }
    if (p.timeSec < prevT) sorted = false;
    prevT = p.timeSec;
    seenPositive = true;
    times.push(p.timeSec);
    pointSpeeds.push(p.speed);
  }

  const m = times.length;
  const cum = new Float64Array(m + 1);
  const segSpeed = new Float64Array(m + 1);
  segSpeed[0] = speed0;
  for (let k = 0; k < m; k++) {
    segSpeed[k + 1] = pointSpeeds[k];
    const baseT = k > 0 ? times[k - 1] : 0;
    cum[k + 1] = cum[k] + (times[k] - baseT) * segSpeed[k];
  }

  return { sorted, times: Float64Array.from(times), cum, segSpeed };
}

/**
 * 求时刻 `timeSec` 的累计滚动距离。
 *
 * 与 `getScrollDistance(timeSec, rt.speedPoints)` 等价；排序谱面下走二分 + O(1)
 * 插值，避免每帧对 speedPoints 做线性扫描。
 */
export function scrollDistanceAt(rt: ChartRuntime, timeSec: number): number {
  const prefix = rt.prefix;
  if (!prefix.sorted) return getScrollDistance(timeSec, rt.speedPoints);
  const times = prefix.times;
  const m = times.length;
  // lower_bound：第一个 >= timeSec 的下标（严格小于才计入，与原函数的 `>=` break 一致）。
  let lo = 0;
  let hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < timeSec) lo = mid + 1;
    else hi = mid;
  }
  const baseT = lo > 0 ? times[lo - 1] : 0;
  return prefix.cum[lo] + (timeSec - baseT) * prefix.segSpeed[lo];
}

/** 构建谱面运行时数据（一次性，成本随谱面规模线性增长）。 */
export function buildChartRuntime(chart: ChartData): ChartRuntime {
  const notes = resolveChart(chart);
  const events = resolveEvents(chart);
  // 传已解析的 events，避免 extractSpeedPoints 内部再解析一遍全谱事件。
  const speedPoints = extractSpeedPoints(events);
  const prefix = buildSpeedPrefix(speedPoints);

  let hasNegativeSpeed = false;
  let minSpeed = 1;
  for (let i = 0; i < speedPoints.length; i++) {
    const s = speedPoints[i].speed;
    if (s < 0) hasNegativeSpeed = true;
    if (s < minSpeed) minSpeed = s;
  }

  // 预计算滚动距离：音符与 slide 子节点的 timeSec 在一局内恒定，结果直接写回对象，
  // 运行期从「每帧 O(变速点数) 线性扫描」降为「一次属性读取」。
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    n.scrollDist = getScrollDistance(n.timeSec, speedPoints);
    const children = n.resolvedNodes;
    if (children) {
      for (let j = 0; j < children.length; j++) {
        children[j].scrollDist = getScrollDistance(children[j].timeSec, speedPoints);
      }
    }
  }

  // 与 GameCanvas.resetPlayState 的预计算逐行同构。
  let totalNotes = 0;
  let lastNoteTime = 0;
  let maxSlideSpan = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    totalNotes++; // 头节点计一个
    if (n.type === 'slide') {
      const children = n.resolvedNodes;
      if (children) {
        totalNotes += children.length;
        let lastChildT = n.timeSec;
        for (let j = 0; j < children.length; j++) {
          const t = children[j].timeSec;
          if (t > lastChildT) lastChildT = t;
          if (t > lastNoteTime) lastNoteTime = t;
        }
        const span = lastChildT - n.timeSec;
        if (span > maxSlideSpan) maxSlideSpan = span;
      }
    }
    if (n.timeSec > lastNoteTime) lastNoteTime = n.timeSec;
  }

  return {
    notes,
    events,
    speedPoints,
    prefix,
    hasNegativeSpeed,
    minSpeed,
    totalNotes,
    lastNoteTime,
    maxSlideSpan,
  };
}

/**
 * 谱面运行时缓存：以谱面对象为键的 WeakMap。
 *  - 同一谱面重复进入（重试）直接命中，零重算；
 *  - 谱面对象被替换（切歌 / 编辑器改动）即自然失效；
 *  - 纯内存，随谱面对象回收，不做持久化。
 */
const runtimeCache = new WeakMap<ChartData, ChartRuntime>();

/** 获取（必要时构建）谱面运行时数据。 */
export function getChartRuntime(chart: ChartData): ChartRuntime {
  const hit = runtimeCache.get(chart);
  if (hit) return hit;
  const built = buildChartRuntime(chart);
  runtimeCache.set(chart, built);
  return built;
}
