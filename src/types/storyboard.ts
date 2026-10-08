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

/** 受控视觉样式句柄（`api.game` / `api.hud` 同构：只接受白名单三个键）。 */
export interface StoryboardStyleHandle {
  style(patch: StoryboardGameStylePatch): void;
}

// ============================ §3.7 v3：指针 / HUD / 音频写入 / 资源 ============================

/**
 * 游戏侧原始指针（判定面坐标）。与 `hooks/judgeContext` 的 `PointerState` 结构一致，
 * 这里独立声明以避免类型层反向依赖 hooks。
 */
export interface StoryboardRawPointer {
  x: number;
  y: number;
  down: boolean;
  active: boolean;
  type: string;
}

/**
 * 故事板看到的指针。**宿主每帧原地刷新同一批对象**（对象池，零逐帧分配）：
 * 需要跨帧留存时自行拷贝数值，不要持有旧引用。
 */
export interface StoryboardPointer {
  /** 指针 id（与 `pointerdown` 事件的 `pointerId` 同值）。 */
  id: number;
  /** 判定面 x（±2.4）。 */
  x: number;
  /** 判定面 y（±1.5）。 */
  y: number;
  /** 画布 CSS 像素 x（宿主用主相机实时投影换算，省故事板重复投影）。 */
  sx: number;
  /** 画布 CSS 像素 y。 */
  sy: number;
  down: boolean;
  /** 是否"在场"（触摸笔必须按住才 active；鼠标恒 true）。 */
  active: boolean;
  /** 'touch' | 'mouse' | 'pen' …（原样透传）。 */
  type: string;
  /**
   * 已被拦截器判定为**不参与游戏判定**。注意：被拦截的指针**仍会出现在快照里**
   * （宿主只过滤判定侧，不过滤观测侧），否则故事板拿不到坐标、无法绘制反馈。
   */
  blocked: boolean;
}

/**
 * 判定拦截器：返回 `false` = 该指针不参与任何判定（tap / touch / slide 全部屏蔽）。
 * 多个拦截器按注册顺序 AND 串联（任一返回 false 即拦截）；回调抛异常被宿主吞掉并
 * warn（与 `onJudge` 同策略），且**按放行处理**——故事板 bug 不该让玩家打不出音。
 */
export type StoryboardPointerFilter = (p: StoryboardPointer) => boolean;

/** `api.input`：指针观测 + 判定拦截。 */
export interface StoryboardInputHandle {
  /** 当前指针（只读；对象每帧原地刷新）。 */
  readonly pointers: readonly StoryboardPointer[];
  /** 注册判定拦截器（传 null 视为清空）；返回退订函数。 */
  setPointerFilter(fn: StoryboardPointerFilter | null): () => void;
  /**
   * 主动解除某指针在所有 slide 上的绑定（"立即脱手"），幂等。
   * 故事板在把某个指针"没收"（如永久失能）时调用一次即可。
   */
  releasePointerBindings(pointerId: number): void;
}

/**
 * 主输出总效果（**写入侧**；音乐 / 音效 / 打击音统一走这条链）。
 * 典型用途：随画面状态压低音量 + 加低通（"隔着介质听"）。
 * 省略的键保持当前值；`resetMasterEffect()` / seek / dispose 时由宿主复位。
 */
export interface StoryboardMasterEffect {
  /** 0~1 总增益（1 = 原音量）。 */
  gain?: number;
  /** 低通截止频率 Hz（clamp 20~20000；20000 ≈ 旁路）。 */
  lowpassHz?: number;
  /** 高通截止频率 Hz（clamp 20~20000；20 ≈ 旁路）。 */
  highpassHz?: number;
  /** 滤波器 Q（clamp 0.0001~30）。 */
  q?: number;
}

/**
 * `api.scene`：游戏画面快照（§3.7 v4）。
 *
 * 存在的理由：CSS `filter` 只能作用于**整个元素**，做不出 prpr 那种
 * "**只在域内**把背景位移 + 块量化"的效果 —— 那是靠 SceneColor 副本
 * （`_DisplaceBlendIntensity` / `_BackgroundPixelScale` / `snapshotSample`）
 * 在着色器里 composite 出来的。宿主每帧把游戏画布缩放复制到一张 2D 画布，
 * 故事板把它当纹理上传即可。
 *
 * 边界：
 *  - 复制发生在**每次 `update` 之前**，取到的是游戏**上一帧**的画面（差一帧，
 *    肉眼不可见；3D 渲染器开了 `preserveDrawingBuffer` 正是为了这个）；
 *  - 2D 渲染器同样可用（源是 2D 画布）；Lite 不挂故事板，不涉及；
 *  - 未开局 / 画布尺寸为 0 / 上下文丢失时 `canvas` 为 `null`，故事板需自行降级。
 */
export interface StoryboardScene {
  /**
   * 缩放后的画面（2D 画布）。`null` = 本帧不可用。
   * ⚠️ 由宿主每帧写入，**故事板侧只读**（改它没有任何效果，下一帧就被覆盖）。
   */
  canvas: HTMLCanvasElement | null;
  /** 快照尺寸（= 游戏画布尺寸 × scale 取整）。故事板侧只读。 */
  width: number;
  height: number;
  /**
   * 请求的缩放系数，宿主会夹到 `[0.05, 1]`。1/6 ≈ prpr 的 SceneColor 分辨率，
   * 视觉几乎无差别但复制成本只有 1/36。
   */
  scale: number;
  /** 是否需要下一帧继续复制。故事板不用时置 false → 宿主零开销。 */
  enabled: boolean;
}

/**
 * `api.assets`：歌曲目录相对资源。
 *
 * 存在的理由：story.js 在 zip / 本地库场景是以 **blob: URL** 动态 import 的
 * （`resolveStoryboardUrl` → idb:// → blob），blob URL 没有可解析的相对基址，
 * 故事板内部 `fetch('./x.json')` 必然失败。宿主负责把"歌曲目录相对路径"解析成
 * 真正可 fetch 的地址，**在线谱面与本地目录谱面行为一致**。
 *
 * 已知边界：zip 导入只会把约定的少量文件（cover/audio/bg.jpg/bga.mp4/story.js）
 * 收进本地库，任意额外文件不会被打包 —— 这种歌曲调用本接口会 reject，
 * 故事板应自行降级（宿主抛出的错误带明确 message）。
 */
export interface StoryboardAssetsHandle {
  url(relPath: string): Promise<string>;
  fetch(relPath: string): Promise<Response>;
  json(relPath: string): Promise<unknown>;
}

/**
 * 指针桥：3D 渲染器（数据源 + 命令执行端）与故事板宿主（代理端）之间的唯一通道。
 *
 * 方向一（游戏 → 故事板，每帧只读）：`pointers` / `project`。
 * 方向二（故事板 → 游戏，同步）：`blockedIds`（宿主每帧重写，游戏侧同步查询，
 * 保证 pointerdown 当帧即可生效）与 `releaseBindings`（命令）。
 *
 * 未就绪（2D / 无故事板 / 组件未挂载）时各字段为空实现，调用方不必判空。
 */
export interface StoryboardPointerBridge {
  pointers: ReadonlyMap<number, StoryboardRawPointer>;
  project: ((x: number, y: number) => { sx: number; sy: number }) | null;
  blockedIds: Set<number>;
  /**
   * **同步**重算 `blockedIds`（幂等、零分配）。
   *
   * 存在的理由：游戏的 tap 判定在 pointerdown 事件回调里**同步**查 `blockedIds`，
   * 而宿主平时只在 rAF 里更新它 → 第一次按下时读到的是上一帧的结论，必然漏判
   * （实测"故事板挡不住 tap"）。游戏侧在查询前先调一次本方法即可拿到当帧结论。
   *
   * 可选：未注册 = 沿用"每帧 rAF 更新"的旧行为。
   */
  syncBlocked?: () => void;
  releaseBindings: (pointerId: number) => void;
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
   * HUD 受控柄（§3.7 v3）：与 `game` 同构的白名单样式，作用目标是**游戏 HUD 容器**。
   * 故事板层的 `mount('overlay')` 恒在 HUD 之下（z-5 vs z-10），要影响 HUD 的视觉
   * （例如让画面整体像素化/扭曲时把 HUD 一起卷进来）必须走这个句柄。
   * 与 `game.style` 同一复位时机：重开局 / 切歌 / 卸载时由宿主复位；**seek 不复位**
   * （故事板在 `onSeek` 里自行重设，避免每次拖进度条都闪一下）。
   */
  hud: StoryboardStyleHandle;
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
  readonly audio: {
    levels(): StoryboardAudioLevels;
    /**
     * 主输出总效果（§3.7 v3，写入侧）。**每帧调用安全**：宿主内部做脏检查，
     * 值未变不会触碰音频参数（避免持续 `setTargetAtTime` 产生可听的 zipper noise）。
     * 省略的键保持当前值；重开局 / 切歌 / 卸载时宿主复位为原声。
     */
    setMasterEffect(effect: StoryboardMasterEffect): void;
  };
  /**
   * 指针观测 + 判定拦截（§3.7 v3）。仅 3D 渲染器有数据；2D / Lite 恒为空快照
   * 且拦截器为空转（不报错、不生效）。
   */
  input: StoryboardInputHandle;
  /**
   * 原始谱面对象（只读约定，§3.7 v3）。⚠️ **不要依赖它承载自定义数据** ——
   * `shared/chartSchema` 的 `parseAndValidateChart` 会逐字段重建 metadata 与顶层
   * 结构，未声明的自定义键会被剥离。需要给故事板传数据请走 `assets`。
   */
  readonly chartData: Readonly<Record<string, unknown>> | null;
  /** 歌曲目录相对资源（§3.7 v3，见 StoryboardAssetsHandle 的已知边界）。 */
  assets: StoryboardAssetsHandle;
  /**
   * 游戏画面快照（§3.7 v4）。宿主在每次 `update` 之前，把游戏画布按 `scale`
   * 缩放复制到一张 2D 画布上，故事板可把它当纹理用（`texImage2D(..., canvas)`）。
   *
   * 典型用途：**域内透出被位移 + 块量化的背景**。prpr 的 `_DisplaceBlendIntensity`
   * 与 `_BackgroundPixelScale` 正是靠 SceneColor 副本实现的，而 CSS 滤镜只能作用于
   * 整个元素，做不到"只在域内"。有了这一层，背景扭曲就能限定在域内。
   *
   * ⚠️ 成本：每帧一次 GPU→GPU 复制（w·h·scale² 像素）。scale 越小越快
   * （prpr 的 SceneColor 是 1/6）。**不需要时把 `enabled` 置 false 即完全零开销**
   * —— 宿主会在故事板 dispose 时自动复位。
   */
  readonly scene: StoryboardScene;
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
  /**
   * 故事板完成"重型初始化"后调用一次，通知宿主可以启动歌曲时钟。
   *
   * 开局时宿主把音频时钟挂起（pendingAudioStart），直到收到本回调（或兜底超时）——
   * 否则弱机上预解码**阻塞主线程**的这段时间里音频时钟照走，解码结束后谱面直接从
   * 中段开始。轻量故事板可不实现（宿主按兜底超时处理）。
   */
  markReady?(): void;
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
