import type { MutableRefObject } from 'react';
import type * as THREE from 'three';
import type {
  ChartData,
  EasingType,
  JudgementFeedback,
  JudgementType,
  NoteType,
} from '../types/game';
import type { SceneGroups } from '../scenes/sceneGroups';
import type { RingPt } from '../systems/geometry';
import type { PreparedNote } from '../utils/chartRuntime';
// SlideRt 在 GameCanvas 中定义（与 slide 运行态绑定），此处仅作类型引用。
import type { SlideRt } from '../components/GameCanvas';

/**
 * 音符触发器（§3.4）的分发回调：判定提交后由渲染器执行该音符触发的事件。
 *
 * 未注入 = 不支持触发器（2D / Lite 若不实现则自动降级为无触发）。
 * 幂等由 `judgedNotesRef` 保证：一个音符只会被判定一次 → 只触发一次。
 */
export type DispatchNoteTrigger = (note: PreparedNote, judgement: JudgementType) => void;

/** 指针运行态（与 GameCanvas 内联类型保持一致）。 */
export interface PointerState {
  x: number;
  y: number;
  down: boolean;
  active: boolean;
  type: string;
}

/** 打击特效条目（与 GameCanvas 内 activeBurstsRef 元素结构一致）。 */
export interface BurstEntry {
  group: THREE.Group;
  startTime: number;
  duration: number;
  scaleTarget: number;
  baseScale: number;
}

/** 碎裂粒子条目（与 GameCanvas 内 shatterSystemsRef 元素结构一致）。 */
export interface ShatterEntry {
  points: THREE.Points;
  velocities: Float32Array;
  startMs: number;
  duration: number;
}

/**
 * 判定/特效/编辑器手势逻辑迁出后所需的全部依赖聚合包。
 *
 * 设计要点（Facade + 上下文包）：
 * - 所有被迁出闭包在运行时持续写入的 `RefObject` 直接以 ref 形式传入，保证 hook 内
 *   读取 `.current` 始终是最新值，零行为变化。
 * - 模块级 helper（getAllNodes / makeRingMesh / pickProj / projSize / chartTimeToBeat）
 *   以函数引用传入；它们是稳定的纯函数，无闭包陈旧问题。
 * - 外部单例（globalAudio / liveDragStore）由 hook 内部直接 import，不在此列出。
 * - 游戏常量（JUDGE_Z / BLOOM_LAYER / HIT_WINDOW_MS 等）统一收敛在 gameplayConstants。
 *
 * 字段必须与被迁出逻辑实际读取的依赖严格一一对应；缺字段会在编译期触发 TS 报错，
 * 从而消除"漏依赖只在运行时暴露"的回归风险。
 *
 * **所有字段必填**：本 context 的唯一构造点是 3D 渲染器（`GameCanvas`）；2D 画布
 * 自带 `commitJudge`、Lite 是 ES5 单文件，二者都不构造也不消费它。此前 5 个字段曾
 * 标为可选并各自带「未注入 → 降级到旧行为」的分支，形成永久的并行双路径（代码审查
 * 文档第二节 #9）。这些分支在唯一调用点恒不触发，已删除 —— **不要把字段改回可选**，
 * 否则等于把双路径换个形式留下。
 */
export interface JudgeSystemContext {
  // —— 场景 / 特效 ——
  sceneRef: MutableRefObject<THREE.Scene | null>;
  groupsRef: MutableRefObject<SceneGroups | null>;
  sizeScaleRef: MutableRefObject<number>;
  defaultSkinJudgeWidthRef: MutableRefObject<number>;
  activeBurstsRef: MutableRefObject<BurstEntry[]>;
  allowHitEffectsRef: MutableRefObject<boolean>;
  speedRef: MutableRefObject<number>;
  particleSpriteRef: MutableRefObject<THREE.CanvasTexture | null>;
  shatterSystemsRef: MutableRefObject<ShatterEntry[]>;

  // —— 判定状态 ——
  isEditorModeRef: MutableRefObject<boolean | undefined>;
  judgedNotesRef: MutableRefObject<Set<string>>;
  judgedCountRef: MutableRefObject<number>;
  chartRef: MutableRefObject<ChartData>;
  onJudgementRef: MutableRefObject<((f: JudgementFeedback) => void) | undefined>;
  slideStateRef: MutableRefObject<Map<string, SlideRt>>;
  playStartTimeRef: MutableRefObject<number>;
  pointersRef: MutableRefObject<Map<number, PointerState>>;
  autoPlayRef: MutableRefObject<boolean>;

  // —— 数据 / 编辑器 ——
  resolvedRef: MutableRefObject<PreparedNote[]>;
  isPlayingRef: MutableRefObject<boolean>;
  isPausedRef: MutableRefObject<boolean>;
  gameTimeRef: MutableRefObject<number>;
  activeToolRef: MutableRefObject<string | undefined>;
  onPlaceEditorNoteRef: MutableRefObject<((x: number, y: number) => void) | undefined>;
  onSelectEditorNoteRef: MutableRefObject<((id: string | null) => void) | undefined>;
  isDraggingRef: MutableRefObject<boolean>;

  // —— 模块级 helper（值引用）——
  getAllNodes: (note: PreparedNote) => Array<{
    x: number;
    y: number;
    timeSec: number;
    angle: number;
    easing: EasingType;
  }>;
  /**
   * 图层（Layer）偏移后的音符位置。由渲染器（唯一持有图层树者）提供；
   * 编辑器选择与 tap 命中都用「合成后」坐标。slide 子节点由调用方按头节点图层换算。
   */
  getEffectivePos: (note: PreparedNote) => { x: number; y: number };
  /** 音符触发器（§3.4）：判定提交后由渲染器分发该音符触发的事件。 */
  dispatchNoteTrigger: DispatchNoteTrigger;
  /**
   * 判定**落位**处的音符位置（按音符 / slide 子节点自己的 timeSec 求图层偏移）。
   * 打击特效与判定反馈钉在落位（不随播放中的整列平移跑动）；slide 子节点经
   * `childIdx`（1-based，与 id 后缀一致）取各自坐标。
   */
  getLandingPos: (note: PreparedNote, childIdx?: number) => { x: number; y: number };
  /**
   * 音符的**有效音符色**：note.color → 图层色（就近继承 / 图层内 note_color_change 事件）
   * → 全局 noteColor。
   */
  getNoteColor: (note: PreparedNote) => string;
  /**
   * 该指针是否被故事板拦截（§3.7 v3 `api.input.setPointerFilter`）——true = **不参与
   * 任何判定**（tap / touch / slide 全部屏蔽）。由渲染器（唯一持有指针桥的组件）提供。
   */
  isPointerBlocked: (pointerId: number) => boolean;
  makeRingMesh: (
    outer: RingPt[],
    thickness: number,
    color: string | THREE.Color,
    opacity: number,
    isBorder?: string,
  ) => THREE.Mesh;
  pickProj: (nt: NoteType) => THREE.Texture | undefined;
  projSize: (nt: NoteType) => number;
  chartTimeToBeat: (tSec: number) => number;
}
