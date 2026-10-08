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
  buildSpeedPrefix,
  extractSpeedPoints,
  getScrollDistance,
  prefixDistanceAt,
  resolveChart,
  resolveEvents,
  type SpeedPoint,
  type SpeedPrefix,
} from './beatTime';
import {
  buildLayerTree,
  layerSpeedMul,
  layerHasOwnSpeed,
  layerSpeedTimeline,
  layerMinRelSpeed,
  noteLayerIdx,
} from './layers';

/**
 * 单个图层的**滚动距离时间轴**。
 *
 * 流速通道是 Π 相乘：`speed_layer(t) = base(t) × Π(链上各层自身 speed(t)) × Π(speedMul)`。
 * 于是 `S_layer(t) = ∫ speed_layer` —— 各层必须**各自积分**，不能共用一条全局曲线。
 *
 * `base(t)` **只有默认根图层**才有（= 顶层 `chart.events` 的 speed_change，默认根私有，
 * 其它图层不继承）；显式图层的基底恒为常数 1（即距离 = t）。
 *
 * 两种形态（数学等价，后者省掉一条时间轴）：
 *  - `points === null`：`S_layer = mul × (globalBase ? S_global(t) : t)`；
 *  - `points !== null`：`getScrollDistance(t, points)`（base 与常数倍率已并入 points）。
 */
export interface LayerDist {
  /** 静态连乘倍率（无自身变速事件时的缩放系数）。 */
  mul: number;
  /** 是否以**顶层 events** 为基底。仅默认根图层（下标 0）为 true。 */
  globalBase: boolean;
  /** 合并后的变速时间轴；null = 纯静态倍率。 */
  points: SpeedPoint[] | null;
  /** 由 `points` 建立的前缀表（仅当 points 可用且排序正常时非空）。 */
  prefix: SpeedPrefix | null;
}

export interface ChartRuntime {
  /** 解析后的音符（按 timeSec 升序）。 */
  notes: ResolvedNote[];
  events: ReturnType<typeof resolveEvents>;
  speedPoints: SpeedPoint[];
  prefix: SpeedPrefix;
  /** 每个图层节点的滚动距离时间轴（下标与图层树 nodes 对齐；下标 0 = 默认根图层）。 */
  layerDist: LayerDist[];
  /** 每帧各图层「当前时刻」的滚动距离（原地更新，热路径零分配）。
   *  由 `updateLayerCurDist` 填充，长度 = layerDist.length。 */
  layerCurDist: Float64Array;
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
  /** 所有图层流速倍率的最小值（≤1）。渲染距离窗按 `1/minLayerSpeed` 扩宽，
   *  否则慢速图层的可见音符会落在窗外。无图层时恒为 1（窗口不变）。 */
  minLayerSpeed: number;
  /**
   * 按 `note.scrollDist` 升序的音符下标（长度与 `notes` 相同）。
   *
   * 负流速下 `S(t)` 非单调，可见集合在 timeSec 空间不再连续，无法用时间二分；
   * 但可见性本质是 `S(noteTime) - S(curTime)` 落在深度带内 —— 即**在滚动距离
   * 空间上连续**。故按 `scrollDist` 建一份索引，使窗口可对任意符号流速二分求得。
   */
  notesByDist: Int32Array;
  /**
   * 各 slide 的 `|S(子节点) - S(头)|` 最大值。用于把「距离窗口」外扩，
   * 保证「头在窗外、子节点在窗内」的 slide 仍被访问（与时间窗口用
   * `maxSlideSpan` 外扩同理，只是换到滚动距离空间）。
   */
  maxSlideScrollSpan: number;
}

/**
 * 求时刻 `timeSec` 的累计滚动距离。
 *
 * 与 `getScrollDistance(timeSec, rt.speedPoints)` 等价；排序谱面下走二分 + O(1)
 * 插值，避免每帧对 speedPoints 做线性扫描。
 */
export function scrollDistanceAt(rt: ChartRuntime, timeSec: number): number {
  return prefixDistanceAt(rt.prefix, timeSec, rt.speedPoints);
}

/**
 * 时刻 `timeSec` 的**瞬时**变速倍率 = 最后一个 `timeSec <= t` 的变速点的 `speed`（无则 1）。
 *
 * 与调用方原先每帧的线性扫描完全等价：
 *   `for (const p of speedPoints) { if (p.timeSec <= t) s = p.speed; else break; }`
 * 升序谱面且 `t >= 0` 时走二分 O(log N)（变速点常达数百，SV 谱面收益显著）；
 * 退化情况（非升序 / 负 t）回退线性扫描，保证与旧行为逐位一致。
 */
export function speedAt(rt: ChartRuntime, timeSec: number): number {
  const sp = rt.speedPoints;
  if (rt.prefix.sorted && timeSec >= 0) {
    // 首个 timeSec > t 的下标（严格小于等于才计入，与原扫描的 `else break` 一致）。
    let lo = 0;
    let hi = sp.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sp[mid].timeSec <= timeSec) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? 1 : sp[lo - 1].speed;
  }
  let s = 1;
  for (let i = 0; i < sp.length; i++) {
    if (sp[i].timeSec <= timeSec) s = sp[i].speed;
    else break;
  }
  return s;
}

/** 构建谱面运行时数据（一次性，成本随谱面规模线性增长）。 */
export function buildChartRuntime(chart: ChartData): ChartRuntime {
  const notes = resolveChart(chart);
  const events = resolveEvents(chart);
  // 传已解析的 events，避免 extractSpeedPoints 内部再解析一遍全谱事件。
  const speedPoints = extractSpeedPoints(events);
  const prefix = buildSpeedPrefix(speedPoints);

  /* —— 图层滚动距离时间轴 ——
   * 流速是 Π 相乘：speed_layer(t) = base(t) × Π(链上各层自身 speed(t)) × Π(speedMul)。
   * 因此每个图层要有自己的 `S_layer(t) = ∫ speed_layer`；只有「链上各层都没有自身
   * 变速事件」时才能退化为 `mul × base距离`（常数倍率，数学等价且更省）。
   * base **只有默认根图层**有（顶层 events 是它私有的），显式图层基底恒为 1。
   * 判定时刻恒为 t = timeSec（此时 S_layer(t) − S_layer(t) = 0），不受流速影响。 */
  const layerTree = buildLayerTree(chart);
  const layerDist: LayerDist[] = [];
  let minLayerSpeed = 1;
  for (let li = 0; li < layerTree.nodes.length; li++) {
    const mul = layerSpeedMul(layerTree, li);
    const globalBase = li === 0;
    // 默认根图层恒走 base 路径（无自身轴），避免重复计入顶层 events。
    if (li !== 0 && layerHasOwnSpeed(layerTree, li)) {
      const points = layerSpeedTimeline(layerTree, li, speedPoints);
      layerDist.push({ mul, globalBase, points, prefix: buildSpeedPrefix(points) });
    } else {
      layerDist.push({ mul, globalBase, points: null, prefix: null });
    }
    const rel = layerMinRelSpeed(layerTree, li);
    if (rel > 0 && rel < minLayerSpeed) minLayerSpeed = rel;
  }

  /** 图层 li 在时刻 t 的滚动距离。 */
  const distAt = (li: number, t: number): number => {
    const ld = layerDist[li];
    if (!ld) return getScrollDistance(t, speedPoints);
    if (ld.prefix) return prefixDistanceAt(ld.prefix, t, ld.points as SpeedPoint[]);
    const base = ld.globalBase ? getScrollDistance(t, speedPoints) : t;
    return ld.mul === 1 ? base : ld.mul * base;
  };

  let hasNegativeSpeed = false;
  let minSpeed = 1;
  for (let i = 0; i < speedPoints.length; i++) {
    const s = speedPoints[i].speed;
    if (s < 0) hasNegativeSpeed = true;
    if (s < minSpeed) minSpeed = s;
  }

  // 预计算滚动距离：音符与 slide 子节点的 timeSec 在一局内恒定，结果直接写回对象，
  // 运行期从「每帧 O(变速点数) 线性扫描」降为「一次属性读取」。
  // scrollDist = **所属图层**时间轴下的距离（已含图层流速积分）；
  // globalDist = 全局时间轴下的距离，只用于负流速时的距离窗排序。
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const li = noteLayerIdx(layerTree, n);
    n.layerIdx = li;
    n.globalDist = getScrollDistance(n.timeSec, speedPoints);
    n.scrollDist = distAt(li, n.timeSec);
    n.layerSpeedMul = undefined;
    const children = n.resolvedNodes;
    if (children) {
      for (let j = 0; j < children.length; j++) {
        // slide 子节点不带 layerId，沿用头节点的图层。
        children[j].globalDist = getScrollDistance(children[j].timeSec, speedPoints);
        children[j].scrollDist = distAt(li, children[j].timeSec);
        children[j].layerSpeedMul = undefined;
      }
    }
  }

  // 按滚动距离排序的音符索引 + slide 滚动距离跨度（供负流速下的距离窗口使用）。
  // 各图层距离尺度不同，排序统一走 globalDist（窗口另按 minLayerSpeed 扩宽）。
  const distCount = notes.length;
  const notesByDist = new Int32Array(distCount);
  for (let i = 0; i < distCount; i++) notesByDist[i] = i;
  notesByDist.sort((a, b) => (notes[a].globalDist ?? 0) - (notes[b].globalDist ?? 0));
  let maxSlideScrollSpan = 0;
  for (let i = 0; i < distCount; i++) {
    const n = notes[i];
    const children = n.resolvedNodes;
    if (!children) continue;
    const headDist = n.scrollDist ?? 0;
    for (let j = 0; j < children.length; j++) {
      const d = Math.abs((children[j].scrollDist ?? 0) - headDist);
      if (d > maxSlideScrollSpan) maxSlideScrollSpan = d;
    }
  }

  // 与 GameCanvas.resetPlayState 的预计算逐行同构。
  let totalNotes = 0;
  let lastNoteTime = 0;
  let maxSlideSpan = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    // 假音符 / 不计分音符不计入 totalNotes（与 countPlayableNotes 同口径）；
    // lastNoteTime / maxSlideSpan 仍统计，保证歌曲结束时间与 slide 窗口语义不变。
    const counted = !(n.fake || n.noScore);
    if (counted) totalNotes++; // 头节点计一个
    if (n.type === 'slide') {
      const children = n.resolvedNodes;
      if (children) {
        if (counted) totalNotes += children.length;
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
    layerDist,
    layerCurDist: new Float64Array(layerDist.length),
    hasNegativeSpeed,
    minSpeed,
    totalNotes,
    lastNoteTime,
    maxSlideSpan,
    minLayerSpeed,
    notesByDist,
    maxSlideScrollSpan,
  };
}

/**
 * 在「滚动距离序」上求音符窗口，返回 `notesByDist` 上的连续区间 `[first, last)`。
 *
 * `lo` / `hi` 是相对 `curScrollDist` 的滚动距离偏移（上下界），由调用方按渲染
 * 深度带换算。含负流速时调用方应额外用 `rt.maxSlideScrollSpan` 外扩，以覆盖
 * 「slide 头在窗外、子节点在窗内」的情形。
 *
 * 语义与时间窗口互补：时间窗口保证判定（时间语义）不丢，本窗口保证渲染
 * （深度/滚动距离语义）不丢，二者对负流速谱面取并集使用。
 */
export function scrollDistWindow(
  rt: ChartRuntime,
  curScrollDist: number,
  lo: number,
  hi: number
): { first: number; last: number } {
  const order = rt.notesByDist;
  const notes = rt.notes;
  const dLo = curScrollDist + lo;
  const dHi = curScrollDist + hi;
  // 排序键是 **globalDist**（各图层距离尺度不同，只有全局轴是可比的单调序）。
  const keyOf = (i: number): number => notes[i].globalDist ?? notes[i].scrollDist ?? 0;
  let a = 0;
  let b = order.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (keyOf(order[mid]) < dLo) a = mid + 1;
    else b = mid;
  }
  const first = a;
  b = order.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (keyOf(order[mid]) <= dHi) a = mid + 1;
    else b = mid;
  }
  return { first, last: a };
}

/**
 * 每帧更新各图层「当前时刻」的滚动距离（原地写入 `rt.layerCurDist`，零分配）。
 *
 * 图层数很少（通常 1~4），每帧开销 O(图层数 · log n)，可忽略；无图层 / 各层均
 * 无自身变速事件时只有下标 0 参与，结果与旧的单条全局曲线逐位一致。
 */
export function updateLayerCurDist(rt: ChartRuntime, curTime: number): Float64Array {
  const out = rt.layerCurDist;
  const lds = rt.layerDist;
  const globalNow = prefixDistanceAt(rt.prefix, curTime, rt.speedPoints);
  for (let i = 0; i < lds.length && i < out.length; i++) {
    const ld = lds[i];
    if (ld.prefix) out[i] = prefixDistanceAt(ld.prefix, curTime, ld.points as SpeedPoint[]);
    else {
      // 只有默认根图层以顶层 events 为基底；其余图层基底 = 常数 1（距离 = t）。
      const base = ld.globalBase ? globalNow : curTime;
      out[i] = ld.mul === 1 ? base : ld.mul * base;
    }
  }
  return out;
}

/** 图层 li 在时刻 t 的滚动距离（slide 管道采样等「任意时刻」场景用）。 */
export function layerDistAt(rt: ChartRuntime, li: number, timeSec: number): number {
  const ld = rt.layerDist[li];
  if (!ld) return prefixDistanceAt(rt.prefix, timeSec, rt.speedPoints);
  if (ld.prefix) return prefixDistanceAt(ld.prefix, timeSec, ld.points as SpeedPoint[]);
  const base = ld.globalBase ? prefixDistanceAt(rt.prefix, timeSec, rt.speedPoints) : timeSec;
  return ld.mul === 1 ? base : ld.mul * base;
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
