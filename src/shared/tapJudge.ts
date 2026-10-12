import type { HitRegion, JudgementType } from '../types/game';

/**
 * tap / touch 判定的**纯逻辑核心**：不依赖 React、不依赖 THREE、不依赖具体指针容器。
 *
 * 与 `shared/slideJudge.ts` 同构：把此前被 3 端各自复制的两条规则收敛为单一来源 ——
 *   - **tap 命中检索**（pointerdown 即时判定 + 同刻重叠合并「方案二」）；
 *   - **touch 逐帧判定**（悬停触发状态机：早扫记账 / 到面结算 / 超窗 Miss）。
 *
 * 各端只保留「适配层」：把音符的**合成位置**（`base + 图层偏移`）、活跃指针查询、
 * 已判定集合等环境能力经 `TapHitEnv` / `TouchJudgeEnv` 注入，副作用（音效 / 特效 /
 * 反馈 / 计分）仍由各端在拿到 `TouchDecision` 后自行提交。
 *
 * ## 本文件会被 Lite 构建期内联（`scripts/build-lite.mjs` 的 SHARED_FILES）
 *
 * 因此必须遵守 `shared/` 的 ES5 约束：
 *   - 声明一律 `var`（esbuild 的 es5 transform 不降级块级声明）；
 *   - 禁用 ES2015+ 内建：`Set` / `Map` / `WeakMap` / `Array.from` /
 *     `Array.prototype.includes` / `Object.entries` / `Number.isFinite` / **`Math.hypot`**
 *     （故距离用手写 `Math.sqrt(dx*dx+dy*dy)`）；
 *   - 禁用 `??` / `?.` / `for...of`；
 *   - **零运行时 import**（构建用的是 esbuild `transform` 而非 bundle，
 *     残留的 import 会直接出现在 IIFE 顶层）。类型 import 会被擦除，可保留。
 */

/** 判定核心需要「看懂」的音符最小结构（三端音符结构上均满足）。 */
export interface TapJudgeNote {
  /** 音符类型（核心只处理 `'tap'` 的即时判定；其余由各端自己分流）。 */
  type?: string;
  /** 假音符：完全不参与判定。 */
  fake?: boolean;
  timeSec: number;
  /** 同刻重叠合并产生的额外命中盒（运行期字段，每局复位）。 */
  extraHitRegions?: HitRegion[];
}

/** 三端共用的**判定规则**（常量 + 纯规则）——由 `src/systems/tapJudge.ts` 绑定一次。 */
export interface TapJudgeDeps {
  /** 判定窗口（毫秒）。 */
  hitWindowMs: number;
  /** tap 判定盒半宽（世界单位）。 */
  tapHitHalf: number;
  /** touch 判定盒半宽（世界单位）。 */
  touchHitHalf: number;
  /** 轴对齐命中盒判定。 */
  isWithinBox(px: number, py: number, cx: number, cy: number, half: number): boolean;
  /** 是否在判定窗口（毫秒）内（对称：`|dt| <= window`）。 */
  withinHitWindow(deltaTMs: number, windowMs: number): boolean;
  /** 由绝对时间误差（毫秒）评定档位；`null` = 落在所有窗口之外。 */
  evaluateJudgement(deltaTMs: number): JudgementType | null;
}

/** tap 命中检索所需的环境能力（各端注入）。 */
export interface TapHitEnv<TNote> {
  /** 音符**当前帧的合成位置**（= base + 该音符图层的偏移；渲染与判定同源）。 */
  getEffectivePos(n: TNote): { x: number; y: number };
  /** 该音符是否已被判定（各端各自的已判定集合）。 */
  isJudged(n: TNote): boolean;
}

/** touch 逐帧判定所需的环境能力（各端注入）。 */
export interface TouchJudgeEnv<TNote> {
  /** 音符**当前帧的合成位置**（同上）。 */
  getEffectivePos(n: TNote): { x: number; y: number };
  /** 是否有活跃指针落在以 (x,y) 为中心、半宽 `half` 的盒内（悬停触发）。 */
  isAnyPointerInside(x: number, y: number, half: number): boolean;
}

/** touch 的运行态（各端持久存储，核心就地改写）。 */
export interface TouchJudgeState {
  /** 最近一次「处于窗口内且指针在盒内」的时间（早扫记账）。 */
  lastInsideTime: number | null;
  /** 到达判定面（dt>=0）后是否已做过一次到面结算。 */
  arrivalChecked: boolean;
}

/** 核心给出的判定结论；副作用（音效 / 特效 / 反馈 / 计分）由调用方提交。 */
export interface TouchDecision {
  judgement: JudgementType;
  dtMs: number;
}

/** tap 判定结论：命中的音符 + 档位 + 时间误差。 */
export interface TapHitDecision<TNote> {
  note: TNote;
  judgement: JudgementType;
  dtMs: number;
}

/** 创建 touch 运行态（各端 `getTouchRt` 可直接复用）。 */
export function createTouchJudgeState(): TouchJudgeState {
  return { lastInsideTime: null, arrivalChecked: false };
}

/**
 * tap 命中检索 + 选中（pointerdown 即时判定）。
 *
 * 一条 tap「可命中」= 触点落在**它自己的判定盒**内，或落在它已合并的任一
 * `extraHitRegions` 内。在全部可命中的候选里按两条规则选出唯一目标：
 *   1. 先取**最晚**时刻组（`curTime - timeSec` 最大）——抢救即将 Miss 的那个；
 *   2. 同刻组内取**离触点最近**者；严格 `<`，并列取先遇到者。
 * 选中后把它的判定盒合并进「同刻」其它可命中 tap 的 `extraHitRegions`（方案二），
 * 使后续在重叠点按下仍能命中它们。**绝不跨时刻合并**（否则污染命中面积导致误触）。
 *
 * **合并只在该 tap 真正被判定时发生**：先评档，无档位则整体不生效（该 tap 未被
 * 消费）。当前 `HIT_WINDOW_MS === JUDGE_THRESH.GOOD === 160`，故该分支实际不可达，
 * 但语义务必保持 —— 若将来放宽命中窗而不放宽档位窗，未消费的 tap 不该被合并掉。
 *
 * @param candidates 候选音符（各端可传全量或 `type === 'tap'` 子集；核心自行过滤）。
 */
export function judgeTapCore<TNote extends TapJudgeNote>(
  candidates: readonly TNote[],
  px: number,
  py: number,
  curTime: number,
  env: TapHitEnv<TNote>,
  deps: TapJudgeDeps,
): TapHitDecision<TNote> | null {
  // 热路径：依赖先落到局部变量，避免反复属性查找。
  var isWithinBox = deps.isWithinBox;
  var TAP_HIT_HALF = deps.tapHitHalf;
  var HIT_WINDOW_MS = deps.hitWindowMs;

  var overlap: TNote[] = [];
  for (var i = 0; i < candidates.length; i++) {
    var n = candidates[i];
    if (env.isJudged(n) || n.type !== 'tap' || n.fake) continue;
    var dt = Math.abs((curTime - n.timeSec) * 1000);
    if (dt >= HIT_WINDOW_MS) continue;
    var ep = env.getEffectivePos(n);
    var inOwn = isWithinBox(px, py, ep.x, ep.y, TAP_HIT_HALF);
    var inExtra = false;
    var extra = n.extraHitRegions;
    if (extra) {
      for (var e = 0; e < extra.length; e++) {
        if (Math.abs(px - extra[e].x) < extra[e].half && Math.abs(py - extra[e].y) < extra[e].half) {
          inExtra = true;
          break;
        }
      }
    }
    if (inOwn || inExtra) overlap.push(n);
  }
  if (overlap.length === 0) return null;

  // 规则 1：最晚时刻组。timeSec 恒为数值、id 可为任意字符串，故只比 timeSec。
  var bestLate = -Infinity;
  var bestTimeSec = Infinity;
  for (var i = 0; i < overlap.length; i++) {
    var late = curTime - overlap[i].timeSec;
    if (late > bestLate) {
      bestLate = late;
      bestTimeSec = overlap[i].timeSec;
    }
  }

  // 规则 2：同刻组内取最近（严格 <，并列取先遇到者）。
  var best: TNote | null = null;
  var bestDist = Infinity;
  for (var i = 0; i < overlap.length; i++) {
    var m = overlap[i];
    if (m.timeSec !== bestTimeSec) continue;
    var mp = env.getEffectivePos(m);
    var mdx = mp.x - px;
    var mdy = mp.y - py;
    var d = Math.sqrt(mdx * mdx + mdy * mdy);
    if (d < bestDist) {
      best = m;
      bestDist = d;
    }
  }

  if (!best) return null;

  // 先评档：无档位 = 该 tap 未被消费 → 不合并（见函数头说明）。
  var bestDt = (curTime - best.timeSec) * 1000;
  var bestJ = deps.evaluateJudgement(bestDt);
  if (!bestJ) return null;

  // 方案二：把被消费 tap 的判定盒合并进同刻其它可命中 tap。
  var bp = env.getEffectivePos(best);
  var merged: HitRegion = { x: bp.x, y: bp.y, half: TAP_HIT_HALF };
  for (var i = 0; i < overlap.length; i++) {
    var other = overlap[i];
    if (other === best || other.timeSec !== best.timeSec) continue;
    var regions = other.extraHitRegions;
    if (!regions) {
      regions = [];
      other.extraHitRegions = regions;
    }
    var dup = false;
    for (var r = 0; r < regions.length; r++) {
      if (regions[r].x === merged.x && regions[r].y === merged.y && regions[r].half === merged.half) {
        dup = true;
        break;
      }
    }
    if (!dup) regions.push(merged);
  }
  return { note: best, judgement: bestJ, dtMs: bestDt };
}

/**
 * touch 逐帧判定（悬停触发：窗口内任一指在盒内即可命中，无需按下/点击）。
 *
 * 语义（与抽出前逐字等价）：
 * - `|dt| <= HIT_WINDOW_MS` 且指针在盒内 → 记 `lastInsideTime`（早扫记账）；
 * - AutoPlay：`dt >= 0` 即 S-Perfect；
 * - `dt >= 0` 首次到面结算（`arrivalChecked`）：在盒内 → S-Perfect；否则若曾早扫
 *   过（`lastInsideTime`）则按早扫误差 `evaluateJudgement`（无档位则继续往下走）；
 * - 之后仍在盒内且 `dt <= HIT_WINDOW_MS` → 按当前误差评档；
 * - `dt > HIT_WINDOW_MS` → Miss。
 *
 * **就地改写 `state`**（`lastInsideTime` / `arrivalChecked` 跨帧保留）。
 * 返回 `null` 表示本帧未产生判定。
 */
export function processTouchCore<TNote extends TapJudgeNote>(
  note: TNote,
  curTime: number,
  autoPlay: boolean,
  state: TouchJudgeState,
  env: TouchJudgeEnv<TNote>,
  deps: TapJudgeDeps,
): TouchDecision | null {
  if (note.fake) return null; // 假音符：完全不参与判定
  var evaluateJudgement = deps.evaluateJudgement;
  var HIT_WINDOW_MS = deps.hitWindowMs;

  var ep = env.getEffectivePos(note);
  var inside = env.isAnyPointerInside(ep.x, ep.y, deps.touchHitHalf);
  var dt = (curTime - note.timeSec) * 1000;

  if (deps.withinHitWindow(dt, HIT_WINDOW_MS) && inside) state.lastInsideTime = curTime;

  // AutoPlay：过判定面即 S-Perfect。
  if (autoPlay && dt >= 0) return { judgement: 'S-Perfect', dtMs: dt };

  if (dt >= 0) {
    if (!state.arrivalChecked) {
      state.arrivalChecked = true;
      if (inside) return { judgement: 'S-Perfect', dtMs: dt };
      if (state.lastInsideTime !== null) {
        var earlyDt = (state.lastInsideTime - note.timeSec) * 1000;
        var earlyJ = evaluateJudgement(earlyDt);
        if (earlyJ) return { judgement: earlyJ, dtMs: earlyDt };
      }
    }
    if (inside && dt <= HIT_WINDOW_MS) {
      var j = evaluateJudgement(dt);
      if (j) return { judgement: j, dtMs: dt };
    }
    if (dt > HIT_WINDOW_MS) return { judgement: 'Miss', dtMs: dt };
  }
  return null;
}
