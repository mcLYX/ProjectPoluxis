import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref, RefObject } from 'react';
// 与游戏共用同一份 three（打包器去重，零额外体积）：经 importmap shim 注入给
// story.js（three external 构建）+ api.three 命名空间，消除双实例与相关警告。
// 故事板自建 renderer/canvas，游戏的 scene/renderer 不暴露 —— 渲染管线互不干扰。
import * as THREE from 'three';
import { ensureThreeImportMap } from '../utils/storyboardThree';
import { globalAudio } from '../audio/AudioManager';
import { PRESET_VALUES, qualityStore, type QualityState } from '../qualityStore';
import { playheadStore } from '../playheadStore';
import { beatToSecondsMultiBpm, countPlayableNotes, secondsToBeatMultiBpm } from '../utils/beatTime';
import { JUDGEMENT_THRESHOLDS } from '../utils/scoring';
import { SCORE_BASE } from '../shared/gameplaySpec';
import type { ChartData, GameStats } from '../types/game';
import {
  isStoryboardModule,
  type JudgeProjector,
  type StoryboardApi,
  type StoryboardAssetsHandle,
  type StoryboardAudioLevels,
  type StoryboardChartMeta,
  type StoryboardMasterEffect,
  type StoryboardNote,
  type StoryboardPalette,
  type StoryboardPointer,
  type StoryboardPointerBridge,
  type StoryboardPointerFilter,
  type StoryboardRawPointer,
  type StoryboardQuality,
  type StoryboardScene,  type StoryboardSafeZone,
  type StoryboardGameStylePatch,
  type StoryboardInstance,
  type StoryboardJudgeEvent,
  type StoryboardLayer,
  type StoryboardModule,
  type StoryboardPlayState,
  type StoryboardSnapshot,
} from '../types/storyboard';

/**
 * 故事板宿主（§3.7，仅完整版 3D 渲染器）。
 *
 * 职责：
 *  - 动态 `import()` story.js（在线 URL / zip→idb→blob URL），契约校验失败/加载失败
 *    **静默降级**为无故事板（console.warn 一条），绝不影响游戏；
 *  - `api.mount('bg' | 'overlay')` 双层级容器（bg = 音符下，overlay = 音符上、HUD 下），
 *    可并存、共享同一时间轴；容器 absolute 铺满、pointer-events:none；
 *  - 每帧以 `globalAudio.getCurrentTime()`（与判定时钟同源）驱动 `instance.update(t, snapshot)`，
 *    snapshot 为同一对象原地刷新（api.snapshot 引用恒定，读到的永远是最新值）；
 *  - seek 通过时间不连续检测自动广播（|Δt| > SEEK_JUMP_SEC）；
 *  - playSession / storyUrl 变化或卸载 → `dispose()` + 清空容器 + 复位受控样式/音频效果。
 *
 * §3.7 v3 新增（能力通用，不为任何具体故事板定制）：
 *  - `api.hud.style()`：HUD 容器受控样式（overlay 层恒在 HUD 之下，想影响 HUD 只能走它）；
 *  - `api.input`：指针快照（判定面坐标 + 画布像素）+ 判定拦截器 + 立即脱手；
 *    数据源是 3D 渲染器每帧写入的**指针桥**（`pointerBridge`），判定侧只读
 *    `blockedIds`，被拦截的指针仍留在观测快照里（否则故事板画不出反馈）；
 *  - `api.audio.setMasterEffect()`：主输出总效果写入（低通/高通/总增益），
 *    内部脏检查 + 平滑，避免每帧 `setTargetAtTime` 的 zipper noise；
 *  - `api.assets`：歌曲目录相对资源（`resolveAssetUrl` 由 App 提供，内部走
 *    `utils/storyboardAssets` 的纯函数拼接）—— blob URL 下故事板无法自己 fetch；
 *  - `api.chartData`：原始谱面只读引用（**自定义键会被 chartSchema 剥离，别依赖它传数据**）。
 *
 * 本组件**不渲染任何 JSX**：bg/overlay 容器由 App 以 ref 占位（保证 z 序），宿主向其中
 * 命令式追加故事板自建的 DOM。判定事件经 `ref.handle.dispatchJudge()` 由 App 转发
 * （applyJudgement 热路径上只是一次 Set 遍历，零 React state）。
 */

/** 时间不连续阈值（秒）：正常播放每帧推进 ~16ms，超过即视为 seek。 */
const SEEK_JUMP_SEC = 0.75;

/** 画布受控样式的复位值（seek / 重开局 / dispose 时应用）。 */
export const GAME_STYLE_RESET = { opacity: '1', filter: '', transform: '' } as const;

/** HUD 受控样式的复位值（与画布同一套白名单，故复位值也相同）。 */
/**
 * 把受控样式补丁写进一个元素（game / hud 共用）。
 * 纯函数之外的最小封装：调用方保证元素非空。
 */
export function applyStylePatch(
  el: HTMLElement | null | undefined,
  patch: StoryboardGameStylePatch,
): void {
  if (!el) return;
  const resolved = resolveGameStylePatch(patch);
  if (resolved.opacity !== undefined) el.style.opacity = resolved.opacity;
  if (resolved.filter !== undefined) el.style.filter = resolved.filter;
  if (resolved.transform !== undefined) el.style.transform = resolved.transform;
}

/** 受控样式的复位（game / hud 共用）。 */
export function resetStyle(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.style.opacity = GAME_STYLE_RESET.opacity;
  el.style.filter = GAME_STYLE_RESET.filter;
  el.style.transform = GAME_STYLE_RESET.transform;
}

/**
 * `api.scene.scale` 的钳制（纯函数，便于单测）。
 * 下限 0.05：再小快照就没有足够像素表达"块量化"了。
 * 上限 1：放大没有意义（源只有原生分辨率）。
 */
export function clampSceneScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1 / 6;
  return Math.min(1, Math.max(0.05, scale));
}

/** `api.scene` 的复位（dispose 时调用：停复制 + 丢弃画布）。 */
export function resetScene(scene: StoryboardScene): void {
  scene.enabled = false;
  scene.canvas = null;
  scene.width = 0;
  scene.height = 0;
}

/**
 * 把游戏画布复制进快照画布。
 *
 * ⚠️ 必须用 `'copy'`：3D 渲染器是 `alpha: true`，画布大片区域**透明**；而
 * `drawImage` 默认 `source-over`（结果 = src + dst·(1-srcAlpha)）**不会用透明
 * 像素覆盖目标** → 上一帧内容残留、逐帧累积。`'copy'` 连透明区域一起替换。
 *
 * 抽成函数是为了能单测（jsdom 的 canvas 没有真实 2D 上下文）。
 */
export function copyCanvas(
  ctx: { globalCompositeOperation: string; drawImage(...a: unknown[]): void },
  src: CanvasImageSource,
  dw: number,
  dh: number,
): void {
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(src, 0, 0, dw, dh);
  // 复位：留着 'copy' 会让后续（若有人扩展）绘制语义变怪
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * 这个画布是不是**故事板自己**挂上去的？（bg / overlay 层里的 canvas）
 *
 * `api.scene` 必须排除它们：`drawImage` 抓到自己 → 下一帧把上帧的域内画面当成
 * "游戏画面"再画进域内 → **逐帧自我反馈累积**（域内糊成一块、越玩越亮）。
 *
 * 纯函数：给定候选画布与两个层容器即可判定，便于单测。
 */
export function isStoryboardCanvas(
  canvas: HTMLCanvasElement | null | undefined,
  layers?: { bg: HTMLElement | null; overlay: HTMLElement | null },
): boolean {
  if (!canvas || !layers) return false;
  return !!(
    (layers.bg && layers.bg.contains(canvas)) ||
    (layers.overlay && layers.overlay.contains(canvas))
  );
}

/**
 * 纯函数（便于单测）：把游戏侧原始指针同步进宿主对象池，产出故事板看到的快照。
 *
 * - 对象池：同一 id 复用同一对象（跨帧只写字段），避免逐帧分配；
 * - 消失的指针从池与列表中剔除（否则池会无界增长）；
 * - `blocked` 由拦截器现算，并**仅标记、不剔除** —— 被拦截的指针仍要能被故事板
 *   看见（画反馈），真正的过滤发生在游戏的判定侧。
 * - `project` 为 null 时用调用方给的兜底（宿主用图层尺寸做线性近似）。
 *
 * @returns 复用的列表（引用恒定，内容与长度按本帧刷新）
 */
export function syncPointers(
  pool: Map<number, StoryboardPointer>,
  list: StoryboardPointer[],
  raw: ReadonlyMap<number, StoryboardRawPointer> | null | undefined,
  project: ((x: number, y: number) => { sx: number; sy: number }) | null,
  filters: ReadonlySet<StoryboardPointerFilter>,
  onFilterError: (err: unknown) => void,
): StoryboardPointer[] {
  list.length = 0;
  if (!raw || raw.size === 0) {
    if (pool.size > 0) pool.clear();
    return list;
  }
  raw.forEach((p, id) => {
    let rec = pool.get(id);
    if (!rec) {
      rec = { id, x: 0, y: 0, sx: 0, sy: 0, down: false, active: false, type: '', blocked: false };
      pool.set(id, rec);
    }
    rec.x = p.x;
    rec.y = p.y;
    const s = project ? project(p.x, p.y) : null;
    rec.sx = s ? s.sx : 0;
    rec.sy = s ? s.sy : 0;
    rec.down = p.down;
    rec.active = p.active;
    rec.type = p.type;
    rec.blocked = isPointerBlocked(filters, rec, onFilterError);
    list.push(rec);
  });
  // 清理已消失的指针（池必须与本帧 raw 一致，否则 id 复用时会读到脏对象）。
  if (pool.size > raw.size) {
    const alive = new Set<number>();
    raw.forEach((_p, id) => alive.add(id));
    pool.forEach((_rec, id) => {
      if (!alive.has(id)) pool.delete(id);
    });
  }
  return list;
}

/**
 * 纯函数（便于单测）：判定某指针是否应被拦截。
 *
 * 语义：多个拦截器按注册顺序 AND 串联，**任一返回 false 即拦截**；
 * 回调抛异常按"放行"处理（故事板 bug 不该让玩家打不出音），并由宿主打一条 warn。
 *
 * @param filters 拦截器集合（Set，插入序 = 注册序）
 * @param pointer  已填好坐标/状态的指针快照对象（过滤器和故事板看到的是同一批对象）
 * @param onError  回调抛异常时的通知（宿主接 console.warn；单测可传 spy）
 */
export function isPointerBlocked(
  filters: ReadonlySet<StoryboardPointerFilter>,
  pointer: StoryboardPointer,
  onError?: (err: unknown) => void,
): boolean {
  if (filters.size === 0) return false;
  for (const fn of filters) {
    let ok: boolean;
    try {
      ok = fn(pointer) !== false;
    } catch (e) {
      onError?.(e);
      continue;
    }
    if (!ok) return true;
  }
  return false;
}

/**
 * 纯函数（便于单测）：本帧故事板的时间源。
 *
 * ## 为什么需要 `sessionActive` 而不只看 `audioRunning`
 * `globalAudio.isRunning()` 描述的是**音频引擎的时钟是否在推进**，它**不等价于**
 * 「本局仍在进行」。曲终时走的 `fadeOutAndStop()` 会**故意**把 `isPlaying` 保持为
 * true（见其 NOTE：置 false 会让 `getCurrentTime()` 回退到陈旧的 `pauseTime`，把整段
 * 曲终窗口的画面与粒子冻住）。若只按 `audioRunning` 选时间源，那么「试玩结束后回到
 * 编辑器」时音频时钟仍在推进，故事板就会**继续自己跑**一段。
 *
 * 因此这里把判据收紧为「音频时钟在推进 **且** 本局仍在进行」：一旦回到编辑器
 * （`gameState` 离开 playing/paused），立即改用播放头（编辑器的单一真相），故事板
 * 立刻停住 —— 同时音频仍能把自己的淡出正常播完，两者互不牵制。
 *
 * @param audioRunning  `globalAudio.isRunning()`：音频时钟是否实时。
 * @param audioTime     `globalAudio.getCurrentTime()`。
 * @param fallbackTime  宿主播放头（未在局中 / 未运行时的时间源）。
 * @param sessionActive 本局是否仍在进行（playing 或 paused）。
 */
export function resolveStoryboardTime(
  audioRunning: boolean,
  audioTime: number,
  fallbackTime: number | undefined,
  sessionActive: boolean = true,
): number {
  return audioRunning && sessionActive ? audioTime : (fallbackTime ?? 0);
}

/**
 * 白名单解析 `api.game.style(patch)`：只接受 opacity（数字，截断 0~1）/
 * filter / transform（字符串），其余键忽略。未提供的键不会被修改。
 * 纯函数（便于单测）；宿主把返回值逐键写入画布容器元素。
 */
export function resolveGameStylePatch(
  patch: StoryboardGameStylePatch,
): Partial<Record<'opacity' | 'filter' | 'transform', string>> {
  const out: Partial<Record<'opacity' | 'filter' | 'transform', string>> = {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
      out.opacity = String(Math.min(1, Math.max(0, patch.opacity)));
    }
    if (typeof patch.filter === 'string') out.filter = patch.filter;
    if (typeof patch.transform === 'string') out.transform = patch.transform;
  }
  return out;
}

/** 判定面坐标范围（与游戏判定面一致；音符只会出现在这个矩形内）。 */
export const JUDGE_PLANE = { x: 2.4, y: 1.5 } as const;

/**
 * 纯函数：谱面 → 故事板元数据（§3.7 v2）。
 * 拍→秒换算走 `beatToSecondsMultiBpm`，因此变速谱也正确。
 */
export function buildChartMeta(chart: ChartData | null | undefined): StoryboardChartMeta {
  const md = chart?.metadata;
  const bpm = md?.bpm ?? 120;
  const offset = md?.offset ?? 0;
  const bpmlist = md?.bpmlist;
  const timeline = buildNoteTimeline(chart);
  const noteCount = chart ? countPlayableNotes(chart) : 0;
  const firstNoteSec = timeline.length ? timeline[0].t : 0;
  const lastNoteSec = timeline.length ? timeline[timeline.length - 1].t : 0;
  // 时长只是"估计"（末音符 + 尾奏余量）：用于密度换算，不是权威曲长。
  const durationSec = Math.max(lastNoteSec + 6, firstNoteSec + 1, 1);
  return {
    title: md?.title ?? '',
    artist: md?.artist ?? '',
    difficulty: md?.difficulty ?? '',
    bpm,
    offset,
    bpmlist,
    noteCount,
    noteDensity: noteCount / Math.max(1, durationSec),
    durationSec,
    firstNoteSec,
  };
}

/** 纯函数：整谱音符 → 秒坐标时间线（升序）。开局一次性构建，不进热路径。 */
export function buildNoteTimeline(chart: ChartData | null | undefined): StoryboardNote[] {
  const notes = chart?.notes;
  if (!notes || notes.length === 0) return [];
  const md = chart.metadata;
  const bpm = md?.bpm ?? 120;
  const offset = md?.offset ?? 0;
  const bpmlist = md?.bpmlist;
  const out: StoryboardNote[] = [];
  for (const n of notes) {
    const t = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
    out.push({
      t,
      x: n.x,
      y: n.y,
      type: n.type as StoryboardNote['type'],
      ...(n.fake ? { fake: true } : null),
      ...(n.noScore ? { noScore: true } : null),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 纯函数：由元数据生成 秒↔拍 互转（含变速）。 */
export function makeBeatConverters(meta: StoryboardChartMeta): {
  timeAtBeat: (beat: number) => number;
  beatAt: (t: number) => number;
} {
  const { bpm, offset, bpmlist } = meta;
  return {
    timeAtBeat: (beat: number) => beatToSecondsMultiBpm(beat, bpm, offset, bpmlist),
    beatAt: (t: number) => secondsToBeatMultiBpm(t, bpm, offset, bpmlist),
  };
}

/** 纯函数：升序时间线的二分下界。 */
function lowerBound(arr: StoryboardNote[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 纯函数：取 `[fromSec, toSec]` 内的音符切片。 */
export function sliceNotes(
  timeline: StoryboardNote[],
  fromSec: number,
  toSec: number,
): StoryboardNote[] {
  if (!timeline.length || toSec < fromSec) return [];
  const out: StoryboardNote[] = [];
  for (let i = lowerBound(timeline, fromSec); i < timeline.length; i++) {
    const n = timeline[i];
    if (n.t > toSec) break;
    out.push(n);
  }
  return out;
}

/**
 * 纯函数：中央判定区在画布上的包围盒（CSS px）。
 * 有主相机投影时精确；无投影时退回"判定面铺满画布"的线性近似（与 toScreen 一致）。
 */
export function computeSafeZone(
  project: JudgeProjector | null | undefined,
  width: number,
  height: number,
  margin = 0,
): StoryboardSafeZone {
  let left = 0;
  let top = 0;
  let right = width;
  let bottom = height;
  if (project) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const sx of [-JUDGE_PLANE.x, JUDGE_PLANE.x]) {
      for (const sy of [-JUDGE_PLANE.y, JUDGE_PLANE.y]) {
        const p = project(sx, sy);
        xs.push(p.sx);
        ys.push(p.sy);
      }
    }
    left = Math.min(...xs);
    right = Math.max(...xs);
    top = Math.min(...ys);
    bottom = Math.max(...ys);
  }
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  right = Math.min(width, right + margin);
  bottom = Math.min(height, bottom + margin);
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
    width: Math.max(0, Math.max(left, right) - Math.max(0, left)),
    height: Math.max(0, Math.max(top, bottom) - top),
  };
}

/** 纯函数：把画质设置解析成故事板可读的快照（预设档位已回填为有效值）。 */
export function resolveStoryboardQuality(state: QualityState): StoryboardQuality {
  const mode = state.qualityMode;
  const preset = mode === 'custom' ? undefined : PRESET_VALUES[mode];
  const antialias = preset ? preset.customAntialias : state.customAntialias;
  const bloom = preset ? preset.customBloom : state.customBloom;
  const particles = preset ? preset.customParticles : state.customParticles;
  const lighting = preset ? preset.customDynamicLighting : state.customDynamicLighting;
  const hitEffects = preset ? preset.customHitEffects : state.customHitEffects;
  const renderScale = preset ? preset.customRenderScale : state.customRenderScale;
  let tier: 0 | 1 | 2;
  if (preset) {
    tier = mode === 'lite' || mode === 'low' ? 0 : mode === 'standard' ? 1 : 2;
  } else {
    const score = (bloom ? 1 : 0) + (particles ? 1 : 0) + (lighting ? 1 : 0);
    tier = score >= 2 ? 2 : score === 1 || antialias ? 1 : 0;
  }
  return { mode, antialias, bloom, particles, lighting, hitEffects, renderScale, tier };
}

/** 纯函数：谱面 → 曲目配色（让故事板与画面统一）。 */
export function buildPalette(chart: ChartData | null | undefined): StoryboardPalette {
  const md = chart?.metadata;
  return {
    noteColor: md?.noteColor,
    accent: md?.bgScheme?.accentColor,
    bgStart: md?.bgScheme?.gradientStart,
    bgEnd: md?.bgScheme?.gradientEnd,
  };
}

/** 把 GameStats + 时钟状态写入 `out`（原地刷新，返回同一引用；api.snapshot 的稳定性由此保证）。 */
export function buildSnapshotInto(
  out: StoryboardSnapshot,
  stats: GameStats | undefined,
  timeSec: number,
  playing: boolean,
  paused: boolean,
): StoryboardSnapshot {
  out.timeSec = timeSec;
  out.playing = playing;
  out.paused = paused;
  out.score = stats?.score ?? 0;
  out.combo = stats?.combo ?? 0;
  out.maxCombo = stats?.maxCombo ?? 0;
  out.accuracy = stats?.accuracy ?? 100;
  out.counts.sPerfect = stats?.sPerfectCount ?? 0;
  out.counts.perfect = stats?.perfectCount ?? 0;
  out.counts.good = stats?.goodCount ?? 0;
  out.counts.miss = stats?.missCount ?? 0;
  out.totalNotes = stats?.totalNotes ?? 0;
  out.judged =
    (stats?.sPerfectCount ?? 0) +
    (stats?.perfectCount ?? 0) +
    (stats?.goodCount ?? 0) +
    (stats?.missCount ?? 0);
  out.progress = out.totalNotes > 0 ? out.judged / out.totalNotes : 0;
  out.rank = stats?.rank ?? '';
  out.scoreFull = SCORE_BASE;
  out.judgeWindows.sPerfect = JUDGEMENT_THRESHOLDS.S_PERFECT;
  out.judgeWindows.perfect = JUDGEMENT_THRESHOLDS.PERFECT;
  out.judgeWindows.good = JUDGEMENT_THRESHOLDS.GOOD;
  return out;
}

/** 纯函数版（单测用）：新建快照对象。 */
export function buildSnapshot(
  stats: GameStats | undefined,
  timeSec: number,
  playing: boolean,
  paused: boolean,
): StoryboardSnapshot {
  return buildSnapshotInto(
    {
      timeSec: 0,
      playing: false,
      paused: false,
      score: 0,
      combo: 0,
      maxCombo: 0,
      accuracy: 100,
      counts: { sPerfect: 0, perfect: 0, good: 0, miss: 0 },
      totalNotes: 0,
      judged: 0,
      progress: 0,
      rank: '',
      scoreFull: SCORE_BASE,
      judgeWindows: { sPerfect: 40, perfect: 80, good: 160 },
    },
    stats,
    timeSec,
    playing,
    paused,
  );
}

export interface StoryboardHostHandle {
  /** App 的判定回传处调用（applyJudgement），转发给所有 onJudge 订阅者。 */
  dispatchJudge(e: StoryboardJudgeEvent): void;
}

export interface StoryboardHostProps {
  /** App 背景层占位容器（音符之下；置于 ambient 背景与 3D 画布之间）。 */
  bgSlotRef: RefObject<HTMLDivElement | null>;
  /** App 覆盖层占位容器（3D 画布之上、HUD 之下）。 */
  overlaySlotRef: RefObject<HTMLDivElement | null>;
  /** 3D 画布容器（`api.game.style` 的作用目标）。 */
  gameViewportRef: RefObject<HTMLDivElement | null>;
  /**
   * 游戏画布（GameCanvas 回写）。`api.scene` 优先用它，**不再猜 querySelector**。
   *
   * 猜错的后果很严重：抓到故事板自己的画布 → 每帧把上帧的域内画面当成"游戏画面"
   * 再画进域内 → 逐帧自我反馈累积。实机症状：域内"大量历史帧糊成一块"且越玩越亮。
   */
  gameCanvasRef?: RefObject<HTMLCanvasElement | null>;
  /** 游戏 HUD 容器（`api.hud.style` 的作用目标；App 里 z-10 那层）。 */
  hudRef?: RefObject<HTMLDivElement | null>;
  /**
   * 指针桥（§3.7 v3）：3D 渲染器每帧写入指针与投影函数，宿主据此产出
   * `api.input.pointers` 并回写 `blockedIds`。传对象本身（身份恒定、字段是活的）。
   * 2D / 无故事板时可以不传。
   */
  pointerBridge?: StoryboardPointerBridge;
  /**
   * 歌曲目录相对地址解析（§3.7 v3，`api.assets` 的底座）。由 App 提供（它才知道当前
   * 歌曲的 basePath）。缺省 = `api.assets` 全部 reject，故事板应自行降级。
   */
  resolveAssetUrl?: (relPath: string) => Promise<string>;
  /**
   * 当前歌曲目录基址（仅用于诊断展示：`api.assets` 失败时把"算了什么路径"记到
   * window，故事板侧只能看到一句 reject，分不清"基址算错"与"文件不在服务器上"）。
   */
  songAssetBase?: string;
  /**
   * 当前歌曲的**外部资源映射**（相对路径 → 可 fetch 地址）。zip 导入 / 下载到本地时
   * 指向 `idb://`，在线时指向 URL。`api.assets` 先查它再回退到"story.js 同目录"，
   * 于是同一份故事板代码在两种来源下都能读到配置。
   */
  songAssets?: Record<string, string>;
  /** 判定面→屏幕投影函数（GameCanvas 写入；缺省时 `toScreen` 走线性近似回退）。 */
  projectorRef?: RefObject<JudgeProjector | null>;
  /** App 的成绩镜像 ref（applyJudgement 热路径直写，宿主每帧读取）。 */
  statsRef: RefObject<GameStats>;
  /**
   * 当前谱面镜像 ref（§3.7 v2）—— 用于 `api.chart` / `beatAt` / `notes` / `palette`。
   * 只在开局建实例时读一次（谱面与 storyUrl / playSession 同步变化）。
   */
  chartRef?: RefObject<ChartData | null>;
  /** story.js 的可加载地址（undefined = 无故事板）。 */
  storyUrl?: string;
  /**
   * 故事板通过 `api.markReady()` 上报"重型初始化完成"时回调一次（每局一次）。
   * App 用它把音频时钟的启动推迟到故事板预热完成之后（弱机故事板会阻塞
   * 主线程，其间音频时钟若已启动，解码结束后谱面会直接从中间开始）。
   * 无故事板 / 加载失败时宿主也会回调，避免时钟被永久挂起。
   */
  onReady?: () => void;
  /** 开局会话号：变化即重建（dispose 旧实例）。 */
  playSession: number;
  playing: boolean;
  paused: boolean;
}

/**
 * 立刻作废一个 canvas 的 WebGL 上下文。
 *
 * 背景：`renderer.dispose()`（three）只释放资源与 program，**不会**释放 WebGL
 * context —— 上下文要等 canvas 被 GC 才回收。而浏览器有活动上下文上限（Chrome
 * 约 16），反复进出带故事板的曲目（编辑器试玩尤其密集：进一次建一次）就会堆满，
 * 抛 `Too many active WebGL contexts. Oldest context will be lost.`，**被强杀的往往
 * 是游戏自己那个更早创建的上下文**（表现为游戏画面渲染失效）。
 *
 * 这里用 `WEBGL_lose_context` 主动作废，不依赖故事板自身是否自觉调用
 * `forceContextLoss()` —— 对第三方 story.js 同样有效。失败一律静默。
 */
function loseWebglContext(canvas: HTMLCanvasElement): void {
  try {
    // getContext 返回与创建时同一个上下文（浏览器按 contextType 缓存）；
    // 纯 2D canvas 再请求 webgl 会返回 null（一个 canvas 只能有一种上下文）。
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_lose_context') as
      | { loseContext?: () => void }
      | null
      | undefined;
    ext?.loseContext?.();
    // 缩到 1×1：即使上面失败（扩展不可用），也显著降低显存占用并帮助 GC 回收。
    canvas.width = 1;
    canvas.height = 1;
  } catch {
    /* 忽略：拿不到上下文说明它本来就没建 */
  }
}

/**
 * 收集容器内的 canvas。**必须在故事板 dispose 之前调用**：
 * 不少故事板（含本项目的 story-mv.ts）会先 `canvas.remove()` 再返回，
 * 之后再遍历容器就一个 canvas 都找不到了 —— 宿主这层兜底会完全失效
 * （这正是"编辑器试玩反复加载仍耗尽上下文"的直接原因）。
 */
function collectCanvases(root: HTMLElement | null): HTMLCanvasElement[] {
  if (!root) return [];
  return Array.prototype.slice.call(root.querySelectorAll('canvas')) as HTMLCanvasElement[];
}

function makeLayerContainer(layer: StoryboardLayer): HTMLDivElement {
  const div = document.createElement('div');
  div.dataset.storyboardLayer = layer;
  div.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
  return div;
}

function StoryboardHostImpl(
  {
    bgSlotRef,
    overlaySlotRef,
    gameViewportRef,
    gameCanvasRef,
    hudRef,
    pointerBridge,
    resolveAssetUrl,
    songAssetBase,
    songAssets,
    statsRef,
    projectorRef,
    chartRef,
    storyUrl,
    onReady,
    playSession,
    playing,
    paused,
  }: StoryboardHostProps,
  handle: Ref<StoryboardHostHandle>,
) {
  /** 实例与容器（加载 effect 的 cleanup 负责销毁）。 */
  const instanceRef = useRef<StoryboardInstance | null>(null);
  const containersRef = useRef<Map<StoryboardLayer, HTMLDivElement>>(new Map());
  /** 订阅表：组件级持有（加载 effect 与 dispatchJudge / playState 广播都要访问）。 */
  const judgeListenersRef = useRef(new Set<(e: StoryboardJudgeEvent) => void>());
  /* —— §3.7 v3：指针（对象池，零逐帧分配）——
     池里的对象**跨帧复用**，故事板读到的是同一批实例；需要跨帧留存请自行拷数值。
     `pointerList` 原地改内容（长度可变），数组引用恒定，与 snapshot 的既有约定一致。 */
  const pointerPoolRef = useRef(new Map<number, StoryboardPointer>());
  const pointerListRef = useRef<StoryboardPointer[]>([]);
  /** 判定拦截器（注册序 = 插入序；AND 串联）。组件级持有：dispose 时统一清空。 */
  const pointerFiltersRef = useRef(new Set<StoryboardPointerFilter>());
  /** 已经 warn 过异常的拦截器：同一回调只提醒一次，避免每帧刷屏。 */
  const filterWarnedRef = useRef(new WeakSet<StoryboardPointerFilter>());
  const seekListenersRef = useRef(new Set<(t: number) => void>());
  const playStateListenersRef = useRef(new Set<(p: StoryboardPlayState) => void>());
  const endListenersRef = useRef(new Set<() => void>());
  /** 帧率 EMA（api.perf.fps；由 rAF 循环写入）。 */
  const fpsRef = useRef(0);
  /** props 镜像（rAF 闭包读取，避免重建加载 effect）。 */
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** 只读快照：同一对象每帧原地刷新。 */
  const snapshotRef = useRef<StoryboardSnapshot>({
    timeSec: 0,
    playing: false,
    paused: false,
    score: 0,
    combo: 0,
    maxCombo: 0,
    accuracy: 100,
    counts: { sPerfect: 0, perfect: 0, good: 0, miss: 0 },
    totalNotes: 0,
    judged: 0,
    progress: 0,
    rank: '',
    scoreFull: SCORE_BASE,
    judgeWindows: { sPerfect: 40, perfect: 80, good: 160 },
  });

  // App 侧通过 ref 调用：判定事件 → 全部 onJudge 订阅者（回调异常互不影响）。
  useImperativeHandle(handle, () => ({
    dispatchJudge(e: StoryboardJudgeEvent) {
      judgeListenersRef.current.forEach((cb) => {
        try {
          cb(e);
        } catch (err) {
          console.warn('[storyboard] onJudge 回调异常（已忽略）', err);
        }
      });
    },
  }), []);

  // —— 播放状态广播（props 变化时通知订阅者）——
  const prevPlayStateRef = useRef<StoryboardPlayState>({ playing, paused });
  useEffect(() => {
    const prev = prevPlayStateRef.current;
    if (prev.playing !== playing || prev.paused !== paused) {
      const next = { playing, paused };
      playStateListenersRef.current.forEach((cb) => {
        try {
          cb(next);
        } catch (err) {
          console.warn('[storyboard] onPlayState 回调异常（已忽略）', err);
        }
      });
      // playing true→false（曲终 / 退出，非暂停）→ 曲终通知（§3.7 v2 onEnd）。
      if (prev.playing && !playing && !paused) {
        endListenersRef.current.forEach((cb) => {
          try {
            cb();
          } catch (err) {
            console.warn('[storyboard] onEnd 回调异常（已忽略）', err);
          }
        });
      }
      prevPlayStateRef.current = next;
    }
  }, [playing, paused]);

  // —— 加载 / 重建 / 销毁 ——
  useEffect(() => {
    let cancelled = false;
    /** 本局内是否已停用（update 抛异常后不再驱动）。 */
    let dead = false;

    /**
     * api.scene 的状态（§3.7 v4）。
     *
     * ⚠️ **必须声明在 `disposeAll` 之前**：下面的"防御性清场"会在本 effect 的
     * 中段就调用一次 `disposeAll()`，而 `const` 有 TDZ（死区）——声明在后面的话
     * 那次调用会抛 `ReferenceError: Cannot access 'sceneHandle' before
     * initialization`，整个游戏直接白屏（实测踩过）。
     */
    const sceneHandle: StoryboardScene = {
      canvas: null,
      width: 0,
      height: 0,
      scale: 1 / 6,
      enabled: false,
    };
    /** 复制的源画布（缓存，避免每帧 querySelector）。 */
    let sceneSrc: HTMLCanvasElement | null = null;
    let sceneCtx: CanvasRenderingContext2D | null = null;

    /** 销毁当前实例 + 容器 + 画布受控样式（不触碰 cancelled）。 */
    const disposeAll = () => {
      dead = true;
      const inst = instanceRef.current;
      instanceRef.current = null;
      // 先快照 canvas：故事板 dispose 里常会先 `canvas.remove()`，之后再查就查不到了。
      const canvases: HTMLCanvasElement[] = [];
      containersRef.current.forEach((div) => {
        const found = collectCanvases(div);
        for (let i = 0; i < found.length; i++) canvases.push(found[i]);
      });
      try {
        inst?.dispose?.();
      } catch (e) {
        console.warn('[storyboard] dispose 异常（已忽略）', e);
      }
      /* 故事板建了自己的 WebGLRenderer：dispose 不释放上下文，这里主动作废，
         否则反复加载会耗尽浏览器的上下文上限（丢失最旧的那个）。 */
      for (let i = 0; i < canvases.length; i++) loseWebglContext(canvases[i]);
      containersRef.current.forEach((div) => div.remove());
      containersRef.current.clear();
      // 受控视觉复位：画布 + HUD（两者同一套白名单，故同一份复位值）。
      resetStyle(gameViewportRef.current);
      resetStyle(hudRef?.current);
      // 判定拦截器与音频效果必须一并清干净：否则故事板卸载后玩家会永久打不出音
      // （拦截器残留）或一直听着被压低的声场（效果残留）。
      pointerFiltersRef.current.clear();
      filterWarnedRef.current = new WeakSet();
      pointerPoolRef.current.clear();
      pointerListRef.current.length = 0;
      // 画面快照：停复制并丢弃画布（否则故事板卸载后仍每帧做一次 GPU 拷贝）
      resetScene(sceneHandle);
      const bridge = pointerBridge;
      if (bridge) bridge.blockedIds.clear();
      globalAudio.resetMasterEffect();
    };
    /** effect 卸载：置 cancelled + 全量销毁。 */
    const cleanup = () => {
      cancelled = true;
      disposeAll();
    };
    // 防御性清场（正常情况下 React 已先跑过上一局的 cleanup）。
    // ⚠️ disposeAll 会置 dead = true（面向"上一个实例"），本会话必须复位，
    // 否则帧循环第一帧就退出 —— 症状会是"故事板完全不动，但 onJudge 还活着"。
    disposeAll();
    dead = false;
    if (!storyUrl) {
      // 无故事板（未提供 / 被 disableExtraContent 禁用 / 宿主未挂）：没有预热，
      // 立即放行时钟，避免时钟被永久挂起（只能靠兜底超时启动）。
      onReady?.();
      return cleanup;
    }

    // —— §3.7 v2：谱面派生数据（开局一次性构建，之后只读，不进热路径）——
    const chart = chartRef?.current ?? null;
    const chartMeta = buildChartMeta(chart);
    const beatConv = makeBeatConverters(chartMeta);
    const noteTimeline = buildNoteTimeline(chart);
    const storyPalette = buildPalette(chart);

    /** api.audio：频谱（只读）+ 主输出总效果（写入侧，内部脏检查 + 平滑）。 */
    const audioHandle: {
      levels(): StoryboardAudioLevels;
      setMasterEffect(effect: StoryboardMasterEffect): void;
    } = {
      levels: () => globalAudio.getSpectrum(),
      setMasterEffect(effect: StoryboardMasterEffect) {
        try {
          globalAudio.setMasterEffect(effect);
        } catch (e) {
          console.warn('[storyboard] setMasterEffect 异常（已忽略）', e);
        }
      },
    };

    /** api.assets：歌曲目录相对资源。
     *
     * 查找顺序（先 idb 后 URL，故事板侧代码不变）：
     *   ① `songAssets[relPath]` —— zip 导入 / 下载到本地时是 `idb://` 引用；
     *   ② 歌曲目录基址拼出的 URL —— 在线 / 静态托管。
     * ① 保证离线可用（不挂外链），② 覆盖没有 assets 映射的在线场景。
     */
    const assetsHandle: StoryboardAssetsHandle = {
      async url(relPath: string): Promise<string> {
        // ① 显式/约定收录的外部资源（idb:// 或绝对 URL 都直接用）
        const mapped = songAssets?.[relPath] ?? songAssets?.[relPath.replace(/^\.\//, '')];
        if (mapped) return mapped;
        if (!resolveAssetUrl) {
          throw new Error('[storyboard.assets] 当前宿主未提供歌曲目录基址，资源不可用');
        }
        // ② 回退：story.js 同目录（App 侧按 storyUrl 推导）
        return resolveAssetUrl(relPath);
      },
      async fetch(relPath: string): Promise<Response> {
        return fetch(await assetsHandle.url(relPath));
      },
      async json(relPath: string): Promise<unknown> {
        // 记录最近一次尝试的**绝对 URL 与 HTTP 状态**到 window：故事板侧只能看到
        // reject 的一句话，分不清"基址算错了"和"文件真的不在服务器上"。
        // 走 window 而非 console —— 产物 minify 开了 drop_console，控制台留不下痕迹。
        const note = (patch: Record<string, unknown>): void => {
          const g = globalThis as unknown as { __assetFetchLog?: unknown[] };
          if (!Array.isArray(g.__assetFetchLog)) g.__assetFetchLog = [];
          g.__assetFetchLog.push({ relPath, base: songAssetBase ?? '(未提供)', ...patch });
          if (g.__assetFetchLog.length > 20) g.__assetFetchLog.shift();
        };
        let url: string;
        try {
          url = await assetsHandle.url(relPath);
        } catch (e) {
          note({ stage: 'resolve', error: String((e as Error)?.message ?? e) });
          throw e;
        }
        let res: Response;
        try {
          res = await fetch(url);
        } catch (e) {
          note({ stage: 'fetch', url, error: String((e as Error)?.message ?? e) });
          throw e;
        }
        note({ stage: 'http', url, status: res.status, ok: res.ok });
        if (!res.ok) throw new Error(`[storyboard.assets] ${relPath} 加载失败（HTTP ${res.status}）`);
        return (await res.json()) as unknown;
      },
    };

    /** 指针兜底投影：无主相机投影时按图层尺寸线性近似（与 toScreen 回退一致）。 */
    const fallbackProject = (x: number, y: number): { sx: number; sy: number } => {
      const el = containersRef.current.get('bg')?.parentElement;
      const w = el?.clientWidth ?? window.innerWidth;
      const h = el?.clientHeight ?? window.innerHeight;
      return { sx: ((x + JUDGE_PLANE.x) / (JUDGE_PLANE.x * 2)) * w, sy: ((JUDGE_PLANE.y - y) / (JUDGE_PLANE.y * 2)) * h };
    };

    /** api.input：指针快照 + 判定拦截器 + 立即脱手。 */
    const inputHandle = {
      get pointers(): readonly StoryboardPointer[] {
        return pointerListRef.current;
      },
      setPointerFilter(fn: StoryboardPointerFilter | null): () => void {
        if (typeof fn !== 'function') return () => undefined;
        pointerFiltersRef.current.add(fn);
        return () => {
          pointerFiltersRef.current.delete(fn);
        };
      },
      releasePointerBindings(pointerId: number): void {
        const bridge = pointerBridge;
        if (!bridge) return;
        try {
          bridge.releaseBindings(pointerId);
        } catch (e) {
          console.warn('[storyboard] releasePointerBindings 异常（已忽略）', e);
        }
      },
    };
    /** 拦截器异常节流：同一时刻只提醒一次（每 2s 最多一条），防每帧刷屏。 */
    let lastFilterWarnMs = 0;
    const warnFilterError = (err: unknown): void => {
      const nowMs = Date.now();
      if (nowMs - lastFilterWarnMs < 2000) return;
      lastFilterWarnMs = nowMs;
      console.warn('[storyboard] 指针拦截器异常（已按放行处理）', err);
    };
    /** api.perf：帧率 EMA + 画质快照（getter 实时读，设置改动即刻生效）。 */
    const perfHandle: { fps(): number; readonly quality: StoryboardQuality } = {
      fps: () => fpsRef.current,
      get quality(): StoryboardQuality {
        return resolveStoryboardQuality(qualityStore.getSnapshot());
      },
    };

    /**
     * 每帧在 `update` 之前把游戏画布缩放复制到快照画布（§3.7 v4）。
     * 独立函数是为了能单测（`clampSceneScale` / `resetScene` 已是纯函数导出）。
     * ⚠️ 用箭头函数而非 `function` 声明：它只在本 effect 帧循环里被调用，
     * 那时 sceneHandle 早已初始化完毕，不涉及 TDZ。
     */
    const refreshScene = (): void => {
      if (!sceneHandle.enabled) return;
      // 源画布：① 游戏侧显式回写（权威）；② 兜底才查 DOM，且**必须排除故事板自己的画布**。
      //
      // ⚠️ 为什么要显式回写：渲染器重建时容器里可能残留旧画布（GameCanvas setup 里就有
      // `querySelector('canvas')?.remove()`），猜错就会把**故事板自己的 overlay 画布**
      // 当成游戏画面抓回来 → 每帧把上帧的域内画面再画进域内 → 逐帧自我反馈累积
      // （实机症状：域内"大量历史帧糊成一块"，且越玩越亮 —— 一帧比一帧橙）。
      const explicit = gameCanvasRef?.current ?? null;
      if (explicit && explicit.isConnected) {
        sceneSrc = explicit;
      } else if (!sceneSrc || !sceneSrc.isConnected || isStoryboardCanvas(sceneSrc)) {
        const cand = (gameViewportRef.current?.querySelector('canvas') ?? null) as
          | HTMLCanvasElement
          | null;
        sceneSrc = cand && !isStoryboardCanvas(cand, {
          bg: bgSlotRef.current,
          overlay: overlaySlotRef.current,
        })
          ? cand
          : null;
      }
      const src = sceneSrc;
      const sw = src?.clientWidth ?? 0;
      const sh = src?.clientHeight ?? 0;
      if (!src || sw <= 0 || sh <= 0) {
        sceneHandle.canvas = null;
        sceneHandle.width = 0;
        sceneHandle.height = 0;
        return;
      }
      const s = clampSceneScale(sceneHandle.scale);
      const dw = Math.max(1, Math.round(sw * s));
      const dh = Math.max(1, Math.round(sh * s));
      if (!sceneHandle.canvas || sceneHandle.canvas.width !== dw || sceneHandle.canvas.height !== dh) {
        const c = document.createElement('canvas');
        c.width = dw;
        c.height = dh;
        sceneHandle.canvas = c;
        sceneCtx = null;
      }
      if (!sceneCtx) sceneCtx = sceneHandle.canvas.getContext('2d');
      if (!sceneCtx) {
        sceneHandle.canvas = null;
        return;
      }
      try {
        // ⚠️ **必须用 'copy' 合成模式**，这是"历史帧逐帧累积"的唯一根因。
        //
        // `drawImage` 默认 `source-over`：结果 = src + dst·(1-srcAlpha)。而 3D 渲染器
        // 是 `alpha: true`，画布大片区域是**透明**的（背景在 CSS / 场景背景上）。
        // 透明像素在 source-over 下**不覆盖目标** → 上一帧的音符留在快照里，
        // 下一帧又叠一层 → 域内"大量历史帧糊成一块、越玩越亮"。
        //
        // 佐证：调整窗口大小能清掉一次残留 —— 因为尺寸变化会重建这张 2D 画布
        //（`canvas.width = dw` 会清空），累积随之清零。
        //
        // 'copy' 直接用源替换目标（含透明区域），一次操作同时完成"清 + 画"。
        // 3D 渲染器开了 preserveDrawingBuffer，所以 drawImage 读得到上一帧画面。
        copyCanvas(sceneCtx, src, dw, dh);
        sceneHandle.width = dw;
        sceneHandle.height = dh;
      } catch {
        // 上下文丢失 / 画布不可读：本帧降级为"无快照"，故事板自行处理
        sceneHandle.canvas = null;
        sceneHandle.width = 0;
        sceneHandle.height = 0;
      }
    };

    /**
     * 同步刷新指针快照 + 回写 `blockedIds`。
     *
     * 两条路径共用：① 宿主 rAF（常规）；② 游戏侧查询拦截前（`bridge.syncBlocked`）——
     * 游戏的 tap 判定在 pointerdown 事件回调里同步查 `blockedIds`，若只靠 rAF 更新，
     * 第一次按下读到的必然是上一帧的结论 → 故事板挡不住这一击（实测）。
     */
    const refreshBlockedIds = (): void => {
      const bridge = pointerBridge;
      if (!bridge) {
        pointerListRef.current.length = 0;
        pointerPoolRef.current.clear();
        return;
      }
      syncPointers(
        pointerPoolRef.current,
        pointerListRef.current,
        bridge.pointers,
        bridge.project ?? fallbackProject,
        pointerFiltersRef.current,
        warnFilterError,
      );
      const ids = bridge.blockedIds;
      ids.clear();
      const list = pointerListRef.current;
      for (let i = 0; i < list.length; i++) {
        if (list[i].blocked) ids.add(list[i].id);
      }
    };

    // 故事板完成重型初始化后经 api.markReady() 通知一次 → 上报 App（每局只放行一次）。
    let readyFired = false;
    const markReady = (): void => {
      if (readyFired) return;
      readyFired = true;
      try {
        onReady?.();
      } catch (e) {
        console.warn('[storyboard] onReady 回调异常（已忽略）', e);
      }
    };

    const api: StoryboardApi = {
      // three 命名空间（与游戏同一实例）：零构建故事板可直接取用；
      // external 构建的故事板经 importmap shim 拿到同一份。
      three: THREE,
      mount(layer: StoryboardLayer): HTMLDivElement {
        // 同层重复 mount → 替换旧容器（语义：一个故事板每层一个容器）。
        const prev = containersRef.current.get(layer);
        if (prev) prev.remove();
        const slot = layer === 'bg' ? bgSlotRef.current : overlaySlotRef.current;
        const div = makeLayerContainer(layer);
        containersRef.current.set(layer, div);
        if (slot) slot.appendChild(div);
        else console.warn(`[storyboard] ${layer} 层占位容器缺失，故事板该层不可见`);
        return div;
      },
      game: {
        style(patch: StoryboardGameStylePatch) {
          applyStylePatch(gameViewportRef.current, patch);
        },
      },
      hud: {
        style(patch: StoryboardGameStylePatch) {
          applyStylePatch(hudRef?.current, patch);
        },
      },
      input: inputHandle,
      assets: assetsHandle,
      scene: sceneHandle,
      get chartData(): Readonly<Record<string, unknown>> | null {
        return (chart as unknown as Record<string, unknown>) ?? null;
      },
      toScreen(x: number, y: number) {
        // 首选：GameCanvas 主相机实时投影（精确）。
        const project = projectorRef?.current;
        if (project) return project(x, y);
        // 回退：线性映射 ±2.4/±1.5 → bg 层矩形（近似；3D 透视下略有偏差）。
        const el = containersRef.current.get('bg')?.parentElement;
        const w = el?.clientWidth ?? window.innerWidth;
        const h = el?.clientHeight ?? window.innerHeight;
        return { sx: ((x + 2.4) / 4.8) * w, sy: ((1.5 - y) / 3) * h };
      },
      get snapshot(): StoryboardSnapshot {
        return snapshotRef.current;
      },
      // —— §3.7 v2 ——
      chart: chartMeta,
      beatAt(t: number) {
        return beatConv.beatAt(t);
      },
      timeAtBeat(beat: number) {
        return beatConv.timeAtBeat(beat);
      },
      safeZone(margin = 0) {
        const host = containersRef.current.get('bg')?.parentElement;
        const w = host?.clientWidth ?? window.innerWidth;
        const h = host?.clientHeight ?? window.innerHeight;
        return computeSafeZone(projectorRef?.current, w, h, margin);
      },
      notes(fromSec: number, toSec: number) {
        return sliceNotes(noteTimeline, fromSec, toSec);
      },
      get audio() {
        return audioHandle;
      },
      get perf(): { fps(): number; readonly quality: StoryboardQuality } {
        return perfHandle;
      },
      palette: storyPalette,
      onEnd(cb) {
        endListenersRef.current.add(cb);
        return () => {
          endListenersRef.current.delete(cb);
        };
      },
      onJudge(cb) {
        judgeListenersRef.current.add(cb);
        return () => judgeListenersRef.current.delete(cb);
      },
      onSeek(cb) {
        seekListenersRef.current.add(cb);
        return () => seekListenersRef.current.delete(cb);
      },
      onPlayState(cb) {
        playStateListenersRef.current.add(cb);
        // 订阅即推送当前状态（实例在播放中途创建也不丢状态）。
        try {
          cb({ playing: playingRef.current, paused: pausedRef.current });
        } catch (err) {
          console.warn('[storyboard] onPlayState 回调异常（已忽略）', err);
        }
        return () => playStateListenersRef.current.delete(cb);
      },
      // 故事板重型初始化完成后调用（见上方 markReady 定义）。
      markReady,
    };

    // 动态加载 → 契约校验 → 建实例 → 起帧循环。任何一步失败都只降级。
    // 首次加载前注入「three → 宿主命名空间」importmap（幂等；必须在任何裸名
    // 'three' 解析前 —— 应用本体无裸名 three 运行时解析，这里是首个消费者）。
    ensureThreeImportMap(THREE);
    import(/* @vite-ignore */ storyUrl)
      .then((mod) => {
        if (cancelled) return;
        // 接受 default export 或模块本体（宽松：谁身上有 create() 就用谁）。
        const raw: unknown = (mod as { default?: unknown } | undefined)?.default ?? mod;
        if (!isStoryboardModule(raw)) {
          markReady(); // 无可用实例 → 立即放行时钟，避免被永久挂起
          console.warn('[storyboard] story.js 缺少 create()，已忽略。', storyUrl);
          return;
        }
        const m: StoryboardModule = raw;
        let inst: StoryboardInstance;
        try {
          inst = m.create(api);
        } catch (e) {
          markReady(); // 建实例失败 → 立即放行时钟
          console.warn('[storyboard] create() 抛异常，已忽略该故事板。', e);
          return;
        }
        if (cancelled) {
          try {
            inst.dispose?.();
          } catch {
            /* 已取消：实例随即丢弃，dispose 失败无需处理 */
          }
          return;
        }
        instanceRef.current = inst;
        // 让游戏侧在查询拦截前能**同步**重算 blockedIds（时序正确性，见 refreshBlockedIds）。
        if (pointerBridge) pointerBridge.syncBlocked = refreshBlockedIds;
        // 初始尺寸 + 随窗口变化（以任一已挂载层的宿主占位尺寸为准）。
        const measure = () => {
          const host = containersRef.current.get('bg')?.parentElement
            ?? containersRef.current.get('overlay')?.parentElement;
          const w = host?.clientWidth ?? window.innerWidth;
          const h = host?.clientHeight ?? window.innerHeight;
          try {
            inst.setSize?.(w, h);
          } catch (e) {
            console.warn('[storyboard] setSize 异常（已忽略）', e);
          }
        };
        measure();
        window.addEventListener('resize', measure);

        // 帧循环：与判定时钟同源；seek 用时间不连续检测广播。
        let lastT = Number.NaN;
        let lastFrameMs = 0;
        const loop = () => {
          if (dead) return;
          requestAnimationFrame(loop);
          // 帧率 EMA（api.perf.fps）：仅统计，不参与任何游戏逻辑。
          const nowMs = performance.now();
          if (lastFrameMs > 0) {
            const dtMs = nowMs - lastFrameMs;
            if (dtMs > 0) {
              const inst = 1000 / dtMs;
              fpsRef.current = fpsRef.current > 0 ? fpsRef.current * 0.9 + inst * 0.1 : inst;
            }
          }
          lastFrameMs = nowMs;
          /* 时间源：音频时钟运行时严格用它（与判定时钟同源）；未运行（菜单/暂停/
             编辑器未预览/曲终）时退回宿主的 playhead —— 否则拖动进度条故事板不动。 */
          const t = resolveStoryboardTime(
            globalAudio.isRunning(),
            globalAudio.getCurrentTime(),
            /* 回退时间源：直接读播放头的单一真相（编辑器预览播放时它由 App 的 HUD
             * rAF 实时写入，故编辑器内一样跟得上），不再经 App 的 ref 镜像。 */
            playheadStore.getSnapshot().timeSec,
            /* 仅当本局仍在进行（playing / paused）时才认音频时钟。曲终后
             * fadeOutAndStop 会**故意**让 isPlaying 保持为真，若据此认音频时钟，
             * 回到编辑器后故事板会继续跑。 */
            playingRef.current || pausedRef.current,
          );
          const snap = buildSnapshotInto(
            snapshotRef.current,
            statsRef.current ?? undefined,
            t,
            playingRef.current,
            pausedRef.current,
          );
          if (Number.isFinite(lastT) && Math.abs(t - lastT) > SEEK_JUMP_SEC) {
            seekListenersRef.current.forEach((cb) => {
              try {
                cb(t);
              } catch (e) {
                console.warn('[storyboard] onSeek 回调异常（已忽略）', e);
              }
            });
          }
          lastT = t;
          /* §3.7 v3：指针同步（快照 + 拦截判定）。
             必须在 update 之前 —— 故事板在本帧 update 里读到的指针与本帧判定用的
             blockedIds 是同一份结论。游戏侧 pointerdown 当帧同步查询 blockedIds，
             所以"碰到即拦"不会有任何延迟（不依赖本行的执行时机）。 */
          const bridge = pointerBridge ?? null;
          if (bridge) {
            refreshBlockedIds();
          } else if (pointerListRef.current.length > 0) {
            // 无桥（2D / 故事板未挂载）：快照清空，判定侧自然不拦截。
            pointerListRef.current.length = 0;
            pointerPoolRef.current.clear();
          }
          try {
            // 画面快照必须在 update 之前刷新：故事板在本帧 update 里上传的就是它。
            // （取到的是游戏上一帧的画面 —— 3D 渲染器开了 preserveDrawingBuffer。）
            refreshScene();
            inst.update(t, snap);
          } catch (e) {
            // update 抛异常只 warn 一次并停止驱动，避免每帧刷屏；游戏不受影响。
            console.warn('[storyboard] update() 抛异常，停用该故事板。', e);
            dead = true;
            // 与 disposeAll 同序：先快照 canvas（dispose 会先 remove 它们），
            // 再 dispose，最后作废上下文 —— 否则这条路径每局泄漏一个 context。
            const canvases: HTMLCanvasElement[] = [];
            containersRef.current.forEach((div) => {
              const found = collectCanvases(div);
              for (let i = 0; i < found.length; i++) canvases.push(found[i]);
            });
            try {
              inst.dispose?.();
            } catch {
              /* dispose 失败也要继续：下面仍要作废 canvas 的 WebGL 上下文，不能中断拆除 */
            }
            for (let i = 0; i < canvases.length; i++) loseWebglContext(canvases[i]);
            instanceRef.current = null;
          }
        };
        requestAnimationFrame(loop);
      })
      .catch((e) => {
        // 加载失败 → 没有故事板也就没有预热，立即放行时钟，避免被永久挂起。
        markReady();
        if (!cancelled) console.warn('[storyboard] 加载失败，降级为无故事板。', storyUrl, e);
      });

    return cleanup;
    // playSession 变化 = 重开局：dispose 旧实例并重建（storyUrl 通常不变）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyUrl, playSession]);

  // 本组件不渲染 JSX；容器由 App 的占位 ref 提供 z 序。
  return null;
}

export const StoryboardHost = forwardRef<StoryboardHostHandle, StoryboardHostProps>(StoryboardHostImpl);
