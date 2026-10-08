/**
 * 图层（Layer）模型：树结构与三条通道的合成 / 求值。
 *
 * Single source of truth for layer composition, shared by the full app and the
 * Lite ES5 build (inlined verbatim by scripts/build-lite.mjs — 需在 SHARED_FILES
 * 中登记，否则 Lite 侧拿不到这些符号)。
 *
 * ## 三条通道的合成规则（三者互不相同，不可统一处理）
 *
 * | 通道 | 合成规则 | 缺省 |
 * |---|---|---|
 * | 坐标偏移 offset | **相加**：自身 + Σ 所有祖先 | 0 |
 * | 流速 speed | **相乘**：自身 × Π 所有祖先 | 1 |
 * | 音符色 noteColor | **就近继承**：自身未取则追溯最近祖先，再无则用全局 | 继承 |
 *
 * 背景色**不属于**图层：`bg_change` 写在任意图层都全局生效（仅在谱面检查时对
 * 「写在非根图层」给 warning）。故本模块完全不处理 bg_change。
 *
 * ## 依赖注入（重要）
 *
 * 本文件禁止任何**运行时 import**：它被剥掉 `export` 后内联进 Lite 的单一 IIFE，
 * 而同一份源码在 full app 里又是独立 ES 模块作用域。若在文件内直接引用
 * `EASING_FNS` / `beatToSecondsMultiBpm`，full app 侧会指向未定义的全局而崩溃
 * （Lite 侧因为同 IIFE 恰好可用，属于「侥幸成功」，不能依赖）。
 *
 * 因此 beat→秒 与 easing 一律由调用方通过 `LayerDeps` 注入：
 *  - full app：`src/utils/layers.ts` 注入真实实现；
 *  - Lite：`09-engine.js` 注入同作用域的实现。
 *
 * ## 约定
 *
 * - ES5-clean：`var` / `function` / 下标循环，**无** const/let/箭头/for-of/对象展开
 *   （build-lite.mjs 用的是 esbuild *transform*，无法降级这些语法）。
 * - 只用 `import type`（编译后完全擦除）。
 */

import type { ChartData, LayerData } from '../types/game';

/**
 * 默认根图层的 id。它是「没有 `layers` 字段」的旧谱面所处的唯一图层，
 * 音符省略 `layerId` 时等价于挂在它上面。索引恒为 0。
 */
export var DEFAULT_LAYER_ID = '';

/** 由调用方注入的两个外部依赖，见文件头「依赖注入」。 */
export interface LayerDeps {
  /** beat → 秒。 */
  beatToSec: (beat: number) => number;
  /** easing 名 → 缓动后的进度。未知名称应回退到 linear。 */
  ease: (name: string, t: number) => number;
  /** 变速斜坡的离散段数。必须与 `shared/beatTime.ts` 的 `SPEED_RAMP_STEPS` 一致
   *  （两个 shared 文件之间禁止运行时 import，故由调用方注入）。缺省 24。 */
  rampSteps?: number;
}

/** 与 `SPEED_RAMP_STEPS` 对齐的兜底值（仅在调用方未注入时生效）。 */
var FALLBACK_RAMP_STEPS = 24;

/** 一段偏移过渡（自身图层的，不含祖先、不含静态偏移）。 */
export interface OffsetStep {
  /** 起始时间（秒）。在此之前本段不生效。 */
  timeSec: number;
  /** 过渡时长（秒）。0 = 瞬时跳变。 */
  duration: number;
  easing: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/** 一次音符色变更（自身图层的 note_color_change 事件）。 */
export interface ColorEvent {
  timeSec: number;
  color: string;
}

/**
 * 一次变速（自身图层的 speed_change 事件）。
 *
 * 流速通道的合成规则是 **Π 相乘**；当各层的值是**时变**的（各自有自己的
 * speed_change 事件）时，该规则自然延伸为**逐段相乘**：
 *
 * `speed_layer(t) = speed_global(t) × Π(链上各层自身的 speed(t)) × Π(链上静态 speedMul)`
 *
 * 于是滚动距离必须**按图层各自积分**：`S_layer(t) = ∫ speed_layer`，而不能再共用
 * 一条全局 `S(t)` 乘一个常数（那只在各层流速为常数倍率时才等价）。
 */
export interface SpeedEvent {
  timeSec: number;
  speed: number;
}

export interface LayerNode {
  id: string;
  /** 父节点下标，-1 = 根图层。 */
  parentIdx: number;
  name?: string;
  /** 静态初始偏移（LayerData.offsetX/Y），参与 Σ 相加。 */
  staticOffsetX: number;
  staticOffsetY: number;
  /** 图层流速倍率，参与 Π 连乘。缺省 1。 */
  speedMul: number;
  /** 图层音符色（就近继承的候选值）。 */
  noteColor?: string;
  /** 自身偏移时间轴（按 timeSec 升序）。 */
  steps: OffsetStep[];
  /** 自身音符色时间轴（note_color_change 事件，按 timeSec 升序）。 */
  colorEvents: ColorEvent[];
  /** 自身变速时间轴（speed_change 事件，按 timeSec 升序）。
   *  ⚠️ 默认根图层（下标 0）恒为空：顶层 `chart.events` 是**全局**时间轴，
   *  由 `layerSpeedTimeline` 作为基底单独乘入，不能在这里再算一次（否则翻倍）。 */
  speedEvents: SpeedEvent[];
  /** 自身变速轴上 >0 的最小速度（无事件 = 1）。仅用于渲染窗扩宽的估算。 */
  minOwnSpeed: number;
  /** 祖先链：**从根到自身**、含自身的下标序列。Σ/Π/继承三种合成都沿它走。 */
  chain: number[];
}

export interface LayerTree {
  /** 下标 0 恒为默认根图层。 */
  nodes: LayerNode[];
  byId: { [id: string]: number };
  ease: (name: string, t: number) => number;
}

function isNum(v: any): boolean {
  return typeof v === 'number' && isFinite(v);
}

/** 求某一段在时刻 t 的插值结果，**写入 out**（零分配）。t 超出段范围时按端点钳取。 */
function stepValueAtInto(
  tree: LayerTree,
  step: OffsetStep,
  t: number,
  out: { x: number; y: number }
): void {
  if (step.duration <= 0) { out.x = step.toX; out.y = step.toY; return; }
  var p = (t - step.timeSec) / step.duration;
  if (p < 0) p = 0;
  if (p > 1) p = 1;
  var e = tree.ease(step.easing, p);
  out.x = step.fromX + (step.toX - step.fromX) * e;
  out.y = step.fromY + (step.toY - step.fromY) * e;
}

/**
 * 从图层自身的时间轴 + 静态偏移，构造 `steps`。
 *
 * 打断语义：新的过渡事件开始时，若上一段尚未走完，则**上一段被就地打断**，
 * 新段的起点取「打断瞬间画面上真实所在的偏移值」（对上一段做插值），
 * 而不是上一段的目标值 —— 否则叠加过渡时会出现跳变。
 */
function buildSteps(
  tree: LayerTree,
  events: any,
  beatToSec: (beat: number) => number,
  baseX: number,
  baseY: number
): OffsetStep[] {
  var steps: OffsetStep[] = [];
  if (!Array.isArray(events) || events.length === 0) return steps;

  var list: any[] = [];
  for (var i = 0; i < events.length; i++) {
    var ev: any = events[i];
    if (!ev || ev.eventType !== 'offset_change') continue;
    var t = isNum(ev.timeSec) ? ev.timeSec : isNum(ev.beat) ? beatToSec(ev.beat) : 0;
    list.push({ t: t, ev: ev });
  }
  if (list.length === 0) return steps;
  list.sort(function (a: any, b: any) { return a.t - b.t; });

  var prev: OffsetStep | null = null;
  for (var s = 0; s < list.length; s++) {
    var fromX = baseX;
    var fromY = baseY;
    if (prev) {
      stepValueAtInto(tree, prev, list[s].t, _layerOwnScratch);
      fromX = _layerOwnScratch.x;
      fromY = _layerOwnScratch.y;
    }
    // 只给出一个轴时，另一轴保持当前值不变。
    var toX = isNum(list[s].ev.offsetX) ? list[s].ev.offsetX : fromX;
    var toY = isNum(list[s].ev.offsetY) ? list[s].ev.offsetY : fromY;
    // 过渡时长单位为「拍」（offset_change 专用约定，谱面以拍为主思维）。
    // 换算成秒：beatToSec(beat+拍数) − beatToSec(beat)，多 BPM 谱面自动取该窗口实际时长。
    var dur = 0;
    if (isNum(list[s].ev.duration) && list[s].ev.duration > 0) {
      var b0 = isNum(list[s].ev.beat) ? list[s].ev.beat : 0;
      dur = beatToSec(b0 + list[s].ev.duration) - beatToSec(b0);
      if (!(dur > 0)) dur = 0;
    }
    var easing = typeof list[s].ev.easing === 'string' ? list[s].ev.easing : 'linear';
    prev = {
      timeSec: list[s].t,
      duration: dur,
      easing: easing,
      fromX: fromX,
      fromY: fromY,
      toX: toX,
      toY: toY,
    };
    steps.push(prev);
  }
  return steps;
}

/**
 * 收集自身图层的 speed_change 事件（按 timeSec 升序）。
 *
 * 与全局轴同样支持**时间过渡**（`duration > 0`，单位秒）：斜坡用中点采样离散成
 * 分段常数（步进数与全局轴一致，见 `SPEED_RAMP_STEPS`）。`ease` 由调用方注入。
 * 斜坡起点 = `speedFrom`，缺省为该事件开始时的当前速度。
 */
function buildSpeedEvents(
  events: any,
  beatToSec: (beat: number) => number,
  ease: (name: string, t: number) => number,
  rampSteps: number
): SpeedEvent[] {
  var out: SpeedEvent[] = [];
  if (!Array.isArray(events) || events.length === 0) return out;
  var raw: any[] = [];
  for (var i = 0; i < events.length; i++) {
    var ev: any = events[i];
    if (!ev || ev.eventType !== 'speed_change') continue;
    if (!isNum(ev.speed)) continue;
    var t = isNum(ev.timeSec) ? ev.timeSec : isNum(ev.beat) ? beatToSec(ev.beat) : 0;
    raw.push({ t: t, ev: ev });
  }
  if (raw.length === 0) return out;
  raw.sort(function (a: any, b: any) { return a.t - b.t; });

  var cur = 1;
  for (var s = 0; s < raw.length; s++) {
    var e: any = raw[s].ev;
    var t0: number = raw[s].t;
    var to: number = e.speed;
    var from = isNum(e.speedFrom) ? e.speedFrom : cur;
    var dur = isNum(e.duration) && e.duration > 0 ? e.duration : 0;
    var easing = typeof e.easing === 'string' ? e.easing : 'linear';
    if (dur > 0) {
      // 标准中点法则（与 shared/beatTime.ts 的 pushSpeedRamp 完全一致）：
      // 采样点落在段起点 t0 + dt*k，取值取该段中点；最后补收尾点精确落到目标速度。
      var dt = dur / rampSteps;
      for (var k = 0; k < rampSteps; k++) {
        var p = (k + 0.5) / rampSteps;
        out.push({ timeSec: t0 + dt * k, speed: from + (to - from) * ease(easing, p) });
      }
      out.push({ timeSec: t0 + dur, speed: to });
    } else {
      out.push({ timeSec: t0, speed: to });
    }
    cur = to;
  }
  out.sort(function (a: SpeedEvent, b: SpeedEvent) { return a.timeSec - b.timeSec; });
  return out;
}

/** 自身变速轴上 >0 的最小速度（无事件 → 1）。负/零速不参与（窗口扩宽只对慢速有意义）。 */
function minOwnSpeedOf(list: SpeedEvent[]): number {
  var m = 1;
  for (var i = 0; i < list.length; i++) {
    var s = list[i].speed;
    if (s > 0 && s < m) m = s;
  }
  return m;
}

/** 时间轴上 t 处的速度：最后一个 timeSec ≤ t 的点；没有则为 1。 */
function speedValueAt(list: SpeedEvent[], t: number): number {
  var v = 1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].timeSec <= t) v = list[i].speed;
    else break;
  }
  return v;
}

/** 收集自身图层的 note_color_change 事件（按 timeSec 升序）。 */
function buildColorEvents(events: any, beatToSec: (beat: number) => number): ColorEvent[] {
  var out: ColorEvent[] = [];
  if (!Array.isArray(events) || events.length === 0) return out;
  for (var i = 0; i < events.length; i++) {
    var ev: any = events[i];
    if (!ev || ev.eventType !== 'note_color_change') continue;
    if (typeof ev.noteColor !== 'string' || !ev.noteColor) continue;
    var t = isNum(ev.timeSec) ? ev.timeSec : isNum(ev.beat) ? beatToSec(ev.beat) : 0;
    out.push({ timeSec: t, color: ev.noteColor });
  }
  out.sort(function (a: ColorEvent, b: ColorEvent) { return a.timeSec - b.timeSec; });
  return out;
}

/**
 * 构建图层树。**缺省形态**：只含索引 0 的默认根图层，且它没有任何偏移 ——
 * 此时所有合成结果恒等于旧行为（偏移 0、流速 1、颜色取全局）。
 */
export function buildLayerTree(chart: ChartData, deps: LayerDeps): LayerTree {
  var rawLayers: LayerData[] = Array.isArray(chart.layers) ? chart.layers : [];

  var nodes: LayerNode[] = [];
  var byId: { [id: string]: number } = {};

  var tree: LayerTree = { nodes: nodes, byId: byId, ease: deps.ease };
  var rampSteps = deps.rampSteps && deps.rampSteps > 0 ? deps.rampSteps : FALLBACK_RAMP_STEPS;

  // 索引 0：默认根图层。它的偏移时间轴就是**顶层 events**（旧格式的事件轴），
  // 因此旧谱面里写在顶层的 offset_change 也能正常工作。
  // 顶层 `chart.events` 的 speed_change 是**默认根图层私有**的时间轴（其它图层
  // 不继承）。旧谱面只有默认根一个图层 → 行为与现状逐位一致。
  // 它经由 `layerSpeedTimeline` 的 basePoints 传入（而非挂在这里），
  // 这样 legacy `chart.speedEvents` 也能被覆盖，且不会与自身轴重复计入。
  nodes.push({
    id: DEFAULT_LAYER_ID,
    parentIdx: -1,
    staticOffsetX: 0,
    staticOffsetY: 0,
    speedMul: 1,
    steps: buildSteps(tree, chart.events, deps.beatToSec, 0, 0),
    colorEvents: buildColorEvents(chart.events, deps.beatToSec),
    speedEvents: [],
    minOwnSpeed: 1,
    chain: [0],
  });
  byId[DEFAULT_LAYER_ID] = 0;

  var parentRaw: string[] = [];
  for (var i = 0; i < rawLayers.length; i++) {
    var L: any = rawLayers[i] || {};
    var id = typeof L.id === 'string' && L.id ? L.id : '';
    if (!id || byId[id] !== undefined) continue; // 重复 id：解析层已去重并告警
    parentRaw.push(typeof L.parentId === 'string' ? L.parentId : '');
    byId[id] = nodes.length;
    nodes.push({
      id: id,
      parentIdx: -1, // 下一趟回填（父图层可能排在子节点之后）
      name: typeof L.name === 'string' && L.name ? L.name : undefined,
      staticOffsetX: isNum(L.offsetX) ? L.offsetX : 0,
      staticOffsetY: isNum(L.offsetY) ? L.offsetY : 0,
      speedMul: isNum(L.speedMul) ? L.speedMul : 1,
      noteColor: typeof L.noteColor === 'string' && L.noteColor ? L.noteColor : undefined,
      steps: buildSteps(tree, L.events, deps.beatToSec, 0, 0),
      colorEvents: buildColorEvents(L.events, deps.beatToSec),
      speedEvents: buildSpeedEvents(L.events, deps.beatToSec, deps.ease, rampSteps),
      minOwnSpeed: 1, // 下一趟回填（依赖 speedEvents）
      chain: [],
    });
  }

  for (var c = 1; c < nodes.length; c++) {
    // ⚠️ 空parentId（''）= 根图层，**不是**默认根图层（byId[''] === 0 是默认根的下标），
    // 否则新建的显式根图层会被静默挂成默认根的子图层、错误继承其偏移/流速。
    var raw = parentRaw[c - 1];
    var p = raw && typeof byId[raw] === 'number' ? byId[raw] : -1;
    if (p === c) p = -1; // 自引用
    nodes[c].parentIdx = p;
    nodes[c].minOwnSpeed = minOwnSpeedOf(nodes[c].speedEvents);
  }

  // 祖先链：从自身向上走到根。带环检测与深度上限（解析层已修复过，这里再兜一层）。
  for (var n = 0; n < nodes.length; n++) {
    var chain: number[] = [];
    var seen: { [k: number]: boolean } = {};
    var cur = n;
    var guard = 0;
    while (cur >= 0 && !seen[cur] && guard < 128) {
      seen[cur] = true;
      chain.push(cur);
      cur = nodes[cur].parentIdx;
      guard++;
    }
    chain.reverse(); // ← 由「自身→根」反转为「根→自身」
    nodes[n].chain = chain;
  }

  return tree;
}

/** 音符所属图层下标。找不到 / 未指定 → 0（默认根图层）。 */
export function noteLayerIdx(tree: LayerTree, note: any): number {
  var id = note && typeof note.layerId === 'string' ? note.layerId : '';
  var idx = tree.byId[id];
  return typeof idx === 'number' ? idx : 0;
}

/** 单个图层**自身**在时刻 t 的偏移（不含祖先），**写入 out**（零分配）。 */
export function ownOffsetAtInto(tree: LayerTree, idx: number, t: number, out: { x: number; y: number }): void {
  var node = tree.nodes[idx];
  var steps = node.steps;
  if (!steps || steps.length === 0) { out.x = node.staticOffsetX; out.y = node.staticOffsetY; return; }
  // 最后一个 timeSec <= t 的段。
  var lo = 0;
  var hi = steps.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (steps[mid].timeSec <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) { out.x = node.staticOffsetX; out.y = node.staticOffsetY; return; }
  stepValueAtInto(tree, steps[lo - 1], t, out);
}

/** 单个图层**自身**在时刻 t 的偏移（不含祖先）。 */
export function ownOffsetAt(tree: LayerTree, idx: number, t: number): { x: number; y: number } {
  var o = { x: 0, y: 0 };
  ownOffsetAtInto(tree, idx, t, o);
  return o;
}

/**
 * 合成偏移链上的复用 scratch。
 * `layerOffsetAtInto` 是同步、不可重入的（一次调用内只用于累积链上各段），故可共享。
 * ES5 风格：本文件被 scripts/build-lite.mjs 原样内联进 Lite 的单一 IIFE。
 */
var _layerOwnScratch = { x: 0, y: 0 };

/** 图层**合成后**（自身 + Σ 所有祖先）在时刻 t 的偏移，**写入 out**（零分配）。 */
export function layerOffsetAtInto(tree: LayerTree, idx: number, t: number, out: { x: number; y: number }): void {
  var chain = tree.nodes[idx].chain;
  var x = 0;
  var y = 0;
  for (var i = 0; i < chain.length; i++) {
    ownOffsetAtInto(tree, chain[i], t, _layerOwnScratch);
    x += _layerOwnScratch.x;
    y += _layerOwnScratch.y;
  }
  out.x = x;
  out.y = y;
}

/** 图层**合成后**（自身 + Σ 所有祖先）在时刻 t 的偏移。 */
export function layerOffsetAt(tree: LayerTree, idx: number, t: number): { x: number; y: number } {
  var o = { x: 0, y: 0 };
  layerOffsetAtInto(tree, idx, t, o);
  return o;
}

/**
 * 音符在时刻 t 的**显示位置** = base + 所在图层的合成偏移。
 * 渲染时 t 取当前播放时间（于是音符会在飞行途中随事件平移）；
 * 校验 / 放置时 t 取**音符自己的时间**（于是得到它真正被判定的落点）。
 */
export function resolvedNotePosAt(
  tree: LayerTree,
  note: any,
  t: number
): { x: number; y: number } {
  var off = layerOffsetAt(tree, noteLayerIdx(tree, note), t);
  var bx = isNum(note.x) ? note.x : 0;
  var by = isNum(note.y) ? note.y : 0;
  return { x: bx + off.x, y: by + off.y };
}

/** 判定落点：显示位置在「音符自己的时间」处的取值。校验只用这一个。 */
export function landingPos(tree: LayerTree, note: any): { x: number; y: number } {
  var t = isNum(note.timeSec) ? note.timeSec : 0;
  return resolvedNotePosAt(tree, note, t);
}

/**
 * 放置换算的**逆运算**：想在时刻 t 显示在 `(displayX, displayY)`，应存的 base 是多少。
 * 编辑器放置 / 拖动音符时必须用它，否则偏移存在时会「指哪不打哪」。
 */
export function toStoredPos(
  tree: LayerTree,
  idx: number,
  displayX: number,
  displayY: number,
  t: number
): { x: number; y: number } {
  var off = layerOffsetAt(tree, idx, t);
  return { x: displayX - off.x, y: displayY - off.y };
}

/** 图层流速倍率 = Π 链上各节点的 speedMul（缺省 1）。 */
export function layerSpeedMul(tree: LayerTree, idx: number): number {
  var chain = tree.nodes[idx].chain;
  var mul = 1;
  for (var i = 0; i < chain.length; i++) mul *= tree.nodes[chain[i]].speedMul;
  return mul;
}

/**
 * 图层**自身/祖先链**上是否含变速事件。true 表示该图层的滚动距离不能由
 * 「全局距离 × 常数倍率」得到，必须走 `layerSpeedTimeline` 单独积分。
 */
export function layerHasOwnSpeed(tree: LayerTree, idx: number): boolean {
  var chain = tree.nodes[idx].chain;
  for (var i = 0; i < chain.length; i++) {
    if (tree.nodes[chain[i]].speedEvents.length > 0) return true;
  }
  return false;
}

/**
 * 图层 i 的**有效滚动速度时间轴**：
 *
 * `speed(t) = base(t) × Π(链上各层自身 speed(t)) × Π(链上静态 speedMul)`
 *
 * 其中 `base(t)` **只对默认根图层存在**（= 顶层 `chart.events` 的 speed_change，
 * 它是默认根私有的时间轴，其它图层不继承）；其余图层 base 恒为常数 1。
 *
 * 返回值是可直接喂给 `getScrollDistance` / 前缀和构造器的变速点数组
 * （首点为 `timeSec = 0`，承载「起始速度」，与两者对 ≤0 点的约定一致）。
 *
 * 无图层 / 各层均无自身变速事件时，调用方应直接用「base 距离 × layerSpeedMul」
 * —— 数学上完全等价，且省掉一条时间轴。
 */
export function layerSpeedTimeline(
  tree: LayerTree,
  idx: number,
  basePoints: SpeedEvent[]
): SpeedEvent[] {
  var chain = tree.nodes[idx].chain;
  var mul = layerSpeedMul(tree, idx);
  // 顶层 events 只属于默认根图层；显式图层（含显式根）的基底是常数 1。
  var globalPoints = idx === 0 ? basePoints : null;

  // 起始速度：base 初值（最后一个 timeSec ≤ 0 的点，缺省 1）× 各层自身初值 × 静态倍率
  var v0 = 1;
  if (globalPoints) {
    for (var g = 0; g < globalPoints.length; g++) {
      var gp = globalPoints[g];
      if (isNum(gp.timeSec) && gp.timeSec <= 0 && isNum(gp.speed)) v0 = gp.speed;
    }
  }
  v0 *= mul;
  for (var c0 = 0; c0 < chain.length; c0++) {
    v0 *= speedValueAt(tree.nodes[chain[c0]].speedEvents, 0);
  }

  // 断点 = 全局轴与链上各层自身轴的并集（只取 > 0 的时刻）
  var raw: number[] = [];
  if (globalPoints) {
    for (var i = 0; i < globalPoints.length; i++) {
      var p = globalPoints[i];
      if (isNum(p.timeSec) && p.timeSec > 0) raw.push(p.timeSec);
    }
  }
  for (var c = 0; c < chain.length; c++) {
    var se = tree.nodes[chain[c]].speedEvents;
    for (var k = 0; k < se.length; k++) {
      if (se[k].timeSec > 0) raw.push(se[k].timeSec);
    }
  }
  raw.sort(function (a: number, b: number) { return a - b; });

  var out: SpeedEvent[] = [{ timeSec: 0, speed: v0 }];
  var last = -Infinity;
  for (var r = 0; r < raw.length; r++) {
    var t = raw[r];
    if (t === last) continue;
    last = t;
    var v = mul * (globalPoints ? speedValueAt(globalPoints, t) : 1);
    for (var c2 = 0; c2 < chain.length; c2++) {
      v *= speedValueAt(tree.nodes[chain[c2]].speedEvents, t);
    }
    out.push({ timeSec: t, speed: v });
  }
  return out;
}

/**
 * 图层相对全局的**最小流速系数**（≤1，用于渲染距离窗扩宽；
 * 慢速图层的可见带对应更大的 ΔS，不扩宽会漏渲染）。
 */
export function layerMinRelSpeed(tree: LayerTree, idx: number): number {
  var chain = tree.nodes[idx].chain;
  var r = 1;
  for (var i = 0; i < chain.length; i++) {
    r *= tree.nodes[chain[i]].speedMul * tree.nodes[chain[i]].minOwnSpeed;
  }
  return r;
}

/** 图层音符色 = 沿祖先链**就近继承**；链上都没有则返回 `fallback`（通常是全局 noteColor）。 */
export function resolveLayerNoteColor(tree: LayerTree, idx: number, fallback: string): string {
  var chain = tree.nodes[idx].chain;
  for (var i = chain.length - 1; i >= 0; i--) {
    var c = tree.nodes[chain[i]].noteColor;
    if (c) return c;
  }
  return fallback;
}

/**
 * 图层音符色（**按时间求值**）：沿祖先链就近取值，每层先看该层时间轴上
 * 「最近一次 note_color_change」（timeSec ≤ t），再看静态 `noteColor`；
 * 链上都没有 → `fallback`（全局 noteColor）。
 * 顶层事件属于默认根图层的时间轴 —— 旧谱面（全部音符都在默认根）行为与全局完全一致。
 */
export function layerColorAt(
  tree: LayerTree,
  idx: number,
  t: number,
  fallback: string
): string {
  var chain = tree.nodes[idx].chain;
  for (var i = chain.length - 1; i >= 0; i--) {
    var node = tree.nodes[chain[i]];
    var ce = node.colorEvents;
    if (ce && ce.length > 0) {
      var lo = 0;
      var hi = ce.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (ce[mid].timeSec <= t) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) return ce[lo - 1].color;
    }
    if (node.noteColor) return node.noteColor;
  }
  return fallback;
}
