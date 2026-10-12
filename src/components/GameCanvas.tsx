import React, { useEffect, useRef, useMemo, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ChartData, ResolvedEvent, JudgementFeedback, JudgementType, NoteType, EasingType, SkinTextureSet } from '../types/game';
import type { JudgeProjector, StoryboardPointerBridge, StoryboardRawPointer } from '../types/storyboard';
import { getScrollDistance, secondsToBeatMultiBpm } from '../utils/beatTime';
import { getChartRuntime, scrollDistanceAt, speedAt, scrollDistWindow, updateLayerCurDist, layerDistAt, type PreparedNote } from '../utils/chartRuntime';
import { buildLayerTree, layerOffsetAt, layerOffsetAtInto, layerColorAt, noteLayerIdx, type LayerTree } from '../utils/layers';
import { resolveTriggerEvents, isTriggerEventUnsupported } from '../shared/triggers';
import { createFrameGate } from '../utils/frameLimiter';
import { qualityStore } from '../qualityStore';
import { EASING_FNS } from '../utils/easing';
import { clampPlaneX, clampPlaneY } from '../utils/editorCoords';
import { WORLD_UNITS_PER_SECOND } from '../systems/judge';
import { expandRing, type RingPt } from '../systems/geometry';
import { TAP_SIZE, TOUCH_SIZE, SLIDE_SIZE, SLIDE_HALF, BLOOM_LAYER, JUDGE_Z, SLIDE_HIT_HALF, HIT_WINDOW_MS, TAP_RING_OUTER, TOUCH_RING_OUTER, SLIDE_RING_OUTER } from '../gameplayConstants';
// touch 逐帧判定（悬停触发）已下沉 shared/tapJudge.processTouchCore，环境面在此注入。
import { createTouchJudgeState, processTouchCore, tapJudgeDeps, type TouchJudgeEnv, type TouchJudgeState } from '../systems/tapJudge';
// 快速制谱手势引擎：渲染器无关，3D 与 2D(GameCanvas2D / Lite 画质) 共用同一份实现。
import {
  createQuickCreateController,
  type QuickCreateDelta,
  type QuickCreateController,
} from '../systems/quickCreate';
import { createSceneGroups, disposeSceneGroups, type SceneGroups } from '../scenes/sceneGroups';
import { usePropRefs } from '../hooks/usePropRefs';
import { selectionStore } from '../selectionStore';
import type { JudgeSystemContext } from '../hooks/judgeContext';
import { useJudgeSystem } from '../hooks/useJudgeSystem';
import { useNoteEffects, recycleBurst, recycleShatter, disposeEffectPools } from '../hooks/useNoteEffects';
import { useEditorGestures } from '../hooks/useEditorGestures';
import { shouldDeselectOnRightClick } from '../utils/editorPointer';
import { setCanvasCapturer } from '../utils/canvasCapture';

import { globalAudio } from '../audio/AudioManager';
import { liveDragStore } from '../liveDragStore';

// QuickCreateDelta 已迁至 ../systems/quickCreate（3D / 2D 共用同一份定义）。

interface GameCanvasProps {
  chart: ChartData;
  /** false → pause the render loop entirely (e.g. editor switched to 2D view):
   *  no tick, no renderer.render, no window update — zero background cost while
   *  keeping the WebGL scene + note meshes alive so switching back resumes
   *  instantly without the heavy rebuild hitch. Defaults to true. */
  viewportActive?: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  gameTime: number;
  speedMultiplier: number;
  projectionLeadMs: number;
  noteRenderDistance?: number;
  noteSizeScale?: number;
  /** 抗锯齿开关：由 qualityStore 的 customAntialias 直接传入（预设已回填）。 */
  antialias?: boolean;
  /** 是否允许 Bloom 辉光（仍会受谱面 effectToggles.bloom 进一步约束）。 */
  allowBloom?: boolean;
  /** 是否允许背景粒子（仍会受谱面 effectToggles.particles 进一步约束）。 */
  allowParticles?: boolean;
  /** 是否允许极高档的动态光照（音符点亮隧道墙体与光源池）。 */
  allowDynamicLighting?: boolean;
  /** 是否允许极高档的打击光粒碎裂特效。 */
  allowHitEffects?: boolean;
  /** 渲染倍率（分辨率缩放）：1.0 = 设备像素比上限，<1 降低分辨率，>1 超采样。 */
  renderScale?: number;
  autoPlay: boolean;
  playSession: number;
  isEditorMode?: boolean;
  activeEditorTool?: 'select' | 'place-tap' | 'place-touch' | 'place-slide' | 'quick-create';
  /* 选中态（`selectedNoteId` / `selectedNoteIds`）**不再是 prop**：
   * 它是模块级 `selectionStore` 的单一真相，本组件在 rAF / 指针处理器里按需
   * `getSnapshot()` 读取。这样选中变化不再触发整个 3D 子树的 React 重渲染
   * （`arePropsEqual` 对数组按身份比较，原先每次点选都会重渲染整棵子树）。
   * 选中高亮由常驻的 rAF 循环自然刷新，观感不变。
   * 注：`isMultiSelect` 是交互模式而非选中数据，仍走 prop。 */
  /** 是否处于多选模式（含 Ctrl 临时）。为 true 时绘制多选框。 */
  isMultiSelect?: boolean;
  snapSubdivision?: number;
  onJudgement?: (feedback: JudgementFeedback) => void;
  onSongEnd?: () => void;
  /** 本局第一次把画面渲染到屏幕时回调一次（每次 playSession/chart 变化后重新武装）。
   *  App 用它把音频时钟的启动推迟到首帧之后，消除"黑屏期间谱面时间已在走"。 */
  onFirstFrame?: () => void;
  onSelectEditorNote?: (id: string | null) => void;
  onMoveEditorNote?: (id: string, x: number, y: number) => void;
  onPlaceEditorNote?: (x: number, y: number) => void;
  onApplyQuickCreateDelta?: (delta: QuickCreateDelta) => void;
  /** 预加载后的皮肤贴图集合；为 null 时走默认纯色外观。 */
  skinTextures?: SkinTextureSet | null;
  /** 默认皮肤（未选皮肤包时）自定义项：内框/外框/判定框。 */
  defaultSkinInnerEnabled?: boolean;
  defaultSkinOuterEnabled?: boolean;
  defaultSkinOuterWidth?: number;
  defaultSkinOuterColor?: string;
  defaultSkinOuterAlpha?: number;
  defaultSkinJudgeWidth?: number;
  /** 画布后方的环境背景 DOM 层（App 内 `ambientBgRef`）。bg_change 事件据此实时更新渐变。 */
  ambientBgRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * 判定面→屏幕投影函数的回写目标（故事板宿主经 `api.toScreen` 消费）。
   */
  projectorRef?: React.RefObject<JudgeProjector | null>;
  /**
   * **游戏画布**回写目标（§3.7 v4 的 `api.scene` 依赖它）。
   *
   * 存在的理由：宿主原本用 `querySelector('canvas')` 去猜游戏画布，但渲染器重建
   * 时容器里可能残留旧画布（见 setup 里 `querySelector('canvas')?.remove()`），
   * 猜错就会把**故事板自己的画布**当成游戏画面抓回来 → 逐帧自我反馈累积
   * （实机症状：域内"大量历史帧糊成一块"，且越玩越亮）。
   * 由渲染器显式回写，宿主就不必猜。
   */
  gameCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /**
   * 指针桥（§3.7 v3）：本组件是**唯一数据源**（每帧把 `pointersRef` 挂上去供宿主
   * 产出 `api.input` 快照），同时执行宿主下发的命令（`releaseBindings` 立即脱手）
   * 并同步读取 `blockedIds` 作为判定拦截依据。
   * 传对象本身而非 ref：桥的身份恒定、字段是活的，直接传更直白（ref 只为"延迟创建"
   * 才需要）。缺省 = 无故事板，零额外开销。
   */
  storyboardBridge?: StoryboardPointerBridge;
  /**
   * 背景媒体（歌曲目录约定 bg.jpg / bga.mp4，开局由 App 解析传入）。
   * 渲染优先级：video > image > 内置渐变；bg_change 事件只改渐变色，不再切换媒体。
   */
  bgMedia?: { image?: string; video?: string };
}

// 共享游戏常数（TAP_SIZE/SLIDE_HALF/BLOOM_LAYER/JUDGE_Z/判定窗口/ring 外观等）
// 已统一收敛到 ../gameplayConstants，此处仅保留本地派生项。
// Pipe cross-section is a diamond slightly smaller than the slide node itself.
const SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
const SLIDE_RED = '#ff0000';
/** 图层偏移的零值（旧谱面恒为此），避免热路径分配。 */
const ZERO_OFF = { x: 0, y: 0 };
/** 指针桥的"空指针集"：故事板未挂载 / 组件卸载后桥上挂这个，宿主无需判空。 */
const EMPTY_POINTERS: ReadonlyMap<number, StoryboardRawPointer> = new Map();
/** 桥的默认"立即脱手"实现（无桥时的空操作）。 */
const noopReleaseBindings = (): void => undefined;

const CAMERA_VFOV = 52;
// --- 渲染 / HUD 调参常量（P2-2：消除魔法数字）---
const DEFAULT_HUD_FONT_PX = 36;    // HUD 文本默认字号（像素）
const HUD_ANCHOR_PERCENT = 50;     // HUD 居中锚点（百分比）
const HUD_SPREAD_PERCENT = 40;     // 归一化坐标 [-1,1] → 百分比的横向拉伸
const DRAG_START_THRESHOLD = 0.05; // 编辑器拖拽启动阈值（世界单位）
const PARTICLE_DUST_SIZE = 0.12;   // 环境粒子尺寸（更似浮尘而非大雪）
const FIT_HALF = 2.42;
const CAMERA_AXIS_Y = 0;
function fitCameraDistance(aspect: number): number {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(CAMERA_VFOV / 2));
  const dVertical = FIT_HALF / tanHalf;
  const dHorizontal = FIT_HALF / (tanHalf * Math.max(aspect, 0.2));
  return Math.max(dVertical, dHorizontal, 4.4);
}

/**
 * Module-level scratch vectors — reused every frame inside the slide pipe
 * loop to avoid creating hundreds of THREE.Vector3 objects per tick.
 * Safe because the render loop is single-threaded and sequential.
 */
const _vNaturalA = new THREE.Vector3();
const _vNaturalB = new THREE.Vector3();
const _vCrossPoint = new THREE.Vector3();
// Scratch vectors for eased slide-pipe consumption (reused per segment).
const _vConsP = new THREE.Vector3();
// Scratch for ultra-mode light pool: midpoint of a slide pipe segment.
// Computed from the pipe's stored endpoints (pipe.mid) each frame.
const _vLightMid = new THREE.Vector3();
// Scratch for per-pipe tube geometry rebuild (relative end offset A→B).
const _vTubeEnd = new THREE.Vector3();
// Reused per-frame inside tick() so slide-note Z lists don't allocate a new
// array on every frame (GC churn is amplified ~2.4x at 144Hz displays).
const _slideZs: number[] = [];

/** 量化到 3 / 4 位小数（等价于原 `toFixed(3)` / `toFixed(4)` 的数值比较）。 */
function q3(v: number): number { return Math.round(v * 1000); }
function q4(v: number): number { return Math.round(v * 10000); }
/** slide 管线几何签名 scratch（复用；仅在几何变化时才 slice 保存）。 */
const _geoSig: number[] = [];

/** 图层偏移复用缓冲（写入式求值，消除每帧每音符的 {x,y} 分配）。 */
const _landingOff = { x: 0, y: 0 };
const _layerOffTmp = { x: 0, y: 0 };

/**
 * Ultra 动态光源池的「最小 |z| 前 N 名」选择槽位。
 *
 * 原实现每帧为每个候选 new 一个对象再 `Array.sort`（带比较器闭包）——
 * 超长谱面下候选可达数百，等于每帧数百次分配 + 一次 O(C log C) 排序。
 * 这里改用固定 N 槽位（N = 灯数，恒定 8）的插入式选择：
 *  - 只保留 |z| 最小的 N 个，语义与原 sort 完全一致（含并列时的稳定性：
 *    仅当严格更小才前移，等价于稳定排序）；
 *  - 零分配、O(C·N) 且 N 恒为 8。
 */
const _lightAZ: number[] = [];   // |z|
const _lightZ: number[] = [];
const _lightX: number[] = [];
const _lightY: number[] = [];
const _lightC: (THREE.Color | null)[] = [];

/**
 * 每帧「当前可见」的网格集合：由窗口遍历在置 `visible = true` 时登记，
 * 供 ultra 灯光池只遍历可见项（原实现遍历**本局累计**的全部网格 = O(累计音符)，
 * 随歌进行越来越慢）。单线程顺序消费 —— 复用安全。
 */
const _visNoteMeshes: Array<{ group: THREE.Group; projectionGroup: THREE.Group }> = [];
const _visSlideNodes: SlideMeshSet['nodes'] = [];
const _visSlidePipes: SlideMeshSet['pipes'] = [];

/** 灯光池槽位状态（模块级，取代原先每帧新建的 `consider` 闭包）。 */
let _lightCap = 0;
let _lightCnt = 0;
/** 把候选 (z,x,y,color) 插入「|z| 最小前 _lightCap 名」固定槽位（零分配）。 */
function considerLight(z: number, x: number, y: number, color: THREE.Color): void {
  const az = Math.abs(z);
  const cap = _lightCap;
  if (_lightCnt < cap) {
    let k = _lightCnt;
    while (k > 0 && _lightAZ[k - 1] > az) {
      _lightAZ[k] = _lightAZ[k - 1];
      _lightZ[k] = _lightZ[k - 1];
      _lightX[k] = _lightX[k - 1];
      _lightY[k] = _lightY[k - 1];
      _lightC[k] = _lightC[k - 1];
      k--;
    }
    _lightAZ[k] = az; _lightZ[k] = z; _lightX[k] = x; _lightY[k] = y; _lightC[k] = color;
    _lightCnt++;
    return;
  }
  if (az >= _lightAZ[cap - 1]) return; // 不够近，丢弃（等价于 sort 后被截断）
  let k = cap - 1;
  while (k > 0 && _lightAZ[k - 1] > az) {
    _lightAZ[k] = _lightAZ[k - 1];
    _lightZ[k] = _lightZ[k - 1];
    _lightX[k] = _lightX[k - 1];
    _lightY[k] = _lightY[k - 1];
    _lightC[k] = _lightC[k - 1];
    k--;
  }
  _lightAZ[k] = az; _lightZ[k] = z; _lightX[k] = x; _lightY[k] = y; _lightC[k] = color;
}

/**
 * 颜色字符串 → THREE.Color 缓存。
 *
 * `Color.set('#rrggbb')` 走 `setStyle()`：每次都要跑正则/字符串解析。原来每个可见
 * 音符每帧要做 3~4 次（fill / innerWire / outerWire / 投影），而谱面颜色在一局内
 * 基本不变。这里把解析结果缓存住，运行期改用 `Color.copy()` —— 只写 3 个 float，
 * 不再解析字符串。判定与画面语义完全不变。
 */
const _colorCache = new Map<string, THREE.Color>();
function cachedColor(hex: string): THREE.Color {
  let c = _colorCache.get(hex);
  if (!c) {
    // 动态颜色（如逐帧变化的亮度）可能让缓存无界增长，做个上限保护。
    if (_colorCache.size > 256) _colorCache.clear();
    c = new THREE.Color(hex);
    _colorCache.set(hex, c);
  }
  return c;
}

/**
 * Per-slide-note cache of the combined "all nodes" array (head + children).
 * `processSlide` and the slide renderer both previously rebuilt this array
 * every frame for every slide via `[head, ...resolvedNodes]` spread, which
 * produced significant GC pressure. Since `resolvedNodes` is stable for a
 * given PreparedNote object (created once by resolveChart useMemo), we
 * cache the combined array Weakly-keyed on the note object. When the chart
 * changes and old PreparedNote objects become unreachable, the cache entries
 * are GC'd automatically.
 */
const _allNodesCache = new WeakMap<
  PreparedNote,
  Array<{ x: number; y: number; timeSec: number; angle: number; easing: EasingType }>
>();
function getAllNodes(note: PreparedNote): Array<{ x: number; y: number; timeSec: number; angle: number; easing: EasingType }> {
  let cached = _allNodesCache.get(note);
  if (!cached) {
    // angle/easing are static per note — computed once here. x/y are re-synced
    // from the live source objects on every call (see below) so an in-progress
    // editor drag (which mutates note.x/y or resolvedNodes[i].x/y directly, with
    // NO full chart re-resolve) is reflected immediately in the slide pipe and
    // node meshes. This keeps the slide following the pointer in real time during
    // a drag instead of only the selection gizmo ("dragging just the box").
    cached = [
      { x: note.x, y: note.y, timeSec: note.timeSec, angle: note.angle ?? 0, easing: note.easing ?? 'linear' },
      ...(note.resolvedNodes ?? []).map((rn) => ({
        x: rn.x,
        y: rn.y,
        timeSec: rn.timeSec,
        angle: rn.angle,
        easing: rn.easing,
      })),
    ];
    _allNodesCache.set(note, cached);
  }
  // Live-follow: write the latest x/y from the source objects into the cached
  // elements. Zero allocation (the array + element objects already exist), just
  // a couple of assignments per frame.
  cached[0].x = note.x;
  cached[0].y = note.y;
  if (note.resolvedNodes) {
    for (let i = 0; i < note.resolvedNodes.length; i++) {
      cached[i + 1].x = note.resolvedNodes[i].x;
      cached[i + 1].y = note.resolvedNodes[i].y;
    }
  }
  return cached;
}

/**
 * Build a slide-pipe tube along a curve from the local origin (node A) to `end`
 * (node B, as a relative offset). The centerline is a cubic Bézier whose
 * endpoint tangents are rotated away from the straight A→B direction by an
 * angle dictated by `easing`, producing a smooth curve (linear = straight line).
 * The diamond cross-section is rotated around the tube axis from `angleStart`
 * (at A) to `angleEnd` (at B), so each node's `angle` is honoured even where
 * two consecutive nodes differ.
 *
 * Built in LOCAL space (A at the origin); the caller positions the mesh at world
 * A and applies a uniform scale equal to the note visual scale (the cross-section
 * is already sized to `half`).
 */
function buildSlideTubeGeometry(opts: {
  end: THREE.Vector3;
  angleStart: number;
  angleEnd: number;
  easing: EasingType;
  half: number;
  lengthSegments?: number;
  /**
   * Local-Z (relative to node A) for a given normalized-time τ.
   * Defaults to `end.z * τ` — correct for constant scroll speed. When a
   * `speed_change` event lies inside the segment, the caller passes a sampler
   * that follows the real scroll-distance integral so the pipe's Z profile (and
   * therefore its visual length) honours the speed change instead of ramping
   * linearly (which made it look too far on acceleration / too close on
   * deceleration).
   */
  zAt?: (tau: number) => number;
}): THREE.BufferGeometry {
  const { end, angleStart, angleEnd, easing, half } = opts;
  const lengthSegments = opts.lengthSegments ?? 32;
  const radialSegments = 4; // diamond cross-section
  const ease = EASING_FNS[easing] ?? EASING_FNS.linear;
  const zAt = opts.zAt ?? ((tau: number) => end.z * tau);

  // The slide interpolates its travel position by `ease(τ)` while time (z) advances
  // linearly with τ. Endpoints coincide with A and B (ease(0)=0, ease(1)=1), so the
  // pipe still connects the two nodes exactly. Because the bow is along the
  // direction of travel (x,y) as a function of time (z) — not perpendicular — a
  // left/right slide bows left/right and an up/down slide bows up/down. E.g. for
  // x:0→2.5 at the temporal midpoint: linear 1.25, sine-out 2.5·sin45°≈1.767,
  // sine-in 2.5·(1−sin45°)≈0.732, sine-io 1.25 (matches linear at mid, differs at ends).
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= lengthSegments; i++) {
    const tau = i / lengthSegments;
    const e = ease(tau);
    pts.push(new THREE.Vector3(end.x * e, end.y * e, zAt(tau)));
  }

  const positions: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const N = new THREE.Vector3();
  const Bn = new THREE.Vector3();
  for (let i = 0; i <= lengthSegments; i++) {
    p.copy(pts[i]);
    const tau = i / lengthSegments;
    // Tangent via central difference (robust where easing'(τ)=0, e.g. sine-in at τ=0).
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(lengthSegments, i + 1)];
    tan.subVectors(b, a);
    if (tan.lengthSq() < 1e-12) tan.set(0, 0, 1);
    tan.normalize();
    N.copy(up).cross(tan);
    if (N.lengthSq() < 1e-6) N.set(1, 0, 0);
    N.normalize();
    Bn.copy(tan).cross(N).normalize();
    // Inter-node rotation follows the easing too: the cross-section's angle is
    // interpolated by `ease(τ)` so the twist rate matches the travel easing
    // (e.g. sin-in twists slowly then fast), not a linear ramp. The tube's
    // cross-section frame (N × ... ) twists opposite to `rotation.z` for the same
    // sign, so we keep +angle here to match the node visuals (which negate angle
    // on `rotation.z`); the net result is +angle = clockwise, like the 2D editor.
    const ang = angleStart + (angleEnd - angleStart) * ease(tau);
    for (let k = 0; k < radialSegments; k++) {
      const phi = ang + (k * Math.PI * 2) / radialSegments;
      positions.push(
        p.x + half * (Math.cos(phi) * N.x + Math.sin(phi) * Bn.x),
        p.y + half * (Math.cos(phi) * N.y + Math.sin(phi) * Bn.y),
        p.z + half * (Math.cos(phi) * N.z + Math.sin(phi) * Bn.z),
      );
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < lengthSegments; i++) {
    for (let k = 0; k < radialSegments; k++) {
      const a = i * radialSegments + k;
      const b = i * radialSegments + ((k + 1) % radialSegments);
      const c = (i + 1) * radialSegments + ((k + 1) % radialSegments);
      const dd = (i + 1) * radialSegments + k;
      indices.push(a, b, c, a, c, dd);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Shared geometries — created ONCE at module load and reused across all notes
 * of the same type. Previously every tap/touch/slide-node/slide-pipe allocated
 * its own geometry, which for a 1000-note chart meant ~3000 geometry objects
 * (each carrying its own vertex buffer). Sharing drops that to ~7.
 *
 * These are tagged via `userData.shared = true` so that disposeGroup knows
 * NOT to dispose them when an individual note is removed (disposing a shared
 * geometry would break every other note using it).
 */
function markShared(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.userData.shared = true;
  return geo;
}
function isSharedGeo(geo: THREE.BufferGeometry | undefined | null): boolean {
  return !!geo?.userData?.shared;
}

// Slide 皮肤的贴图平面现在与 tap 共用 TAP_SIZE 见方、不旋转（见 ensureSlideMeshes）：
// 皮肤作者把图形画成"内接菱形"（顶点触四边中点）即可，对角线 = TAP_SIZE = 1.6，
// 与默认描边菱形（SLIDE_RING_OUTER，对角线 = SLIDE_SIZE×√2 = 1.6）完全同尺寸。

// Generic 1×1 plane: default-skin rings / fills attach a soft-edged CanvasTexture
// and scale the MESH to the texture's world size (keeps a single shared geometry).
export const _unitGeo = markShared(new THREE.PlaneGeometry(1, 1));

// Full-size planes used when a skin texture *fully* replaces a note (no colored
// border). The texture's own alpha defines the note shape; we tint via
// material.color × map, so a plain opaque quad sized to the note bbox is enough.
const _tapSkinGeo = markShared(new THREE.PlaneGeometry(TAP_SIZE, TAP_SIZE));
const _touchSkinGeo = markShared(new THREE.PlaneGeometry(TOUCH_SIZE, TOUCH_SIZE));

// --- 默认皮肤（未选皮肤包时）：用「软边 Canvas 纹理」绘制可调粗细的描边/填充 ---
// 之前的 ShapeGeometry 硬边环形在音符移动时会产生典型的"低分辨率 / 无抗锯齿"
// 式闪烁（时间域锯齿）；皮肤贴图不闪是因为纹理自带平滑的 alpha 边缘。这里同样
// 用 canvas 绘制抗锯齿的环形/填充形，作为纹理贴到 _unitGeo 平面上，使默认皮肤
// 与皮肤包一样平滑。环的径向厚度由 defaultSkinInnerWidth / defaultSkinOuterWidth
// （世界单位）控制。
interface SoftShapeTex { texture: THREE.CanvasTexture; size: number; }
const softShapeTexCache = new Map<string, SoftShapeTex>();
// 软边纹理按几何 key 缓存复用；上限防止长会话/多谱面累积（P2-4）。
// 真实谱面内不同几何数量远小于上限，故淘汰最旧项时几乎不会命中「仍被活动网格引用」的纹理。
const SOFT_SHAPE_TEX_CACHE_MAX = 128;

function evictSoftShapeTexCache(): void {
  while (softShapeTexCache.size > SOFT_SHAPE_TEX_CACHE_MAX) {
    const oldestKey = softShapeTexCache.keys().next().value;
    if (oldestKey === undefined) break;
    const rec = softShapeTexCache.get(oldestKey);
    if (!rec) { softShapeTexCache.delete(oldestKey); continue; }
    rec.texture.dispose();
    softShapeTexCache.delete(oldestKey);
  }
}

function softShapeBBox(pts: RingPt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** 软边环形纹理：以线宽 thickness（世界单位）沿多边形描边，环带落在 [maxR-thickness, maxR]。 */
export function makeSoftRingTexture(outer: RingPt[], thickness: number): SoftShapeTex {
  const key = `r|${JSON.stringify(outer)}|${thickness.toFixed(4)}`;
  const hit = softShapeTexCache.get(key);
  if (hit) return hit;
  const { minX, minY, maxX, maxY } = softShapeBBox(outer);
  const pad = Math.max(thickness * 2.5, 0.02);
  const size = Math.max(maxX - minX, maxY - minY) + pad * 2;
  let maxR = 0;
  for (const [x, y] of outer) { const r = Math.hypot(x, y); if (r > maxR) maxR = r; }
  // 中线半径 = maxR - thickness/2，使 thickness 宽描边恰好落在 [maxR-thickness, maxR]。
  const k = maxR > 0 ? Math.max(0, maxR - thickness / 2) / maxR : 0;
  const RES = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RES;
  const ctx = canvas.getContext('2d')!;
  const s = RES / size;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, thickness * s);
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  ctx.beginPath();
  ctx.moveTo((outer[0][0] * k + size / 2) * s, (size / 2 - outer[0][1] * k) * s);
  for (let i = 1; i < outer.length; i++) {
    ctx.lineTo((outer[i][0] * k + size / 2) * s, (size / 2 - outer[i][1] * k) * s);
  }
  ctx.closePath();
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const record: SoftShapeTex = { texture, size };
  softShapeTexCache.set(key, record);
  evictSoftShapeTexCache();
  return record;
}

/** 软边填充纹理：多边形实心填充（canvas 自带抗锯齿，边缘平滑）。 */
function makeSoftFillTexture(pts: RingPt[]): SoftShapeTex {
  const key = `f|${JSON.stringify(pts)}`;
  const hit = softShapeTexCache.get(key);
  if (hit) return hit;
  const { minX, minY, maxX, maxY } = softShapeBBox(pts);
  const pad = 0.02;
  const size = Math.max(maxX - minX, maxY - minY) + pad * 2;
  const RES = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RES;
  const ctx = canvas.getContext('2d')!;
  const s = RES / size;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo((pts[0][0] + size / 2) * s, (size / 2 - pts[0][1]) * s);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo((pts[i][0] + size / 2) * s, (size / 2 - pts[i][1]) * s);
  }
  ctx.closePath();
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const record: SoftShapeTex = { texture, size };
  softShapeTexCache.set(key, record);
  evictSoftShapeTexCache();
  return record;
}

/** 默认皮肤描边环网格（软边纹理），已开启 bloom 层。 */
function makeRingMesh(outer: RingPt[], thickness: number, color: string | THREE.Color, opacity: number, isBorder?: string): THREE.Mesh {
  const rec = makeSoftRingTexture(outer, thickness);
  const mesh = new THREE.Mesh(
    _unitGeo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, map: rec.texture, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.scale.set(rec.size, rec.size, 1);
  if (isBorder) mesh.userData.isBorder = isBorder;
  mesh.layers.enable(BLOOM_LAYER);
  return mesh;
}

/** 默认皮肤填充面（软边纹理），略微后移让描边稳定压在其上。 */
function makeSoftFillMesh(pts: RingPt[], color: string | THREE.Color, opacity: number): THREE.Mesh {
  const rec = makeSoftFillTexture(pts);
  const mesh = new THREE.Mesh(
    _unitGeo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, map: rec.texture, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.scale.set(rec.size, rec.size, 1);
  mesh.position.z = FILL_Z;
  mesh.userData.defaultFill = true;
  mesh.layers.enable(BLOOM_LAYER);
  return mesh;
}
// ---------------------------------------------------------------------------
// 音符描边改用 THREE.Line（旧版渲染）：WebGL 中 LineBasicMaterial.linewidth 在
// 几乎所有平台都被忽略，描边恒为 ~1px 屏幕像素 —— 粗细不随音符距离变化，远处
// 不会因透视把世界恒定宽度的软纹理缩小采样而模糊/闪烁。填充仍用软边纹理
// （makeSoftFillMesh），以保证平滑抗锯齿。几何体按世界坐标烘焙一次并跨音符
// 复用（markShared），音符 group 的 vScale 负责整体缩放。
// ---------------------------------------------------------------------------
function makeOutlineGeo(pts: RingPt[]): THREE.BufferGeometry {
  const v: number[] = [];
  for (const [x, y] of pts) v.push(x, y, 0);
  v.push(pts[0][0], pts[0][1], 0); // 闭合
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}
const _tapOutlineGeo = markShared(makeOutlineGeo(TAP_RING_OUTER));
const _touchOutlineGeo = markShared(makeOutlineGeo(TOUCH_RING_OUTER));
const _slideOutlineGeo = markShared(makeOutlineGeo(SLIDE_RING_OUTER));

/** 音符描边 Line（几何体共享，材质每音符一个，供逐帧改色/透明度）。 */
function makeOutlineLine(geo: THREE.BufferGeometry, color: string | THREE.Color, opacity: number, isBorder: 'inner' | 'outer'): THREE.Line {
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.userData.isBorder = isBorder;
  line.layers.enable(BLOOM_LAYER);
  return line;
}

// 填充仍用软边 Canvas 纹理（makeSoftRingTexture / makeSoftFillTexture）。
// FILL_Z 让半透明填充面略微后移，保证描边稳定压在填充之上；
// 所有透明材质均 depthWrite:false，避免写入深度而错误遮挡更远音符的描边。
const FILL_Z = -0.001;

// Slide pipes no longer share a geometry: each builds its own curved,
// angle-rotated tube (see buildSlideTubeGeometry) so easing/angle vary per segment.

/** Runtime state per slide node */
interface SlideNodeRt {
  judged: boolean;
  /** Released early without ever passing the spatial zone → unhittable, will late miss (red). */
  missLocked: boolean;
  /** Bound pointer entered this node's spatial zone at some point while held. */
  everInZone: boolean;
  lastInsideTime: number | null;
  lastInsidePointerId: number | null;
  arrivalChecked: boolean;
  tailLockedSPerfect: boolean;
  /** Pre-window early S-Perfect lock: a finger was inside the hit box during
   *  -HIT_WINDOW_MS <= dt < 0, so commit S-Perfect once dt >= 0 (lenient early sweep). */
  earlySPLocked: boolean;
  /** Head only: ids of every finger that entered the box during the pre-window,
   *  recorded so we can bind them (incl. out-of-box) and require at least one still down. */
  earlyTouchIds: number[];
}

/** Runtime state per slide chain */
export interface SlideRt {
  boundPointerIds: Set<number>;
  nodes: SlideNodeRt[];
  /** 头节点特殊窗口内发生过「全松手」但尚未裁定：窗口结束才决定要不要红锁
   *  （期间允许目标手指自由加绑接管链）。 */
  headReleasePending?: boolean;
}

interface SlideMeshSet {
  nodes: Array<{
    group: THREE.Group;
    /** 预计算的判定 key = `${noteId}#${idx}`（避免每帧每节点拼字符串）。 */
    key: string;
    /** Only the slide head keeps a border: inner (note color, Line) + outer (custom, soft texture). */
    innerWire?: THREE.LineBasicMaterial;
    outerWire?: THREE.MeshBasicMaterial;
    fill: THREE.MeshBasicMaterial;
    /** Only the slide head has a 2D judgement projection guide. */
    proj?: THREE.Group;
    projMat?: THREE.LineBasicMaterial;
  }>;
  pipes: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    geo: THREE.BufferGeometry;
    /** 1 = clipped at judgement plane, 0 = full natural segment. */
    clipAmount: number;
    lastUpdateMs: number;
    /** World-space clip planes: judgePlane hides z > cutZ (already-passed part),
     *  farPlane hides z < spawnLimit (beyond the far render plane, editor only). */
    judgePlane: THREE.Plane;
    farPlane: THREE.Plane;
    /** 几何签名（数值化，替代每帧拼 geoKey 字符串）；null = 尚未构建。 */
    gSig: number[] | null;
    /** 签名中的 easing 分量（字符串，单独比较）。 */
    gEasing: string | null;
    /** World-space midpoint, reused by the ultra light pool. */
    mid: THREE.Vector3;
  }>;
}

/**
 * Live-drag follow without a React re-render. Directly mutates the dragged
 * note's resolved position so the windowed render loop (which reads these
 * fields) places its mesh correctly on the very next frame. The authoritative
 * React commit (setCurrentChart → resolveChart over the whole chart) is
 * throttled separately, so a long drag no longer re-resolves 2000 notes every
 * frame — that was the source of per-frame jank on lower-end Android WebViews.
 */
function liveMoveResolvedNote(noteIndex: Map<string, PreparedNote>, id: string, x: number, y: number): void {
  const hashIdx = id.indexOf('#');
  if (hashIdx < 0) {
    const n = noteIndex.get(id);
    if (n) { n.x = x; n.y = y; }
    return;
  }
  // tap/touch chains are expanded into standalone resolved notes whose id
  // already carries the "#i" suffix — prefer an exact match (same convention
  // as the selection gizmo and handleMoveEditorNote).
  const exact = noteIndex.get(id);
  if (exact) { exact.x = x; exact.y = y; return; }
  const base = id.slice(0, hashIdx);
  const childIdx = parseInt(id.slice(hashIdx + 1), 10) - 1;
  const n = noteIndex.get(base);
  if (n && n.resolvedNodes && childIdx >= 0 && childIdx < n.resolvedNodes.length) {
    n.resolvedNodes[childIdx].x = x;
    n.resolvedNodes[childIdx].y = y;
  }
}

const GameCanvasImpl: React.FC<GameCanvasProps> = ({
  chart,
  bgMedia,
  viewportActive = true,
  isPlaying,
  isPaused,
  gameTime,
  speedMultiplier,
  projectionLeadMs,
  noteRenderDistance = 70,
  noteSizeScale = 1.0,
  antialias = true,
  allowBloom = false,
  allowParticles = false,
  allowDynamicLighting = false,
  allowHitEffects = false,
  renderScale = 1.0,
  autoPlay,
  playSession,
  isEditorMode = false,
  activeEditorTool = 'select',
  isMultiSelect = false,
  snapSubdivision = 0.25,
  onJudgement,
  onSongEnd,
  onFirstFrame,
  onSelectEditorNote,
  onMoveEditorNote,
  onPlaceEditorNote,
  onApplyQuickCreateDelta,
  skinTextures,
  ambientBgRef,
  projectorRef,
  gameCanvasRef,
  storyboardBridge,
  defaultSkinInnerEnabled = true,
  defaultSkinOuterEnabled = false,
  defaultSkinOuterWidth = 0.05,
  defaultSkinOuterColor = '#22d3ee',
  defaultSkinOuterAlpha = 1,
  defaultSkinJudgeWidth = 0.05,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Renders only while the viewport is active (see viewportActive prop). Kept in
  // refs so the mount-effect loop can read/restart it without re-running setup.
  const viewportActiveRef = useRef(true);
  const startLoopRef = useRef<() => void>(() => {});
  // Tracks whether the rAF render loop is currently scheduled. Lets re-arm
  // triggers (viewport re-activate / gameplay start) restart a stopped loop
  // without double-scheduling a second rAF chain.
  const runningRef = useRef(false);
  // Timestamp (performance.now) of the last successful tick. The frame
  // watchdog uses it to detect a stalled loop and force-restart it.
  const lastTickPerfRef = useRef(0);
  // Single rAF handle, shared across loop/startLoop/cleanup so the loop chain
  // can always be cancelled. A `runningRef` token guarantees at most ONE chain
  // ever exists — stale chains self-terminate instead of accumulating.
  const animIdRef = useRef(0);
  const pointersRef = useRef<Map<number, { x: number; y: number; down: boolean; active: boolean; type: string }>>(new Map());
  const dragPointerIdRef = useRef<number | null>(null);
  const pointerDownStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);

  // Throttled editor-drag commit. The drag itself live-updates the dragged
  // note's mesh every frame (via liveMoveResolvedNote), but we only push the
  // authoritative position into React state at a reduced rate + on release.
  // This avoids resolveChart() over the full chart on every rAF frame.
  const dragLiveXRef = useRef<number>(NaN);
  const dragLiveYRef = useRef<number>(NaN);
  // The authoritative position is committed to React state ONCE, on pointer
  // release (see dragFinalCommitRef handling in tick) — never per-frame, so a
  // drag never re-resolves the full chart mid-move.
  const dragFinalCommitRef = useRef<boolean>(false);

  // ====== Quick-Create gesture tracking =========================================
  /** Per-pointer state used by the "quick-create" gesture mode. */
  interface QCTrack {
    pointerId: number;
    /** Audio-clock time at press (seconds). */
    pressTimeSec: number;
    /** Beat value derived from pressTimeSec. */
    pressBeat: number;
    /** Press start 2D pos on the note-plane (in game coords, ~[-2.4,2.4] x [-1.5,1.5]). */
    pressX: number;
    pressY: number;
    /** Full trajectory (pos + audio time) recorded during press. 1 entry per
     *  pointermove + the initial press. Used to detect fast swipes (touch
     *  stream) vs stationary holds (slide notes). */
    trajectory: Array<{ tSec: number; beat: number; x: number; y: number }>;
    /** The last beat for which we placed a note — used to honour the
     *  snapSubdivision minimum interval (no double notes at the same beat). */
    lastPlacedBeat: number | null;
    /** Gesture classification, locked ONCE at the end of the first beat (1 beat
     *  after press) based on the finger's displacement during that first beat:
     *    'undecided'  = still within the first beat, or not yet released
     *    'tap'        = released within the first beat with little movement
     *    'slide'      = first-beat displacement stayed under QC_STATIC_MOVE_PX → held slide
     *    'touch-stream' = first-beat displacement exceeded QC_STATIC_MOVE_PX → swipe of touches */
    gesture: 'undecided' | 'tap' | 'slide' | 'touch-stream';
  }
  const qcTracksRef = useRef<Map<number, QCTrack>>(new Map());
  /** Refs for the latest values of props used inside gesture callbacks.
   *  activeToolRef / chartRef are declared later alongside the other
   *  per-prop refs and shared between editor / QC logic. */
  const snapSubdivisionRef = useRef(snapSubdivision);
  const onApplyQuickCreateDeltaRef = useRef(onApplyQuickCreateDelta);
  const judgedNotesRef = useRef<Set<string>>(new Set());
  const songEndedRef = useRef(false);
  const songEndTimerRef = useRef<number | null>(null);
  /** 本局开始时的时间（秒）。从谱面中间试玩时>0，用于把起点之前的音符预先
   *  标记为已判定，避免开局瞬间刷出一排先前音符的 Miss 框。 */
  const playStartTimeRef = useRef(0);
  /** Incremented in commitJudgement / commitSlideNode so the song-end check
   *  is O(1) instead of iterating all notes every frame. */
  const judgedCountRef = useRef(0);
  /** Total playable note count (head + slide child nodes) — set in resetPlayState. */
  const totalNotesRef = useRef(0);
  /** Max timeSec across all notes (incl. slide children) — set in resetPlayState. */
  const lastNoteTimeRef = useRef(0);
  /** Event system state */
  const nextEventIdxRef = useRef(0);
  const currentTextRef = useRef<{ text: string; endTime: number | null; x?: number; y?: number; fontSize?: number; color?: string } | null>(null);
  const currentNoteColorRef = useRef<string | null>(null);
  const currentBgRef = useRef<{ gradientStart: string; gradientEnd: string } | null>(null);
  /** 环境背景媒体层（§3.6）：image/video 双槽叠放，换背景时旧槽淡出新槽淡入。
   *  命令式管理（不进 React state）——与该 DOM 层的既有用法一致。 */
  const bgMediaRef = useRef<{
    a: HTMLElement | null;
    b: HTMLElement | null;
    active: 'a' | 'b';
    key: string;
  }>({ a: null, b: null, active: 'a', key: '' });
  /** 背景媒体 prop 镜像（开局取值用，避免闭包过期）。 */
  const bgMediaPropRef = useRef(bgMedia);
  bgMediaPropRef.current = bgMedia;
  /** 媒体铺满方式 → CSS object-fit。 */
  const bgFitCss = (fit?: string): string =>
    fit === 'contain' ? 'contain' : fit === 'stretch' ? 'fill' : 'cover';
  /**
   * 把一组背景配色（可选叠加媒体层）应用到画布后方的环境背景 DOM 层（ambientBgRef）。
   * 渐变公式与 App.tsx 中逐谱面基础背景保持一致，确保 bg_change 与基础背景视觉统一。
   *
   * `media`：
   *  - `undefined` → 不动媒体层（纯配色事件：图片/视频背景之上改渐变底色）；
   *  - `null` → 清除媒体层（回到纯渐变）；
   *  - `{ type, src }` → 切换/设置媒体。`fadeSec > 0` 时交叉淡入淡出。
   */
  const applyAmbientBg = (
    scheme: { gradientStart: string; gradientEnd: string },
    media?: { type: 'image' | 'video'; src: string; fit?: string; opacity?: number } | null,
    fadeSec = 0
  ) => {
    const el = ambientBgRef?.current;
    if (!el) return;
    el.style.background =
      `radial-gradient(circle at 50% 50%, ${scheme.gradientEnd} 21.6%, ${scheme.gradientStart} 90%)`;
    if (media === undefined) return;

    const st = bgMediaRef.current;
    const fade = Math.max(0, fadeSec);
    const hide = (m: HTMLElement | null) => {
      if (!m) return;
      m.style.opacity = '0';
      if (m instanceof HTMLVideoElement) m.pause();
    };
    if (!media) {
      // 清除：两个槽都淡出（无过渡时立即移除，避免残留 DOM）。
      if (fade <= 0) {
        st.a?.remove();
        st.b?.remove();
        st.a = st.b = null;
      } else {
        hide(st.a);
        hide(st.b);
      }
      st.key = '';
      st.active = 'a';
      return;
    }

    const key = `${media.type}|${media.src}`;
    if (st.key === key) {
      // 仅铺满方式/不透明度变化：就地更新活动槽样式。
      const cur = st.active === 'a' ? st.a : st.b;
      if (cur) {
        cur.style.objectFit = bgFitCss(media.fit);
        cur.style.opacity = String(media.opacity ?? 1);
      }
      return;
    }

    // 写入非活动槽 → 交叉淡入淡出（fade=0 时瞬时切换）。
    const inactiveName = st.active === 'a' ? 'b' : 'a';
    let slot = inactiveName === 'a' ? st.a : st.b;
    if (!slot) {
      slot =
        media.type === 'video'
          ? document.createElement('video')
          : document.createElement('img');
      slot.style.position = 'absolute';
      slot.style.inset = '0';
      slot.style.width = '100%';
      slot.style.height = '100%';
      el.appendChild(slot);
      st[inactiveName] = slot;
    }
    slot.style.transition = fade > 0 ? `opacity ${fade}s ease` : 'none';
    slot.style.objectFit = bgFitCss(media.fit);
    slot.style.opacity = '0';
    if (media.type === 'video') {
      const v = slot as HTMLVideoElement;
      if (v.getAttribute('src') !== media.src) {
        v.src = media.src;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
      }
      v.play().catch(() => { /* 自动播放被拒：静默（静音视频通常允许） */ });
    } else {
      (slot as HTMLImageElement).src = media.src;
    }
    // 触发一次布局后再设透明度，保证 CSS transition 生效。
    void slot.offsetWidth;
    slot.style.opacity = String(media.opacity ?? 1);
    hide(st.active === 'a' ? st.a : st.b);
    st.active = inactiveName;
    st.key = key;
  };
  /** 将环境背景恢复为基础配色 + 歌曲目录背景媒体（开局/重置/反向 seek 后调用）。
   *  媒体来自 bgMedia prop（bg.jpg / bga.mp4），优先级 video > image；铺满 cover、不透明 1。 */
  const resetAmbientBg = () => {
    const bg = chartRef.current?.metadata.bgScheme;
    if (!bg) return;
    const m = bgMediaPropRef.current;
    const media = m?.video
      ? { type: 'video' as const, src: m.video, fit: 'cover', opacity: 1 }
      : m?.image
        ? { type: 'image' as const, src: m.image, fit: 'cover', opacity: 1 }
        : null;
    applyAmbientBg({ gradientStart: bg.gradientStart, gradientEnd: bg.gradientEnd }, media);
  };
  /**
   * 统一应用一条 bg_change（供时间轴事件、反向 seek 重建与触发器共用）：
   * 只改渐变配色；媒体层由歌曲文件决定，事件不再切换（旧字段读取时忽略）。
   */
  const applyBgEvent = (evt: {
    gradientStart?: string; gradientEnd?: string; duration?: number;
  }) => {
    const base = currentBgRef.current ?? chartRef.current?.metadata.bgScheme
      ?? { gradientStart: '#050c1e', gradientEnd: '#1a0d2e' };
    const gs = evt.gradientStart || base.gradientStart;
    const ge = evt.gradientEnd || base.gradientEnd;
    currentBgRef.current = { gradientStart: gs, gradientEnd: ge };
    applyAmbientBg({ gradientStart: gs, gradientEnd: ge }, undefined, evt.duration ?? 0);
  };
  const eventTextRef = useRef<HTMLDivElement>(null);
  // Cached last-applied text styles so we only touch the DOM when a value
  // actually changes (avoids redundant style recalcs at 144Hz).
  const lastTextStyleRef = useRef({ left: '', top: '', fs: '', color: '', op: '' });
  const lastTickTimeRef = useRef(0);
  /** Max (last_child_time - head_time) across all slides — used to expand the
   *  sliding window's pastBuffer so slides whose head is far in the past but
   *  whose children are still upcoming are not skipped from processing. */
  const maxSlideSpanRef = useRef(0);
  /** Previous frame's note window [firstIdx, lastIdx) over the current
   *  resolvedNotes array. The windowed render loop only visits notes inside
   *  [firstIdx, lastIdx), so a note that LEAVES the window (e.g. after a big
   *  seek while dragging the editor progress bar) is never visited and never
   *  gets `mesh.visible = false` → it lingers on screen as a ghost. Each frame
   *  we hide every note that was in last frame's window but is outside this
   *  frame's window. The notes array identity is stored so a chart change
   *  (which clears meshes via resetPlayState) invalidates the stale window. */
  const lastWindowRef = useRef<{ firstIdx: number; lastIdx: number; notes: PreparedNote[] | null }>({ firstIdx: 0, lastIdx: 0, notes: null });
  /** 负流速：并集遍历的复用缓冲（每帧 reset，避免分配）。 */
  const unionScratchRef = useRef<number[]>([]);
  /** 负流速：并集去重的帧戳数组 + 当前帧号。 */
  const unionStampRef = useRef<{ arr: Int32Array | null; frame: number }>({ arr: null, frame: 0 });
  /** 负流速：上一帧访问过的音符下标（用于幽灵网格的帧戳差分清理）。 */
  const lastVisitedRef = useRef<{ notes: PreparedNote[] | null; list: number[] }>({ notes: null, list: [] });
  const touchTrackRef = useRef<Map<string, TouchJudgeState>>(new Map());
  const slideStateRef = useRef<Map<string, SlideRt>>(new Map());

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  // 命名场景图分组句柄（setup 内创建并写入，运行时 ensure*/spawnBurst 经此挂载）。
  const groupsRef = useRef<SceneGroups | null>(null);
  /** Post-processing composer — only created when allowBloom AND
   *  chart.metadata.effectToggles.bloom is true. Otherwise null and the renderer
   *  falls back to a direct `renderer.render(scene, camera)` call. */
  const composerRef = useRef<EffectComposer | null>(null);
  /** SelectiveBloom state — bloom camera, offscreen RT, UnrealBloomPass, and
   *  the additive overlay quad. Used in place of composerRef when bloom is on.
   *  Only note meshes (BLOOM_LAYER) participate in the bloom input, so tunnel
   *  lines / bursts / projections never over-expose. */
  const bloomComposerRef = useRef<{
    bloomCam: THREE.PerspectiveCamera;
    bloomRT: THREE.WebGLRenderTarget;
    bloomPass: UnrealBloomPass;
    overlayScene: THREE.Scene;
    overlayCam: THREE.OrthographicCamera;
    overlayMat: THREE.ShaderMaterial;
  } | null>(null);
  /** Ambient particle field for allowParticles when chart.effectToggles.particles. */
  const particleFieldRef = useRef<THREE.Points | null>(null);
  /** Particle velocity buffer (one vec3 per point) for the ambient field. */
  const particleVelRef = useRef<Float32Array | null>(null);
  /** Shared soft-circle sprite texture used by both ambient particles and
   *  ultra-mode shatter bursts. Created once per scene rebuild. */
  const particleSpriteRef = useRef<THREE.CanvasTexture | null>(null);
  /** Last audio time seen by tick() — used to compute the true delta for
   *  particle z-advance so particles flow at exactly the same rate as notes
   *  (which are positioned from audio time, not frame count). */
  const lastCurTimeRef = useRef<number | null>(null);
  /** Tunnel wall planes for ultra mode — receive lighting from note PointLights. */
  const ultraWallsRef = useRef<THREE.Group | null>(null);
  /** Pool of N PointLights for ultra mode — repositioned each frame to follow
   *  the closest-to-judge-plane notes. Avoids per-note PointLight explosion. */
  const ultraLightPoolRef = useRef<THREE.PointLight[]>([]);
  /** Active light-burst particle systems emitted on note hit (ultra mode). */
  const shatterSystemsRef = useRef<Array<{
    points: THREE.Points;
    velocities: Float32Array;
    startMs: number;
    duration: number;
  }>>([]);

  const noteMeshesRef = useRef<Map<string, { group: THREE.Group; projectionGroup: THREE.Group }>>(new Map());
  const slideMeshesRef = useRef<Map<string, SlideMeshSet>>(new Map());
  const selectionGizmoRef = useRef<THREE.Line | null>(null);
  // 多选 gizmo 池：为每个选中的 note（头节点）绘制一个金色选中框。
  const multiGizmosRef = useRef<THREE.Line[]>([]);
  const isMultiSelectRef = useRef(isMultiSelect);
  useEffect(() => { isMultiSelectRef.current = isMultiSelect; }, [isMultiSelect]);
  const activeBurstsRef = useRef<Array<{
    group: THREE.Group;
    startTime: number;
    duration: number;
    scaleTarget: number;
    baseScale: number;
  }>>([]);

  // 谱面运行时预处理层（见 utils/chartRuntime）：一次完成解析 + 预计算
  //  · 每个音符 / slide 子节点的滚动距离（替代每帧逐音符线性扫描变速点）
  //  · 变速点前缀和（使任意时刻的滚动距离可 O(log N) 求得）
  //  · 窗口所需的 hasNegativeSpeed / minSpeed / totalNotes / lastNoteTime / maxSlideSpan
  // 同一谱面重复进入（重试）命中 WeakMap 缓存，零重算；不做持久化。
  const chartRuntime = useMemo(() => getChartRuntime(chart), [chart]);
  const runtimeRef = useRef(chartRuntime);
  useEffect(() => { runtimeRef.current = chartRuntime; }, [chartRuntime]);

  const resolvedNotes = chartRuntime.notes;
  const resolvedRef = useRef(resolvedNotes);
  // id → PreparedNote 索引（P2-6）：把编辑器 gizmo 每帧的 O(N) notes.find 改为 O(1) 查表。
  // 仅在 resolvedNotes 变化时重建；in-place 编辑改的是同一 note 对象引用，Map 取到的是最新值。
  const noteIndexRef = useRef<Map<string, PreparedNote>>(new Map());
  useEffect(() => {
    resolvedRef.current = resolvedNotes;
    const idx = new Map<string, PreparedNote>();
    for (const n of resolvedNotes) idx.set(n.id, n);
    noteIndexRef.current = idx;
  }, [resolvedNotes]);

  // —— 图层（Layer）运行时 ——
  // 树随谱面重建；偏移数组按图层数预分配，tick 每帧原地更新（热路径零分配）。
  // note→图层下标按对象缓存（谱面重解析产生新对象时随树一起失效）。
  const layerTreeRef = useRef<LayerTree | null>(null);
  const layerOffsRef = useRef<Array<{ x: number; y: number }>>([ZERO_OFF]);
  const noteLayerCacheRef = useRef<WeakMap<object, number>>(new WeakMap());
  useEffect(() => {
    const tree = buildLayerTree(chart);
    layerTreeRef.current = tree;
    layerOffsRef.current = tree.nodes.map(() => ({ x: 0, y: 0 }));
    noteLayerCacheRef.current = new WeakMap();
  }, [chart]);
  /** 音符所属图层下标（带缓存）。 */
  const layerIdxOf = (n: object): number => {
    const cache = noteLayerCacheRef.current;
    let idx = cache.get(n);
    if (idx === undefined) {
      const tree = layerTreeRef.current;
      idx = tree ? noteLayerIdx(tree, n) : 0;
      cache.set(n, idx);
    }
    return idx;
  };
  /** 当前帧该音符所在图层的合成偏移 —— 统一按**当前播放时间**求值：
   *  播放中整列平移（动画）；编辑器暂停/擦洗时即「冻结在当前时间轴位置的一帧」。
   *  逐帧值由 tick 顶部统一写入 layerOffsRef（每图层一次，零分配）。
   *  放置/拖动的写回反解不在此处（App 放置包装与拖动块按「音符自己的时间」计算）。 */
  const offOf = (n: object): { x: number; y: number } => {
    const offs = layerOffsRef.current;
    const idx = layerIdxOf(n);
    return idx >= 0 && idx < offs.length ? offs[idx] : ZERO_OFF;
  };
  /** 指定图层在时刻 t 的合成偏移（slide 子节点按各自 timeSec 取值时用）。 */
  const layerOffAtIdx = (idx: number, t: number): { x: number; y: number } => {
    const tree = layerTreeRef.current;
    if (!tree) return ZERO_OFF;
    return layerOffsetAt(tree, idx, t);
  };
  /** 指定图层合成偏移，**写入 out**（零分配）——热路径（每可见音符每帧）专用。 */
  const layerOffAtIdxInto = (idx: number, t: number, out: { x: number; y: number }): void => {
    const tree = layerTreeRef.current;
    if (!tree) { out.x = 0; out.y = 0; return; }
    layerOffsetAtInto(tree, idx, t, out);
  };
  /** 判定落点图层偏移，**写入 out**（零分配）。 */
  const landingOffOfInto = (n: object, out: { x: number; y: number }): void => {
    const t = (n as { timeSec?: number }).timeSec;
    layerOffAtIdxInto(layerIdxOf(n), typeof t === 'number' ? t : 0, out);
  };

  const resolvedEvents = chartRuntime.events;
  const eventsRef = useRef(resolvedEvents);
  useEffect(() => { eventsRef.current = resolvedEvents; }, [resolvedEvents]);

  // Pre-computed speed change points for scroll distance calculation.
  // This ensures note spacing is visually correct BEFORE a speed change
  // reaches the judge line (no teleportation artifacts).
  // （取自预处理层：传已解析的 events，避免 extractSpeedPoints 内部再解析一遍全谱。）
  const speedPoints = chartRuntime.speedPoints;
  const speedPointsRef = useRef(speedPoints);

  const chartRef = useRef(chart);
  const isPlayingRef = useRef(isPlaying);
  const isPausedRef = useRef(isPaused);
  const gameTimeRef = useRef(gameTime);
  const speedRef = useRef(speedMultiplier);
  const projectionLeadRef = useRef(projectionLeadMs);
  const renderDistRef = useRef(noteRenderDistance);
  const sizeScaleRef = useRef(noteSizeScale);
  const skinTexturesRef = useRef<SkinTextureSet | null>(skinTextures ?? null);
  const defaultSkinInnerEnabledRef = useRef(defaultSkinInnerEnabled);
  const defaultSkinOuterEnabledRef = useRef(defaultSkinOuterEnabled);
  const defaultSkinOuterWidthRef = useRef(defaultSkinOuterWidth);
  const defaultSkinOuterColorRef = useRef(defaultSkinOuterColor);
  const defaultSkinOuterAlphaRef = useRef(defaultSkinOuterAlpha);
  const defaultSkinJudgeWidthRef = useRef(defaultSkinJudgeWidth);
  const antialiasRef = useRef(antialias);
  const renderScaleRef = useRef(renderScale);
  const allowBloomRef = useRef(allowBloom);
  const allowParticlesRef = useRef(allowParticles);
  const allowDynamicLightingRef = useRef(allowDynamicLighting);
  const allowHitEffectsRef = useRef(allowHitEffects);
  /** Chart effect toggles mirror — when false, projection/gridLines are
   *  forcibly disabled regardless of `projectionLeadMs` / tunnel.visible.
   *  Default to all-true if the chart omits effectToggles (see chartParser). */
  const effectTogglesRef = useRef({
    bloom: true, particles: true, projection: true, gridLines: true,
    ...((chart.metadata.effectToggles || {}) as Partial<typeof chart.metadata.effectToggles>),
  });
  useEffect(() => {
    effectTogglesRef.current = {
      bloom: true, particles: true, projection: true, gridLines: true,
      ...((chart.metadata.effectToggles || {}) as Partial<typeof chart.metadata.effectToggles>),
    };
  }, [chart.metadata.effectToggles]);
  const autoPlayRef = useRef(autoPlay);
  const isEditorModeRef = useRef(isEditorMode);
  const activeToolRef = useRef(activeEditorTool);
  const onSelectEditorNoteRef = useRef(onSelectEditorNote);
  const onMoveEditorNoteRef = useRef(onMoveEditorNote);
  const onPlaceEditorNoteRef = useRef(onPlaceEditorNote);
  const onJudgementRef = useRef(onJudgement);
  const onSongEndRef = useRef(onSongEnd);
  const onFirstFrameRef = useRef(onFirstFrame);
  /** 本局是否已上报过首帧（playSession/chart 变化时复位，见 resetPlayState effect）。 */
  const firstFrameReportedRef = useRef(false);

  // R4-3：批量同步纯 prop→ref 镜像（带副作用的 skinTextures/defaultSkin/effectToggles 仍保留独立 effect）。
  usePropRefs(
    {
      isPlaying, isPaused, gameTime, speedMultiplier, projectionLeadMs, noteRenderDistance, noteSizeScale,
      antialias, renderScale, allowBloom, allowParticles,
      allowDynamicLighting, allowHitEffects, autoPlay, isEditorMode, activeEditorTool, snapSubdivision,
      chart, speedPoints,
      onSelectEditorNote, onMoveEditorNote, onPlaceEditorNote, onApplyQuickCreateDelta, onJudgement, onSongEnd,
      onFirstFrame,
    },
    {
      isPlaying: isPlayingRef, isPaused: isPausedRef, gameTime: gameTimeRef, speedMultiplier: speedRef,
      projectionLeadMs: projectionLeadRef, noteRenderDistance: renderDistRef, noteSizeScale: sizeScaleRef,
      antialias: antialiasRef, renderScale: renderScaleRef, allowBloom: allowBloomRef,
      allowParticles: allowParticlesRef, allowDynamicLighting: allowDynamicLightingRef, allowHitEffects: allowHitEffectsRef,
      autoPlay: autoPlayRef, isEditorMode: isEditorModeRef, activeEditorTool: activeToolRef, snapSubdivision: snapSubdivisionRef,
      chart: chartRef, speedPoints: speedPointsRef,
      onSelectEditorNote: onSelectEditorNoteRef, onMoveEditorNote: onMoveEditorNoteRef, onPlaceEditorNote: onPlaceEditorNoteRef,
      onApplyQuickCreateDelta: onApplyQuickCreateDeltaRef, onJudgement: onJudgementRef, onSongEnd: onSongEndRef,
      onFirstFrame: onFirstFrameRef,
    },
  );
  /**
   * Rebuild event state from scratch up to the given time.
   * Used when seeking/scrubbing to ensure event state is consistent.
   */
  const rebuildEventState = (upToTime: number) => {
    const events = eventsRef.current;
    nextEventIdxRef.current = 0;
    currentTextRef.current = null;
    currentNoteColorRef.current = null;
    currentBgRef.current = null;
    resetAmbientBg();

    while (nextEventIdxRef.current < events.length && events[nextEventIdxRef.current].timeSec <= upToTime) {
      const evt = events[nextEventIdxRef.current];
      // Apply effect (but for text_display, check if it's still active)
      switch (evt.eventType) {
        case 'speed_change':
          // No runtime effect — scroll speed changes are pre-computed in scroll distance.
          // The note spacing already reflects speed changes before the event is reached.
          break;
        case 'text_display':
          if (evt.text) {
            const duration = evt.textDuration ?? 2;
            const endTime = duration > 0 ? evt.timeSec + duration : null;
            if (endTime == null || endTime > upToTime) {
              currentTextRef.current = { text: evt.text, endTime, x: evt.x, y: evt.y, fontSize: evt.fontSize, color: evt.color };
            } else {
              currentTextRef.current = null;
            }
          }
          break;
        case 'note_color_change':
          if (evt.noteColor) currentNoteColorRef.current = evt.noteColor;
          break;
        case 'bg_change':
          applyBgEvent(evt);
          break;
        default:
          break;
      }
      nextEventIdxRef.current++;
    }
  };

  useEffect(() => {
    const prev = skinTexturesRef.current;
    skinTexturesRef.current = skinTextures ?? null;
    // 释放上一套皮肤贴图，避免 GPU 资源泄漏。
    if (prev) {
      (Object.values(prev) as (THREE.Texture | undefined)[]).forEach((t) => t?.dispose?.());
    }
    // 贴图变更时移除并销毁已构建的 note / slide 网格，使其在下帧用新贴图重建。
    noteMeshesRef.current.forEach((entry) => {
      entry.group?.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        mat?.dispose?.();
      });
      entry.group?.removeFromParent();
      // BUGFIX: 之前漏掉 tap/touch 的投影组（slide 分支有 nd.proj.removeFromParent，
      // 这里没有）。贴图变更（每次进游戏皮肤引用都会重载）时旧投影变成场景中的
      // 孤儿对象：它不在任何 ref 里，渲染循环不再更新它，会以最后一次游戏帧的
      // visible 状态 + 皮肤投影材质透明度(0.5) 残留在屏幕上——所以只有自定义皮肤
      // 时可见，且退出/重试都清不掉。
      entry.projectionGroup?.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        mat?.dispose?.();
      });
      entry.projectionGroup?.removeFromParent();
    });
    noteMeshesRef.current.clear();
    slideMeshesRef.current.forEach((sm) => {
      sm.nodes.forEach((nd) => {
        nd.group.removeFromParent();
        if (nd.proj) {
          nd.proj.traverse((o) => {
            const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
            mat?.dispose?.();
          });
          nd.proj.removeFromParent();
        }
      });
      sm.pipes.forEach((p) => p.mesh.removeFromParent());
    });
    slideMeshesRef.current.clear();
  }, [skinTextures]);
  // 默认皮肤自定义项：变更时同步到 ref（新建 note 时读取），并重建已存在的
  // 默认外观网格，使线框粗细/颜色即时生效。
  useEffect(() => {
    defaultSkinInnerEnabledRef.current = defaultSkinInnerEnabled;
    defaultSkinOuterEnabledRef.current = defaultSkinOuterEnabled;
    defaultSkinOuterWidthRef.current = defaultSkinOuterWidth;
    defaultSkinOuterColorRef.current = defaultSkinOuterColor;
    defaultSkinOuterAlphaRef.current = defaultSkinOuterAlpha;
    defaultSkinJudgeWidthRef.current = defaultSkinJudgeWidth;
    if (!skinTexturesRef.current) {
      noteMeshesRef.current.forEach((entry) => {
        entry.group?.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
          mat?.dispose?.();
        });
        entry.group?.removeFromParent();
      });
      noteMeshesRef.current.clear();
      slideMeshesRef.current.forEach((sm) => {
        sm.nodes.forEach((nd) => {
          nd.group.removeFromParent();
          if (nd.proj) nd.proj.removeFromParent();
        });
        sm.pipes.forEach((p) => p.mesh.removeFromParent());
      });
      slideMeshesRef.current.clear();
    }
  }, [defaultSkinInnerEnabled, defaultSkinOuterEnabled, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth, skinTextures]);

  const disposeGroup = (g: THREE.Object3D) => {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        // Shared geometries (module-level, reused across notes) must NOT be
        // disposed here — disposing one would corrupt every other note that
        // still references it. Only per-note geometries get disposed.
        if (!isSharedGeo(o.geometry)) o.geometry?.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m?.dispose();
      }
    });
  };

  /** Force-hide every mesh owned by a note (tap/touch group + projection, or
   *  all slide node groups + their projections + all pipes). Used by the
   *  window-cleanup pass to retire notes that have fallen outside the current
   *  frame's sliding window — otherwise the windowed render loop never visits
   *  them and they'd keep their last-frame `visible = true`. */
  const hideNoteMeshes = (note: PreparedNote) => {
    if (note.type === 'slide') {
      const sm = slideMeshesRef.current.get(note.id);
      if (!sm) return;
      for (const nd of sm.nodes) {
        nd.group.visible = false;
        if (nd.proj) nd.proj.visible = false;
      }
      for (const p of sm.pipes) p.mesh.visible = false;
    } else {
      const entry = noteMeshesRef.current.get(note.id);
      if (entry) {
        entry.group.visible = false;
        entry.projectionGroup.visible = false;
      }
    }
  };

  const resetPlayState = () => {
    noteMeshesRef.current.forEach((entry) => {
      entry.group.removeFromParent();
      entry.projectionGroup.removeFromParent();
      disposeGroup(entry.group);
      disposeGroup(entry.projectionGroup);
    });
    noteMeshesRef.current.clear();
    slideMeshesRef.current.forEach((sm) => {
      sm.nodes.forEach((nd) => {
        nd.group.removeFromParent();
        if (nd.proj) nd.proj.removeFromParent();
        disposeGroup(nd.group);
        if (nd.proj) disposeGroup(nd.proj);
      });
      sm.pipes.forEach((p) => {
        p.mesh.removeFromParent();
        // Each pipe owns its geometry; dispose it (shared geos are tagged and skipped).
        if (!isSharedGeo(p.geo)) p.geo.dispose();
        p.mat.dispose();
      });
    });
    slideMeshesRef.current.clear();
    activeBurstsRef.current.forEach((b) => { b.group.removeFromParent(); recycleBurst(b.group); });
    activeBurstsRef.current = [];
    judgedNotesRef.current.clear();
    songEndedRef.current = false;
    // Clear per-play overlap-merge hit regions so a replay starts fresh.
    for (const n of resolvedRef.current) n.extraHitRegions = undefined;
    // Invalidate the previous frame's window so the cleanup pass doesn't try
    // to hide notes from the old chart (their meshes are already cleared above).
    lastWindowRef.current = { firstIdx: 0, lastIdx: 0, notes: null };
    // Precompute song-end metrics for an O(1) per-frame end check.
    const resolved = resolvedRef.current;
    let total = 0;
    let lastT = 0;
    let maxSlideSpan = 0;
    for (const n of resolved) {
      // 假音符 / 不计分音符不计入 totalNotes（与 chartRuntime.totalNotes 同口径）；
      // lastNoteTime / maxSlideSpan 仍统计，歌曲结束的时间兜底不受影响。
      const counted = !(n.fake || n.noScore);
      if (counted) total++; // head counts as one
      if (n.type === 'slide') {
        const childCount = n.resolvedNodes?.length ?? 0;
        if (counted) total += childCount;
        let lastChildT = n.timeSec;
        if (n.resolvedNodes) {
          for (const nd of n.resolvedNodes) {
            if (nd.timeSec > lastChildT) lastChildT = nd.timeSec;
            if (nd.timeSec > lastT) lastT = nd.timeSec;
          }
        }
        const span = lastChildT - n.timeSec;
        if (span > maxSlideSpan) maxSlideSpan = span;
      }
      if (n.timeSec > lastT) lastT = n.timeSec;
    }
    totalNotesRef.current = total;
    lastNoteTimeRef.current = lastT;
    maxSlideSpanRef.current = maxSlideSpan;
    judgedCountRef.current = 0;
    touchTrackRef.current.clear();
    slideStateRef.current.clear();
    // 从谱面中间开始试玩：把起点之前的音符预先标记为"已判定"（只标记、不产生
    // 判定/不计入 judgedCount），从而开局瞬间不再刷出一排先前音符的 Miss 框，
    // 同时其网格/连线也会因 judged 而被隐藏/退役。歌曲结束由时间判定
    // `curTime > lastNoteTime + 2` 兜底，因此不会因这些音符未计入而卡结算。
    playStartTimeRef.current = gameTimeRef.current;
    if (playStartTimeRef.current > 0) {
      for (const n of resolved) {
        if (n.timeSec < playStartTimeRef.current) judgedNotesRef.current.add(n.id);
        if (n.type === 'slide') {
          const count = 1 + (n.resolvedNodes?.length ?? 0);
          for (let i = 0; i < count; i++) {
            const t = i === 0 ? n.timeSec : (n.resolvedNodes?.[i - 1]?.timeSec ?? n.timeSec);
            if (t < playStartTimeRef.current) judgedNotesRef.current.add(`${n.id}#${i}`);
          }
        }
      }
    }
    // Reset event system state
    nextEventIdxRef.current = 0;
    currentTextRef.current = null;
    currentNoteColorRef.current = null;
    currentBgRef.current = null;
    resetAmbientBg();
    lastTickTimeRef.current = 0;
  };

  /**
   * Handle a single chart event at trigger time.
   * Modifies runtime refs (speed, text, colors) that are read by the render loop.
   */
  const handleEvent = (evt: ResolvedEvent, currentTime: number) => {
    switch (evt.eventType) {
      case 'speed_change':
        // No runtime effect — scroll speed changes are pre-computed in scroll distance.
        // The note spacing already reflects speed changes before the event is reached.
        break;
      case 'text_display':
        if (evt.text) {
          const duration = evt.textDuration ?? 2;
          currentTextRef.current = {
            text: evt.text,
            endTime: duration > 0 ? currentTime + duration : null,
            x: evt.x,
            y: evt.y,
            fontSize: evt.fontSize,
            color: evt.color,
          };
        }
        break;
      case 'note_color_change':
        if (evt.noteColor) {
          currentNoteColorRef.current = evt.noteColor;
        }
        break;
      case 'bg_change':
        applyBgEvent(evt);
        break;
      default:
        break;
    }
  };

  // 事件 id → 事件表：触发器 `{ ref }` 用它引用谱面里已定义的事件（顶层 + 各图层事件轴）。
  const eventByIdRef = useRef<Map<string, ResolvedEvent>>(new Map());
  useEffect(() => {
    const m = new Map<string, ResolvedEvent>();
    const push = (list?: ResolvedEvent[]) => {
      if (!list) return;
      for (const e of list) if (e.id) m.set(e.id, e);
    };
    push(chartRuntime.events);
    const layers = chart.layers;
    if (layers) for (const l of layers) push(l.events as ResolvedEvent[] | undefined);
    eventByIdRef.current = m;
  }, [chart, chartRuntime]);

  /**
   * 音符触发器（§3.4）分发：把该音符在本次判定下触发的事件交给 `handleEvent` 执行。
   * 只支持运行时可即时生效的类型（文本 / 音符色 / 背景）；变速与偏移已预先积分，
   * 无法在判定时刻改变，直接忽略（编辑器会对此给 warning）。
   */
  const dispatchNoteTrigger = (note: PreparedNote, judgement: JudgementType): void => {
    if (!note.trigger) return;
    const evts = resolveTriggerEvents(note, judgement, (id) => eventByIdRef.current.get(id));
    const now = gameTimeRef.current;
    for (const e of evts) {
      if (isTriggerEventUnsupported(e)) continue;
      handleEvent({ ...e, timeSec: now } as ResolvedEvent, now);
    }
  };

  useEffect(() => {
    resetPlayState();
    firstFrameReportedRef.current = false; // 新的一局：重新等待首帧上报
  }, [playSession, chart]);

  // 返回菜单 / 结算（非 暂停、非编辑器）时清空所有 note / projection / slide / burst
  // 网格，避免中途退出后 projection 等残留在屏幕上不消失。
  useEffect(() => {
    if (!isPlaying && !isPaused && !isEditorMode) {
      resetPlayState();
    }
  }, [isPlaying, isPaused, isEditorMode]);

  // Pause/resume the render loop when the editor switches between 3D and 2D
  // view. While inactive the loop self-stops (see `loop` in the setup effect);
  // flipping back to active re-arms it. The WebGL scene + meshes are preserved
  // so the switch-back is instant instead of rebuilding everything.
  useEffect(() => {
    viewportActiveRef.current = viewportActive;
    if (viewportActive) startLoopRef.current();
  }, [viewportActive]);

  // Re-arm the render loop when gameplay actually starts. The single initial
  // rAF scheduled inside the heavy setup effect (WebGL context creation,
  // forceContextLoss/dispose, scene rebuild) can be dropped on low-end iOS
  // when the main thread is saturated at game start — and `viewportActive`
  // does NOT change at that moment (it is already true during play), so the
  // effect above never re-fires to recover it. That leaves the scene frozen
  // (incl. background particles) while audio/judge logic keep running off
  // audio.getCurrentTime(). Re-arming on `isPlaying` recovers a dropped loop
  // within the same session, without needing a pause/retry.
  useEffect(() => {
    if (isPlaying) startLoopRef.current();
  }, [isPlaying]);

  // `vpKey` is bumped when the 3D viewport becomes visible again (see the
  // ResizeObserver below) so the heavy setup effect re-runs with correct
  // dimensions and the metadata edited while hidden.
  const [vpKey, setVpKey] = useState(0);

  // A plain window 'resize' listener does NOT fire when a container transitions
  // display:none → block (e.g. switching the editor from 2D back to 3D), so the
  // WebGL canvas never gets re-sized / re-built and stays blank. Watch the
  // container with a ResizeObserver and bump `vpKey` on the hidden→visible edge.
  // 容器 rect 缓存：触摸事件处理器用此缓存代替每次 getBoundingClientRect()。
  // 原实现每次 touch/pointer 事件都强制同步 layout —— App 侧 HUD 每帧写 style 使
  // layout 树持续脏，点击时该调用触发完整 layout 计算（HarmonyOS 弱设备上数十 ms
  // 长任务），正是"每次点击停顿 + 音频/谱面连动停"的根因。此处仅在 ResizeObserver
  // 触发时低频更新（一次 layout 读），触摸路径零同步 layout。
  const containerRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let wasVisible = el.clientWidth > 0 && el.clientHeight > 0;
    let scheduled = false;
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // 合并高频 RO 回调到每帧一次，避免持续 resize 时反复读取 layout（P2-10）。
      requestAnimationFrame(() => {
        scheduled = false;
        const visible = el.clientWidth > 0 && el.clientHeight > 0;
        containerRectRef.current = el.getBoundingClientRect();
        if (visible && !wasVisible) setVpKey((k) => k + 1);
        wasVisible = visible;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;
    // The 3D viewport may be hidden — e.g. the editor is in 2D view, where this
    // canvas is display:none and reports a 0×0 box. Never build/rebuild the
    // WebGL scene while hidden: doing so would create a useless 0×0 renderer and
    // tear down the previously-good one, leaving a blank 3D view when we switch
    // back. The ResizeObserver above bumps `vpKey` when the container becomes
    // visible again, re-running this effect at the correct size with whatever
    // metadata was edited while hidden.
    if (w <= 0 || h <= 0) return;
    const scene = new THREE.Scene(); sceneRef.current = scene;
    // 命名场景图分组：一次性静态对象与运行时动态对象按职责挂载到对应 Group，
    // 分组按"首个对象原应插入 scene 的位置"逐个 add 到 scene，确保渲染顺序不变。
    const groups = createSceneGroups();
    groupsRef.current = groups;
    const camera = new THREE.PerspectiveCamera(CAMERA_VFOV, w / h, 0.1, 1000);
    const dist0 = fitCameraDistance(w / h);
    camera.position.set(0, CAMERA_AXIS_Y, dist0); camera.lookAt(0, CAMERA_AXIS_Y, 0); cameraRef.current = camera;

    // 判定面 → 屏幕投影器（故事板 `api.toScreen` / `api.input` 的 sx·sy 消费）：
    // 用主相机实时 project，bloom / 分辨率 / 相机参数变化都天然正确。坐标返回画布 CSS 像素。
    {
      const projV = new THREE.Vector3();
      const projector: JudgeProjector = (x: number, y: number) => {
        const cam = cameraRef.current;
        if (!cam) return { sx: 0, sy: 0 };
        projV.set(x, y, JUDGE_Z).project(cam);
        const el = rendererRef.current?.domElement;
        return {
          sx: (projV.x * 0.5 + 0.5) * (el?.clientWidth ?? 0),
          sy: (1 - (projV.y * 0.5 + 0.5)) * (el?.clientHeight ?? 0),
        };
      };
      if (projectorRef) projectorRef.current = projector;
      // 指针桥复用同一个投影器（§3.7 v3）：故事板不必自己投影指针坐标。
      if (storyboardBridge) storyboardBridge.project = projector;
    }
    // 抗锯齿 / 渲染倍率由传入的细项控制（自定义档位下由用户决定）。
    const useAA = antialiasRef.current;
    const renderer = new THREE.WebGLRenderer({
      antialias: useAA,
      alpha: true,
      // 允许在帧结束后读取画布（结算截图 / 分享成绩用）。轻微性能开销，可接受。
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    // 主场景直渲屏幕（bloom 只是附加叠加层）：清除 alpha 恒为 0，保证画布透明 ——
    // DOM 的 ambient 渐变 / 故事板 bg 层才能透出来（bloom RT 的 clear 也用同值）。
    renderer.setClearColor(0x000000, 0);
    // Per-material clipping planes drive the slide-pipe "clip at the judgement
    // plane" behaviour (and the editor far-plane trim) without rebuilding geometry.
    renderer.localClippingEnabled = true;
    renderer.setSize(w, h);
    // 渲染倍率（分辨率缩放）：>1 超采样更清晰但更耗 GPU，<1 降分辨率换帧率。
    // 上限 1.5→1.25：HarmonyOS 平板（Kirin 9000wm，dpr≥2）上 2x 屏原先会渲染到
    // 1.5× 像素，约 30% 像素量用于超采样。降至 1.25 在弱 GPU 上显著减轻 fill-rate
    // 压力，视觉清晰度仍足够；renderScale（低画质 0.75）继续叠加。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25) * renderScaleRef.current);
    // Remove any previous canvas without touching other DOM children (text overlays, etc.)
    const existingCanvas = container.querySelector('canvas');
    if (existingCanvas) existingCanvas.remove();
    container.appendChild(renderer.domElement); rendererRef.current = renderer;
    // 把真实画布回写给宿主（§3.7 v4 api.scene 用它抓画面，不猜 querySelector）
    if (gameCanvasRef) gameCanvasRef.current = renderer.domElement;
    // 注册截图函数：结算分享时抓取当前游戏画面（不把 3D 模块静态引入首屏）。
    setCanvasCapturer(() => {
      const r = rendererRef.current;
      const s = sceneRef.current;
      const c = cameraRef.current;
      if (!r) return null;
      try {
        if (s && c) r.render(s, c);
        return r.domElement.toDataURL('image/png');
      } catch {
        return null;
      }
    });

    // iOS Safari (tabbed AND standalone/PWA) arms a double-tap-zoom gesture
    // recognizer per touch *target*. That recognizer holds the 2nd+ rapid tap
    // for ~300ms to decide if it's a zoom — which shows up as "missing fast
    // taps" in gameplay. Setting touch-action: none on the parent isn't enough;
    // it must be on the canvas itself (the element the touch actually lands
    // on), so we pin it inline to survive any library/UA stylesheet override.
    // The loupe/magnifier is already killed by the non-passive touchstart
    // preventDefault below; here we also block text selection / callout that
    // can swallow a held tap. Pointer events (gameplay input) are unaffected.
    const cv = renderer.domElement;
    cv.style.touchAction = 'none';
    cv.style.userSelect = 'none';
    cv.style.webkitUserSelect = 'none';
    (cv.style as CSSStyleDeclaration & { webkitTouchCallout?: string }).webkitTouchCallout = 'none';
    const onCanvasTouchStart = (e: TouchEvent) => { e.preventDefault(); };
    cv.addEventListener('touchstart', onCanvasTouchStart, { passive: false });

    // effectToggles defaults to all-true (see chartParser.ts) — only the chart
    // author can explicitly disable each effect.
    const toggles = chart.metadata.effectToggles || { bloom: true, particles: true, projection: true, gridLines: true };

    const gridColor = new THREE.Color(chart.metadata.bgScheme.accentColor || '#00f0ff');
    const tunnel = new THREE.Group();
    const dMat = new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.18 });
    [[-3.6,-2.4],[3.6,-2.4],[3.6,2.4],[-3.6,2.4],[-1.8,-1.2],[1.8,-1.2],[1.8,1.2],[-1.8,1.2]].forEach(([cx,cy])=>{
      tunnel.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx*1.8,cy*1.8,-90),new THREE.Vector3(cx,cy,0)]),dMat));
    });
    tunnel.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-3.8,-2.5,0),new THREE.Vector3(3.8,-2.5,0),new THREE.Vector3(3.8,2.5,0),new THREE.Vector3(-3.8,2.5,0),new THREE.Vector3(-3.8,-2.5,0),
    ]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })));
    // effectToggles.gridLines === false → hide the entire tunnel group.
    tunnel.visible = toggles.gridLines !== false;

    const gizmoHalf = TAP_SIZE * 0.65;
    const gizmoGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-gizmoHalf, -gizmoHalf, 0),
      new THREE.Vector3(gizmoHalf, -gizmoHalf, 0),
      new THREE.Vector3(gizmoHalf, gizmoHalf, 0),
      new THREE.Vector3(-gizmoHalf, gizmoHalf, 0),
      new THREE.Vector3(-gizmoHalf, -gizmoHalf, 0),
    ]);
    const gizmoMat = new THREE.LineBasicMaterial({ color: 0xffd700, linewidth: 3, transparent: true, opacity: 0 });
    const gizmo = new THREE.Line(gizmoGeo, gizmoMat);
    gizmo.visible = false;
    scene.add(groups.editor);
    groups.editor.add(gizmo);
    selectionGizmoRef.current = gizmo;

    // Multi-select gizmo pool: one gold outline per selected note (lazily grown).
    const multiMat = new THREE.LineBasicMaterial({ color: 0xffd700, linewidth: 2, transparent: true, opacity: 0.85 });
    const pool: THREE.Line[] = [];
    const ensurePool = (n: number) => {
      while (pool.length < n) {
        const g = new THREE.Line(gizmoGeo, multiMat);
        g.visible = false;
        groups.editor.add(g);
        pool.push(g);
      }
    };
    ensurePool(32);
    multiGizmosRef.current = pool;

    scene.add(groups.gameplay);
    // fx 与 lighting 分组始终挂载到 scene：其运行时内容（打击 burst / 碎裂粒子 /
    // 点光源）在 useParticles / allowDynamicLighting 关闭时也可能存在，必须保证
    // 分组本身在场景图中，否则特效会因父组未挂载而不可见。
    scene.add(groups.fx);
    scene.add(groups.lighting);
    groups.gameplay.add(tunnel);

    // === SelectiveBloom for 'high' / 'ultra' quality (if chart enables it) ===
    // SelectiveBloom = bloom applied ONLY to note meshes (tagged with
    // BLOOM_LAYER), not tunnel lines / projections / bursts. This avoids the
    // "everything blooms" over-exposure problem.
    //
    // Implementation: a second camera (bloomCamera) renders only BLOOM_LAYER
    // objects into an offscreen RT. UnrealBloomPass processes it. The result
    // is additively composited over the main render via a fullscreen quad.
    //
    // NOTE: 旧版 EffectComposer 时代主场景渲染进 opaque framebuffer，需要在这里画
    // scene.background 渐变。现在 SelectiveBloom 的主场景**直渲屏幕**（alpha:true +
    // clearAlpha 0），bloom 只经叠加 quad 合成 —— scene.background 必须保持 null，
    // 否则会把 DOM 的 ambient 渐变 / 故事板 bg 层整个挡住（bloom 一开背景全黑）。
    const useBloom = allowBloomRef.current && toggles.bloom !== false;
    if (useBloom) {
      scene.background = null;

      // Main camera also enables BLOOM_LAYER so it still sees the note meshes.
      camera.layers.enable(BLOOM_LAYER);

      // Bloom-only camera — only renders objects tagged with BLOOM_LAYER.
      const bloomCam = camera.clone();
      bloomCam.layers.set(BLOOM_LAYER);

      // Offscreen RT for the bloom-only scene render.
      const bloomRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
      });

      // The UnrealBloomPass — threshold kept low because we already restrict
      // to note meshes only; saturated note colors should bloom fully.
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        0.0,   // strength — strong bloom on notes (selective so no over-exposure)
        0.7,   // radius
        0.0    // threshold — bloom everything since input is only notes
      );

      // Additive overlay quad: blends bloomResult texture onto the main render.
      const overlayScene = new THREE.Scene();
      const overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const overlayMat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      overlayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMat));

      bloomComposerRef.current = {
        bloomCam,
        bloomRT,
        bloomPass,
        overlayScene,
        overlayCam,
        overlayMat,
      };
      composerRef.current = null; // legacy composer no longer used
    } else {
      // No bloom → keep alpha:true so the CSS ambient bg shows through.
      scene.background = null;
      bloomComposerRef.current = null;
      composerRef.current = null;
    }

    // === Ambient particle field for 'high' / 'ultra' quality (if chart enables it) ===
    // Particles are inherently drifting in world space. During gameplay the
    // camera (effectively) advances forward, so the particles appear to rush
    // toward the screen — but they themselves only drift. When paused, the
    // camera stops and particles simply float.
    //
    // Distribution follows the user's "note render distance" setting so the
    // particle cloud density scales with the visible tunnel length.
    // Build the shared soft-circle sprite texture unconditionally: it is used by
    // BOTH the ambient particle field AND the ultra-mode shatter bursts. If it
    // were only created when ambient particles are enabled, disabling background
    // particles would null it out and shatter bursts would fall back to THREE's
    // default square point sprites (visible as square instead of soft glow).
    // (This is a pure canvas draw — creating it even with particles off costs
    // nothing measurable.)
    const sc = document.createElement('canvas');
    sc.width = 32; sc.height = 32;
    const sctx = sc.getContext('2d')!;
    const sgrad = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    sgrad.addColorStop(0,    'rgba(255,255,255,1.0)');
    sgrad.addColorStop(0.4,  'rgba(255,255,255,0.55)');
    sgrad.addColorStop(1,    'rgba(255,255,255,0.0)');
    sctx.fillStyle = sgrad;
    sctx.fillRect(0, 0, 32, 32);
    const spriteTex = new THREE.CanvasTexture(sc);
    spriteTex.colorSpace = THREE.SRGBColorSpace;
    particleSpriteRef.current = spriteTex;

    const useParticles = allowParticlesRef.current && toggles.particles !== false;
    if (useParticles) {
      const renderDist = renderDistRef.current; // mirrors "渲染距离" setting（经 ref 读，避免重建 renderer）
      // Density: ~1.6 particles per unit of tunnel length, capped to keep perf sane.
      const PCOUNT = Math.min(180, Math.max(40, Math.round(renderDist * 1.6)));
      const pos = new Float32Array(PCOUNT * 3);
      // Pure drift velocity (no z-rush — that's camera motion, applied in update).
      const vel = new Float32Array(PCOUNT * 3);
      for (let i = 0; i < PCOUNT; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 7.0;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 4.5;
        // Spread across [-renderDist, +5] so they wrap within the visible tunnel.
        pos[i * 3 + 2] = 5 - Math.random() * (renderDist + 5);
        vel[i * 3]     = (Math.random() - 0.5) * 0.012;
        vel[i * 3 + 1] = (Math.random() - 0.5) * 0.012;
        vel[i * 3 + 2] = 0; // drift is purely lateral; z-motion = camera
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pMat = new THREE.PointsMaterial({
        color: new THREE.Color(chart.metadata.bgScheme.accentColor || '#00f0ff'),
        size: PARTICLE_DUST_SIZE, // smaller — feels like floating dust, not big snowflakes
        map: particleSpriteRef.current,
        transparent: true,
        opacity: 0.5,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const field = new THREE.Points(pGeo, pMat);
      // Particles also bloom in SelectiveBloom mode — they're "light dust".
      field.layers.enable(BLOOM_LAYER);
      groups.fx.add(field);
      particleFieldRef.current = field;
      particleVelRef.current = vel;
    } else {
      particleFieldRef.current = null;
      particleVelRef.current = null;
      // Note: do NOT null particleSpriteRef.current here — the soft-circle sprite
      // is still needed by ultra-mode shatter bursts, even with background
      // particles disabled.
    }

    // === Ultra mode: invisible walls that catch light from note PointLights ===
    // A box-shaped "tunnel room" surrounds the play area. MeshStandardMaterial
    // with low metalness + high roughness gives a soft diffuse response.
    //
    // Each note attaching its own PointLight would explode the shader cost on
    // 1000-note charts, so instead we use a small pool of N lights that are
    // repositioned each frame to follow the closest-to-judge-plane notes
    // (see render loop). Notes themselves stay MeshBasicMaterial (cheap).
    if (allowDynamicLightingRef.current) {
      const walls = new THREE.Group();
      // Wall material: deep navy base + transparent so scene.background
      // (radial gradient) shows through; MeshStandardMaterial catches light
      // from the PointLight pool to create the "notes illuminate walls" effect.
      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x1a2440,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      // Single box covers the entire visible tunnel (z: +2 → -renderDist-5).
      const tunnelLen = renderDistRef.current + 10;
      const roomGeo = new THREE.BoxGeometry(8, 5.5, tunnelLen);
      const room = new THREE.Mesh(roomGeo, wallMat);
      room.position.set(0, 0, -tunnelLen / 2 + 2);
      walls.add(room);
      groups.gameplay.add(walls);
      ultraWallsRef.current = walls;

      // Ambient light so unlit walls are not pure black.
      groups.lighting.add(new THREE.AmbientLight(0x3a4870, 0.6));
      // lighting 分组已在 setup 顶部无条件 scene.add，此处仅填充内容。

      // Pool of 8 PointLights — repositioned each frame to follow the
      // closest notes. More than 8 hurts perf on mid-range GPUs.
      const lightPool: THREE.PointLight[] = [];
      for (let i = 0; i < 8; i++) {
        const pl = new THREE.PointLight(0xffffff, 0, 1800, 1.6);
        pl.position.set(0, 0, -100); // parked far away when unused
        groups.lighting.add(pl);
        lightPool.push(pl);
      }
      ultraLightPoolRef.current = lightPool;
    } else {
      ultraWallsRef.current = null;
      ultraLightPoolRef.current = [];
    }

    const onResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const ww = containerRef.current.clientWidth; const hh = containerRef.current.clientHeight;
      cameraRef.current.aspect = ww / hh;
      const dd = fitCameraDistance(ww / hh);
      cameraRef.current.position.set(0, CAMERA_AXIS_Y, dd);
      cameraRef.current.lookAt(0, CAMERA_AXIS_Y, 0);
      cameraRef.current.updateProjectionMatrix(); rendererRef.current.setSize(ww, hh);
      if (composerRef.current) {
        composerRef.current.setSize(ww, hh);
      }
      // SelectiveBloom resources must track canvas size too.
      if (bloomComposerRef.current) {
        const bc = bloomComposerRef.current;
        bc.bloomRT.setSize(ww, hh);
        bc.bloomPass.setSize(ww, hh);
        // Keep bloom camera in sync with main camera (aspect / fov).
        bc.bloomCam.aspect = ww / hh;
        bc.bloomCam.updateProjectionMatrix();
      }
    };
    window.addEventListener('resize', onResize);
    // Single-chain render loop guarded by a `runningRef` token. The loop only
    // keeps scheduling itself while the token is true AND the viewport is
    // active; flipping the token false makes any live chain self-terminate on
    // its very next frame. This guarantees AT MOST ONE chain ever exists — a
    // force-restart (watchdog / viewport re-activate) cannot accumulate
    // duplicate rAF chains, which previously multiplied tick() work every time
    // it fired (cause of the progressive frame-rate drop on iOS).
    // 帧率上限门控（设置-图形）：被跳过的帧不执行 tick()（省下真正的渲染/逻辑
    // 工作），但 rAF 链保持不断。60fps 上限下判定/音符运动精度充足
    // （最小判定窗口 ±40ms，远大于 16.7ms 帧步）。
    const frameGate = createFrameGate();
    const loop = () => {
      if (!viewportActiveRef.current || !runningRef.current) {
        runningRef.current = false;
        return;
      }
      animIdRef.current = requestAnimationFrame(loop);
      if (!frameGate(performance.now(), qualityStore.getSnapshot().maxFps)) return;
      tick();
    };
    // Re-arm the loop. Idempotent: a live chain never triggers a second one.
    // Always cancels the single tracked handle first so even a stray chain is
    // killed before a fresh one is scheduled.
    startLoopRef.current = () => {
      if (!viewportActiveRef.current || runningRef.current) return;
      cancelAnimationFrame(animIdRef.current);
      runningRef.current = true;
      animIdRef.current = requestAnimationFrame(loop);
    };
    startLoopRef.current();
    // Frame watchdog: if the viewport should be rendering but no tick has run
    // for >1s, force-restart the rAF loop. This self-heals transient stalls
    // that the single initial rAF (scheduled inside this heavy setup, e.g.
    // WebGL context creation / forceContextLoss / scene rebuild) cannot
    // guarantee on low-end iOS at game start, plus any tick exception that
    // breaks the chain. Without it, the scene (incl. background particles)
    // freezes while audio/judge keep running — recoverable only via a view
    // update (tap / orientation change). 1s << normal frame cadence, so a
    // merely-slow frame never trips it.
    lastTickPerfRef.current = performance.now();
    const watchdog = setInterval(() => {
      if (!viewportActiveRef.current) return;
      if (performance.now() - lastTickPerfRef.current > 1000) {
        // Drop the token first: any live chain sees runningRef=false on its
        // next frame and self-terminates, then a single fresh chain is armed.
        runningRef.current = false;
        startLoopRef.current();
      }
    }, 400);
    return () => {
      cancelAnimationFrame(animIdRef.current);
      clearInterval(watchdog);
      runningRef.current = false;
      window.removeEventListener('resize', onResize);
      if (projectorRef) projectorRef.current = null;
      // 同理清画布回写：否则渲染器卸载后宿主仍会抓一个已脱离文档的旧画布
      if (gameCanvasRef) gameCanvasRef.current = null;
      resetPlayState();
      // Dispose legacy EffectComposer resources
      if (composerRef.current) { composerRef.current.dispose(); composerRef.current = null; }
      // Dispose SelectiveBloom resources
      if (bloomComposerRef.current) {
        const bc = bloomComposerRef.current;
        bc.bloomRT.dispose();
        bc.bloomPass.dispose();
        bc.overlayMat.dispose();
        bc.overlayScene.children.forEach((c) => {
          if (c instanceof THREE.Mesh) c.geometry.dispose();
        });
        bloomComposerRef.current = null;
      }
      if (particleFieldRef.current) {
        particleFieldRef.current.removeFromParent();
        particleFieldRef.current.geometry.dispose();
        (particleFieldRef.current.material as THREE.Material).dispose();
        particleFieldRef.current = null;
        particleVelRef.current = null;
      }
      shatterSystemsRef.current.forEach((s) => {
        s.points.removeFromParent();
        recycleShatter(s.points);
      });
      shatterSystemsRef.current.length = 0;
      disposeEffectPools();
      // Dispose ultra light pool
      ultraLightPoolRef.current.forEach((pl) => { pl.removeFromParent(); });
      ultraLightPoolRef.current = [];
      // Dispose scene background texture (bloom mode created it)
      if (scene.background instanceof THREE.Texture) {
        scene.background.dispose();
      }
      // Dispose shared particle sprite texture
      if (particleSpriteRef.current) {
        particleSpriteRef.current.dispose();
        particleSpriteRef.current = null;
      }
      if (songEndTimerRef.current !== null) { window.clearTimeout(songEndTimerRef.current); songEndTimerRef.current = null; }
      renderer.dispose();
      // 释放底层 WebGL context，避免反复切歌/卸载累积 GPU context（浏览器上限约 16 个）。
      renderer.forceContextLoss();
      scene.clear();
      // 解除命名分组内子对象挂载（共享几何/材质/纹理由既有收口处理，避免重复释放）。
      disposeSceneGroups(groups);
      // 释放缓存的软边纹理——引用它们的网格已随 scene.clear() 移除（P2-4）。
      softShapeTexCache.forEach((rec) => rec.texture.dispose());
      softShapeTexCache.clear();
      cv.removeEventListener('touchstart', onCanvasTouchStart);
      sceneRef.current = null; cameraRef.current = null; rendererRef.current = null;
      ultraWallsRef.current = null;
      // Drop any live-drag override so the side panel doesn't keep showing a
      // frozen value if this canvas unmounts mid-drag (e.g. switching to 2D).
      liveDragStore.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.metadata.bgScheme.accentColor, chart.metadata.bgScheme.gradientStart, chart.metadata.bgScheme.gradientEnd, chart.metadata.noteColor, chart.metadata.effectToggles?.bloom, chart.metadata.effectToggles?.particles, chart.metadata.effectToggles?.gridLines, chart.metadata.effectToggles?.projection, antialias, renderScale, allowBloom, allowParticles, allowDynamicLighting, allowHitEffects, vpKey]);

  // ====== Quick-Create time/beat helpers =========================================
  /** Chart-clock timestamp -> beat, via the shared inverse in beatTime.ts.
   *  Handles bpmlist tempo changes, so mid-press beat interpolation stays
   *  correct through BPM shifts. */
  const chartTimeToBeat = (tSec: number): number => {
    const m = chartRef.current.metadata;
    return secondsToBeatMultiBpm(tSec, m.bpm, m.offset || 0, m.bpmlist);
  };

  /* 吸附步长 / 轨迹插值 / 分类阈值已迁至 ../systems/quickCreate（3D 与 2D 共用）。 */

  /** Dispatch a QuickCreateDelta payload to the parent. If the parent hasn't
   *  wired up the callback, fall back to emulating the existing per-note
   *  placement callback so the user never gets stuck in "nothing happens". */
  const qcDispatchDelta = (delta: QuickCreateDelta) => {
    const cb = onApplyQuickCreateDeltaRef.current;
    if (cb) {
      try { cb(delta); } catch { /* swallow */ }
      return;
    }
    // Fallback: place each note individually via the existing single-note
    // callback. The parent's implementation snaps to currentBeat at call
    // time, so this is less precise than the full delta path — that's why we
    // ship the proper callback. But it keeps the feature functional on any
    // consumer that hasn't wired the new prop.
    const place = (type: 'tap' | 'touch', x: number, y: number) => {
      const oldTool = activeToolRef.current;
      activeToolRef.current = type === 'tap' ? 'place-tap' : 'place-touch';
      onPlaceEditorNoteRef.current?.(x, y);
      activeToolRef.current = oldTool;
      onSelectEditorNoteRef.current?.(null);
    };
    for (const t of delta.taps ?? []) place('tap', t.x, t.y);
    for (const t of delta.touches ?? []) place('touch', t.x, t.y);
  };

  /** 快速制谱手势控制器。分类与落音逻辑在 ../systems/quickCreate，与 2D 渲染器
   *  共用；本组件只负责喂指针坐标（世界坐标 + beat）并转发 delta。 */
  const qcControllerRef = useRef<QuickCreateController | null>(null);
  if (!qcControllerRef.current) {
    qcControllerRef.current = createQuickCreateController({
      getSnapSubdivision: () => snapSubdivisionRef.current,
      dispatch: qcDispatchDelta,
    });
  }
  const qc = qcControllerRef.current;

  // 触摸/指针数学缓存：复用 Raycaster/向量/平面，避免每次 pointer 事件分配对象
  // 并在 GC 压力下造成点击停顿（HarmonyOS 平板实测，见性能修复）。
  const pointerMathRef = useRef<{
    rc: THREE.Raycaster;
    ndc: THREE.Vector2;
    plane: THREE.Plane;
    hit: THREE.Vector3;
  } | null>(null);
  if (!pointerMathRef.current) {
    pointerMathRef.current = {
      rc: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      hit: new THREE.Vector3(),
    };
  }
  // pointermove rAF 节流：合并同帧内多次 move，避免触摸拖动时的高频分配 + layout 读。
  const pendingMoveRef = useRef<Map<number, { cx: number; cy: number; pointerType: string }>>(new Map());
  const moveRafRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
    moveRafRef.current = null;
  }, []);

  const updatePointer = (
    pointerId: number,
    cx: number,
    cy: number,
    down: boolean,
    pointerType: string = 'mouse'
  ) => {
    if (!containerRef.current || !cameraRef.current || !pointerMathRef.current) return;
    // 读缓存 rect，避免每次触摸强制同步 layout（见 containerRectRef 注释）。
    const r = containerRectRef.current ?? containerRef.current.getBoundingClientRect();
    const { rc, ndc, plane, hit } = pointerMathRef.current;
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, cameraRef.current);
    if (rc.ray.intersectPlane(plane, hit)) {
      const isTouchLike = pointerType === 'touch' || pointerType === 'pen';
      const active = isTouchLike ? down : true;
      // §3.7 v3 故事板**判定拦截**：被 blockedIds 列出的指针不参与任何判定。
      // 把 down 语义降级为"仅观测"—— 不进判定、不绑 slide、不拖拽。
      const blocked = !!storyboardBridge && down && storyboardBridge.blockedIds.has(pointerId);
      pointersRef.current.set(pointerId, { x: hit.x, y: hit.y, down: down && !blocked, active, type: pointerType });
      if (down && !blocked && dragPointerIdRef.current === null) {
        dragPointerIdRef.current = pointerId;
        pointerDownStartRef.current = { x: hit.x, y: hit.y };
        // Start a fresh drag: reset throttled-commit tracking so the first move
        // is always committed immediately to React state.
        dragLiveXRef.current = NaN;
        dragLiveYRef.current = NaN;
        dragFinalCommitRef.current = false;
      }
    }
  };

  const removePointer = (pointerId: number) => {
    pointersRef.current.delete(pointerId);
    if (dragPointerIdRef.current === pointerId) {
      dragPointerIdRef.current = null;
      pointerDownStartRef.current = null;
      // Mark a pending final commit so the next tick persists the last live
      // position to React state (only if a real drag actually happened).
      if (isDraggingRef.current) dragFinalCommitRef.current = true;
      isDraggingRef.current = false;
    }
  };

  /* ====== 指针桥（§3.7 v3）======
     宿主（StoryboardHost）需要两样东西：①每帧的指针集合（判定面坐标）②判定面→屏幕
     投影。二者都不是"每帧计算"的东西，所以这里把已有的 refs / 投影器**挂到桥上**，
     宿主每帧只做一次同步（零分配）。反向命令只有一条：releaseBindings（立即脱手）。 */
  useEffect(() => {
    const bridge = storyboardBridge;
    if (!bridge) return;
    bridge.pointers = pointersRef.current;
    bridge.releaseBindings = (pointerId: number) => {
      // 解除该指针在所有 slide 上的绑定 → 正在滑的滑条立即脱手（下一帧判 Miss）。
      // 幂等：Set.delete 对不存在的 id 无副作用；遍历期间不改 slideStateRef 的结构。
      slideStateRef.current.forEach((rt) => {
        rt.boundPointerIds.delete(pointerId);
      });
    };
    return () => {
      bridge.pointers = EMPTY_POINTERS;
      bridge.project = null;
      bridge.releaseBindings = noopReleaseBindings;
      bridge.blockedIds.clear();
    };
  }, [storyboardBridge]);

  /** 该指针当前是否被故事板拦截（不参与任何判定）。仅游玩态生效 —— 编辑器不该被故事板夺权。 */
  const isPointerBlocked = (pointerId: number): boolean => {
    if (isEditorModeRef.current) return false;
    const b = storyboardBridge;
    if (!b) return false;
    // ⚠️ 必须**同步重算**：tap 判定在 pointerdown 事件回调里就查这里，而宿主平时
    // 只在 rAF 里更新 blockedIds → 第一次按下读到的是上一帧结论，必然漏判
    //（实测"故事板挡不住 tap"）。syncBlocked 幂等且零分配，每次 tap 多一次
    // 几条指针的过滤循环，可忽略。
    b.syncBlocked?.();
    return b.blockedIds.has(pointerId);
  };

  const isAnyPointerInside = (x: number, y: number, half: number): boolean => {
    for (const p of pointersRef.current.values()) {
      if (!p.active) continue;
      if (Math.abs(p.x - x) < half && Math.abs(p.y - y) < half) return true;
    }
    return false;
  };

  // 默认皮肤：为音符添加 内框(紧贴音符、跟随音符色，Line 恒 1px) + 外框(软边纹理，
  // 颜色/粗细/透明度可调)。外框内径 = 内框外径（视觉上附着在内框上）；颜色/透明度
  // 逐帧由渲染循环设置，粗细在创建时烘焙纹理、设置变更时经 effect 重建网格。
  const addDefaultBorders = (g: THREE.Group, type: 'tap' | 'touch') => {
    const innerGeo = type === 'tap' ? _tapOutlineGeo : _touchOutlineGeo;
    const outer = type === 'tap' ? TAP_RING_OUTER : TOUCH_RING_OUTER;
    g.add(makeOutlineLine(innerGeo, '#ffffff', 1, 'inner'));
    const maxR = (() => { let m = 0; for (const [x, y] of outer) m = Math.max(m, Math.hypot(x, y)); return m; })();
    const w = Math.max(0.001, defaultSkinOuterWidthRef.current);
    const outerPts = outer.map(([x, y]) => [x * ((maxR + w) / maxR), y * ((maxR + w) / maxR)] as RingPt);
    g.add(makeRingMesh(outerPts, w, defaultSkinOuterColorRef.current, 1, 'outer'));
  };

  const mkTap = (c: string) => {
    const g = new THREE.Group();
    const tapTex = skinTexturesRef.current?.tap;
    // 皮肤生效：整块替换为灰度贴图（按判定色染色），不再绘制彩色边框。
    if (tapTex) {
      const fill = new THREE.Mesh(
        _tapSkinGeo,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(c), map: tapTex, transparent: true, opacity: 1, alphaTest: 0.02, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.layers.enable(BLOOM_LAYER);
      g.add(fill);
      return g;
    }
    // 默认外观：软边填充 + 内框(音符色) + 外框(可自定义) 双描边。
    addDefaultBorders(g, 'tap');
    g.add(makeSoftFillMesh(TAP_RING_OUTER.map(([x, y]) => [x * 0.94, y * 0.94] as RingPt), c, 0.18));
    return g;
  };

  const mkTouch = (c: string) => {
    const g = new THREE.Group();
    const touchTex = skinTexturesRef.current?.touch;
    // 皮肤生效：整块替换为灰度贴图（按判定色染色），不再绘制彩色边框。
    if (touchTex) {
      const fill = new THREE.Mesh(
        _touchSkinGeo,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(c), map: touchTex, transparent: true, opacity: 1, alphaTest: 0.02, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.layers.enable(BLOOM_LAYER);
      g.add(fill);
      return g;
    }
    // 默认外观：软边填充 + 内框(音符色) + 外框(可自定义) 双描边。
    addDefaultBorders(g, 'touch');
    g.add(makeSoftFillMesh(TOUCH_RING_OUTER.map(([x, y]) => [x * 0.92, y * 0.92] as RingPt), c, 0.22));
    return g;
  };

  // 按 note 类型取投影贴图：仅取该类型的专属键，缺失时回退到全局共享的
  // projection，再缺失则返回 undefined（走默认判定框渲染）。绝不跨类型借用
  // 其他音符的专属贴图——否则只做了 projTap 的皮肤包会让 touch/slide 的投影
  // 引导也变成同一张贴图。
  const pickProj = (nt: NoteType): THREE.Texture | undefined => {
    const s = skinTexturesRef.current;
    if (!s) return undefined;
    if (nt === 'tap') return s.projTap ?? s.projection;
    if (nt === 'touch') return s.projTouch ?? s.projection;
    return s.projSlide ?? s.projection;
  };
  const projSize = (nt: NoteType) => (nt === 'tap' ? TAP_SIZE : nt === 'touch' ? TOUCH_SIZE : SLIDE_SIZE);

  const mkProj = (type: NoteType, c: string) => {
    const g = new THREE.Group();
    const projTex = pickProj(type);
    if (projTex) {
      // 皮肤投影：灰度贴图绘制在"与屏幕平行"的判定面（xy 平面）上，由
      // material.color × map 染色。不做 x 轴旋转，否则会落到 xz 平面（水平）。
      const size = projSize(type);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(c), transparent: true, opacity: 0.5, map: projTex, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.layers.enable(BLOOM_LAYER);
      g.add(mesh);
      return g;
    }
    // 默认外观：判定框（投影引导）颜色恒等于音符色，仅粗细可调。
    const outer = type === 'tap' ? TAP_RING_OUTER : type === 'touch' ? TOUCH_RING_OUTER : SLIDE_RING_OUTER;
    g.add(makeRingMesh(outer, defaultSkinJudgeWidthRef.current, c, 0, 'judge'));
    return g;
  };

  // R4-2: 判定/特效/编辑器手势逻辑已迁出为独立 hook（useJudgeSystem / useNoteEffects /
  // useEditorGestures）。此处构造强类型 JudgeSystemContext 聚合全部依赖 ref 与 helper，
  // 再实例化 hook；返回的闭包签名与迁移前完全一致，行为零变化。
  // getAllNodes 的偏移感知包装：缓存元素本就每帧从活对象**绝对重同步** x/y，
  // 在此叠加当前帧的图层偏移后，slide 判定（processSlideCore）与 slide 渲染
  // （节点网格 / 管线 / 投影）消费的是同一份「合成后坐标」，天然一致。
  const getAllNodesEff = (note: PreparedNote) => {
    const arr = getAllNodes(note);
    const off = offOf(note);
    if (off.x !== 0 || off.y !== 0) {
      for (let i = 0; i < arr.length; i++) {
        arr[i].x += off.x;
        arr[i].y += off.y;
      }
    }
    return arr;
  };

  const judgeCtx: JudgeSystemContext = {
    sceneRef, groupsRef, sizeScaleRef, defaultSkinJudgeWidthRef, activeBurstsRef,
    allowHitEffectsRef, speedRef, particleSpriteRef, shatterSystemsRef,
    isEditorModeRef, judgedNotesRef, judgedCountRef, chartRef,
    onJudgementRef, slideStateRef, playStartTimeRef, pointersRef, autoPlayRef,
    resolvedRef, isPlayingRef, isPausedRef, gameTimeRef, activeToolRef,
    onPlaceEditorNoteRef, onSelectEditorNoteRef, isDraggingRef,
    getAllNodes: getAllNodesEff,
    getEffectivePos: (n: PreparedNote) => {
      const off = offOf(n);
      return off.x === 0 && off.y === 0 ? n : { x: n.x + off.x, y: n.y + off.y };
    },
    dispatchNoteTrigger,
    getLandingPos: (n: PreparedNote, childIdx?: number) => {
      // PreparedNote 本体不会被嵌入偏移（嵌入只发生在 getAllNodes 的缓存副本里），
      // 这里拿到的是原始 base，直接加「音符/子节点自己 timeSec」的图层偏移即落位。
      let bx = n.x;
      let by = n.y;
      let t = n.timeSec;
      if (childIdx != null && childIdx >= 1) {
        const c = n.resolvedNodes?.[childIdx - 1];
        if (c) {
          bx = c.x;
          by = c.y;
          t = c.timeSec;
        }
      }
      const off = layerOffAtIdx(layerIdxOf(n), t);
      return { x: bx + off.x, y: by + off.y };
    },
    getNoteColor: (n: PreparedNote) => {
      const global = chartRef.current.metadata.noteColor || '#00f0ff';
      if (n.color) return n.color;
      const tree = layerTreeRef.current;
      if (!tree) return global;
      /* 色值按「判定落位时刻」取 —— 与投影框/特效钉落位一致 */
      return layerColorAt(tree, layerIdxOf(n), n.timeSec, global);
    },
    makeRingMesh, pickProj, projSize, chartTimeToBeat,
    // 故事板判定拦截（§3.7 v3）：与 tap 入口读同一判定源（指针桥的 blockedIds）。
    isPointerBlocked,
  };
  const spawnBurst = useNoteEffects(judgeCtx);
  const { commitJudgement, getSlideRt, processSlide } = useJudgeSystem(judgeCtx, spawnBurst);
  const handlePointerInteraction = useEditorGestures(judgeCtx, commitJudgement);

  /** touch 逐帧判定（processTouchCore）的环境面：合成位置 + 活跃指针查询（悬停触发）。 */
  const touchEnv: TouchJudgeEnv<PreparedNote> = {
    getEffectivePos: judgeCtx.getEffectivePos,
    isAnyPointerInside,
  };

  const ensureSlideMeshes = (note: PreparedNote, colorHex: string): SlideMeshSet | null => {
    const scene = sceneRef.current;
    if (!scene) return null;
    const count = 1 + (note.resolvedNodes?.length ?? 0);
    let sm = slideMeshesRef.current.get(note.id);
    if (sm && sm.nodes.length === count) return sm;
    if (sm) {
      sm.nodes.forEach((nd) => {
        nd.group.removeFromParent();
        if (nd.proj) nd.proj.removeFromParent();
        disposeGroup(nd.group);
        if (nd.proj) disposeGroup(nd.proj);
      });
      sm.pipes.forEach((p) => { p.mesh.removeFromParent(); if (!isSharedGeo(p.geo)) p.geo.dispose(); p.mat.dispose(); });
    }
    const nodes: SlideMeshSet['nodes'] = [];
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      const isHead = i === 0;
      const slideTex = skinTexturesRef.current?.slide;
      let innerWire: THREE.LineBasicMaterial | undefined;
      let outerWire: THREE.MeshBasicMaterial | undefined;

      // 皮肤生效时整块替换 node，不绘制彩色边框。否则保留 内框(音符色,Line) + 外框(软边纹理) 两道描边。
      if (!slideTex) {
        const innerRing = makeOutlineLine(_slideOutlineGeo, colorHex, 0, 'inner');
        group.add(innerRing);
        innerWire = innerRing.material as THREE.LineBasicMaterial;
        // 外框：软边纹理环，内径 = 内框外径（附着在内框上）。
        const w = Math.max(0.001, defaultSkinOuterWidthRef.current);
        const outerPts = expandRing(SLIDE_RING_OUTER, w);
        const outerRing = makeRingMesh(outerPts, w, defaultSkinOuterColorRef.current, 0, 'outer');
        group.add(outerRing);
        outerWire = outerRing.material as THREE.MeshBasicMaterial;
      }

      const fill = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: slideTex ? 1 : (isHead ? 0.2 : 0.26),
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      let plane: THREE.Mesh;
      if (slideTex) {
        // 皮肤：用灰度贴图替换 slide 节点纯色填充。与 tap 一样整幅拉伸到
        // TAP_SIZE 见方的平面、不旋转（旧版会 rotation.z = π/4）。这样贴图
        // 直接画"内接菱形"（顶点触四边中点）即可获得与默认描边同尺寸的菱形。
        fill.map = slideTex;
        fill.alphaTest = 0.02;
        plane = new THREE.Mesh(_tapSkinGeo, fill);
        plane.position.z = FILL_Z;
      } else {
        // 默认皮肤：软边半透明填充（菱形），替代硬边几何填充以消除边缘闪烁。
        const rec = makeSoftFillTexture(SLIDE_RING_OUTER.map(([x, y]) => [x * 0.94, y * 0.94] as RingPt));
        fill.map = rec.texture;
        fill.userData.defaultFill = true;
        plane = new THREE.Mesh(_unitGeo, fill);
        plane.scale.set(rec.size, rec.size, 1);
        plane.position.z = FILL_Z;
      }
      plane.layers.enable(BLOOM_LAYER);
      group.add(plane);
      group.visible = false;
      groupsRef.current?.gameplay.add(group);

      // Only the head node displays the judgement projection guide.
      let proj: THREE.Group | undefined;
      let projMat: THREE.LineBasicMaterial | undefined;
      if (isHead) {
        proj = mkProj('slide', colorHex);
        projMat = (proj.children[0] as THREE.Line).material as THREE.LineBasicMaterial;
        proj.visible = false;
        groupsRef.current?.gameplay.add(proj);
      }
      nodes.push({ group, key: `${note.id}#${i}`, innerWire, outerWire, fill, proj, projMat });
    }
    const pipes: SlideMeshSet['pipes'] = [];
    for (let i = 0; i < count - 1; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      // Each pipe owns its geometry: a curved, angle-rotated tube built lazily
      // in the render loop from its two endpoints (cached by shape). We start
      // with an empty geometry and let the loop populate it on first frame.
      const geo = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.layers.enable(BLOOM_LAYER); // slide pipes also bloom
      mesh.visible = false;
      // Two world-space clip planes: the judge plane hides the already-passed
      // portion (z > cutZ); the far plane hides the part beyond the far render
      // plane in editor mode. Both are intersected by three.js clipping.
      const judgePlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), JUDGE_Z);
      const farPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), Number.NEGATIVE_INFINITY);
      mat.clippingPlanes = [judgePlane, farPlane];
      groupsRef.current?.gameplay.add(mesh);
      pipes.push({
        mesh,
        mat,
        geo,
        // Editor and Auto-Play must be clipped from the very first frame.
        clipAmount: isEditorModeRef.current || autoPlayRef.current ? 1 : 0,
        lastUpdateMs: performance.now(),
        judgePlane,
        farPlane,
        gSig: null,
        gEasing: null,
        mid: new THREE.Vector3(),
      });
    }
    sm = { nodes, pipes };
    slideMeshesRef.current.set(note.id, sm);
    return sm;
  };

  const tick = () => {
    lastTickPerfRef.current = performance.now();
    const scene = sceneRef.current; const camera = cameraRef.current; const renderer = rendererRef.current;
    if (!scene || !camera || !renderer) return;
    // 音频时钟**真正在走**才算在播：开局 App 会先把 gameState 置为 'playing'、等首帧
    // 与（故事板）预热完成才 play()，这段等待期 getCurrentTime() 返回陈旧的 pauseTime
    // （0）。若只按 isPlaying 判定，会在 t=0 闪帧上跑判定（0 拍前的音符直接掉、
    // autoplay 打掉这一帧），且画布以 t=0 渲染一帧。加上 isRunning() 后，等待期
    // playing=false → 用 gameTime 渲染（App 置为 -leadIn 的预滚动位）、判定全部关闭。
    const playing = isPlayingRef.current && !isPausedRef.current && globalAudio.isRunning();
    // Read audio time DIRECTLY from the audio clock (AudioContext.currentTime)
    // when playing, NOT from the gameTime prop. The prop is piped through React
    // state in the parent's rAF which is throttled to ~30fps (frame % 2 === 0)
    // AND delayed by a React commit cycle (useEffect runs after paint). Reading
    // it here at 60fps meant every other frame saw a STALE time value → notes
    // didn't move on one frame, then jumped 2× on the next. That produced the
    // classic "FPS counter reads 60 but motion is choppy" symptom: rAF fired at
    // 60fps (so FPS counters were happy), but game state only advanced 30×/sec.
    //
    // When NOT playing (paused game, editor scrubbing), fall back to the prop
    // value — it's authoritative for seeks/scrubs which set gameTime directly.
    const curTime = playing ? globalAudio.getCurrentTime() : gameTimeRef.current;

    // Detect time jumps (seek/scrub) and rebuild event state if needed.
    // Threshold: 0.5s — anything larger than that is definitely a seek, not normal playback.
    if (Math.abs(curTime - lastTickTimeRef.current) > 0.5 && eventsRef.current.length > 0) {
      rebuildEventState(curTime);
    }
    lastTickTimeRef.current = curTime;

    // Process events that have just occurred (time has reached or passed their trigger)
    const events = eventsRef.current;
    while (nextEventIdxRef.current < events.length && events[nextEventIdxRef.current].timeSec <= curTime) {
      const evt = events[nextEventIdxRef.current];
      handleEvent(evt, curTime);
      nextEventIdxRef.current++;
    }

    // Current scroll distance at playhead (integral of speed events over time).
    // Notes sit at fixed scroll distances — as the playhead advances, notes
    // appear to flow toward the judge line. This keeps note spacing correct
    // even before a speed change is reached (no teleportation).
    const curScrollDist = scrollDistanceAt(runtimeRef.current, curTime);
    // 各图层「当前时刻」的滚动距离（图层数很少，每帧 O(图层数·log n)，原地更新）。
    // 音符的 z 一律用 `scrollDist − layerCurDist[layerIdx]`，于是图层流速（含各层
    // 自身的 speed_change）自然生效，且判定时刻恒为 0（不受流速影响）。
    const layerCurDist = updateLayerCurDist(runtimeRef.current, curTime);
    const globalSpeed = speedRef.current;
    const unitPerSecond = WORLD_UNITS_PER_SECOND * globalSpeed; // scale: 1 "1x-second" = 36 world units * globalSpeed
    const notes = resolvedRef.current;
    const colorHex = currentNoteColorRef.current || chartRef.current.metadata.noteColor || '#00f0ff';

    // —— 图层偏移：每帧每图层只求一次（O(图层数·log n)），再被该图层全部音符共享。
    // 渲染与判定都在本帧内读取同一份值，保证「看到的」与「判定的」一致。
    const layerTree = layerTreeRef.current;
    const layerOffs = layerOffsRef.current;
    if (layerTree && layerOffs.length === layerTree.nodes.length) {
      for (let li = 0; li < layerTree.nodes.length; li++) {
        layerOffsetAtInto(layerTree, li, curTime, _layerOffTmp);
        layerOffs[li].x = _layerOffTmp.x;
        layerOffs[li].y = _layerOffTmp.y;
      }
    }

    // Update text display overlay
    const textEl = eventTextRef.current;
    if (textEl) {
      const txt = currentTextRef.current;
      const ls = lastTextStyleRef.current;
      if (txt && (txt.endTime == null || curTime < txt.endTime)) {
        if (textEl.textContent !== txt.text) {
          textEl.textContent = txt.text;
        }
        // Position: normalized [-1, 1] → percentage. Default: center (0, 0) → top-1/3 centered.
        const normX = txt.x ?? 0;
        const normY = txt.y ?? -0.33; // default: slightly above center (top 1/3-ish)
        const left = `${HUD_ANCHOR_PERCENT + normX * HUD_SPREAD_PERCENT}%`;
        const top = `${HUD_ANCHOR_PERCENT + normY * HUD_SPREAD_PERCENT}%`;
        const fs = `${txt.fontSize ?? DEFAULT_HUD_FONT_PX}px`;
        const color = txt.color || chartRef.current.metadata.bgScheme?.accentColor || '#00f0ff';
        if (ls.left !== left) { textEl.style.left = left; ls.left = left; }
        if (ls.top !== top) { textEl.style.top = top; ls.top = top; }
        if (ls.fs !== fs) { textEl.style.fontSize = fs; ls.fs = fs; }
        if (ls.color !== color) { textEl.style.color = color; ls.color = color; }
        if (ls.op !== '1') { textEl.style.opacity = '1'; ls.op = '1'; }
        textEl.style.transform = 'translate(-50%, -50%)';
        textEl.style.justifyContent = 'center';
      } else {
        if (ls.op !== '0') { textEl.style.opacity = '0'; ls.op = '0'; }
      }
    }

    // Audio time delta — computed ONCE at the top of tick so every subsystem
    // (note motion, ambient + shatter particles) shares
    // the exact same dt. Naturally 0 when paused; clamped so a seek doesn't
    // fling particles across the tunnel.
    let audioDt = 0;
    if (lastCurTimeRef.current !== null) {
      const raw = curTime - lastCurTimeRef.current;
      if (raw > 0 && raw < 0.1) audioDt = raw;
    }
    lastCurTimeRef.current = curTime;

    // Editor drag — only the pointer that initiated the drag may move the note.
    if (isEditorModeRef.current && selectionStore.getSnapshot().focus && dragPointerIdRef.current !== null && pointerDownStartRef.current) {
      const dragPointer = pointersRef.current.get(dragPointerIdRef.current);
      if (dragPointer && dragPointer.down) {
        const dDragX = dragPointer.x - pointerDownStartRef.current.x;
        const dDragY = dragPointer.y - pointerDownStartRef.current.y;
        if (Math.sqrt(dDragX * dDragX + dDragY * dDragY) > DRAG_START_THRESHOLD) {
          isDraggingRef.current = true;
          const clampedX = Math.round(clampPlaneX(dragPointer.x) * 10) / 10;
          const clampedY = Math.round(clampPlaneY(dragPointer.y) * 10) / 10;
          // 图层偏移：拖动写回的是**存储坐标 base**（编辑态所见 = 合成后落点，
          // 故 base = 显示位置 − 该音符图层在「被拖动单位自己的时间」的偏移；
          // slide 子节点各自有自己的 timeSec，不能沿用头节点的）。
          const dragSelId = selectionStore.getSnapshot().focus || '';
          const dragHead = noteIndexRef.current.get(dragSelId.split('#')[0]);
          let dragOff = ZERO_OFF;
          if (dragHead) {
            const dragTree = layerTreeRef.current;
            if (dragTree && isEditorModeRef.current) {
              const dragHash = dragSelId.indexOf('#');
              const dragUnit =
                dragHash >= 0
                  ? dragHead.resolvedNodes?.[parseInt(dragSelId.slice(dragHash + 1)) - 1]
                  : dragHead;
              const dragT =
                dragUnit && typeof dragUnit.timeSec === 'number' ? dragUnit.timeSec : dragHead.timeSec;
              dragOff = layerOffsetAt(dragTree, layerIdxOf(dragHead), typeof dragT === 'number' ? dragT : 0);
            } else {
              dragOff = offOf(dragHead);
            }
          }
          const dragStoredX = Math.round((clampedX - dragOff.x) * 10) / 10;
          const dragStoredY = Math.round((clampedY - dragOff.y) * 10) / 10;
          // Live-follow: mutate the dragged note's resolved position directly so
          // the windowed render loop below places its mesh correctly THIS frame.
          // The authoritative React commit happens ONLY on pointer release (the
          // dragFinalCommitRef block below) — committing every frame would
          // re-resolve the whole ~2000-note chart through React state and saturate
          // the main thread (single-digit FPS during fast drags, even on flagship
          // Android). The mesh still follows the pointer perfectly every frame via
          // this live override, so the drag looks smooth.
          liveMoveResolvedNote(noteIndexRef.current, dragSelId, dragStoredX, dragStoredY);
          dragLiveXRef.current = dragStoredX;
          dragLiveYRef.current = dragStoredY;
          // Push the live position to the editor side panel so its x/y inputs
          // update in real time during the drag. This only re-renders the panel
          // (it subscribes to the store); it does NOT touch React chart state or
          // re-render this canvas. Dedup inside the store keeps notifications to
          // one per visible grid-step change.
          liveDragStore.set({ id: dragSelId, x: dragStoredX, y: dragStoredY });
        }
      }
    }

    // Final commit after the drag pointer is released — guarantees the last
    // live position is persisted to React state once (the only commit during a
    // drag, so the full chart is never re-resolved mid-move).
    /* 先取一次快照再判空：TS 无法跨 getSnapshot() 调用做窄化。 */
    const commitSelId = selectionStore.getSnapshot().focus;
    if (dragFinalCommitRef.current && commitSelId) {
      dragFinalCommitRef.current = false;
      if (!Number.isNaN(dragLiveXRef.current)) {
        onMoveEditorNoteRef.current?.(commitSelId, dragLiveXRef.current, dragLiveYRef.current);
      }
      // Drop the live override now that the authoritative position is committed
      // to React state; the panel will show the committed value from `chart`.
      liveDragStore.clear();
    }

    // Selection gizmo — supports slide child ids "id#i", positioned at the node's own depth.
    const selGizmo = selectionGizmoRef.current;
    if (selGizmo) {
      let placed = false;
      /* 同上：先取快照再判空，避免跨调用丢失窄化。 */
      const selId = selectionStore.getSnapshot().focus;
      if (isEditorModeRef.current && selId) {
        const hashIdx = selId.indexOf('#');
        const base = hashIdx >= 0 ? selId.slice(0, hashIdx) : selId;
        const childIdx = hashIdx >= 0 ? parseInt(selId.slice(hashIdx + 1)) : 0;
        // tap/touch chains are expanded into standalone resolved notes whose id
        // already carries the "#i" suffix — prefer an exact match.
        const exact = hashIdx >= 0 ? noteIndexRef.current.get(selId) : undefined;
        const n = exact ?? noteIndexRef.current.get(base);
        if (n) {
          let px = n.x, py = n.y, pt = n.timeSec;
          if (!exact && childIdx >= 1 && n.resolvedNodes && n.resolvedNodes[childIdx - 1]) {
            const c = n.resolvedNodes[childIdx - 1];
            px = c.x; py = c.y; pt = c.timeSec;
          }
          // 按音符**所属图层**的时间轴取滚动距离（图层流速已积分在内）。
          const rtG = runtimeRef.current;
          const noteScrollDist = rtG ? layerDistAt(rtG, n.layerIdx, pt) : getScrollDistance(pt, speedPointsRef.current);
          const gz = JUDGE_Z - (noteScrollDist - layerCurDist[n.layerIdx]) * unitPerSecond;
          // gizmo 必须贴着「合成后」的音符位置（slide 子节点沿用头节点图层）。
          const off = offOf(n);
          selGizmo.position.set(px + off.x, py + off.y, gz + 0.1);
          selGizmo.visible = true;
          (selGizmo.material as THREE.LineBasicMaterial).opacity = 0.9;
          placed = true;
        }
      }
      if (!placed) selGizmo.visible = false;
    }

    // Multi-select gizmos: gold outline at each EXACTLY selected unit
    // (head id or child id "id#i"), independent selection. Only editor mode
    // + multi-select mode (so a single focused note doesn't get a double box).
    const multiGizmos = multiGizmosRef.current;
    const multiSel = selectionStore.getSnapshot().ids;
    /* 循环内不要每轮都调 getSnapshot()：先取一次快照再比较。 */
    const selFocus = selectionStore.getSnapshot().focus;
    let mi = 0;
    if (multiGizmos.length > 0 && isEditorModeRef.current && isMultiSelectRef.current && multiSel.length > 0) {
      for (const selId of multiSel) {
        // 焦点 note 由单选 gizmo 绘制，避免双框重叠。
        if (selId === selFocus) continue;
        const hashIdx = selId.indexOf('#');
        const base = hashIdx >= 0 ? selId.slice(0, hashIdx) : selId;
        const childIdx = hashIdx >= 0 ? parseInt(selId.slice(hashIdx + 1)) : 0;
        const n = noteIndexRef.current.get(base);
        if (!n) continue;
        // 精确定位选中的单位坐标（头节点或指定子节点）。
        let px = n.x, py = n.y, pt = n.timeSec;
        if (childIdx >= 1) {
          // slide 链：子节点在 resolvedNodes；tap/touch 链：子节点是独立 "#i" 条目。
          const resolved = n.resolvedNodes ?? [];
          const c = resolved[childIdx - 1] ?? noteIndexRef.current.get(selId);
          if (c) { px = c.x; py = c.y; pt = c.timeSec; }
        }
        const rtG2 = runtimeRef.current;
        const noteScrollDist = rtG2 ? layerDistAt(rtG2, n.layerIdx, pt) : getScrollDistance(pt, speedPointsRef.current);
        const gz = JUDGE_Z - (noteScrollDist - layerCurDist[n.layerIdx]) * unitPerSecond;
        const off = offOf(n);
        const g = multiGizmos[mi++];
        g.position.set(px + off.x, py + off.y, gz + 0.1);
        g.visible = true;
        if (mi >= multiGizmos.length) break;
      }
    }
    for (; mi < multiGizmos.length; mi++) multiGizmos[mi].visible = false;

    // Hoist invariants out of the per-note loop.
    const spawnLimit = -renderDistRef.current;
    const vScale = sizeScaleRef.current;

    // Determine the note index range to process this frame.
    // - Normal case (all speeds >= 0): use a time-based sliding window for O(log N)
    //   lookup + O(visible) processing — the standard optimisation for rhythm games.
    // - With negative speed events: time order no longer matches spatial order
    //   (a note with smaller timeSec can be farther away due to reverse scroll),
    //   so the time-window optimisation is invalid — fall back to all notes.
    const sp = speedPointsRef.current;
    // 预处理层已算好（原实现每帧全扫两遍 speedPoints）。
    const hasNegativeSpeed = runtimeRef.current.hasNegativeSpeed;

    // 迭代源：
    //  - 非负流速：时间窗连续区间 [firstIdx, lastIdx)（原路径逐位不变）。
    //  - 含负流速：时间窗 ∪ 距离窗 的并集（unionList）。判定是时间语义、渲染是
    //    滚动距离语义，负流速下 S(t) 非单调使二者不再重合，任一方单独用都会漏
    //    音符（判定漏 → 静默丢 Miss；渲染漏 → 音符不显示）。
    let firstIdx = 0;
    let lastIdx = notes.length;
    let unionList: number[] | null = null;

    if (!hasNegativeSpeed) {
      // Sliding window: only iterate notes whose time falls within
      // [curTime - pastBuffer, curTime + futureBuffer].
      // - pastBuffer covers the late-Miss window (160ms) plus a safety margin
      //   AND the max slide span, so a slide whose head is far in the past but
      //   whose child nodes are still upcoming stays in the window (otherwise
      //   processSlide would never run for those children → they'd be silently
      //   dropped, causing "0 Miss but song ended early" bugs in auto-play).
      // - futureBuffer covers (-spawnLimit)/speed + safety — notes that are
      //   about to enter render distance.
      // Notes are sorted by timeSec (resolveChart sorts once), so we can use
      // binary search to find [firstIdx, lastIdx) in O(log N) instead of
      // iterating the full chart (which can be 1000+ notes).
      const pastBuffer = 0.3 + maxSlideSpanRef.current;
      // For variable scroll speed, use the minimum speed across the entire chart
      // to compute a conservative future time window — this ensures we never
      // miss notes that are about to enter render distance.
      const minSpeed = runtimeRef.current.minSpeed;
      const futureBuffer = -spawnLimit / (36 * globalSpeed * minSpeed) + 0.3;
      const pastThreshold = curTime - pastBuffer;
      const futureThreshold = curTime + futureBuffer;

      let lo = 0;
      let hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].timeSec < pastThreshold) lo = mid + 1;
        else hi = mid;
      }
      firstIdx = lo;

      lo = firstIdx;
      hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].timeSec <= futureThreshold) lo = mid + 1;
        else hi = mid;
      }
      lastIdx = lo;
    } else {
      const rt = runtimeRef.current;

      // ---- 时间窗（判定语义）----
      // 判定只需覆盖命中窗 + slide 跨度。负速时 minSpeed 可能为负/极小，直接代入
      // 会得到无效/超长窗口；这里用 |minSpeed| 且下限取 1，得到有限的保守窗口。
      const pastBuffer = 0.3 + maxSlideSpanRef.current;
      const speedMag = Math.max(1, Math.abs(rt.minSpeed));
      const futureBuffer = -spawnLimit / (36 * globalSpeed * speedMag) + 0.3;
      const pastThreshold = curTime - pastBuffer;
      const futureThreshold = curTime + futureBuffer;
      let lo = 0;
      let hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].timeSec < pastThreshold) lo = mid + 1;
        else hi = mid;
      }
      const tFirst = lo;
      lo = tFirst;
      hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].timeSec <= futureThreshold) lo = mid + 1;
        else hi = mid;
      }
      const tLast = lo;

      // ---- 距离窗（渲染语义）----
      // z = JUDGE_Z - (nd - curScrollDist) * unitPerSecond；可见带 z ∈ [spawnLimit, 6]。
      const span = rt.maxSlideScrollSpan;
      /* 图层流速 < 1 的慢速图层，同样可见带对应的 ΔS 更大 → 距离窗按 1/min(m) 扩宽 */
      const minMul = rt.minLayerSpeed || 1;
      let dLo = (JUDGE_Z - 6) / unitPerSecond / minMul;
      let dHi = (JUDGE_Z - spawnLimit) / unitPerSecond / minMul;
      if (dLo > dHi) {
        const t = dLo;
        dLo = dHi;
        dHi = t;
      }
      const order = rt.notesByDist;
      const dw = scrollDistWindow(rt, curScrollDist, dLo - span, dHi + span);

      // ---- 并集 + 帧戳去重（零分配）----
      const stampState = unionStampRef.current;
      if (!stampState.arr || stampState.arr.length !== notes.length) {
        stampState.arr = new Int32Array(notes.length);
        stampState.frame = 0;
      }
      stampState.frame++;
      const frameStamp = stampState.frame;
      const stamp = stampState.arr;
      const prevVisited = lastVisitedRef.current;
      if (prevVisited.notes !== notes) {
        // 谱面变化：上一帧的访问记录已失效（网格由 resetPlayState 重建）。
        prevVisited.notes = notes;
        prevVisited.list.length = 0;
      }
      const list = unionScratchRef.current;
      list.length = 0;
      for (let i = tFirst; i < tLast; i++) {
        if (stamp[i] !== frameStamp) { stamp[i] = frameStamp; list.push(i); }
      }
      for (let k = dw.first; k < dw.last; k++) {
        const i = order[k];
        if (stamp[i] !== frameStamp) { stamp[i] = frameStamp; list.push(i); }
      }
      // 幽灵网格清理：上一帧访问过、本帧未访问的音符隐藏（帧戳差分，替代连续窗口差）。
      const prevList = prevVisited.list;
      for (let q = 0; q < prevList.length; q++) {
        const idx = prevList[q];
        if (stamp[idx] !== frameStamp) hideNoteMeshes(notes[idx]);
      }
      // 交换缓冲：本帧列表成为下一帧的「上一帧列表」，旧缓冲清空后复用（零分配）。
      const recycled = prevVisited.list;
      prevVisited.list = list;
      unionScratchRef.current = recycled;
      recycled.length = 0;
      unionList = list;
    }

    // ---- Window cleanup: hide notes that were visible last frame but have
    // fallen outside this frame's window. The windowed loop below only visits
    // [firstIdx, lastIdx), so without this pass a note that leaves the window
    // (e.g. after a big seek by dragging the editor progress bar) keeps its
    // last-frame `visible = true` and lingers on screen as a ghost note.
    // Leftover = old_window \ new_window = two contiguous index runs:
    //   left run  [lw.firstIdx, min(lw.lastIdx, firstIdx))  when lw.firstIdx < firstIdx
    //   right run [max(lw.firstIdx, lastIdx), lw.lastIdx)   when lastIdx < lw.lastIdx
    // This is O(leftover) — typically 1-2 notes per smooth frame, and the full
    // old window (~visible count) only right after a seek, which is exactly
    // when we need to retire them.
    //
    // 含负流速时改走上面的帧戳差分，故这里只处理非负路径。
    if (!hasNegativeSpeed) {
      const lw = lastWindowRef.current;
      if (lw.notes === notes && lw.lastIdx > lw.firstIdx) {
        if (lw.firstIdx < firstIdx) {
          const end = lw.lastIdx < firstIdx ? lw.lastIdx : firstIdx;
          for (let i = lw.firstIdx; i < end; i++) hideNoteMeshes(notes[i]);
        }
        if (lastIdx < lw.lastIdx) {
          const start = lw.firstIdx > lastIdx ? lw.firstIdx : lastIdx;
          for (let i = start; i < lw.lastIdx; i++) hideNoteMeshes(notes[i]);
        }
      }
      // 原地改字段：原实现每帧 new 一个对象（120fps 下 GC 压力放大约 2.4×）。
      const lwNow = lastWindowRef.current;
      lwNow.firstIdx = firstIdx;
      lwNow.lastIdx = lastIdx;
      lwNow.notes = notes;
    }

    // 收集本帧可见网格（供 ultra 灯光池只遍历可见项，避免 O(累计网格)）。
    _visNoteMeshes.length = 0;
    _visSlideNodes.length = 0;
    _visSlidePipes.length = 0;
    const iterTotal = unionList === null ? lastIdx - firstIdx : unionList.length;
    for (let q = 0; q < iterTotal; q++) {
      const noteIdx = unionList === null ? firstIdx + q : unionList[q];
      const note = notes[noteIdx];
      /* 有效音符色：note.color → 图层色（就近继承 / 图层内 note_color_change）→ 全局 */
      const noteEffectiveColor = note.color || (layerTree ? layerColorAt(layerTree, layerIdxOf(note), curTime, colorHex) : colorHex);

      // ---------- SLIDE ----------
      if (note.type === 'slide') {
        // Cached: avoids rebuilding [head, ...resolvedNodes] every frame.
        // 偏移感知包装：返回的是「合成后坐标」，下游网格/管线/判定共用。
        const allNodes = getAllNodesEff(note);
        if (playing && !isEditorModeRef.current) {
          processSlide(note, curTime);
        }
        // 非激活态（已退出菜单/结算，非 播放/暂停/编辑器）时绝不重建 slide 网格：
        // resetPlayState 已移除旧网格，这里若再次 ensure 会每帧 scene.add 新对象，
        // 既泄漏又让投影在 tick 残帧中被重新点亮（皮肤投影尤其明显）。
        const sm = (playing || isPausedRef.current || isEditorModeRef.current)
          ? ensureSlideMeshes(note, noteEffectiveColor)
          : slideMeshesRef.current.get(note.id) ?? null;
        if (!sm) continue;
        const rt = playing && !isEditorModeRef.current ? getSlideRt(note.id, allNodes.length) : slideStateRef.current.get(note.id);

        _slideZs.length = 0;
        for (let i = 0; i < allNodes.length; i++) {
          // 预处理层已按 timeSec 预计算滚动距离；缺失时回退现算（保持数值一致）。
          // allNodes 由 getAllNodes 构造，元素类型不含 scrollDist，故按需取可选字段。
          const nd = (allNodes[i] as { scrollDist?: number }).scrollDist;
          // 图层时间轴：子节点沿用头节点的图层（resolvedNodes 不带 layerId）。
          const nli = note.layerIdx;
          const nodeScrollDist = nd !== undefined ? nd : layerDistAt(runtimeRef.current, nli, allNodes[i].timeSec);
          const z = JUDGE_Z - (nodeScrollDist - layerCurDist[nli]) * unitPerSecond;
          _slideZs.push(z);
          const key = sm.nodes[i].key; // 预存，避免每帧拼字符串
          const judged = judgedNotesRef.current.has(key);
          const nodeRt = rt?.nodes[i];
          const isRed = !!nodeRt && nodeRt.missLocked && !judged;
          // Respsect "音符渲染距离" in both gameplay and editor mode.
          // In editor mode, also hide notes whose time has already passed —
          // with negative scroll speed a note can come back into the visible
          // Z range visually, but it was already "judged" in the timeline and
          // should stay gone (matching gameplay behaviour).
          const vis = (isEditorModeRef.current
            ? (z >= spawnLimit && z <= 6 && allNodes[i].timeSec >= curTime - 0.05)
            : (z >= spawnLimit && z <= 6 && !judged))
            // 退出到菜单时（非 播放/暂停/编辑器）强制隐藏，避免 projection/边框残留。
            && (playing || isPausedRef.current || isEditorModeRef.current);
          const nm = sm.nodes[i];
          nm.group.visible = vis;
          if (vis) {
            _visSlideNodes.push(nm);
            nm.group.position.set(allNodes[i].x, allNodes[i].y, z);
            nm.group.scale.set(vScale, vScale, 1);
            // Rotate the node visual (note + cross-section) around its center by
            // the node's own angle. Three's rotation.z is counterclockwise for
            // +, but we want +angle = clockwise (matching the 2D editor), so negate.
            nm.group.rotation.z = -(allNodes[i].angle ?? 0);
            if (nm.proj) nm.proj.rotation.z = -(allNodes[i].angle ?? 0);
            nm.fill.color.copy(cachedColor(isRed ? SLIDE_RED : noteEffectiveColor));
            // 内框跟随音符色；外框使用可自定义颜色（不随音符色变化）。
            nm.innerWire?.color.copy(cachedColor(isRed ? SLIDE_RED : noteEffectiveColor));
            nm.outerWire?.color.copy(cachedColor(defaultSkinOuterColorRef.current));

            // Smooth fade-in animation as note enters the render distance
            const fadeZone = 12;
            const fadeInAlpha = isEditorModeRef.current
              ? 1
              : THREE.MathUtils.clamp((z - spawnLimit) / fadeZone, 0, 1);
            // 皮肤贴图整块显示（不透明）；默认填充保持半透明（defaultFill 标记区分）。
            nm.fill.opacity = nm.fill.map && !nm.fill.userData.defaultFill ? fadeInAlpha : (isRed ? 0.4 : (i === 0 ? 0.2 : 0.26)) * fadeInAlpha;
            // 仅 slide 头节点显示边框：内框跟随音符色，外框使用自定义颜色+透明度。
            if (nm.innerWire) nm.innerWire.opacity = (i === 0 && defaultSkinInnerEnabledRef.current) ? 0.85 * fadeInAlpha : 0;
            if (nm.outerWire) nm.outerWire.opacity = (i === 0 && defaultSkinOuterEnabledRef.current) ? defaultSkinOuterAlphaRef.current * fadeInAlpha : 0;
          }
          if (nm.proj && nm.projMat) {
            const timeToHitMs = (allNodes[i].timeSec - curTime) * 1000;
            const leadMs = projectionLeadRef.current;
            // Same projection-toggle rule as tap/touch above.
            const projEnabled = effectTogglesRef.current.projection !== false;
            const po = !projEnabled || leadMs <= 0 || timeToHitMs < 0 || judged
              ? 0
              : THREE.MathUtils.clamp(1 - timeToHitMs / leadMs, 0, 0.95);
            // `vis` 守卫：节点不可见（出窗口/退出菜单/已判定）时投影也必须隐藏。
            // 皮肤 proj 材质初始 opacity=0.5，这里再统一按 po 覆盖——否则无 vis
            // 守卫时，退出菜单后 tick 残帧会把皮肤投影以 0.5 透明度重新点亮残留。
            nm.proj.visible = vis && po > 0;
            // 投影引导 = 落点提示，钉在「最终落位」：base + 该节点自己 timeSec 的图层偏移。
            // allNodes 已嵌入 curTime 偏移（offOf），先反解出 base 再加落点偏移。
            const headOff = offOf(note);
            const projLanding = layerOffAtIdx(layerIdxOf(note), allNodes[i].timeSec);
            nm.proj.position.set(
              allNodes[i].x - headOff.x + projLanding.x,
              allNodes[i].y - headOff.y + projLanding.y,
              JUDGE_Z + 0.01
            );
            nm.proj.scale.set(vScale, vScale, 1);
            nm.projMat.color.copy(cachedColor(noteEffectiveColor));
            nm.projMat.opacity = po;
            nm.projMat.opacity = po;
          }
        }

        // Pipes between consecutive nodes.
        // Editor + Auto-Play are always clipped. During manual play, contact makes the
        // clip engage immediately; leaving the cross-section releases it smoothly.
        const pipeFrameNow = performance.now();
        for (let i = 0; i < sm.pipes.length; i++) {
          const nextKey = sm.nodes[i + 1].key; // 预存（下一节点），避免每帧拼字符串
          const nextJudged = judgedNotesRef.current.has(nextKey);
          const naturalA = _vNaturalA.set(allNodes[i].x, allNodes[i].y, _slideZs[i]);
          const naturalB = _vNaturalB.set(allNodes[i + 1].x, allNodes[i + 1].y, _slideZs[i + 1]);
          const pipe = sm.pipes[i];

          // In gameplay, a completed destination node retires its incoming pipe.
          if (!isEditorModeRef.current && (nextJudged || Math.max(naturalA.z, naturalB.z) < spawnLimit)) {
            pipe.mesh.visible = false;
            continue;
          }

          // In editor mode, nodes already respect render distance but pipes previously did not.
          // Clip the segment at the far render plane (Z = spawnLimit), so a pipe connected
          // to an infinitely distant child cannot remain visible beyond the configured range.
          // Also hide pipes where both endpoints are already past their judgement time —
          // with negative scroll speed they can come back into the visible Z range, but
          // timeline-wise they're done and should stay gone.
          if (isEditorModeRef.current) {
            if (allNodes[i].timeSec < curTime - 0.05 && allNodes[i + 1].timeSec < curTime - 0.05) {
              pipe.mesh.visible = false;
              continue;
            }
            if (naturalA.z < spawnLimit && naturalB.z < spawnLimit) {
              pipe.mesh.visible = false;
              continue;
            }
            if (naturalA.z < spawnLimit && naturalB.z >= spawnLimit) {
              const t = THREE.MathUtils.clamp(
                (spawnLimit - naturalA.z) / (naturalB.z - naturalA.z || 1), 0, 1
              );
              naturalA.lerp(naturalB, t);
              naturalA.z = spawnLimit;
            } else if (naturalB.z < spawnLimit && naturalA.z >= spawnLimit) {
              const t = THREE.MathUtils.clamp(
                (spawnLimit - naturalA.z) / (naturalB.z - naturalA.z || 1), 0, 1
              );
              naturalB.lerpVectors(naturalA, naturalB, t);
              naturalB.z = spawnLimit;
            }
          }

          const crossesPlane =
            (naturalA.z >= JUDGE_Z && naturalB.z <= JUDGE_Z) ||
            (naturalA.z <= JUDGE_Z && naturalB.z >= JUDGE_Z);

          let crossPoint: THREE.Vector3 | null = null;
          if (crossesPlane) {
            const t = THREE.MathUtils.clamp(
              (JUDGE_Z - naturalA.z) / (naturalB.z - naturalA.z || 1),
              0,
              1
            );
            // Reuse scratch vector instead of naturalA.clone().
            _vCrossPoint.copy(naturalA).lerp(naturalB, t);
            _vCrossPoint.z = JUDGE_Z;
            crossPoint = _vCrossPoint;
          }

          // Manual contact condition: the segment actually intersects the judgement
          // plane, and a finger is on that exact cross-section.
          // - Bound chain: only the bound pointers count (normal "drag along the pipe").
          // - FREE chain (the front node has NOT been judged yet — e.g. it was missed or
          //   the slide never started): ANY held pointer on the cross-section still clips
          //   the pipe. The intended behaviour is: as long as a finger is on the pipe it
          //   truncates, regardless of whether the leading node was successfully judged.
          let isHoldingCrossSection = false;
          if (!isEditorModeRef.current && !autoPlayRef.current && crossPoint && rt) {
            const candidates = rt.boundPointerIds.size > 0
              ? rt.boundPointerIds
              : pointersRef.current.keys();
            for (const pid of candidates) {
              const bp = pointersRef.current.get(pid);
              if (bp?.down &&
                  Math.abs(bp.x - crossPoint.x) < SLIDE_HIT_HALF &&
                  Math.abs(bp.y - crossPoint.y) < SLIDE_HIT_HALF) {
                isHoldingCrossSection = true;
                break;
              }
            }
          }

          const forceClip = isEditorModeRef.current || autoPlayRef.current;
          const targetClipped = forceClip || isHoldingCrossSection;
          const elapsedSec = Math.min(0.05, Math.max(0, (pipeFrameNow - pipe.lastUpdateMs) / 1000));
          pipe.lastUpdateMs = pipeFrameNow;

          if (targetClipped) {
            // Engage immediately: no stale frame can flash past the judgement plane.
            pipe.clipAmount = 1;
          } else {
            // Release smoothly over roughly 220ms. The endpoint starts at Z=0 and
            // travels outward instead of the full outside section appearing at once.
            pipe.clipAmount *= Math.exp(-elapsedSec / 0.22);
            if (pipe.clipAmount < 0.002) pipe.clipAmount = 0;
          }

          // --- Geometry + world-space clipping ---
          // Eased consumption along the segment, in ALL modes (editor / autoplay /
          // manual). The pipe is consumed from node A toward node B following the
          // eased curve; τ is the normalized TIME within [tA, tB] and advances
          // LINEARLY (easing is NOT applied to time). At τ=0 nothing is consumed
          // (whole pipe); at τ=1 it is fully gone (playhead reaches node B).
          const ax = allNodes[i].x, ay = allNodes[i].y, az = _slideZs[i];
          const bx = allNodes[i + 1].x, by = allNodes[i + 1].y, bz = _slideZs[i + 1];
          const tA = allNodes[i].timeSec, tB = allNodes[i + 1].timeSec;
          const segDur = Math.max(1e-4, tB - tA);
          const tau = THREE.MathUtils.clamp((curTime - tA) / segDur, 0, 1);
          const ease = EASING_FNS[allNodes[i + 1].easing ?? 'linear'] ?? EASING_FNS.linear;
          const e = ease(tau);
          const ex = bx - ax, ey = by - ay;
          // A speed_change event strictly between A and B makes the segment's Z
          // non-linear in τ. In that case sample the true scroll-distance profile so the
          // pipe length / playhead honour the speed change; otherwise fall back to the
          // cheap linear ramp (prior behaviour, no per-frame getScrollDistance calls).
          // 用该音符**所属图层**的时间轴采样（含图层自身的 speed_change）。
          const nli2 = note.layerIdx;
          const lrt = runtimeRef.current;
          const lpts = (lrt.layerDist[nli2] && lrt.layerDist[nli2].points) || sp;
          let midSpeed = false;
          for (const p of lpts) {
            if (p.timeSec > tA && p.timeSec < tB) { midSpeed = true; break; }
          }
          const scrollDistA = midSpeed ? layerDistAt(lrt, nli2, tA) : 0;
          const zAt = midSpeed
            ? (tauN: number) =>
                (scrollDistA - layerDistAt(lrt, nli2, tA + tauN * segDur)) * unitPerSecond
            : undefined;
          const localZ = (tauN: number) => (zAt ? zAt(tauN) : (bz - az) * tauN);
          // Playhead = point on the eased curve at the current linear-time fraction τ.
          // X/Y follow `ease(τ)`; Z follows the scroll-distance profile above. The clip
          // plane passes through G(τ) with the curve TANGENT as its normal, so the cut
          // stays perpendicular to the tube and tracks the playhead exactly. (Placing the
          // cut along the straight A→B segment by ease(τ)·segLen mislocates the
          // truncation and makes it stretch whenever the pipe bows in X/Y.)
          const eLo = ease(Math.max(0, tau - 0.005));
          const eHi = ease(Math.min(1, tau + 0.005));
          const zNow = az + localZ(tau);
          const zLo = az + localZ(Math.max(0, tau - 0.005));
          const zHi = az + localZ(Math.min(1, tau + 0.005));
          _vConsP.set(ax + ex * e, ay + ey * e, zNow);
          pipe.judgePlane.normal.set(
            ex * (eHi - eLo) / 0.01,
            ey * (eHi - eLo) / 0.01,
            (zHi - zLo) / 0.01,
          ).normalize();
          pipe.judgePlane.constant = -pipe.judgePlane.normal.dot(_vConsP);
          // Editor additionally trims at the far render plane; gameplay clips nothing.
          pipe.farPlane.constant = isEditorModeRef.current ? -spawnLimit : Number.POSITIVE_INFINITY;

          // Once the segment is fully consumed (playhead at node B in TIME) there is
          // nothing left. Gate on τ, not on the eased position: for sine-out etc.
          // `ease(τ)` reaches ~0.999 well before τ=1, which would hide a long pipe
          // while a visible tail near node B still remained ("end disappears").
          if (tau >= 0.999) {
            pipe.mesh.visible = false;
            continue;
          }

          // A wholly-future segment (Editor/Auto-Play) is not shown until it reaches
          // the judge region — keeps the timeline readable.
          if (forceClip && naturalA.z > JUDGE_Z && naturalB.z > JUDGE_Z) {
            pipe.mesh.visible = false;
            continue;
          }

          // Manual, fully released pipes may render naturally, but not wholly behind camera.
          if (!forceClip && naturalA.z > 8 && naturalB.z > 8) {
            pipe.mesh.visible = false;
            continue;
          }

          // Build/refresh the curved tube geometry. Cached by shape so it only
          // rebuilds when the segment's endpoints, angles, easing, note scale, or
          // (when a speed change lands inside the segment) its Z profile actually
          // change — not every frame.
          const angleStart = allNodes[i].angle ?? 0;
          const angleEnd = allNodes[i + 1].angle ?? 0;
          const easing = allNodes[i + 1].easing ?? 'linear';
          const endX = bx - ax, endY = by - ay, endZ = bz - az;
          // 形状签名（数值化，零字符串分配）：分量与原 geoKey 的 toFixed 精度一致。
          const sig = _geoSig;
          sig.length = 0;
          sig.push(q4(angleStart), q4(angleEnd), q3(endX), q3(endY), q3(endZ), SLIDE_PIPE_HALF * vScale);
          if (midSpeed) {
            // 段内速度剖面签名（4 个内部采样；不同速度曲线 → 不同缓存几何）。
            for (let s = 1; s <= 4; s++) {
              sig.push(q3((scrollDistA - layerDistAt(lrt, nli2, tA + (s / 5) * segDur)) * unitPerSecond));
            }
          }
          let geoChanged = pipe.gEasing !== easing || pipe.gSig === null || pipe.gSig.length !== sig.length;
          if (!geoChanged) {
            const g = pipe.gSig!;
            for (let si = 0; si < sig.length; si++) {
              if (g[si] !== sig[si]) { geoChanged = true; break; }
            }
          }
          if (geoChanged) {
            if (pipe.geo) pipe.geo.dispose();
            pipe.geo = buildSlideTubeGeometry({
              end: _vTubeEnd.set(endX, endY, endZ),
              angleStart,
              angleEnd,
              easing,
              half: SLIDE_PIPE_HALF * vScale,
              zAt,
            });
            pipe.mesh.geometry = pipe.geo;
            pipe.gSig = sig.slice(); // 复制（sig 为复用 scratch）；仅在变化时分配
            pipe.gEasing = easing;
          }
          pipe.mesh.position.set(ax, ay, az);
          pipe.mesh.scale.set(1, 1, 1);
          pipe.mesh.quaternion.identity();
          pipe.mesh.visible = true;
          _visSlidePipes.push(pipe);
          // Cache world midpoint for the ultra light pool.
          pipe.mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);

          const nodeRt = rt?.nodes[i + 1];
          const isRed = !!nodeRt && nodeRt.missLocked && !nextJudged;
          pipe.mat.color.copy(cachedColor(isRed ? SLIDE_RED : noteEffectiveColor));
          const pipeFadeAlpha = isEditorModeRef.current
            ? 1
            : THREE.MathUtils.clamp((Math.max(naturalA.z, naturalB.z) - spawnLimit) / 12, 0, 1);
          const pipeOpacity = isHoldingCrossSection
            ? (isRed ? 0.60 : 0.52)
            : (isRed ? 0.38 : 0.25);
          // The pipe fades together with the slide nodes as it enters render distance.
          pipe.mat.opacity = pipeOpacity * pipeFadeAlpha;
        }

        continue;
      }

      // ---------- TAP / TOUCH ----------
      // 预处理层已按 timeSec 预计算滚动距离；PreparedNote 保证该字段必填，直接读。
      const nli = note.layerIdx;
      const noteScrollDist = note.scrollDist;
      const nz = JUDGE_Z - (noteScrollDist - layerCurDist[nli]) * unitPerSecond;
      const judged = judgedNotesRef.current.has(note.id);
      // Respsect "音符渲染距离" in both gameplay and editor mode.
      // In editor mode, also hide notes whose time has already passed —
      // with negative scroll speed a note can come back into the visible
      // Z range visually, but it was already "judged" in the timeline and
      // should stay gone (matching gameplay behaviour).
      const vis = (isEditorModeRef.current
        ? (nz >= spawnLimit && nz <= 6 && note.timeSec >= curTime - 0.05)
        : (nz >= spawnLimit && nz <= 6 && !judged))
        // 退出到菜单时（非 播放/暂停/编辑器）强制隐藏，避免 projection/边框残留。
        && (playing || isPausedRef.current || isEditorModeRef.current);
      let entry = noteMeshesRef.current.get(note.id);
      const noteOff = offOf(note); // 图层合成偏移（网格与判定必须用同一份）
      if (vis) {
        if (!entry) {
          const ng = note.type === 'tap' ? mkTap(noteEffectiveColor) : mkTouch(noteEffectiveColor);
          const pg = mkProj(note.type, noteEffectiveColor); landingOffOfInto(note, _landingOff); pg.position.set(note.x + _landingOff.x, note.y + _landingOff.y, JUDGE_Z + 0.01);
          groupsRef.current?.gameplay.add(ng); groupsRef.current?.gameplay.add(pg);
          entry = { group: ng, projectionGroup: pg }; noteMeshesRef.current.set(note.id, entry);
          // (Ultra note-light handled by ultraLightPoolRef — see render loop)
        }
        entry.group.position.set(note.x + noteOff.x, note.y + noteOff.y, nz);
        entry.group.scale.set(vScale, vScale, 1);
        entry.group.rotation.z = -(note.angle ?? 0);
        entry.group.visible = true;
        _visNoteMeshes.push(entry);

        // Smooth fade-in animation as note enters the render distance
        const fadeZone = 12;
        const fadeInAlpha = isEditorModeRef.current
          ? 1
          : THREE.MathUtils.clamp((nz - spawnLimit) / fadeZone, 0, 1);
        entry.group.children.forEach((child) => {
          // 内/外框为 Line（默认皮肤描边）或旧式 Mesh（兼容），统一按 isBorder 处理。
          if (child.userData.isBorder === 'inner') {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
              const m = child.material;
              if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.LineBasicMaterial) {
                // 内框：颜色恒等于音符色，由开关控制显示。
                m.color.copy(cachedColor(noteEffectiveColor));
                m.opacity = defaultSkinInnerEnabledRef.current ? 0.85 * fadeInAlpha : 0;
              }
            }
          } else if (child.userData.isBorder === 'outer') {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
              const m = child.material;
              if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.LineBasicMaterial) {
                // 外框：使用可自定义颜色与透明度，由开关控制显示。
                m.color.copy(cachedColor(defaultSkinOuterColorRef.current));
                m.opacity = defaultSkinOuterEnabledRef.current ? defaultSkinOuterAlphaRef.current * fadeInAlpha : 0;
              }
            }
          } else if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            child.material.color.copy(cachedColor(noteEffectiveColor));
            // 皮肤贴图整块显示（不透明）；默认填充保持半透明（defaultFill 标记区分）。
            child.material.opacity = child.material.map && !child.userData.defaultFill ? fadeInAlpha : (note.type === 'tap' ? 0.18 : 0.22) * fadeInAlpha;
          }
        });

        const timeToHitMs = (note.timeSec - curTime) * 1000;
        const leadMs = projectionLeadRef.current;
        // effectToggles.projection === false disables the projection guide
        // entirely, ignoring the user's projectionLeadMs setting.
        const projEnabled = effectTogglesRef.current.projection !== false;
        const po = !projEnabled || leadMs <= 0 || timeToHitMs < 0
          ? 0
          : THREE.MathUtils.clamp(1 - timeToHitMs / leadMs, 0, 0.95);
        entry.projectionGroup.visible = po > 0;
        // 原先同一行调了两次 landingOffOf(note)（各分配一个 {x,y}）—— 改为一次写入式。
        landingOffOfInto(note, _landingOff);
        entry.projectionGroup.position.set(note.x + _landingOff.x, note.y + _landingOff.y, JUDGE_Z + 0.01);
        entry.projectionGroup.scale.set(vScale, vScale, 1);
        entry.projectionGroup.rotation.z = -(note.angle ?? 0);
        entry.projectionGroup.children.forEach((c) => {
          const material = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | null;
          if (!material) return;
          // 判定框（投影引导）颜色恒等于音符色，不可修改，仅粗细可调。
          material.color.copy(cachedColor(noteEffectiveColor));
          material.opacity = po;
        });
      } else if (entry) { entry.group.visible = false; entry.projectionGroup.visible = false; }

      // 假音符仍渲染（视觉演出），但完全不参与判定：不命中、不产生 Miss、不打断连击。
      if (playing && !judged && !isEditorModeRef.current && !note.fake) {
        if (autoPlayRef.current && note.type === 'tap') {
          const dt = (curTime - note.timeSec) * 1000;
          // AutoPlay: judge as soon as note has passed the plane (dt >= 0). The narrow
          // 15ms window used previously would miss entirely on lower-framerate devices.
          if (dt >= 0) { commitJudgement(note, 'S-Perfect', dt); continue; }
        }
        if (note.type === 'touch') {
          /* touch 逐帧判定（悬停触发）已下沉 shared/tapJudge.processTouchCore：
           * 早扫记账 / 到面结算 / 超窗 Miss 的状态机由核心负责，状态就地写回
           * touchTrackRef（跨帧保留），判定结论在此提交（含音效/特效/反馈）。 */
          let track = touchTrackRef.current.get(note.id);
          if (!track) { track = createTouchJudgeState(); touchTrackRef.current.set(note.id, track); }
          const dec = processTouchCore(note, curTime, autoPlayRef.current, track, touchEnv, tapJudgeDeps);
          if (dec) { commitJudgement(note, dec.judgement, dec.dtMs); continue; }
        } else {
          const dt = (curTime - note.timeSec) * 1000;
          if (dt > HIT_WINDOW_MS) commitJudgement(note, 'Miss', dt);
        }
      }
    }

    // 300ms judgement feedback bursts
    const now = performance.now();

    // Ultra mode: drive the PointLight pool from the closest-to-judge-plane
    // visible notes/slides. `_visNoteMeshes/_visSlideNodes/_visSlidePipes` were
    // filled during the window loop above (only **currently visible** meshes),
    // so this is O(visible) rather than O(all meshes created this round).
    // Pick the 8 smallest |z| (closest to judge plane) and assign one pool light
    // each; park the rest far away with intensity 0.
    const pool = ultraLightPoolRef.current;
    if (pool.length > 0) {
      _lightCap = pool.length;
      _lightCnt = 0;
      for (let i = 0; i < _visNoteMeshes.length; i++) {
        const entry = _visNoteMeshes[i];
        if (!entry.group.visible) continue;
        const p = entry.group.position;
        // Prefer the INNER border (color always tracks the note color every frame),
        // then fall back to the fill mesh / skin texture — skip the outer border
        // (its color is the customizable `defaultSkinOuterColor`, not the note color).
        let color: THREE.Color | null = null;
        const children = entry.group.children;
        for (let ci = 0; ci < children.length; ci++) {
          const c = children[ci];
          if (c.userData.isBorder === 'inner') {
            if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) { color = c.material.color; break; }
            if (c instanceof THREE.Line && c.material instanceof THREE.LineBasicMaterial) { color = c.material.color; break; }
          }
        }
        if (!color) {
          for (let ci = 0; ci < children.length; ci++) {
            const c = children[ci];
            if (c.userData.isBorder === 'outer') continue;
            if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) { color = c.material.color; break; }
          }
        }
        if (color) considerLight(p.z, p.x, p.y, color);
      }
      // Slide nodes contribute too.
      for (let i = 0; i < _visSlideNodes.length; i++) {
        const nd = _visSlideNodes[i];
        if (!nd.group.visible) continue;
        const p = nd.group.position;
        considerLight(p.z, p.x, p.y, nd.fill.color);
      }
      // Slide PIPES also contribute — a long arc is a colored body lighting the walls
      // along its length (use the pipe midpoint cached in `pp.mid`).
      for (let i = 0; i < _visSlidePipes.length; i++) {
        const pp = _visSlidePipes[i];
        if (!pp.mesh.visible) continue;
        _vLightMid.copy(pp.mid);
        const mat = pp.mat as THREE.MeshBasicMaterial;
        considerLight(_vLightMid.z, _vLightMid.x, _vLightMid.y, mat.color);
      }
      // Assign pool lights — 槽位已按 |z| 升序排好（closest to judge plane first）。
      for (let i = 0; i < _lightCap; i++) {
        const pl = pool[i];
        if (i < _lightCnt) {
          const cz = _lightZ[i];
          const cc = _lightC[i];
          pl.position.set(_lightX[i], _lightY[i], cz);
          if (cc) pl.color.copy(cc);
          pl.intensity = Math.max(0, 4.5 - Math.abs(cz) * 0.18);
        } else {
          pl.position.set(0, 0, -1000);
          pl.intensity = 0;
        }
      }
    }

    // In-place compaction (swap-pop style) instead of Array.filter, which
    // allocated a fresh array every frame even when no burst expired.
    const bursts = activeBurstsRef.current;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < bursts.length; readIdx++) {
      const b = bursts[readIdx];
      const p = (now - b.startTime) / b.duration;
      if (p >= 1) {
        b.group.removeFromParent();
        recycleBurst(b.group);
        // Skip copying → effectively removed.
        continue;
      }
      // Scale animation is relative to the selected 0.6~1.0 visual base size.
      const multiplier = 1 + (b.scaleTarget - 1) * Math.sin(p * Math.PI * 0.5);
      const s = b.baseScale * multiplier;
      b.group.scale.set(s, s, 1);
      const fade = 1 - p;
      b.group.children.forEach((c) => { if ((c as THREE.Line).material) ((c as THREE.Line).material as THREE.LineBasicMaterial).opacity = fade; });
      bursts[writeIdx++] = b;
    }
    bursts.length = writeIdx;

    // Ambient particle field update — particles themselves only drift
    // laterally (vel.x/y). The "rushing toward camera" effect is simulated
    // by advancing particle z toward +z at the SAME rate as the notes:
    // per-second z-flow = 36 * globalSpeed * currentChartSpeed (instantaneous).
    if (particleFieldRef.current && particleVelRef.current) {
      const field = particleFieldRef.current;
      const vel = particleVelRef.current;
      const posAttr = field.geometry.getAttribute('position') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      // Compute instantaneous chart speed at current time.
      // 原为每帧线性扫描 speedPoints（SV 谱面可达数百点）；改用 speedAt 的二分（等价语义）。
      const rtNow = runtimeRef.current;
      const chartSpeed = rtNow ? speedAt(rtNow, curTime) : 1;
      const zAdvance = audioDt * 36 * globalSpeed * chartSpeed; // exact match to note z-flow
      const wrapFar = -(renderDistRef.current); // recycle to far end
      const tunnelLen = 5 - wrapFar; // total wrappable span
      for (let i = 0; i < posArr.length; i += 3) {
        posArr[i]     += vel[i];
        posArr[i + 1] += vel[i + 1];
        posArr[i + 2] += zAdvance;
        if (posArr[i + 2] > 5) {
          // Recycle to far end with new random lateral position.
          // IMPORTANT: preserve the overshoot past the near plane (modulo the
          // tunnel length). Hard-resetting z to exactly wrapFar makes every
          // particle recycled in the same frame land on ONE z-plane — during
          // chart speed-ups many particles wrap per frame, producing visible
          // "sheets" of coplanar particles.
          posArr[i]     = (Math.random() - 0.5) * 7.0;
          posArr[i + 1] = (Math.random() - 0.5) * 4.5;
          posArr[i + 2] = wrapFar + ((posArr[i + 2] - 5) % tunnelLen);
        } else if (posArr[i + 2] < wrapFar) {
          // Negative chart speed (rewind sections): wrap symmetrically from
          // the far end back to the near plane, also preserving overshoot.
          posArr[i]     = (Math.random() - 0.5) * 7.0;
          posArr[i + 1] = (Math.random() - 0.5) * 4.5;
          posArr[i + 2] = 5 - ((wrapFar - posArr[i + 2]) % tunnelLen);
        }
      }
      posAttr.needsUpdate = true;
    }

    // Shatter particle systems update (ultra mode hit bursts).
    // Particles drift slowly outward (drag increases over time) and the
    // overall opacity decays quickly via an exponential curve so the burst
    // is bright at impact but fades fast.
    const shatters = shatterSystemsRef.current;
    let sWrite = 0;
    for (let i = 0; i < shatters.length; i++) {
      const s = shatters[i];
      const p = (now - s.startMs) / s.duration;
      if (p >= 1) {
        s.points.removeFromParent();
        recycleShatter(s.points);
        continue;
      }
      const posAttr = s.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      // Use audioDt (same source as note motion) so shatter z-flow scales
      // correctly with speedMultiplier and stays paused when the song pauses.
      const dt = audioDt;
      // Lateral drag grows with p → outward drift slows over time.
      const dragLat = Math.max(0.1, 1 - p * 1.2);
      // Z damping: velocity decays exponentially so particles slow down
      // rather than streaking across the whole tunnel. Damping rate ~2.5/sec
      // → velocity halves every ~280ms, matching the 500ms life span.
      const zDamp = Math.exp(-2.5 * dt);
      for (let k = 0; k < posArr.length; k += 3) {
        posArr[k]     += s.velocities[k] * dt * dragLat;
        posArr[k + 1] += s.velocities[k + 1] * dt * dragLat;
        s.velocities[k + 2] *= zDamp; // apply damping to velocity itself
        posArr[k + 2] += s.velocities[k + 2] * dt;
      }
      posAttr.needsUpdate = true;
      // Fast brightness decay: opacity drops to ~0.15 by p=0.5, then trails off.
      const opacity = Math.pow(1 - p, 2.2);
      (s.points.material as THREE.PointsMaterial).opacity = opacity;
      // Size also shrinks slightly so it doesn't look like a fading blob.
      (s.points.material as THREE.PointsMaterial).size = 0.09 * (1 - p * 0.3);
      shatters[sWrite++] = s;
    }
    shatters.length = sWrite;

    // Song end — O(1) check using precomputed metrics.
    // Previously this iterated all notes every frame to count judged vs total.
    if (playing && !songEndedRef.current && !isEditorModeRef.current) {
      const totalNotes = totalNotesRef.current;
      // 空谱面（0 音符）也要能结束：没有任何可判定物件，等 lead-in 走完后直接结算 0 分。
      const ended = totalNotes > 0
        ? (judgedCountRef.current >= totalNotes || curTime > lastNoteTimeRef.current + 2)
        : curTime > 2;
      if (ended) {
        songEndedRef.current = true;
        songEndTimerRef.current = window.setTimeout(() => { onSongEndRef.current?.(); songEndTimerRef.current = null; }, 800);
      }
    }

    // Bloom-aware render: SelectiveBloom path when active, else direct render.
    // SelectiveBloom flow:
    //   1. Render the main scene to the default framebuffer (screen).
    //   2. Render the same scene with bloomCam (only BLOOM_LAYER objects)
    //      into an offscreen RT.
    //   3. UnrealBloomPass processes that RT → bloom texture.
    //   4. Additive overlay quad composites bloom texture onto the screen.
    if (bloomComposerRef.current) {
      const bc = bloomComposerRef.current;
      // Sync bloom camera with main camera (position/orientation).
      bc.bloomCam.position.copy(camera.position);
      bc.bloomCam.quaternion.copy(camera.quaternion);
      bc.bloomCam.updateMatrixWorld();

      // 1) Main render to screen.
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(scene, camera);

      // 2) Render only BLOOM_LAYER objects to bloomRT (clear to black so
      //    empty pixels produce no bloom).
      renderer.setRenderTarget(bc.bloomRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, bc.bloomCam);

      // 3) UnrealBloomPass processes bloomRT in-place (renders to itself).
      bc.bloomPass.render(renderer, bc.bloomRT, bc.bloomRT, 0, false);

      // 4) Additive overlay: blit bloomRT.texture onto screen.
      bc.overlayMat.uniforms.tDiffuse.value = bc.bloomRT.texture;
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.render(bc.overlayScene, bc.overlayCam);
      renderer.autoClear = true;
    } else {
      renderer.render(scene, camera);
    }

    // 首帧上报：本局第一次真正把画面画到屏幕上。App 以此为锚点启动音频时钟
    // （pendingAudioStart），彻底消除"黑屏期间谱面时间已在走"。
    if (!firstFrameReportedRef.current) {
      firstFrameReportedRef.current = true;
      onFirstFrameRef.current?.();
    }
  };

  // ====== Quick-Create gesture dispatcher =======================================


  /* 手势分类与落音已迁至 ../systems/quickCreate（3D/2D 共用）；本文件仅保留事件接线。 */

  // iOS Safari 15+ shows a text-selection "loupe" (magnifier) on double-tap +
  // hold that CSS alone cannot suppress. The only reliable fix is preventDefault
  // on the native touchstart — and it MUST be non-passive, because React's
  // onTouchStart is registered passively and its preventDefault() is ignored.
  // Pointer events (used for gameplay/editor input) still fire normally, so note
  // tapping and editor dragging are completely unaffected.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => { e.preventDefault(); };
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    return () => el.removeEventListener('touchstart', onTouchStart);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none touch-none overflow-hidden ${
        isEditorMode ? (activeEditorTool === 'select' ? 'cursor-move' : activeEditorTool === 'quick-create' ? 'cursor-grab' : 'cursor-crosshair') : 'cursor-crosshair'
      }`}
      onPointerDown={(e) => {
        /* 编辑器右键 = 取消选中（单选 / 放置工具）；在 updatePointer 之前返回，
           右键既不进入判定/放置/quick-create 任何分支，也不写入 pointersRef
           （否则没有配对的 pointerup，悬停态与 QC 轨迹会残留）。 */
        if (shouldDeselectOnRightClick(e.button, !!isEditorModeRef.current, activeToolRef.current)) {
          e.preventDefault();
          onSelectEditorNoteRef.current?.(null);
          return;
        }
        updatePointer(e.pointerId, e.clientX, e.clientY, true, e.pointerType);
        const p = pointersRef.current.get(e.pointerId);
        if (!p) return;
        const inQC = isEditorModeRef.current && activeToolRef.current === 'quick-create';
        if (inQC) {
          // Read audio time so the gesture beat is precise.
          const playing = isPlayingRef.current && !isPausedRef.current;
          const tSec = playing ? globalAudio.getCurrentTime() : gameTimeRef.current;
          const beat = chartTimeToBeat(tSec);
          const track: QCTrack = {
            pointerId: e.pointerId,
            pressTimeSec: tSec,
            pressBeat: beat,
            pressX: p.x,
            pressY: p.y,
            trajectory: [{ tSec, beat, x: p.x, y: p.y }],
            lastPlacedBeat: null,
            gesture: 'undecided',
          };
          qcTracksRef.current.set(e.pointerId, track);
          // capture the pointer so drags outside the viewport still produce
          // onpointerup events on this element.
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          e.preventDefault();
          return;
        }
        /* pointerId 透传给判定层：故事板的判定拦截（§3.7 v3）在 tap 判定入口收口，
           指针本身仍留在 pointersRef 里（故事板要靠它画反馈），过滤只发生在判定侧。 */
        handlePointerInteraction(p.x, p.y, e.pointerId);
      }}
      onContextMenu={(e) => {
        /* 编辑器内屏蔽系统右键菜单：右键已被赋予「取消选中」语义。
           非编辑（游玩）态仍放行系统菜单。 */
        if (isEditorModeRef.current) e.preventDefault();
      }}
      onPointerMove={(e) => {
        const inQC = isEditorModeRef.current && activeToolRef.current === 'quick-create';
        if (inQC) {
          // Quick-create 手势需要即时高精度采样（分类速度/位移），不走节流。
          const existing = pointersRef.current.get(e.pointerId);
          const down = existing ? existing.down : false;
          updatePointer(e.pointerId, e.clientX, e.clientY, down, e.pointerType);
          const track = qcTracksRef.current.get(e.pointerId);
          const p = pointersRef.current.get(e.pointerId);
          if (!track || !p) return;
          const playing = isPlayingRef.current && !isPausedRef.current;
          const tSec = playing ? globalAudio.getCurrentTime() : gameTimeRef.current;
          const beat = chartTimeToBeat(tSec);
          qc.pushSample(track, tSec, beat, p.x, p.y);
          qc.move(track, beat);
          return;
        }
        // 非 QC：rAF 节流合并同帧多次 move，避免触摸拖动时的高频分配 + layout 读。
        // 判定（tap 在 down 同步处理）不受影响；slide 链在 tick 读 pointersRef，
        // move 延迟一帧（≤16ms）对判定窗口无感知差异。
        pendingMoveRef.current.set(e.pointerId, { cx: e.clientX, cy: e.clientY, pointerType: e.pointerType });
        if (moveRafRef.current === null) {
          moveRafRef.current = requestAnimationFrame(() => {
            moveRafRef.current = null;
            const pending = pendingMoveRef.current;
            if (pending.size === 0) return;
            for (const [pid, m] of pending) {
              // 允许悬停（未按下）的指针也进入 pointersRef：touch 音符是悬停触发，
              // 若仅更新已存在的指针，未按下过的鼠标/触摸永远不会被记录，悬停判定失效。
              // 已 up/removePointer 删除的幽灵指针由 removePointer 负责，此处无需跳过。
              const existing = pointersRef.current.get(pid);
              const down = existing ? existing.down : false;
              updatePointer(pid, m.cx, m.cy, down, m.pointerType);
            }
            pending.clear();
          });
        }
      }}
      onPointerUp={(e) => {
        const inQC = isEditorModeRef.current && activeToolRef.current === 'quick-create';
        const track = inQC ? qcTracksRef.current.get(e.pointerId) : undefined;
        if (track) {
          // Append release-time sample for final classification.
          const playing = isPlayingRef.current && !isPausedRef.current;
          const tSec = playing ? globalAudio.getCurrentTime() : gameTimeRef.current;
          const beat = chartTimeToBeat(tSec);
          const p = pointersRef.current.get(e.pointerId);
          if (p) qc.pushSample(track, tSec, beat, p.x, p.y);
          qc.up(track);
          qcTracksRef.current.delete(e.pointerId);
        }
        removePointer(e.pointerId);
      }}
      onPointerCancel={(e) => {
        qcTracksRef.current.delete(e.pointerId);
        removePointer(e.pointerId);
      }}
      onPointerLeave={(e) => {
        // 拖拽中的指针（slide/编辑器）不在此移除，否则指针离开元素即中断判定。
        if (dragPointerIdRef.current === e.pointerId) return;
        qcTracksRef.current.delete(e.pointerId);
        removePointer(e.pointerId);
      }}
    >
      <div
        ref={eventTextRef}
        className="pointer-events-none absolute font-bold opacity-0 whitespace-nowrap"
        style={{
          textShadow: '0 0 12px rgba(0,0,0,0.95), 0 0 24px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.8)',
          left: '50%',
          top: '33%',
          transform: 'translate(-50%, -50%)',
          zIndex: 100,
          transition: 'opacity 0.3s ease',
        }}
      />
    </div>
  );
};

/**
 * Memoized export. During playback, GameCanvas reads audio time directly
 * from `globalAudio.getCurrentTime()` (see tick), so the `gameTime` prop is
 * irrelevant while playing. Without this comparator, the parent's ~20fps
 * `setGameTime` state updates would re-render the entire GameCanvas
 * subtree (running all useEffect registrations + reconciliation) 20×/sec for
 * nothing. By skipping `gameTime` when playing, we eliminate those wasteful
 * re-renders entirely. When NOT playing (paused / editor scrubbing), gameTime
 * is still compared normally so seeks update the canvas.
 */
const arePropsEqual = (prev: GameCanvasProps, next: GameCanvasProps): boolean => {
  // Play-state change → must re-render (tick switches time source on this).
  if (prev.isPlaying !== next.isPlaying || prev.isPaused !== next.isPaused) return false;
  const playing = next.isPlaying && !next.isPaused;
  for (const key of Object.keys(next) as Array<keyof GameCanvasProps>) {
    // During playback, gameTime prop is read from globalAudio instead — skip it.
    if (playing && key === 'gameTime') continue;
    // quality 派生 props（antialias/allow*/renderScale）为低频稳定项，
    // 仅设置弹窗变更（R4-6 起经 qualityStore 驱动），此处浅比较已正确避免误重渲。
    if (prev[key] !== next[key]) return false;
  }
  return true;
};

export const GameCanvas = React.memo(GameCanvasImpl, arePropsEqual);
