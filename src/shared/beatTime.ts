/**
 * Single source of truth for *chart resolution* (beat→seconds, slide/node
 * expansion, scroll distance, events, duration helpers). Shared by the full
 * app (src/utils/beatTime.ts re-exports this and adapts `angle` to radians)
 * and the Lite ES5 build (inlined verbatim by scripts/build-lite.mjs).
 *
 * Rules (same as chartSchema.ts):
 *  - ES5-clean: `var` / `function` / `forEach` only — no `const`/`let`/`for-of`
 *    / arrow / object-spread. esbuild's *transform* (used by the Lite build)
 *    cannot down-level those to ES5, so they are banned here on purpose.
 *  - `import type` only — erased on inline, so the Lite build has zero runtime
 *    imports. Do NOT add runtime `import`s here.
 *  - `angle` is stored in **DEGREES** (the raw JSON unit). The full app's
 *    src/utils/beatTime.ts wrapper converts it to radians at the render
 *    boundary; the Lite build consumes degrees directly.
 */

import type { ChartData, BpmPoint, EasingType, ResolvedNote, ResolvedEvent } from '../types/game';

/** A point where scroll speed changes, in absolute seconds + speed multiplier */
export interface SpeedPoint {
  timeSec: number;
  speed: number;
}

/**
 * 一条变速斜坡被离散成多少段（中点采样）。
 *
 * 斜坡（duration > 0）在**模型层**仍是分段常数：原因有二 ——
 *  1. 下游的「图层流速 Π 相乘」要把多条时间轴的断点取并集后逐段相乘，
 *     而**两条斜坡相乘是二次曲线**，无法用「分段缓动」表示，精确闭合解在合并后必然失真；
 *  2. 分段常数可以完整复用既有 Machinery（前缀和 O(log N)、Lite 的 getScrollDistance）。
 * 中点采样使积分误差为 O(1/K²)，K=24 时对 2 秒斜坡的误差远小于 1 毫秒的距离。
 */
export var SPEED_RAMP_STEPS = 24;

/** 判断是否为有限数字（本文件内的小工具，避免依赖外部）。 */
function spIsNum(v: any): boolean {
  return typeof v === 'number' && isFinite(v);
}

/**
 * 把一条变速斜坡离散成若干分段常数点（中点采样）。
 * 不传 `ease` 时退化为一次瞬时跳变（旧行为）。
 */
function pushSpeedRamp(
  points: SpeedPoint[],
  t0: number,
  from: number,
  to: number,
  duration: number,
  easing: string,
  ease: (name: string, t: number) => number
): void {
  if (!(duration > 0)) {
    points.push({ timeSec: t0, speed: to });
    return;
  }
  // 标准中点法则：第 s 段（[t0+s·dt, t0+(s+1)·dt)）取该段中点的速度。
  // ⚠️ 采样时刻必须是 t0 + dt*s（段起点），不能是 t0 + dt*(s+0.5)——后者会让
  // 首尾各多出半步用「旧速度/末段速度」积分，产生 dt/2·(from−to) 的系统性误差。
  var dt = duration / SPEED_RAMP_STEPS;
  for (var s = 0; s < SPEED_RAMP_STEPS; s++) {
    var p = (s + 0.5) / SPEED_RAMP_STEPS;
    points.push({ timeSec: t0 + dt * s, speed: from + (to - from) * ease(easing, p) });
  }
  // 收尾点：斜坡结束后精确落在目标速度（否则会永远差半个采样步）。
  points.push({ timeSec: t0 + duration, speed: to });
}

/**
 * Pre-compute scroll speed change points from chart events.
 * Returns speed points sorted by time, with an implicit initial speed of 1 at t=0.
 *
 * 时间过渡（`duration > 0`）：速度在 `duration` 秒内从 `speedFrom`（缺省＝过渡开始时
 * 的当前速度）缓动到 `speed`。斜坡在这里就被离散成分段常数，下游无需感知。
 *
 * `ease` 由调用方注入（本文件禁止运行时 import，见文件头）：
 *  - full app：`src/utils/beatTime.ts` 的包装器注入 EASING_FNS；
 *  - Lite：`09-engine.js` 注入同作用域的 EASING_FNS。
 * 不传时所有变速均为瞬时（旧行为，逐位兼容）。
 */
export function extractSpeedPoints(
  input: ChartData | ResolvedEvent[],
  ease?: (name: string, t: number) => number
): SpeedPoint[] {
  // Accept either a raw ChartData (re-resolve its events) or an already-resolved
  // event array — the Lite engine passes `game.events` (resolved), the full app
  // passes the chart. Keeping both call sites working avoids a signature split.
  var src: ResolvedEvent[] = Array.isArray(input) ? input : resolveEvents(input);
  // 时间顺序处理：斜坡的起点依赖「过渡开始时的当前速度」。
  var events: ResolvedEvent[] = [];
  for (var k = 0; k < src.length; k++) events.push(src[k]);
  events.sort(function (a, b) { return a.timeSec - b.timeSec; });

  var points: SpeedPoint[] = [];
  var cur = 1;
  for (var i = 0; i < events.length; i++) {
    var e: any = events[i];
    if (e.eventType !== 'speed_change' || e.speed == null) continue;
    var t0 = spIsNum(e.timeSec) ? e.timeSec : 0;
    var to = e.speed;
    var dur = spIsNum(e.duration) && e.duration > 0 ? e.duration : 0;
    var from = spIsNum(e.speedFrom) ? e.speedFrom : cur;
    if (dur > 0 && ease) {
      pushSpeedRamp(
        points, t0, from, to, dur,
        typeof e.easing === 'string' ? e.easing : 'linear',
        ease
      );
    } else {
      points.push({ timeSec: t0, speed: to });
    }
    cur = to;
  }
  points.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return points;
}

/**
 * Get the cumulative scroll distance from t=0 up to t=timeSec.
 * Integral of scroll speed over time (speed changes defined by speedPoints).
 * Distance unit: "1x-seconds" (at 1x speed, 1s = 1 unit of distance).
 */
export function getScrollDistance(timeSec: number, speedPoints: SpeedPoint[]): number {
  if (!speedPoints || speedPoints.length === 0) return timeSec;
  var dist = 0;
  var currentTime = 0;
  var currentSpeed = 1;
  for (var i = 0; i < speedPoints.length; i++) {
    var p = speedPoints[i];
    if (p.timeSec <= 0) { currentSpeed = p.speed; continue; }
    if (p.timeSec >= timeSec) break;
    dist += (p.timeSec - currentTime) * currentSpeed;
    currentTime = p.timeSec;
    currentSpeed = p.speed;
  }
  dist += (timeSec - currentTime) * currentSpeed;
  return dist;
}

/** 变速点前缀表：用于 O(log N) 求任意时刻的累计滚动距离。 */
export interface SpeedPrefix {
  /**
   * 是否可用二分 + 前缀和。false 时调用方回退 `getScrollDistance`
   * （非升序 / 含非法时刻的退化谱面 → 保证与旧行为逐位一致）。
   */
  sorted: boolean;
  /** timeSec > 0 的变速点时刻（升序）。长度 m。 */
  times: number[];
  /** 累计滚动距离，长度 m+1：`cum[k]` = 走完前 k 段的距离。 */
  cum: number[];
  /** 分段速度，长度 m+1：`segSpeed[k]` = 第 k 段（times[k-1] → times[k]）所用速度。 */
  segSpeed: number[];
}

/**
 * 依据 `speedPoints` 建立前缀表（复刻 `getScrollDistance` 的语义）：
 *  - `timeSec <= 0` 的点只设定「起始速度」（取最后一个），不产生距离；
 *  - 其余点按数组顺序推进：区间 [上一点, 本点) 用**进入该点之前**的速度。
 * 非升序 / 非法时刻 → `sorted = false`（调用方回退线性扫描，逐位一致）。
 *
 * ES5 风格：本文件被 scripts/build-lite.mjs 原样内联进 Lite 的单一 IIFE，
 * 故**不使用任何 ES2015+ 内建**。特别是这里用普通数组而非 `Float64Array` ——
 * **IE9 没有 TypedArray**（IE10 才引入），而 Lite 的目标就是 IE9；前缀表很小，
 * 与 TypedArray 的性能差异可忽略。
 */
export function buildSpeedPrefix(sp: SpeedPoint[]): SpeedPrefix {
  var times: number[] = [];
  var pointSpeeds: number[] = [];
  var speed0 = 1;
  var sorted = true;
  var seenPositive = false;
  var prevT = -Infinity;
  var i: number;
  for (i = 0; i < sp.length; i++) {
    var p = sp[i];
    if (p.timeSec <= 0) {
      // 原始实现里这类点只改速度；若出现在正时间点之后，前缀模型不再等价 → 回退。
      if (seenPositive) sorted = false;
      speed0 = p.speed;
      continue;
    }
    if (!(typeof p.timeSec === 'number' && isFinite(p.timeSec))) {
      sorted = false;
      continue;
    }
    if (p.timeSec < prevT) sorted = false;
    prevT = p.timeSec;
    seenPositive = true;
    times.push(p.timeSec);
    pointSpeeds.push(p.speed);
  }

  var m = times.length;
  var timesArr = times;            // 本地新建、无别名，直接复用（无需拷贝）
  /* ⚠️ cum[0] 必须显式置 0：普通数组不像 TypedArray 那样零初始化，
   * 而 `prefixDistanceAt` 在 lo === 0 时会读 `cum[0]`（否则得到 NaN）。 */
  var cum = [0];
  var segSpeed = [speed0];
  for (var k = 0; k < m; k++) {
    var baseT = k > 0 ? times[k - 1] : 0;
    cum.push(cum[k] + (times[k] - baseT) * segSpeed[k]);
    segSpeed.push(pointSpeeds[k]);
  }
  return { sorted: sorted, times: timesArr, cum: cum, segSpeed: segSpeed };
}

/** 在指定前缀表上求时刻 `timeSec` 的累计滚动距离；前缀不可用时回退 `getScrollDistance`。 */
export function prefixDistanceAt(prefix: SpeedPrefix, timeSec: number, fallbackPoints: SpeedPoint[]): number {
  if (!prefix.sorted) return getScrollDistance(timeSec, fallbackPoints);
  var times = prefix.times;
  var m = times.length;
  // lower_bound：第一个 >= timeSec 的下标（严格小于才计入，与 getScrollDistance 的 `>=` break 一致）。
  var lo = 0;
  var hi = m;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (times[mid] < timeSec) lo = mid + 1;
    else hi = mid;
  }
  var baseT = lo > 0 ? times[lo - 1] : 0;
  return prefix.cum[lo] + (timeSec - baseT) * prefix.segSpeed[lo];
}

/** Convert a beat number to absolute seconds with constant BPM. */
export function beatToSeconds(beat: number, bpm: number, offset: number): number {
  return offset + (beat * 60) / bpm;
}

/** Convert a beat number to absolute seconds, supporting BPM changes via bpmlist. */
export function beatToSecondsMultiBpm(
  beat: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  if (!bpmlist || bpmlist.length === 0) return beatToSeconds(beat, baseBpm, offset);
  var currentBeat = 0;
  var currentBpm = baseBpm;
  var accumulatedTime = 0;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat <= 0) continue;
    if (point.beat >= beat) break;
    accumulatedTime += ((point.beat - currentBeat) * 60) / currentBpm;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }
  accumulatedTime += ((beat - currentBeat) * 60) / currentBpm;
  return offset + accumulatedTime;
}

/** Exact inverse of `beatToSecondsMultiBpm`: absolute seconds -> beat. */
export function secondsToBeatMultiBpm(
  sec: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  var t = sec - offset;
  if (!bpmlist || bpmlist.length === 0) return (t * baseBpm) / 60;
  var currentBeat = 0;
  var currentBpm = baseBpm;
  var accumulatedTime = 0;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat <= 0) continue;
    var segmentSeconds = ((point.beat - currentBeat) * 60) / currentBpm;
    if (accumulatedTime + segmentSeconds > t) {
      return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
    }
    accumulatedTime += segmentSeconds;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }
  return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
}

/** Get the BPM value at a specific beat, considering BPM changes. */
export function getBpmAtBeat(beat: number, baseBpm: number, bpmlist?: BpmPoint[]): number {
  if (!bpmlist || bpmlist.length === 0) return baseBpm;
  var bpm = baseBpm;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat > beat) break;
    bpm = point.bpm;
  }
  return bpm;
}

/** Copy a note's own fields (minus `nodes`) into a fresh plain object — the
 * ES5 equivalent of `{ ...n, nodes: undefined }`. */
function copyNoteFields(n: { [k: string]: any }): { [k: string]: any } {
  var o: { [k: string]: any } = {};
  for (var k in n) {
    if (n.hasOwnProperty(k) && k !== 'nodes') o[k] = n[k];
  }
  return o;
}

/**
 * Resolve all notes in a chart from beat-based to absolute seconds.
 * Slide child nodes are resolved as well.
 *
 * `angle` is stored in DEGREES (raw JSON). Child note ids are 1-based
 * (`${id}#${k+1}`) to match the full app. Output is sorted by `timeSec`
 * (ascending, stable) so render loops can binary-search the visible window.
 */
export function resolveChart(chart: ChartData): ResolvedNote[] {
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  var resolved: ResolvedNote[] = [];

  chart.notes.forEach(function (n) {
    var headAngle = n.angle == null ? 0 : n.angle;
    var headEasing: EasingType = n.easing == null ? 'linear' : n.easing;

    if (n.type === 'slide') {
      var kids: { [k: string]: any }[] = [];
      var src = n.nodes || [];
      for (var k = 0; k < src.length; k++) {
        var sn = src[k];
        kids.push({
          timeSec: beatToSecondsMultiBpm(sn.beat, bpm, offset, bpmlist),
          angle: sn.angle == null ? headAngle : sn.angle,
          easing: sn.easing == null ? headEasing : sn.easing,
          beat: sn.beat,
          x: sn.x,
          y: sn.y,
        });
      }
      var head = copyNoteFields(n);
      head.timeSec = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
      head.angle = headAngle;
      head.easing = headEasing;
      head.resolvedNodes = kids;
      head.nodes = undefined;
      resolved.push(head as ResolvedNote);
      return;
    }

    var head2 = copyNoteFields(n);
    head2.timeSec = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
    head2.angle = headAngle;
    head2.easing = headEasing;
    head2.resolvedNodes = undefined;
    head2.nodes = undefined;
    resolved.push(head2 as ResolvedNote);

    var csrc = n.nodes || [];
    for (var c = 0; c < csrc.length; c++) {
      var cn = csrc[c];
      var child = copyNoteFields(n);
      child.id = n.id + '#' + (c + 1);
      child.beat = cn.beat;
      child.x = cn.x;
      child.y = cn.y;
      child.timeSec = beatToSecondsMultiBpm(cn.beat, bpm, offset, bpmlist);
      child.angle = cn.angle == null ? headAngle : cn.angle;
      child.easing = cn.easing == null ? headEasing : cn.easing;
      child.resolvedNodes = undefined;
      child.nodes = undefined;
      resolved.push(child as ResolvedNote);
    }
  });

  resolved.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return resolved;
}

/** Resolve all events in a chart from beat-based to absolute seconds. */
export function resolveEvents(chart: ChartData): ResolvedEvent[] {
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  if (!chart.events || chart.events.length === 0) {
    if (chart.speedEvents && chart.speedEvents.length > 0) {
      var legacy: ResolvedEvent[] = chart.speedEvents.map(function (se, idx) {
        return {
          id: 'legacy-speed-' + idx,
          type: 'event' as const,
          eventType: 'speed_change' as const,
          beat: se.beat,
          speed: se.speed,
          timeSec: beatToSecondsMultiBpm(se.beat, bpm, offset, bpmlist),
        };
      });
      legacy.sort(function (a, b) { return a.timeSec - b.timeSec; });
      return legacy;
    }
    return [];
  }
  var out: ResolvedEvent[] = [];
  for (var ei = 0; ei < chart.events.length; ei++) {
    var e: any = chart.events[ei];
    var re: { [k: string]: any } = {};
    for (var ek in e) { if (e.hasOwnProperty(ek)) re[ek] = e[ek]; }
    re.timeSec = beatToSecondsMultiBpm(e.beat, bpm, offset, bpmlist);
    out.push(re as ResolvedEvent);
  }
  out.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return out;
}

/** Max beat across all notes, including slide child nodes. */
export function getMaxBeat(chart: ChartData): number {
  var max = 0;
  chart.notes.forEach(function (n) {
    if (n.beat > max) max = n.beat;
    var ns = n.nodes || [];
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].beat > max) max = ns[i].beat;
    }
  });
  return max;
}

/** Earliest note time in seconds (including offset and slide child nodes). */
export function getFirstNoteTime(chart: ChartData): number {
  if (chart.notes.length === 0) return 0;
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  var minBeat = Infinity;
  chart.notes.forEach(function (n) {
    if (n.beat < minBeat) minBeat = n.beat;
    var ns = n.nodes || [];
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].beat < minBeat) minBeat = ns[i].beat;
    }
  });
  return beatToSecondsMultiBpm(minBeat, bpm, offset, bpmlist);
}

/** Total duration (seconds) of a chart: last node time + 1.5s buffer. */
export function getChartDuration(chart: ChartData): number {
  if (chart.notes.length === 0) return 5;
  var meta = chart.metadata;
  return beatToSecondsMultiBpm(getMaxBeat(chart), meta.bpm, meta.offset, meta.bpmlist) + 1.5;
}

/** Count all scoreable notes: tap/touch = 1 each; slide = head + each child (1 each).
 *  假音符（fake）与不计分音符（noScore）不计入 —— 两种音符都不参与计分与数量统计，
 *  slide 子节点继承头节点的语义（解析层已随头节点复制）。 */
export function countPlayableNotes(chart: ChartData): number {
  var total = 0;
  chart.notes.forEach(function (n) {
    if (n.fake || n.noScore) return;
    total += 1 + ((n.nodes ? n.nodes.length : 0));
  });
  return total;
}
