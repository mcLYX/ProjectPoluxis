export type NoteType = 'tap' | 'touch' | 'slide';

/** 判定面 X 轴半宽：合法落点/放置范围 [-NOTE_X_RANGE, NOTE_X_RANGE]。
 *  编辑、游戏、DSL 三处坐标边界的唯一权威源（消除 ±2.4 字面量漂移）。 */
export const NOTE_X_RANGE = 2.4;
/** 判定面 Y 轴半宽：合法落点/放置范围 [-NOTE_Y_RANGE, NOTE_Y_RANGE]。 */
export const NOTE_Y_RANGE = 1.5;

/** A skin maps each note type to a grayscale (white/transparent) texture stored
 *  as an `idb://` file reference. The game tints these textures with the note's
 *  judgement colour at runtime (map × colour), so the images themselves should
 *  be grayscale with an alpha channel defining the note shape. */
export interface SkinMaps {
  /** tap note body texture. */
  tap?: string;
  /** touch note body texture. */
  touch?: string;
  /** slide note body texture (also used for slide nodes / pipes). */
  slide?: string;
  /** Per-note-type projection guide textures, drawn on the screen-parallel
   *  judgement plane and tinted with the note colour (tap→tap, touch→touch,
   *  slide→slide). When absent, the shared `projection` key is used as fallback. */
  projTap?: string;
  projTouch?: string;
  projSlide?: string;
  /** Legacy shared projection guide texture (overrides the default outline guide).
   *  Used as a fallback when the per-type `projTap/projTouch/projSlide` keys are
   *  absent. Prefer the per-type keys for new skins. */
  projection?: string;
}

/** Persisted skin metadata. `maps` holds `idb://` references to the textures,
 *  which live in the shared file store. */
export interface SkinMeta {
  id: string;
  name: string;
  author?: string;
  /** unix ms */
  createdAt: number;
  /** optional `idb://` preview image shown in the manager UI. */
  preview?: string;
  maps: SkinMaps;
}

/** Result of preloading a skin's textures into GPU-ready THREE.Texture objects.
 *  Any map that fails to load is omitted (the game falls back to the default
 *  solid-colour look for that note type). */
export interface SkinTextureSet {
  tap?: import('three').Texture;
  touch?: import('three').Texture;
  slide?: import('three').Texture;
  /** Per-note-type projection guide textures. */
  projTap?: import('three').Texture;
  projTouch?: import('three').Texture;
  projSlide?: import('three').Texture;
  /** Legacy shared projection guide texture (fallback). */
  projection?: import('three').Texture;
}

/** 2D 渲染器（quality 'lite'）使用的皮肤图集：纯图片，不依赖 three.js。
 *  与 SkinTextureSet 一一对应，仅元素类型从 THREE.Texture 换成可直接 drawImage 的图源。 */
export interface SkinImageSet {
  tap?: CanvasImageSource;
  touch?: CanvasImageSource;
  slide?: CanvasImageSource;
  projTap?: CanvasImageSource;
  projTouch?: CanvasImageSource;
  projSlide?: CanvasImageSource;
  projection?: CanvasImageSource;
}

/** Easing curve for the segment connecting a slide node to its previous node.
 *  - 'linear'  : straight line (default).
 *  - 'sine-in' : curve leaves the previous node perpendicularly, then bends in
 *                (slow "ease-in" start) — visually a smooth entry.
 *  - 'sine-out': straight start, perpendicular exit (smooth "ease-out" end).
 *  - 'sine-io' : perpendicular at both ends (smooth S-curve).
 *  Used by the slide pipe renderer to bend the pipe between two nodes. */
export type EasingType = 'linear' | 'sine-in' | 'sine-out' | 'sine-io';

export type EventType =
  | 'speed_change'
  | 'text_display'
  | 'bg_change'
  | 'note_color_change'
  /** 图层坐标偏移：把所属图层的偏移通道设为目标值（可带过渡）。 */
  | 'offset_change';

export type JudgementType = 'S-Perfect' | 'Perfect' | 'Good' | 'Miss';

/**
 * Graphics quality mode.
 * - 'lite':    2D canvas renderer (no WebGL); the only mode that changes the
 *              renderer itself. Routed in App.tsx; never loads three.js.
 * - 'low' / 'standard' / 'high' / 'ultra': presets. They do NOT drive rendering
 *              directly — selecting one backfills the `custom*` flags
 *              (see qualityStore.PRESET_VALUES), and the 3D renderer consumes
 *              only those flags. So a preset is just a shortcut for a flag set.
 * - 'custom':  the `custom*` flags are edited independently by the user.
 */
export type QualityMode = 'lite' | 'low' | 'standard' | 'high' | 'ultra' | 'custom';

/** A single child node of a slide chain (the head is the NoteData itself). */
export interface SlideNodeData {
  beat: number;
  x: number;
  y: number;
  /** Rotation (degrees) of this node's visual (note + cross-section) around its
   *  center. Defaults to the head node's `angle` (or 0 if unset) when omitted. */
  angle?: number;
  /** Easing for the segment connecting THIS node to the PREVIOUS node.
   *  Defaults to the head node's `easing` (or 'linear') when omitted. */
  easing?: EasingType;
}

/** BPM change point: from this beat onward, use the new BPM for time calculation. */
export interface BpmPoint {
  beat: number;
  bpm: number;
}

/** Chart event: triggers at a specific beat, used for effects/state changes (not judged). */
export interface EventData {
  id: string;
  type: 'event';
  eventType: EventType;
  beat: number;
  /** speed_change: new speed multiplier */
  speed?: number;
  /** text_display: text to show on screen */
  text?: string;
  /** text_display: duration in seconds (0 = persistent until next text event or end) */
  textDuration?: number;
  /** text_display: normalized x position on screen [-1..1], 0 = center */
  x?: number;
  /** text_display: normalized y position on screen [-1..1], 0 = center */
  y?: number;
  /** text_display: font size in pixels (default: 36) */
  fontSize?: number;
  /** text_display: text color (default: chart accent color / cyan) */
  color?: string;
  /** bg_change: new gradient start color */
  gradientStart?: string;
  /** bg_change: new gradient end color */
  gradientEnd?: string;
  /** note_color_change: new note color */
  noteColor?: string;
  /** offset_change: 目标偏移量 x（判定面坐标，单位同 note.x） */
  offsetX?: number;
  /** offset_change: 目标偏移量 y（判定面坐标，单位同 note.y） */
  offsetY?: number;
  /** 时间过渡时长。缺省 0 = 瞬时跳变（等价于旧行为）。
   *  单位按事件类型区分：**offset_change 为拍数**（谱面以拍为主思维），
   *  其余（speed_change / bg_change / note_color_change）为秒。
   *  运行时换算：offset_change 的秒数 = beatToSec(beat+拍数) − beatToSec(beat)。 */
  duration?: number;
  /** 时间过渡缓动。缺省 'linear'。 */
  easing?: EasingType;
  /** speed_change 过渡的起点速度。缺省 = 过渡开始时的当前速度。 */
  speedFrom?: number;
}

export interface NoteData {
  id: string;
  /** Time in beats (not seconds). Converted to seconds via BPM+offset at runtime. */
  beat: number;
  x: number;    // normalized 3D x-coordinate on judgement plane [-2.4 .. 2.4]
  y: number;    // normalized 3D y-coordinate on judgement plane [-1.5 .. 1.5]
  type: NoteType;
  /** Optional custom hex color overriding the global chart metadata.noteColor. */
  color?: string;
  /** Slide only: child nodes following the head node, each judged independently (1 note each). */
  nodes?: SlideNodeData[];
  /** Global rotation (degrees) applied to this chain's visuals. Child nodes may
   *  override it. Touch notes ignore it (a rotated circle looks identical). */
  angle?: number;
  /** Slide only: default easing for all child segments (overridable per child). */
  easing?: EasingType;
  hit?: boolean;
  judgement?: JudgementType;
  deltaT?: number;
  /** 所属图层 id。**省略 = 默认根图层**（与旧谱面完全等价的形态）。
   *  音符的运动偏移、流速、音符色都继承自该图层及其祖先。 */
  layerId?: string;
  /** 假音符：完全不参与判定 —— 不命中、不产生 Miss、不计入总数、不打断连击、无特效音频。 */
  fake?: boolean;
  /** 不计分音符：参与判定，但击中与漏掉均不计分、不计数量（totalNotes）、不计连击。 */
  noScore?: boolean;
  /** 音符触发器（§3.4）：被特定判定等级击中 / 漏掉时触发事件。 */
  trigger?: NoteTrigger;
}

/**
 * 触发器动作：要么引用谱面里已定义的事件（按 id），要么内联一份迷你事件。
 */
export type TriggerAction =
  | { ref: string }
  | ({ eventType: EventType } & Partial<EventData>);

/**
 * 音符触发器（§3.4）。
 *
 * - `onMiss`：漏掉时触发；
 * - `onHit`：命中时触发 —— 可**按判定等级**分别指定，未指定该等级时回退 `default`。
 *
 * ⚠️ `speed_change` / `offset_change` 已预先积分进滚动距离与落点，
 * 判定时刻无法再改变 → 这类动作运行时不生效（编辑器会给出 warning）。
 */
export interface NoteTrigger {
  onHit?: { default?: TriggerAction[] } & Partial<Record<JudgementType, TriggerAction[]>>;
  onMiss?: TriggerAction[];
}

export interface ResolvedSlideNode extends SlideNodeData {
  timeSec: number;
  /** Effective (resolved) angle in radians for rendering. */
  angle: number;
  /** Effective (resolved) easing for the segment leading into this node. */
  easing: EasingType;
  /** 该节点**所在图层**时间轴下的滚动距离（含图层流速积分），由预处理层填充。 */
  scrollDist?: number;
  /** 图层下标（运行期由预处理层填充，缺省 0 = 默认根图层）。 */
  layerIdx?: number;
  /** 全局时间轴下的滚动距离（不含图层流速）。仅供负流速下的距离窗排序使用。 */
  globalDist?: number;
  /** @deprecated 图层流速已改为「按图层各自积分滚动距离」，倍率已并入 scrollDist，
   *  不再单独乘用。保留字段仅为兼容旧运行期数据。 */
  layerSpeedMul?: number;
}

/** A rectangular hit region (axis-aligned) in note-space, used by the
 *  overlap-merge tap judgment (方案二): when a tap is consumed, its own
 *  hitbox is merged into the other same-time taps the touch point overlapped. */
export interface HitRegion {
  x: number;
  y: number;
  half: number;
}

/** Runtime-resolved note with absolute time in seconds */
export interface ResolvedNote extends NoteData {
  timeSec: number;
  /** Resolved (effective) rotation in radians for this note's visual. */
  angle?: number;
  /** Resolved (effective) easing for this note (slide head/children only). */
  easing?: EasingType;
  /** Slide only: resolved child nodes */
  resolvedNodes?: ResolvedSlideNode[];
  /** Extra hit regions (besides the note's own TAP_HIT_HALF box) gained from
   *  consuming other overlapping same-time taps. Runtime-only, reset per play. */
  extraHitRegions?: HitRegion[];
  /** 该音符**所在图层**时间轴下的滚动距离（含图层流速积分），由预处理层填充。 */
  scrollDist?: number;
  /** 图层下标（运行期由预处理层填充，缺省 0 = 默认根图层）。 */
  layerIdx?: number;
  /** 全局时间轴下的滚动距离（不含图层流速）。仅供负流速下的距离窗排序使用。 */
  globalDist?: number;
  /**
   * 该音符**所在图层**时间轴下的滚动距离（已含图层流速/自身变速的积分）。
   * z 公式统一为 `JUDGE_Z − (scrollDist − S_layer(curTime))·unit`，
   * 判定时刻（t = timeSec）恒为 0，不受流速影响。
   *
   * @deprecated 倍率已并入上者，不再单独乘用。保留字段仅为兼容旧运行期数据。
   */
  layerSpeedMul?: number;
}

/** Runtime-resolved event with absolute time in seconds */
export interface ResolvedEvent extends EventData {
  timeSec: number;
}

export interface ChartMetadata {
  title: string;
  artist: string;
  difficulty: string;
  /** Base BPM at beat 0. For multi-BPM charts, use bpmlist. */
  bpm: number;
  /** BPM change points (sorted by beat ascending). First point must not be at beat 0 — use base bpm for that. */
  bpmlist?: BpmPoint[];
  offset: number; // in seconds – audio lead-in before beat 0
  jacket?: string;
  bgScheme: {
    gradientStart: string;
    gradientEnd: string;
    accentColor: string;
    /**
     * 图片/视频背景**不再**存于谱面：由歌曲目录约定文件（bg.jpg / bga.mp4）提供，
     * 经 SongItem.bgImage/bgVideo → 渲染器 bgMedia prop 注入，优先级 视频>图片>渐变。
     * 旧谱面里的 bgType/bgImage/bgVideo/bgFit/bgOpacity 读取时直接忽略、导出时剥离。
     */
  };
  noteColor: string;
  /** 谱面格式版本。缺省/absent = v1（旧格式）。出现显式图层时为 'v2'。
   *  仅用于未来可能的破坏性变更；读取时不影响任何语义。 */
  schemaVersion?: string;
  effectToggles: {
    bloom: boolean;
    particles: boolean;
    projection: boolean;
    gridLines: boolean;
  };
}

/**
 * 图层（Layer）。图层构成一棵树，节点缺失 `parentId` 即为根图层。
 *
 * 同一图层内的音符共享三条通道：**坐标偏移 / 流速 / 音符色**。
 * 子图层的有效值是 自身 与 所有祖先 的合成，且**三条通道的合成规则各不相同**：
 *
 * | 通道 | 合成规则 | 缺省 |
 * |---|---|---|
 * | 坐标偏移 offset | **相加**：`自身 + Σ 祖先` | 0 |
 * | 流速 speed | **相乘**：`自身 × Π 祖先` | 1 |
 * | 音符色 noteColor | **就近继承**：自身未取则取最近祖先，再无则取 `metadata.noteColor` | 继承 |
 *
 * 注意：**背景色不属于图层**（`bg_change` 写在任意图层都全局生效，见 docs 决策 7）。
 */
export interface LayerData {
  id: string;
  /** 省略 = 根图层。谱面至少存在一个根图层。 */
  parentId?: string;
  /** 编辑器展示名（可选，不影响任何行为）。 */
  name?: string;
  /** 图层级事件时间轴。偏移/流速/音符色事件挂在所属图层上；
   *  `bg_change` 挂在这里也全局生效（但会被谱面检查判为不良写法）。 */
  events?: EventData[];
  /** 静态初始偏移（可选）。等价于在 beat 0 放一个瞬时 `offset_change`。 */
  offsetX?: number;
  offsetY?: number;
  /** 图层流速倍率（参与树上的连乘；缺省 1）。 */
  speedMul?: number;
  /** 图层音符色（就近继承；缺省继续向上找，最终落到全局 noteColor）。 */
  noteColor?: string;
}

export interface ChartData {
  metadata: ChartMetadata;
  notes: NoteData[];
  /** @deprecated Use events array with speed_change type instead. Kept for backward compat. */
  speedEvents?: Array<{ beat: number; speed: number }>;
  /** Events mixed into the chart — resolved alongside notes, triggered at their time.
   *  顶层 events 在语义上属于**默认根图层**的事件轴（保持旧格式不变）。 */
  events?: EventData[];
  /** 显式图层。**省略 = 只有默认根图层的旧形态**（旧谱面/旧版本对此完全兼容）。
   *  一旦出现本字段，`metadata.schemaVersion` 应为 'v2'。 */
  layers?: LayerData[];
}

export interface JudgementFeedback {
  id: string;
  type: JudgementType;
  x: number;
  y: number;
  deltaT: number;
  scoreGained: number;
  createdAt: number;
  noteType: NoteType;
  /** 不计分音符的判定：App 统计层据此整条跳过（不计分/数量/连击）。 */
  noScore?: boolean;
}

export interface GameStats {
  score: number;
  combo: number;
  maxCombo: number;
  sPerfectCount: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  // early/late 拆分（Perfect 含 S-Perfect，good 仅 Good 档）。
  perfectEarly: number;
  perfectLate: number;
  goodEarly: number;
  goodLate: number;
  totalNotes: number;
  accuracy: number; // 0 to 100
  rank: 'EX+' | 'EX' | 'S' | 'A' | 'B' | 'C' | 'F';
}
