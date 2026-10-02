/**
 * 故事板（story.js）宿主契约 —— §3.7。
 *
 * 故事板是**纯表现层**：只读游戏实时数据来驱动自身演出，绝不回写、不影响游戏逻辑。
 * 加载方式：ES Module 动态 `import()`（在线为 URL；zip 内经 idb → blob URL）。
 * 仅完整版 3D 渲染器（GameCanvas）挂载；2D / Lite 不支持。
 *
 * 契约（default export，缺省字段全部可选）：
 * ```js
 * export default {
 *   create(api) {
 *     const bg = api.mount('bg');        // 背景层容器（音符后），可不用
 *     const ov = api.mount('overlay');   // 覆盖层容器（音符上、HUD 下），可不用
 *     api.game.style({ opacity: 0.9 });  // 受控画布样式（DOM 级白名单）
 *     api.onJudge((e) => { /* 判定事件流 *\/ });
 *     api.onSeek((t) => { /* seek 通知 *\/ });
 *     api.onPlayState((p) => { /* 播放/暂停 *\/ });
 *     return {
 *       update(t, snapshot) { /* 每帧；t = 歌曲绝对秒 *\/ },
 *       setSize(w, h) {},
 *       dispose() {},
 *     };
 *   },
 * };
 * ```
 *
 * `api.snapshot` 是宿主**每帧原地刷新的同一对象**（读到的永远是最新值，不要持有旧引用）。
 */

import type { QualityMode } from './game';

export type StoryboardLayer = 'bg' | 'overlay';

export type StoryboardJudgeLevel = 'S-Perfect' | 'Perfect' | 'Good' | 'Miss';

/** 谱面元数据（只读）—— §3.7 v2：让故事板不必硬编码 BPM，并支持密度归一化。 */
export interface StoryboardChartMeta {
  title: string;
  artist: string;
  difficulty: string;
  /** 基准 BPM（无变速时即全曲 BPM）。 */
  bpm: number;
  /** 音频偏移（秒）。 */
  offset: number;
  /** 变速表（可选；拍 → BPM 的升序断点）。 */
  bpmlist?: Array<{ beat: number; bpm: number }>;
  /** 可判定音符总数（与 `snapshot.totalNotes` 同源；fake / noScore 不计）。 */
  noteCount: number;
  /** 音符密度（个/秒），用于把"绝对计数"换算成"占比"。 */
  noteDensity: number;
  /** 谱面时长估计（秒；末音符 + 尾奏余量）。 */
  durationSec: number;
  /** 首音符时间（秒）。 */
  firstNoteSec: number;
}

/** 只读音符切片（秒坐标 + 判定面坐标）。 */
export interface StoryboardNote {
  /** 音符时间（秒，与 `update(t)` 同源）。 */
  t: number;
  /** 判定面 x（±2.4）。 */
  x: number;
  /** 判定面 y（±1.5）。 */
  y: number;
  type: 'tap' | 'touch' | 'slide';
  fake?: boolean;
  noScore?: boolean;
}

/** 音频频谱能量（0~1 归一化；不可用时全 0）。 */
export interface StoryboardAudioLevels {
  /** 20–250 Hz。 */
  bass: number;
  /** 250–2000 Hz。 */
  mid: number;
  /** 2000–8000 Hz。 */
  treble: number;
  /** 全频段平均（≈响度）。 */
  level: number;
}

/** 画质设置只读快照（让故事板与游戏画面设置对齐、并据此降级）。 */
export interface StoryboardQuality {
  mode: QualityMode;
  antialias: boolean;
  bloom: boolean;
  particles: boolean;
  lighting: boolean;
  hitEffects: boolean;
  renderScale: number;
  /** 0 = 低 / 1 = 中 / 2 = 高（由档位推导，故事板据此降规模）。 */
  tier: 0 | 1 | 2;
}

/** 曲目配色（让故事板与画面统一）。 */
export interface StoryboardPalette {
  noteColor?: string;
  accent?: string;
  bgStart?: string;
  bgEnd?: string;
}

/** 中央判定区在画布上的包围盒（CSS 像素）—— 故事板的安全区。 */
export interface StoryboardSafeZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 只读快照：宿主每帧原地刷新（同一对象引用）。 */
export interface StoryboardSnapshot {
  /** 歌曲绝对时间（秒），与游戏判定时钟同源。 */
  timeSec: number;
  playing: boolean;
  paused: boolean;
  score: number;
  combo: number;
  maxCombo: number;
  /** 0~100。 */
  accuracy: number;
  counts: {
    sPerfect: number;
    perfect: number;
    good: number;
    miss: number;
  };
  /** 可判定音符总数（fake 不计入）。 */
  totalNotes: number;
  /** 已判定数（sPerfect + perfect + good + miss）。 */
  judged: number;
  /** 判定进度 0~1（judged / totalNotes；未知时为 0）。 */
  progress: number;
  /** 当前评级（与 HUD 同源）。 */
  rank: string;
  /** 满分（1000 万制），用于把 score 归一化到 0~1。 */
  scoreFull: number;
  /** 判定窗口（毫秒），用于把 `onJudge` 的 deltaT 归一化成 0~1。 */
  judgeWindows: { sPerfect: number; perfect: number; good: number };
}

/** 一次判定（含 slide 子节点；noScore 音符不推送）。 */
export interface StoryboardJudgeEvent {
  level: StoryboardJudgeLevel;
  /** 判定发生时的歌曲时间（秒，宿主当时钟近似值）。 */
  timeSec: number;
  /** <0 = early，>=0 = late。 */
  deltaT: number;
  /** 判定面坐标（±2.4 / ±1.5）。 */
  x: number;
  y: number;
  noteType: 'tap' | 'touch' | 'slide';
}

/** 游戏画布受控柄（v1 = DOM 级白名单；`scene` 等深度控制为未来扩展位）。 */
export interface StoryboardGameHandle {
  /**
   * 受控修改游戏画布容器的**纯视觉样式**。
   * 仅接受白名单键（opacity / filter / transform），其余键被忽略；
   * seek / 重开局 / dispose 时宿主自动复位为默认值。
   */
  style(patch: StoryboardGameStylePatch): void;
}

/** 判定面坐标 → 画布 CSS 像素的投影函数（由 3D 渲染器用主相机实时提供）。 */
export type JudgeProjector = (x: number, y: number) => { sx: number; sy: number };

export interface StoryboardGameStylePatch {
  /** 0~1，越界截断。 */
  opacity?: number;
  /** CSS filter 字符串。 */
  filter?: string;
  /** CSS transform 字符串。 */
  transform?: string;
}

export interface StoryboardPlayState {
  playing: boolean;
  paused: boolean;
}

/** 宿主注入给 create 的只读 API。 */
export interface StoryboardApi {
  /**
   * 宿主的 three.js 命名空间（**与游戏同一模块实例**，经 importmap shim /
   * `import * as THREE from 'three'` 拿到的是同一份）。
   * 仅是类/工具的命名空间 —— 游戏的 scene / camera / renderer 不暴露，
   * 故事板自建 renderer/canvas，互不影响渲染管线。zero-build 故事板可直接
   * `const THREE = api.three`；external 构建的故事板运行时自动共享。
   */
  readonly three: typeof import('three');
  /**
   * 挂载一个渲染层容器并返回（可多次调用，bg/overlay 并存、共享同一时间轴）。
   * 容器：absolute 铺满、pointer-events:none、overflow:hidden —— 故事板自建 canvas/renderer。
   */
  mount(layer: StoryboardLayer): HTMLDivElement;
  /** 游戏画布受控柄（v1 仅 DOM 级样式白名单）。 */
  game: StoryboardGameHandle;
  /**
   * 判定面坐标（±2.4 / ±1.5，z = 判定面）→ 画布 CSS 像素 `{sx, sy}`。
   * 由 3D 渲染器的主相机**实时投影**（bloom / 分辨率 / 相机参数变化均正确），
   * 用于把判定/音符位置画在与游戏对齐的 overlay 上。
   */
  toScreen(x: number, y: number): { sx: number; sy: number };
  /** 只读快照（同一对象每帧原地刷新）。 */
  readonly snapshot: StoryboardSnapshot;
  /**
   * 当前谱面元数据（§3.7 v2）。开局时确定，整局不变。
   * 故事板据此做节拍换算，**不要硬编码 BPM**（变速谱会全错）。
   */
  readonly chart: StoryboardChartMeta;
  /** 秒 → 拍（含变速）。与 `snapshot.timeSec` 同源。 */
  beatAt(t: number): number;
  /** 拍 → 秒（含变速）。 */
  timeAtBeat(beat: number): number;
  /**
   * 中央判定区在画布上的包围盒（CSS px）；`margin` = 额外外扩像素。
   * 故事板应把发光元素排布在此盒之外（音符与游戏判定特效占用中央）。
   */
  safeZone(margin?: number): StoryboardSafeZone;
  /**
   * 只读音符切片（秒坐标，按时间升序）。整谱在开局一次性缓存，
   * **不进热路径** —— 用于"让演出与谱面共舞"（对齐重音、避开音符簇）。
   */
  notes(fromSec: number, toSec: number): StoryboardNote[];
  /**
   * 实时音频频谱（§3.7 v2）。⚠️ 依赖真实播放状态，**非 seek 安全**：
   * 只可用于非关键调制，缺失 / 暂停时返回全 0。
   */
  readonly audio: { levels(): StoryboardAudioLevels };
  /** 性能与画质（只读）—— 故事板据此自动降级规模。 */
  readonly perf: { fps(): number; readonly quality: StoryboardQuality };
  /** 曲目配色（让故事板与画面统一）。 */
  readonly palette: StoryboardPalette;
  /** 曲终 / 退出通知（`playing` true → false）；返回退订函数。 */
  onEnd(cb: () => void): () => void;
  /** 判定事件流订阅；返回退订函数。 */
  onJudge(cb: (e: StoryboardJudgeEvent) => void): () => void;
  /** seek 通知（t = seek 目标秒）；返回退订函数。 */
  onSeek(cb: (t: number) => void): () => void;
  /** 播放/暂停变化通知；返回退订函数。 */
  onPlayState(cb: (p: StoryboardPlayState) => void): () => void;
}

/** create 的返回实例（除 update 外均可选）。 */
export interface StoryboardInstance {
  /** 每帧调用：t = 歌曲绝对秒；snapshot 为同一对象的最新内容。 */
  update(t: number, snapshot: StoryboardSnapshot): void;
  /** 容器尺寸变化（初始也会调用一次）。 */
  setSize?(w: number, h: number): void;
  /** 重开局/切歌/卸载时调用一次；缺省时宿主仅清空容器。 */
  dispose?(): void;
}

/** story.js 的 default export 契约。 */
export interface StoryboardModule {
  create(api: StoryboardApi): StoryboardInstance;
}

/** 宽松校验任意 import() 结果是否为可用故事板模块（接受 default 或模块本体）。 */
export function isStoryboardModule(mod: unknown): mod is StoryboardModule {
  const m = (mod as { default?: unknown } | null | undefined)?.default ?? mod;
  return !!m && typeof m === 'object' && typeof (m as StoryboardModule).create === 'function';
}
