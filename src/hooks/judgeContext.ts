import type { MutableRefObject } from 'react';
import type * as THREE from 'three';
import type {
  ChartData,
  EasingType,
  JudgementFeedback,
  NoteType,
  ResolvedNote,
} from '../types/game';
import type { SceneGroups } from '../scenes/sceneGroups';
import type { RingPt } from '../systems/geometry';
// SlideRt 在 GameCanvas 中定义（与 slide 运行态绑定），此处仅作类型引用。
import type { SlideRt } from '../components/GameCanvas';

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
  color: THREE.Color;
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
  currentNoteColorRef: MutableRefObject<string | null>;
  onJudgementRef: MutableRefObject<((f: JudgementFeedback) => void) | undefined>;
  slideStateRef: MutableRefObject<Map<string, SlideRt>>;
  playStartTimeRef: MutableRefObject<number>;
  pointersRef: MutableRefObject<Map<number, PointerState>>;
  autoPlayRef: MutableRefObject<boolean>;

  // —— 数据 / 编辑器 ——
  resolvedRef: MutableRefObject<ResolvedNote[]>;
  isPlayingRef: MutableRefObject<boolean>;
  isPausedRef: MutableRefObject<boolean>;
  gameTimeRef: MutableRefObject<number>;
  activeToolRef: MutableRefObject<string | undefined>;
  onPlaceEditorNoteRef: MutableRefObject<((x: number, y: number) => void) | undefined>;
  onSelectEditorNoteRef: MutableRefObject<((id: string | null) => void) | undefined>;
  isDraggingRef: MutableRefObject<boolean>;

  // —— 模块级 helper（值引用）——
  getAllNodes: (note: ResolvedNote) => Array<{
    x: number;
    y: number;
    timeSec: number;
    angle: number;
    easing: EasingType;
  }>;
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
