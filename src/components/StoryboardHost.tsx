import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref, RefObject } from 'react';
// 与游戏共用同一份 three（打包器去重，零额外体积）：经 importmap shim 注入给
// story.js（three external 构建）+ api.three 命名空间，消除双实例与相关警告。
// 故事板自建 renderer/canvas，游戏的 scene/renderer 不暴露 —— 渲染管线互不干扰。
import * as THREE from 'three';
import { ensureThreeImportMap } from '../utils/storyboardThree';
import { globalAudio } from '../audio/AudioManager';
import { PRESET_VALUES, qualityStore, type QualityState } from '../qualityStore';
import { beatToSecondsMultiBpm, countPlayableNotes, secondsToBeatMultiBpm } from '../utils/beatTime';
import { JUDGEMENT_THRESHOLDS } from '../utils/scoring';
import { SCORE_BASE } from '../shared/gameplaySpec';
import type { ChartData, GameStats } from '../types/game';
import {
  isStoryboardModule,
  type JudgeProjector,
  type StoryboardApi,
  type StoryboardAudioLevels,
  type StoryboardChartMeta,
  type StoryboardNote,
  type StoryboardPalette,
  type StoryboardQuality,
  type StoryboardSafeZone,
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
 *  - playSession / storyUrl 变化或卸载 → `dispose()` + 清空容器 + 复位画布受控样式。
 *
 * 本组件**不渲染任何 JSX**：bg/overlay 容器由 App 以 ref 占位（保证 z 序），宿主向其中
 * 命令式追加故事板自建的 DOM。判定事件经 `ref.handle.dispatchJudge()` 由 App 转发
 * （applyJudgement 热路径上只是一次 Set 遍历，零 React state）。
 */

/** 时间不连续阈值（秒）：正常播放每帧推进 ~16ms，超过即视为 seek。 */
const SEEK_JUMP_SEC = 0.75;

/** 画布受控样式的复位值（seek / 重开局 / dispose 时应用）。 */
export const GAME_STYLE_RESET = { opacity: '1', filter: '', transform: '' } as const;

/**
 * 纯函数（便于单测）：本帧故事板的时间源。
 *
 * 音频时钟运行时严格用它（与判定时钟同源）；未运行时（菜单 / 暂停 / 编辑器未预览 /
 * 曲终）`getCurrentTime()` 返回陈旧的 `pauseTime`，必须退回宿主的播放头时间，
 * 否则拖动进度条画面不更新。
 */
export function resolveStoryboardTime(
  audioRunning: boolean,
  audioTime: number,
  fallbackTime: number | undefined,
): number {
  return audioRunning ? audioTime : (fallbackTime ?? 0);
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
   * 宿主播放头时间（秒）的 ref —— **音频时钟未运行时的回退时间源**。
   *
   * `globalAudio.getCurrentTime()` 在未播放态返回陈旧的 `pauseTime`（见 AudioManager），
   * 因此编辑器未预览 / 暂停时拖动进度条若只更新 `gameTime`，故事板会停在旧画面。
   * 其它画布（`GameCanvas` / `Editor2DCanvas` / `GameCanvas2D`）全部写了
   * `playing ? getCurrentTime() : gameTime` 这条回退，本宿主此前漏了它。
   * 省略则回退到 0。
   */
  fallbackTimeRef?: RefObject<number>;
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
    statsRef,
    projectorRef,
    chartRef,
    storyUrl,
    fallbackTimeRef,
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
      const vp = gameViewportRef.current;
      if (vp) {
        vp.style.opacity = GAME_STYLE_RESET.opacity;
        vp.style.filter = GAME_STYLE_RESET.filter;
        vp.style.transform = GAME_STYLE_RESET.transform;
      }
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
    if (!storyUrl) return cleanup;

    // —— §3.7 v2：谱面派生数据（开局一次性构建，之后只读，不进热路径）——
    const chart = chartRef?.current ?? null;
    const chartMeta = buildChartMeta(chart);
    const beatConv = makeBeatConverters(chartMeta);
    const noteTimeline = buildNoteTimeline(chart);
    const storyPalette = buildPalette(chart);

    /** api.audio：转发给音频管理器的频谱（不可用时返回全 0）。 */
    const audioLevelsHandle: { levels(): StoryboardAudioLevels } = {
      levels: () => globalAudio.getSpectrum(),
    };
    /** api.perf：帧率 EMA + 画质快照（getter 实时读，设置改动即刻生效）。 */
    const perfHandle: { fps(): number; readonly quality: StoryboardQuality } = {
      fps: () => fpsRef.current,
      get quality(): StoryboardQuality {
        return resolveStoryboardQuality(qualityStore.getSnapshot());
      },
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
          const vp = gameViewportRef.current;
          if (!vp) return;
          const resolved = resolveGameStylePatch(patch);
          if (resolved.opacity !== undefined) vp.style.opacity = resolved.opacity;
          if (resolved.filter !== undefined) vp.style.filter = resolved.filter;
          if (resolved.transform !== undefined) vp.style.transform = resolved.transform;
        },
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
      get audio(): { levels(): StoryboardAudioLevels } {
        return audioLevelsHandle;
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
          console.warn('[storyboard] story.js 缺少 create()，已忽略。', storyUrl);
          return;
        }
        const m: StoryboardModule = raw;
        let inst: StoryboardInstance;
        try {
          inst = m.create(api);
        } catch (e) {
          console.warn('[storyboard] create() 抛异常，已忽略该故事板。', e);
          return;
        }
        if (cancelled) {
          try {
            inst.dispose?.();
          } catch {
            /* 忽略 */
          }
          return;
        }
        instanceRef.current = inst;
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
            fallbackTimeRef?.current,
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
          try {
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
              /* 忽略 */
            }
            for (let i = 0; i < canvases.length; i++) loseWebglContext(canvases[i]);
            instanceRef.current = null;
          }
        };
        requestAnimationFrame(loop);
      })
      .catch((e) => {
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
