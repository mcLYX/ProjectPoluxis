import React, { useEffect, useRef, useMemo, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ChartData, ResolvedNote, ResolvedEvent, JudgementType, JudgementFeedback, NoteType, QualityMode, HitRegion, EasingType, SkinTextureSet } from '../types/game';
import { evaluateJudgement, calculateNoteScore, JUDGEMENT_COLORS } from '../utils/scoring';
import { resolveChart, resolveEvents, countPlayableNotes, extractSpeedPoints, getScrollDistance, secondsToBeatMultiBpm } from '../utils/beatTime';
import { EASING_FNS } from '../utils/easing';

import { globalAudio } from '../audio/AudioManager';

interface QuickCreateDelta {
  taps?: Array<{ beat: number; x: number; y: number }>;
  touches?: Array<{ beat: number; x: number; y: number }>;
  slides?: Array<{
    headBeat: number; headX: number; headY: number;
    nodes: Array<{ beat: number; x: number; y: number }>;
  }>;
  suppressSelection?: boolean;
}

interface GameCanvasProps {
  chart: ChartData;
  isPlaying: boolean;
  isPaused: boolean;
  gameTime: number;
  speedMultiplier: number;
  projectionLeadMs: number;
  noteRenderDistance?: number;
  noteSizeScale?: number;
  qualityMode?: QualityMode;
  /** 抗锯齿开关（自定义档位下由用户控制；其余档位按预设推导后传入）。 */
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
  selectedNoteId?: string | null;
  snapSubdivision?: number;
  onJudgement?: (feedback: JudgementFeedback) => void;
  onSongEnd?: () => void;
  onSelectEditorNote?: (id: string | null) => void;
  onMoveEditorNote?: (id: string, x: number, y: number) => void;
  onPlaceEditorNote?: (x: number, y: number) => void;
  onApplyQuickCreateDelta?: (delta: QuickCreateDelta) => void;
  /** 预加载后的皮肤贴图集合；为 null 时走默认纯色外观。 */
  skinTextures?: SkinTextureSet | null;
  /** 默认皮肤（未选皮肤包时）自定义项：内框/外框/判定框。 */
  defaultSkinInnerWidth?: number;
  defaultSkinOuterWidth?: number;
  defaultSkinOuterColor?: string;
  defaultSkinOuterAlpha?: number;
  defaultSkinJudgeWidth?: number;
}

const TAP_SIZE = 1.6;
const TOUCH_SIZE = TAP_SIZE * 0.707;
const SLIDE_SIZE = TAP_SIZE * 0.707; // slide diamond edge = 0.707x tap
const SLIDE_HALF = (SLIDE_SIZE * Math.SQRT2) / 2; // half-diagonal of the 45°-rotated square
// Pipe cross-section is a diamond slightly smaller than the slide node itself.
const SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
/** Layer index used by SelectiveBloom — note meshes are added to this layer
 *  so the bloom camera (which only sees this layer) renders ONLY notes,
 *  not tunnel lines, projections, or burst outlines. */
const BLOOM_LAYER = 1;
const JUDGE_Z = 0;
const TAP_HIT_HALF = 1.2;
const TOUCH_HIT_HALF = 1.0;
const SLIDE_HIT_HALF = 1.2;
const HIT_WINDOW_MS = 160;
const SLIDE_RED = '#ff0000';

const CAMERA_VFOV = 52;
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

/**
 * Per-slide-note cache of the combined "all nodes" array (head + children).
 * `processSlide` and the slide renderer both previously rebuilt this array
 * every frame for every slide via `[head, ...resolvedNodes]` spread, which
 * produced significant GC pressure. Since `resolvedNodes` is stable for a
 * given ResolvedNote object (created once by resolveChart useMemo), we
 * cache the combined array Weakly-keyed on the note object. When the chart
 * changes and old ResolvedNote objects become unreachable, the cache entries
 * are GC'd automatically.
 */
const _allNodesCache = new WeakMap<
  ResolvedNote,
  Array<{ x: number; y: number; timeSec: number; angle: number; easing: EasingType }>
>();
function getAllNodes(note: ResolvedNote): Array<{ x: number; y: number; timeSec: number; angle: number; easing: EasingType }> {
  let cached = _allNodesCache.get(note);
  if (!cached) {
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

// Slide: filled plane for the *skin* texture path (rotated 45° at mesh level).
// 默认皮肤的填充已改用软边纹理（见 makeSoftFillTexture），不再用硬边几何体。
const _slideFillGeo = markShared(new THREE.PlaneGeometry(SLIDE_SIZE * 0.94, SLIDE_SIZE * 0.94));

// Generic 1×1 plane: default-skin rings / fills attach a soft-edged CanvasTexture
// and scale the MESH to the texture's world size (keeps a single shared geometry).
const _unitGeo = markShared(new THREE.PlaneGeometry(1, 1));

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
type RingPt = [number, number];
interface SoftShapeTex { texture: THREE.CanvasTexture; size: number; }
const softShapeTexCache = new Map<string, SoftShapeTex>();

function softShapeBBox(pts: RingPt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** 软边环形纹理：以线宽 thickness（世界单位）沿多边形描边，环带落在 [maxR-thickness, maxR]。 */
function makeSoftRingTexture(outer: RingPt[], thickness: number): SoftShapeTex {
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
const TAP_RING_OUTER: RingPt[] = [
  [-TAP_SIZE / 2, -TAP_SIZE / 2],
  [TAP_SIZE / 2, -TAP_SIZE / 2],
  [TAP_SIZE / 2, TAP_SIZE / 2],
  [-TAP_SIZE / 2, TAP_SIZE / 2],
];
const TOUCH_RING_OUTER: RingPt[] = (() => {
  const rad = TOUCH_SIZE / 2;
  const pts: RingPt[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  return pts;
})();
const SLIDE_RING_OUTER: RingPt[] = [
  [0, -SLIDE_HALF],
  [SLIDE_HALF, 0],
  [0, SLIDE_HALF],
  [-SLIDE_HALF, 0],
];

// 描边闪烁的根因：默认皮肤的填充/描边是「硬边透明几何体」，音符移动时产生
// 时间域锯齿（看起来像低分辨率+无抗锯齿）。皮肤贴图不闪是因为纹理自带平滑
// alpha 边缘。现已把默认皮肤的填充/描边改为软边 Canvas 纹理（makeSoftRingTexture /
// makeSoftFillTexture）。FILL_Z 让半透明填充面略微后移，保证描边环稳定压在填充之上；
// 所有透明材质均 depthWrite:false，避免写入深度而错误遮挡更远音符的描边。
const FILL_Z = -0.012;

// Slide pipes no longer share a geometry: each builds its own curved,
// angle-rotated tube (see buildSlideTubeGeometry) so easing/angle vary per segment.

interface TouchTrackState {
  lastInsideTime: number | null;
  arrivalChecked: boolean;
}

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
  /** In time window + a non-bound pointer is on the node (recoverable warning, red). */
  redWarn: boolean;
  /** Tail-node special rule: when true, the node is locked for S-Perfect at dt>=0
   *  as long as the bound pointer is still on screen (doesn't need to be in zone). */
  tailLockedSPerfect: boolean;
}

/** Runtime state per slide chain */
interface SlideRt {
  boundPointerIds: Set<number>;
  nodes: SlideNodeRt[];
}

interface SlideMeshSet {
  nodes: Array<{
    group: THREE.Group;
    /** Only the slide head keeps a border: inner (note color) + outer (custom). */
    innerWire?: THREE.MeshBasicMaterial;
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
    /** Geometry cache key; rebuilt only when the segment shape actually changes. */
    geoKey: string | null;
    /** World-space midpoint, reused by the ultra light pool. */
    mid: THREE.Vector3;
  }>;
}

const GameCanvasImpl: React.FC<GameCanvasProps> = ({
  chart,
  isPlaying,
  isPaused,
  gameTime,
  speedMultiplier,
  projectionLeadMs,
  noteRenderDistance = 70,
  noteSizeScale = 1.0,
  qualityMode = 'standard',
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
  selectedNoteId = null,
  snapSubdivision = 0.25,
  onJudgement,
  onSongEnd,
  onSelectEditorNote,
  onMoveEditorNote,
  onPlaceEditorNote,
  onApplyQuickCreateDelta,
  skinTextures,
  defaultSkinInnerWidth = 0.05,
  defaultSkinOuterWidth = 0,
  defaultSkinOuterColor = '#22d3ee',
  defaultSkinOuterAlpha = 1,
  defaultSkinJudgeWidth = 0.05,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number; down: boolean; active: boolean; type: string }>>(new Map());
  const dragPointerIdRef = useRef<number | null>(null);
  const pointerDownStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);

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
  const lastWindowRef = useRef<{ firstIdx: number; lastIdx: number; notes: ResolvedNote[] | null }>({ firstIdx: 0, lastIdx: 0, notes: null });
  const touchTrackRef = useRef<Map<string, TouchTrackState>>(new Map());
  const slideStateRef = useRef<Map<string, SlideRt>>(new Map());

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  /** Post-processing composer — only created when qualityMode >= 'high' AND
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
  /** Ambient particle field for qualityMode >= 'high' when chart.effectToggles.particles. */
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
    color: THREE.Color;
  }>>([]);

  const noteMeshesRef = useRef<Map<string, { group: THREE.Group; projectionGroup: THREE.Group }>>(new Map());
  const slideMeshesRef = useRef<Map<string, SlideMeshSet>>(new Map());
  const selectionGizmoRef = useRef<THREE.Line | null>(null);
  const activeBurstsRef = useRef<Array<{
    group: THREE.Group;
    startTime: number;
    duration: number;
    scaleTarget: number;
    baseScale: number;
  }>>([]);

  const resolvedNotes = useMemo(() => resolveChart(chart), [chart]);
  const resolvedRef = useRef(resolvedNotes);
  useEffect(() => { resolvedRef.current = resolvedNotes; }, [resolvedNotes]);

  const resolvedEvents = useMemo(() => resolveEvents(chart), [chart]);
  const eventsRef = useRef(resolvedEvents);
  useEffect(() => { eventsRef.current = resolvedEvents; }, [resolvedEvents]);

  // Pre-computed speed change points for scroll distance calculation.
  // This ensures note spacing is visually correct BEFORE a speed change
  // reaches the judge line (no teleportation artifacts).
  const speedPoints = useMemo(() => extractSpeedPoints(chart), [chart]);
  const speedPointsRef = useRef(speedPoints);
  useEffect(() => { speedPointsRef.current = speedPoints; }, [speedPoints]);

  const chartRef = useRef(chart);
  const isPlayingRef = useRef(isPlaying);
  const isPausedRef = useRef(isPaused);
  const gameTimeRef = useRef(gameTime);
  const speedRef = useRef(speedMultiplier);
  const projectionLeadRef = useRef(projectionLeadMs);
  const renderDistRef = useRef(noteRenderDistance);
  const sizeScaleRef = useRef(noteSizeScale);
  const skinTexturesRef = useRef<SkinTextureSet | null>(skinTextures ?? null);
  const defaultSkinInnerWidthRef = useRef(defaultSkinInnerWidth);
  const defaultSkinOuterWidthRef = useRef(defaultSkinOuterWidth);
  const defaultSkinOuterColorRef = useRef(defaultSkinOuterColor);
  const defaultSkinOuterAlphaRef = useRef(defaultSkinOuterAlpha);
  const defaultSkinJudgeWidthRef = useRef(defaultSkinJudgeWidth);
  const lowQualityModeRef = useRef(qualityMode === 'low');
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
  const selectedNoteIdRef = useRef(selectedNoteId);

  const onSelectEditorNoteRef = useRef(onSelectEditorNote);
  const onMoveEditorNoteRef = useRef(onMoveEditorNote);
  const onPlaceEditorNoteRef = useRef(onPlaceEditorNote);
  const onJudgementRef = useRef(onJudgement);
  const onSongEndRef = useRef(onSongEnd);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
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
          if (evt.gradientStart && evt.gradientEnd) {
            currentBgRef.current = { gradientStart: evt.gradientStart, gradientEnd: evt.gradientEnd };
          }
          break;
        default:
          break;
      }
      nextEventIdxRef.current++;
    }
  };

  useEffect(() => { gameTimeRef.current = gameTime; }, [gameTime]);
  useEffect(() => { speedRef.current = speedMultiplier; }, [speedMultiplier]);
  useEffect(() => { projectionLeadRef.current = projectionLeadMs; }, [projectionLeadMs]);
  useEffect(() => { renderDistRef.current = noteRenderDistance; }, [noteRenderDistance]);
  useEffect(() => { sizeScaleRef.current = noteSizeScale; }, [noteSizeScale]);
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
  }, [skinTextures]);
  // 默认皮肤自定义项：变更时同步到 ref（新建 note 时读取），并重建已存在的
  // 默认外观网格，使线框粗细/颜色即时生效。
  useEffect(() => {
    defaultSkinInnerWidthRef.current = defaultSkinInnerWidth;
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
  }, [defaultSkinInnerWidth, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth, skinTextures]);
  useEffect(() => {
    lowQualityModeRef.current = qualityMode === 'low';
  }, [qualityMode]);
  useEffect(() => { antialiasRef.current = antialias; }, [antialias]);
  useEffect(() => { renderScaleRef.current = renderScale; }, [renderScale]);
  useEffect(() => { allowBloomRef.current = allowBloom; }, [allowBloom]);
  useEffect(() => { allowParticlesRef.current = allowParticles; }, [allowParticles]);
  useEffect(() => { allowDynamicLightingRef.current = allowDynamicLighting; }, [allowDynamicLighting]);
  useEffect(() => { allowHitEffectsRef.current = allowHitEffects; }, [allowHitEffects]);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);
  useEffect(() => { isEditorModeRef.current = isEditorMode; }, [isEditorMode]);
  useEffect(() => { activeToolRef.current = activeEditorTool; }, [activeEditorTool]);
  useEffect(() => { snapSubdivisionRef.current = snapSubdivision; }, [snapSubdivision]);
  useEffect(() => { selectedNoteIdRef.current = selectedNoteId; }, [selectedNoteId]);
  useEffect(() => { chartRef.current = chart; }, [chart]);
  useEffect(() => { onSelectEditorNoteRef.current = onSelectEditorNote; }, [onSelectEditorNote]);
  useEffect(() => { onMoveEditorNoteRef.current = onMoveEditorNote; }, [onMoveEditorNote]);
  useEffect(() => { onPlaceEditorNoteRef.current = onPlaceEditorNote; }, [onPlaceEditorNote]);
  useEffect(() => { onApplyQuickCreateDeltaRef.current = onApplyQuickCreateDelta; }, [onApplyQuickCreateDelta]);
  useEffect(() => { onJudgementRef.current = onJudgement; }, [onJudgement]);
  useEffect(() => { onSongEndRef.current = onSongEnd; }, [onSongEnd]);

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
  const hideNoteMeshes = (note: ResolvedNote) => {
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
    const scene = sceneRef.current;
    noteMeshesRef.current.forEach((entry) => {
      if (scene) { scene.remove(entry.group); scene.remove(entry.projectionGroup); }
      disposeGroup(entry.group);
      disposeGroup(entry.projectionGroup);
    });
    noteMeshesRef.current.clear();
    slideMeshesRef.current.forEach((sm) => {
      sm.nodes.forEach((nd) => {
        if (scene) {
          scene.remove(nd.group);
          if (nd.proj) scene.remove(nd.proj);
        }
        disposeGroup(nd.group);
        if (nd.proj) disposeGroup(nd.proj);
      });
      sm.pipes.forEach((p) => {
        if (scene) scene.remove(p.mesh);
        // Each pipe owns its geometry; dispose it (shared geos are tagged and skipped).
        if (!isSharedGeo(p.geo)) p.geo.dispose();
        p.mat.dispose();
      });
    });
    slideMeshesRef.current.clear();
    activeBurstsRef.current.forEach((b) => { if (scene) scene.remove(b.group); });
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
      total++; // head counts as one
      if (n.type === 'slide') {
        const childCount = n.resolvedNodes?.length ?? 0;
        total += childCount;
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
    // Reset event system state
    nextEventIdxRef.current = 0;
    currentTextRef.current = null;
    currentNoteColorRef.current = null;
    currentBgRef.current = null;
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
        if (evt.gradientStart && evt.gradientEnd) {
          currentBgRef.current = {
            gradientStart: evt.gradientStart,
            gradientEnd: evt.gradientEnd,
          };
        }
        break;
      default:
        break;
    }
  };

  useEffect(() => { resetPlayState(); }, [playSession, chart]);

  // 返回菜单 / 结算（非 暂停、非编辑器）时清空所有 note / projection / slide / burst
  // 网格，避免中途退出后 projection 等残留在屏幕上不消失。
  useEffect(() => {
    if (!isPlaying && !isPaused && !isEditorMode) {
      resetPlayState();
    }
  }, [isPlaying, isPaused, isEditorMode]);

  // `vpKey` is bumped when the 3D viewport becomes visible again (see the
  // ResizeObserver below) so the heavy setup effect re-runs with correct
  // dimensions and the metadata edited while hidden.
  const [vpKey, setVpKey] = useState(0);

  // A plain window 'resize' listener does NOT fire when a container transitions
  // display:none → block (e.g. switching the editor from 2D back to 3D), so the
  // WebGL canvas never gets re-sized / re-built and stays blank. Watch the
  // container with a ResizeObserver and bump `vpKey` on the hidden→visible edge.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let wasVisible = el.clientWidth > 0 && el.clientHeight > 0;
    const ro = new ResizeObserver(() => {
      const visible = el.clientWidth > 0 && el.clientHeight > 0;
      if (visible && !wasVisible) setVpKey((k) => k + 1);
      wasVisible = visible;
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
    const camera = new THREE.PerspectiveCamera(CAMERA_VFOV, w / h, 0.1, 1000);
    const dist0 = fitCameraDistance(w / h);
    camera.position.set(0, CAMERA_AXIS_Y, dist0); camera.lookAt(0, CAMERA_AXIS_Y, 0); cameraRef.current = camera;
    // 抗锯齿 / 渲染倍率由传入的细项控制（自定义档位下由用户决定）。
    const useAA = antialiasRef.current;
    const renderer = new THREE.WebGLRenderer({
      antialias: useAA,
      alpha: true,
      powerPreference: 'high-performance'
    });
    // Per-material clipping planes drive the slide-pipe "clip at the judgement
    // plane" behaviour (and the editor far-plane trim) without rebuilding geometry.
    renderer.localClippingEnabled = true;
    renderer.setSize(w, h);
    // 渲染倍率（分辨率缩放）：>1 超采样更清晰但更耗 GPU，<1 降分辨率换帧率。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * renderScaleRef.current);
    // Remove any previous canvas without touching other DOM children (text overlays, etc.)
    const existingCanvas = container.querySelector('canvas');
    if (existingCanvas) existingCanvas.remove();
    container.appendChild(renderer.domElement); rendererRef.current = renderer;

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
    (cv.style as any).webkitUserSelect = 'none';
    (cv.style as any).webkitTouchCallout = 'none';
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
    scene.add(gizmo);
    selectionGizmoRef.current = gizmo;

    scene.add(tunnel);

    // === SelectiveBloom for 'high' / 'ultra' quality (if chart enables it) ===
    // SelectiveBloom = bloom applied ONLY to note meshes (tagged with
    // BLOOM_LAYER), not tunnel lines / projections / bursts. This avoids the
    // "everything blooms" over-exposure problem.
    //
    // Implementation: a second camera (bloomCamera) renders only BLOOM_LAYER
    // objects into an offscreen RT. UnrealBloomPass processes it. The result
    // is additively composited over the main render via a fullscreen quad.
    //
    // NOTE: EffectComposer renders to its own framebuffer (opaque black),
    // so we paint a radial gradient onto a CanvasTexture as scene.background
    // — otherwise the CSS ambient bg behind the canvas would be hidden.
    const useBloom = allowBloomRef.current && toggles.bloom !== false;
    if (useBloom) {
      // Build radial-gradient CanvasTexture mirroring App.tsx ambient bg.
      const bg = chart.metadata.bgScheme;
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const cx = c.getContext('2d')!;
      const grad = cx.createRadialGradient(128, 128, 0, 128, 128, 180);
      grad.addColorStop(0, bg.gradientEnd);
      grad.addColorStop(1, bg.gradientStart);
      cx.fillStyle = grad;
      cx.fillRect(0, 0, 256, 256);
      const bgTex = new THREE.CanvasTexture(c);
      bgTex.colorSpace = THREE.SRGBColorSpace;
      scene.background = bgTex;

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
    const useParticles = allowParticlesRef.current && toggles.particles !== false;
    if (useParticles) {
      // Build shared soft-circle sprite texture once (32×32 radial gradient).
      // Used by both ambient particles and ultra-mode shatter bursts.
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

      const renderDist = noteRenderDistance; // mirrors "渲染距离" setting
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
        size: 0.12, // smaller — feels like floating dust, not big snowflakes
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
      scene.add(field);
      particleFieldRef.current = field;
      particleVelRef.current = vel;
    } else {
      particleFieldRef.current = null;
      particleVelRef.current = null;
      particleSpriteRef.current = null;
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
      const tunnelLen = noteRenderDistance + 10;
      const roomGeo = new THREE.BoxGeometry(8, 5.5, tunnelLen);
      const room = new THREE.Mesh(roomGeo, wallMat);
      room.position.set(0, 0, -tunnelLen / 2 + 2);
      walls.add(room);
      scene.add(walls);
      ultraWallsRef.current = walls;

      // Ambient light so unlit walls are not pure black.
      scene.add(new THREE.AmbientLight(0x3a4870, 0.6));

      // Pool of 8 PointLights — repositioned each frame to follow the
      // closest notes. More than 8 hurts perf on mid-range GPUs.
      const lightPool: THREE.PointLight[] = [];
      for (let i = 0; i < 8; i++) {
        const pl = new THREE.PointLight(0xffffff, 0, 1800, 1.6);
        pl.position.set(0, 0, -100); // parked far away when unused
        scene.add(pl);
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
    let animId = 0;
    const loop = () => { animId = requestAnimationFrame(loop); tick(); };
    animId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
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
        scene.remove(particleFieldRef.current);
        particleFieldRef.current.geometry.dispose();
        (particleFieldRef.current.material as THREE.Material).dispose();
        particleFieldRef.current = null;
        particleVelRef.current = null;
      }
      shatterSystemsRef.current.forEach((s) => {
        scene.remove(s.points);
        s.points.geometry.dispose();
        (s.points.material as THREE.Material).dispose();
      });
      shatterSystemsRef.current.length = 0;
      // Dispose ultra light pool
      ultraLightPoolRef.current.forEach((pl) => { scene.remove(pl); });
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
      renderer.dispose(); scene.clear();
      cv.removeEventListener('touchstart', onCanvasTouchStart);
      sceneRef.current = null; cameraRef.current = null; rendererRef.current = null;
      ultraWallsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.metadata.bgScheme.accentColor, chart.metadata.bgScheme.gradientStart, chart.metadata.bgScheme.gradientEnd, chart.metadata.noteColor, chart.metadata.effectToggles?.bloom, chart.metadata.effectToggles?.particles, chart.metadata.effectToggles?.gridLines, chart.metadata.effectToggles?.projection, qualityMode, antialias, renderScale, allowBloom, allowParticles, allowDynamicLighting, allowHitEffects, noteRenderDistance, vpKey]);

  // ====== Quick-Create time/beat helpers =========================================
  /** Chart-clock timestamp -> beat, via the shared inverse in beatTime.ts.
   *  Handles bpmlist tempo changes, so mid-press beat interpolation stays
   *  correct through BPM shifts. */
  const chartTimeToBeat = (tSec: number): number => {
    const m = chartRef.current.metadata;
    return secondsToBeatMultiBpm(tSec, m.bpm, m.offset || 0, m.bpmlist);
  };

  /** Snap grid step (in beats). The user's snapSubdivision is honoured, but it
   *  is never finer than 1/16 beat (per spec: "最少1/16拍，如果选的自由也按1/16计算").
   *  NOTE: previously this used Math.min(1/16, snap) which ALWAYS picked 1/16 —
   *  that's why notes ignored the 1/4 (0.25) setting. We want the user setting
   *  when it is coarser than 1/16, hence Math.max. */
  const qcStep = (): number =>
    Math.max(1 / 16, snapSubdivisionRef.current > 0 ? snapSubdivisionRef.current : 1 / 16);

  /** Round beat to the nearest grid line using the current snap step. */
  const qcSnapBeat = (beat: number): number => {
    const step = qcStep();
    return Math.round(beat / step) * step;
  };

  /** Sample the finger's (x,y) position at a given beat by linearly
   *  interpolating the recorded trajectory. This is what makes slide nodes and
   *  touch notes truly FOLLOW the finger instead of piling at the cursor. */
  const qcSampleAtBeat = (
    traj: Array<{ tSec: number; beat: number; x: number; y: number }>,
    beat: number
  ): { x: number; y: number } => {
    if (traj.length === 0) return { x: 0, y: 0 };
    if (beat <= traj[0].beat) return { x: traj[0].x, y: traj[0].y };
    const last = traj[traj.length - 1];
    if (beat >= last.beat) return { x: last.x, y: last.y };
    for (let i = 1; i < traj.length; i++) {
      if (traj[i].beat >= beat) {
        const a = traj[i - 1];
        const b = traj[i];
        const u = (beat - a.beat) / Math.max(b.beat - a.beat, 1e-6);
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      }
    }
    return { x: last.x, y: last.y };
  };

  /** Displacement (note-plane units) from the press point during the FIRST
   *  beat. If the finger stays within this radius for the whole first beat the
   *  gesture becomes a SLIDE; beyond it becomes a TOUCH stream. Per spec the
   *  slide/touch decision is made ONLY from the first-beat displacement and is
   *  then locked. */
  const QC_STATIC_MOVE_PX = 0.22; // ~14% of note-plane half-width
  /** Beat duration (in beats) after which the slide/touch decision is locked
   *  and a press that is still held can no longer be a tap. */
  const QC_FIRST_BEAT = 1.0;

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
      (activeToolRef as any).current = type === 'tap' ? 'place-tap' : 'place-touch';
      onPlaceEditorNoteRef.current?.(x, y);
      (activeToolRef as any).current = oldTool;
      onSelectEditorNoteRef.current?.(null);
    };
    for (const t of delta.taps ?? []) place('tap', t.x, t.y);
    for (const t of delta.touches ?? []) place('touch', t.x, t.y);
  };

  const updatePointer = (
    pointerId: number,
    cx: number,
    cy: number,
    down: boolean,
    pointerType: string = 'mouse'
  ) => {
    if (!containerRef.current || !cameraRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const nx = ((cx - r.left) / r.width) * 2 - 1;
    const ny = -((cy - r.top) / r.height) * 2 + 1;
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(nx, ny), cameraRef.current);
    const t = new THREE.Vector3();
    if (rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1),0), t)) {
      const isTouchLike = pointerType === 'touch' || pointerType === 'pen';
      const active = isTouchLike ? down : true;
      pointersRef.current.set(pointerId, { x: t.x, y: t.y, down, active, type: pointerType });
      if (down && dragPointerIdRef.current === null) {
        dragPointerIdRef.current = pointerId;
        pointerDownStartRef.current = { x: t.x, y: t.y };
      }
    }
  };

  const removePointer = (pointerId: number) => {
    pointersRef.current.delete(pointerId);
    if (dragPointerIdRef.current === pointerId) {
      dragPointerIdRef.current = null;
      pointerDownStartRef.current = null;
      isDraggingRef.current = false;
    }
  };

  const isAnyPointerInside = (x: number, y: number, half: number): boolean => {
    for (const p of pointersRef.current.values()) {
      if (!p.active) continue;
      if (Math.abs(p.x - x) < half && Math.abs(p.y - y) < half) return true;
    }
    return false;
  };

  // 默认皮肤：为音符添加 内框(紧贴音符、跟随音符色) + 外框(可自定义颜色/透明度) 两道软边环形描边。
  // 颜色逐帧由渲染循环设置；此处仅按当前设置烘焙纹理粗细。
  const addDefaultBorders = (g: THREE.Group, ringOuter: RingPt[]) => {
    // 多边形外接半径（圆心在原点，取各顶点到原点距离的最大值）。
    const maxR = (() => { let m = 0; for (const [x, y] of ringOuter) m = Math.max(m, Math.hypot(x, y)); return m; })();
    const gap = maxR * 0.05; // 外框与内框之间的留白
    g.add(makeRingMesh(ringOuter, defaultSkinInnerWidthRef.current, '#ffffff', 1, 'inner'));
    // 外框需位于内框之外：将多边形整体放大到 maxR + gap + 外框粗细。
    const outerScale = (maxR + gap + defaultSkinOuterWidthRef.current) / maxR;
    const outerPts = ringOuter.map(([x, y]) => [x * outerScale, y * outerScale] as RingPt);
    g.add(makeRingMesh(outerPts, defaultSkinOuterWidthRef.current, defaultSkinOuterColorRef.current, 1, 'outer'));
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
    // 默认外观：软边填充 + 内框(音符色) + 外框(可自定义) 双环描边。
    addDefaultBorders(g, TAP_RING_OUTER);
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
    // 默认外观：软边填充 + 内框(音符色) + 外框(可自定义) 双环描边。
    addDefaultBorders(g, TOUCH_RING_OUTER);
    g.add(makeSoftFillMesh(TOUCH_RING_OUTER.map(([x, y]) => [x * 0.92, y * 0.92] as RingPt), c, 0.22));
    return g;
  };

  // 按 note 类型取投影贴图：优先专属键，缺失时回退共享 projection。
  const pickProj = (nt: NoteType): THREE.Texture | undefined => {
    const s = skinTexturesRef.current;
    if (!s) return undefined;
    if (nt === 'tap') return s.projTap ?? s.projTouch ?? s.projSlide ?? s.projection;
    if (nt === 'touch') return s.projTouch ?? s.projTap ?? s.projSlide ?? s.projection;
    return s.projSlide ?? s.projTap ?? s.projTouch ?? s.projection;
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

  const spawnBurst = (x: number, y: number, j: JudgementType, nt: NoteType, noteColorHex?: string, z: number = JUDGE_Z + 0.05, angle: number = 0) => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;
    const cfg = JUDGEMENT_COLORS[j]; const g = new THREE.Group(); g.position.set(x, y, JUDGE_Z + 0.05);
    // Rotate the burst outline to match the note's own angle (so directional
    // notes leave a directionally-oriented hit effect). Same convention as the
    // note visuals: negate because Three's +rotation.z is counterclockwise.
    g.rotation.z = -(angle ?? 0);
    const col = new THREE.Color(cfg.hex);
    // 打击特效框复用同类型投影贴图，但按"判定等级"染色（而非 note 颜色）。
    const projTex = pickProj(nt);
    if (projTex) {
      const size = projSize(nt);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, map: projTex, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.layers.enable(BLOOM_LAYER);
      g.add(mesh);
    } else {
      // 默认外观：用软边环形当作打击框，粗细使用判定框宽度。
      const outer = nt === 'tap' ? TAP_RING_OUTER : nt === 'touch' ? TOUCH_RING_OUTER : SLIDE_RING_OUTER;
      g.add(makeRingMesh(outer, defaultSkinJudgeWidthRef.current, col, 0.95));
    }
    const visualScale = sizeScaleRef.current;
    g.scale.set(visualScale, visualScale, 1);
    scene.add(g);
    activeBurstsRef.current.push({
      group: g,
      startTime: performance.now(),
      duration: 300,
      // cfg.scale is a relative animation multiplier (1.2 / 1.1 / 1.05).
      scaleTarget: cfg.scale,
      baseScale: visualScale,
    });

    // Ultra mode: shatter the note into many fine particles that drift apart
    // slowly with fast brightness decay. Particle INITIAL positions sample
    // the note's own shape (square for tap, circle for touch, diamond for
    // slide) so it looks like the note literally broke apart. Color = note
    // color (not judgement color) so the burst matches the note's identity.
    if (allowHitEffectsRef.current && j !== 'Miss') {
      const noteCol = new THREE.Color(noteColorHex || cfg.hex);
      const PCOUNT = 90;
      const pos = new Float32Array(PCOUNT * 3);
      const vel = new Float32Array(PCOUNT * 3);
      // Visual scale (noteSizeScale 0.6~1.0) — shatter particles must match
      // the actual on-screen note size, otherwise the burst looks mismatched.
      const vScale = sizeScaleRef.current;
      // Note visual half-size, scaled by vScale to match the rendered note.
      const baseHalf = (nt === 'touch' ? (TOUCH_SIZE / 2) : (TAP_SIZE / 2)) * vScale;
      const slideHalf = SLIDE_HALF * vScale; // diamond half-diagonal
      // Note z-flow speed = 36 * speedMultiplier units/sec. Shatter particles
      // use a near-constant base speed (≈9 u/s + small note-speed fraction)
      // and decelerate via z-damping in the update loop — gives a "burst then
      // drift" feel rather than streaking at note speed.
      const noteSpeed = 36 * speedRef.current;
      const zSpeedBase = 9 + noteSpeed * 0.1;
      const zSpeedRange = noteSpeed * 0.06;
      for (let i = 0; i < PCOUNT; i++) {
        // Sample a point inside the note's shape (already scaled by vScale).
        let lx: number, ly: number;
        if (nt === 'tap') {
          lx = (Math.random() * 2 - 1) * baseHalf;
          ly = (Math.random() * 2 - 1) * baseHalf;
        } else if (nt === 'touch') {
          const r = Math.sqrt(Math.random()) * baseHalf;
          const a = Math.random() * Math.PI * 2;
          lx = Math.cos(a) * r;
          ly = Math.sin(a) * r;
        } else {
          const sx = (Math.random() * 2 - 1) * (slideHalf / Math.SQRT2);
          const sy = (Math.random() * 2 - 1) * (slideHalf / Math.SQRT2);
          lx = (sx - sy) * Math.SQRT1_2;
          ly = (sx + sy) * Math.SQRT1_2;
        }
        pos[i * 3]     = x + lx;
        pos[i * 3 + 1] = y + ly;
        pos[i * 3 + 2] = z;
        // Slow outward drift from note center (small magnitude).
        const dlen = Math.hypot(lx, ly) || 1;
        const driftSpeed = 0.4 + Math.random() * 0.5;
        vel[i * 3]     = (lx / dlen) * driftSpeed + (Math.random() - 0.5) * 0.15;
        vel[i * 3 + 1] = (ly / dlen) * driftSpeed + (Math.random() - 0.5) * 0.15;
        // Z velocity: base 9 u/s + small note-speed-scaled variation (10% of
        // note speed as base offset, 6% as random spread). Decoupled from note
        // speed so particles don't streak; z-damping in the update loop slows
        // them further over their 500ms life.
        vel[i * 3 + 2] = zSpeedBase + Math.random() * zSpeedRange;
      }
      const sGeo = new THREE.BufferGeometry();
      sGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const sMat = new THREE.PointsMaterial({
        color: noteCol,
        size: 0.16,
        map: particleSpriteRef.current,
        transparent: true,
        opacity: 1.0,
        sizeAttenuation: true,
        alphaTest: 0.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(sGeo, sMat);
      // Shatter particles also bloom — they're flying light shrapnel.
      pts.layers.enable(BLOOM_LAYER);
      scene.add(pts);
      shatterSystemsRef.current.push({
        points: pts,
        velocities: vel,
        startMs: performance.now(),
        duration: 500, // shorter — fast brightness decay
        color: noteCol,
      });
    }
  };

  const commitJudgement = (note: ResolvedNote, j: JudgementType, dtMs: number) => {
    if (isEditorModeRef.current) return;
    if (judgedNotesRef.current.has(note.id)) return;
    judgedNotesRef.current.add(note.id);
    judgedCountRef.current++;
    const sc = calculateNoteScore(j, countPlayableNotes(chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound(note.type);
    // Note color = per-note override, then event-driven current color, then chart default.
    const noteColor = note.color || currentNoteColorRef.current || chartRef.current.metadata.noteColor;
    // Spawn the burst at the note's ACTUAL z position when hit, not at the
    // judgement plane. noteZ = JUDGE_Z + (dtMs/1000)*speed: early hits
    // (dtMs<0) place the burst behind the plane (note still approaching);
    // late hits (dtMs>0) place it in front (note has passed). +0.05 keeps
    // particles just in front of the note mesh to avoid z-fighting.
    const hitSpeed = 36 * speedRef.current;
    const noteZ = JUDGE_Z + (dtMs / 1000) * hitSpeed + 0.05;
    spawnBurst(note.x, note.y, j, note.type, noteColor, noteZ, note.angle ?? 0);
    onJudgementRef.current?.({ id: note.id, type: j, x: note.x, y: note.y, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: note.type });
  };

  const commitSlideNode = (slide: ResolvedNote, idx: number, nx: number, ny: number, j: JudgementType, dtMs: number) => {
    if (isEditorModeRef.current) return;
    const key = `${slide.id}#${idx}`;
    if (judgedNotesRef.current.has(key)) return;
    judgedNotesRef.current.add(key);
    judgedCountRef.current++;
    const sc = calculateNoteScore(j, countPlayableNotes(chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound('slide');
    const noteColor = slide.color || chartRef.current.metadata.noteColor;
    // Spawn at the slide node's actual z position (see commitJudgement).
    const hitSpeed = 36 * speedRef.current;
    const noteZ = JUDGE_Z + (dtMs / 1000) * hitSpeed + 0.05;
    const nodeAngle = idx === 0 ? (slide.angle ?? 0) : (slide.resolvedNodes?.[idx - 1]?.angle ?? 0);
    spawnBurst(nx, ny, j, 'slide', noteColor, noteZ, nodeAngle);
    onJudgementRef.current?.({ id: key, type: j, x: nx, y: ny, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: 'slide' });
  };

  const getSlideRt = (id: string, nodeCount: number): SlideRt => {
    let rt = slideStateRef.current.get(id);
    if (!rt || rt.nodes.length !== nodeCount) {
      rt = {
        boundPointerIds: new Set(),
        nodes: Array.from({ length: nodeCount }, () => ({
          judged: false,
          missLocked: false,
          everInZone: false,
          lastInsideTime: null,
          lastInsidePointerId: null,
          arrivalChecked: false,
          redWarn: false,
          tailLockedSPerfect: false,
        })),
      };
      slideStateRef.current.set(id, rt);
    }
    return rt;
  };

  /**
   * Simplified Slide chain judgement (per latest spec):
   * - Nodes behave like Touch but require the pointer to be HELD.
   * - Once a node is judged, EVERY finger currently on that node becomes bound; any of the
   *   bound fingers can judge later nodes (multi-finger support, solves overlapping-node cases).
   * - A bound finger that lifts (released) is removed. A bound finger still down but off the
   *   current node is dropped ONLY when at least one other bound finger is already on that node;
   *   if no bound finger is on the node yet (e.g. fingers still at a shared start, or travelling
   *   between nodes) all bindings are kept, so the chain never loses the finger that will service
   *   the next node (this is what makes split slides from a shared start work).
   * - On release of the LAST remaining bound pointer, the *next unjudged node* is immediately
   *   locked red and will be judged as Late Miss after +160ms, regardless of position.
   * - No Early Miss on release. A normal Miss does NOT clear the binding.
   */
  const processSlide = (note: ResolvedNote, curTime: number) => {
    // Cached: avoids rebuilding [head, ...resolvedNodes] every frame.
    const allNodes = getAllNodes(note);
    const rt = getSlideRt(note.id, allNodes.length);

    // 1) Late-miss every unjudged node past +160ms (incl. missLocked ones)
    for (let i = 0; i < allNodes.length; i++) {
      const ns = rt.nodes[i];
      if (ns.judged) continue;
      const dtI = (curTime - allNodes[i].timeSec) * 1000;
      if (dtI > HIT_WINDOW_MS) {
        ns.judged = true;
        ns.redWarn = false;
        commitSlideNode(note, i, allNodes[i].x, allNodes[i].y, 'Miss', dtI);
        // A miss does not change the binding of subsequent nodes.
      }
    }

    // 2) Simplified release detection (per new spec):
    // Once ALL bound pointers are released, the *next unjudged node* is immediately
    // locked red and will be judged as Late Miss after +160ms, regardless of position.
    // No more "judge at release time" or Early Miss on release.
    // EXCEPTION: If the next node is a tail node already locked for S-Perfect
    // (tailLockedSPerfect), skip missLocked — the player held through the end.
    // nextIdx / current node are needed both here (move-away removal) and in step 3.
    const nextIdx = rt.nodes.findIndex((n) => !n.judged);
    const ndForCheck = nextIdx >= 0 ? allNodes[nextIdx] : null;

    if (rt.boundPointerIds.size > 0) {
      // Remove released pointers from the bound set
      let allReleased = true;
      for (const pid of rt.boundPointerIds) {
        const bp = pointersRef.current.get(pid);
        if (bp && bp.down) {
          allReleased = false;
        } else {
          rt.boundPointerIds.delete(pid);
        }
      }
      // Multi-finger binding: a bound finger that is still down but has slid off the
      // current node is a candidate to be dropped. HOWEVER we must NOT prune during the
      // moment two chains share a start node and the fingers haven't diverged yet (e.g. a
      // split slide where both fingers are still sitting on the shared head, so neither is
      // on either chain's NEXT node). Pruning then would keep, by insertion order, the
      // finger heading the WRONG way and permanently drop the correct one.
      // Fix: only drop off-node fingers when at least ONE bound finger is already on the
      // current node. If none are on it yet (all still travelling / at a shared start),
      // keep every binding so the correct finger is retained until it arrives.
      if (ndForCheck && rt.boundPointerIds.size > 0) {
        const onNodeBound: number[] = [];
        const offNodeBound: number[] = [];
        for (const pid of rt.boundPointerIds) {
          const bp = pointersRef.current.get(pid);
          const onNode = !!bp && bp.down &&
            Math.abs(bp.x - ndForCheck.x) < SLIDE_HIT_HALF &&
            Math.abs(bp.y - ndForCheck.y) < SLIDE_HIT_HALF;
          (onNode ? onNodeBound : offNodeBound).push(pid);
        }
        if (onNodeBound.length > 0) {
          for (const pid of offNodeBound) rt.boundPointerIds.delete(pid);
        }
      }
      if (allReleased && rt.boundPointerIds.size === 0 && nextIdx >= 0) {
        const ns = rt.nodes[nextIdx];
        if (!ns.judged && !ns.tailLockedSPerfect) {
          ns.missLocked = true;
          ns.redWarn = false;
        }
      }
    }

    // 3) Interact with the current next node (nextIdx / ndForCheck hoisted above)
    if (nextIdx < 0) return;
    const ns = rt.nodes[nextIdx];
    const nd = allNodes[nextIdx];
    const dt = (curTime - nd.timeSec) * 1000;

    if (autoPlayRef.current) {
      // AutoPlay: judge as soon as the slide node has passed the plane (dt >= 0).
      if (dt >= 0 && !ns.judged) {
        ns.judged = true;
        commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
      }
      ns.redWarn = false;
      return;
    }

    if (ns.missLocked) { ns.redWarn = false; return; }

    // --- Tail-node special rule ---
    // The last slide node has a relaxed judgement: if ANY bound pointer is still
    // on screen (anywhere) when the node enters the hit window (-160ms), lock it
    // as S-Perfect. The player just needs to hold through the end without lifting.
    const isTail = nextIdx === allNodes.length - 1;
    if (isTail && !ns.tailLockedSPerfect && dt >= -HIT_WINDOW_MS) {
      // Check if ANY bound pointer is still on screen (down === true).
      // Free chain (no binding yet) → any held pointer counts.
      if (rt.boundPointerIds.size > 0) {
        for (const pid of rt.boundPointerIds) {
          const bp = pointersRef.current.get(pid);
          if (bp && bp.down) {
            ns.tailLockedSPerfect = true;
            break;
          }
        }
      } else {
        // No binding yet: if any pointer is held, lock it.
        for (const [, p] of pointersRef.current) {
          if (p.down) { ns.tailLockedSPerfect = true; break; }
        }
      }
    }

    // Which pointers may judge this node? Bound chain → any bound pointer; free chain → any held pointer.
    // Collect EVERY finger currently on the node (multi-finger binding): each eligible finger inside the
    // hit box is a candidate, not just the first one. Overlapping nodes are then each serviced by
    // whatever finger covers them.
    const onNodePids: number[] = [];
    if (rt.boundPointerIds.size > 0) {
      for (const pid of rt.boundPointerIds) {
        const p = pointersRef.current.get(pid);
        if (p && p.down &&
            Math.abs(p.x - nd.x) < SLIDE_HIT_HALF && Math.abs(p.y - nd.y) < SLIDE_HIT_HALF) {
          onNodePids.push(pid);
        }
      }
    } else {
      for (const [pid, p] of pointersRef.current) {
        if (!p.down) continue;
        if (Math.abs(p.x - nd.x) < SLIDE_HIT_HALF && Math.abs(p.y - nd.y) < SLIDE_HIT_HALF) onNodePids.push(pid);
      }
    }

    // Track "has passed the zone while held" for release-judging (no time restriction).
    if (rt.boundPointerIds.size > 0 && onNodePids.length > 0) ns.everInZone = true;

    if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && onNodePids.length > 0) {
      ns.lastInsideTime = curTime;
      ns.lastInsidePointerId = onNodePids[0];
    }

    if (dt >= 0 && !ns.judged) {
      // Tail-node locked S-Perfect: any bound pointer is on screen → instant S-Perfect.
      // Doesn't require being in the spatial zone, just holding through the end.
      if (isTail && ns.tailLockedSPerfect) {
        ns.judged = true;
        // If no binding yet, bind all currently held pointers.
        if (rt.boundPointerIds.size === 0) {
          for (const [pid, p] of pointersRef.current) {
            if (p.down) rt.boundPointerIds.add(pid);
          }
        }
        commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
      } else if (!ns.arrivalChecked) {
        ns.arrivalChecked = true;
        if (onNodePids.length > 0) {
          ns.judged = true;
          // Bind EVERY finger on the node (multi-finger).
          for (const pid of onNodePids) rt.boundPointerIds.add(pid);
          commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
        }
      } else if (onNodePids.length > 0 && dt <= HIT_WINDOW_MS) {
        const j = evaluateJudgement(dt);
        if (j) {
          ns.judged = true;
          for (const pid of onNodePids) rt.boundPointerIds.add(pid);
          commitSlideNode(note, nextIdx, nd.x, nd.y, j, dt);
        }
      }
    }

    // 4) Red warning (recoverable): in time window, chain has bindings,
    //    NONE of the bound pointers are on the node,
    //    but some other held pointer IS on it → move the correct finger back to recover.
    ns.redWarn = false;
    if (!ns.judged && rt.boundPointerIds.size > 0 && onNodePids.length === 0 && dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS) {
      for (const [pid, p] of pointersRef.current) {
        if (rt.boundPointerIds.has(pid) || !p.down) continue;
        if (Math.abs(p.x - nd.x) < SLIDE_HIT_HALF && Math.abs(p.y - nd.y) < SLIDE_HIT_HALF) { ns.redWarn = true; break; }
      }
    }
  };

  const ensureSlideMeshes = (note: ResolvedNote, colorHex: string): SlideMeshSet | null => {
    const scene = sceneRef.current;
    if (!scene) return null;
    const count = 1 + (note.resolvedNodes?.length ?? 0);
    let sm = slideMeshesRef.current.get(note.id);
    if (sm && sm.nodes.length === count) return sm;
    if (sm) {
      sm.nodes.forEach((nd) => {
        scene.remove(nd.group);
        if (nd.proj) scene.remove(nd.proj);
        disposeGroup(nd.group);
        if (nd.proj) disposeGroup(nd.proj);
      });
      sm.pipes.forEach((p) => { scene.remove(p.mesh); if (!isSharedGeo(p.geo)) p.geo.dispose(); p.mat.dispose(); });
    }
    const nodes: SlideMeshSet['nodes'] = [];
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      const isHead = i === 0;
      const slideTex = skinTexturesRef.current?.slide;
      let innerWire: THREE.MeshBasicMaterial | undefined;
      let outerWire: THREE.MeshBasicMaterial | undefined;

      // 皮肤生效时整块替换 node，不绘制彩色边框。否则保留 内框(音符色)+外框(自定义) 双环软边描边。
      if (!slideTex) {
        // 默认皮肤：软边环形描边（内框=音符色，外框=自定义颜色）。
        const maxR = (() => { let m = 0; for (const [x, y] of SLIDE_RING_OUTER) m = Math.max(m, Math.hypot(x, y)); return m; })();
        const gap = maxR * 0.05;
        const recIn = makeSoftRingTexture(SLIDE_RING_OUTER, defaultSkinInnerWidthRef.current);
        innerWire = new THREE.MeshBasicMaterial({
          color: new THREE.Color(colorHex),
          transparent: true,
          opacity: 0,
          map: recIn.texture,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const innerRing = new THREE.Mesh(_unitGeo, innerWire);
        innerRing.scale.set(recIn.size, recIn.size, 1);
        innerRing.userData.isBorder = 'inner';
        innerRing.layers.enable(BLOOM_LAYER);
        group.add(innerRing);

        const outerScale = (maxR + gap + defaultSkinOuterWidthRef.current) / maxR;
        const outerPts = SLIDE_RING_OUTER.map(([x, y]) => [x * outerScale, y * outerScale] as RingPt);
        const recOut = makeSoftRingTexture(outerPts, defaultSkinOuterWidthRef.current);
        outerWire = new THREE.MeshBasicMaterial({
          color: new THREE.Color(defaultSkinOuterColorRef.current),
          transparent: true,
          opacity: 0,
          map: recOut.texture,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const outerRing = new THREE.Mesh(_unitGeo, outerWire);
        outerRing.scale.set(recOut.size, recOut.size, 1);
        outerRing.userData.isBorder = 'outer';
        outerRing.layers.enable(BLOOM_LAYER);
        group.add(outerRing);
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
        // 皮肤：用灰度贴图替换 slide 节点纯色填充。
        fill.map = slideTex;
        fill.alphaTest = 0.02;
        plane = new THREE.Mesh(_slideFillGeo, fill);
        plane.position.z = FILL_Z;
        plane.rotation.z = Math.PI / 4;
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
      scene.add(group);

      // Only the head node displays the judgement projection guide.
      let proj: THREE.Group | undefined;
      let projMat: THREE.LineBasicMaterial | undefined;
      if (isHead) {
        proj = mkProj('slide', colorHex);
        projMat = (proj.children[0] as THREE.Line).material as THREE.LineBasicMaterial;
        proj.visible = false;
        scene.add(proj);
      }
      nodes.push({ group, innerWire, outerWire, fill, proj, projMat });
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
      scene.add(mesh);
      pipes.push({
        mesh,
        mat,
        geo,
        // Editor and Auto-Play must be clipped from the very first frame.
        clipAmount: isEditorModeRef.current || autoPlayRef.current ? 1 : 0,
        lastUpdateMs: performance.now(),
        judgePlane,
        farPlane,
        geoKey: null,
        mid: new THREE.Vector3(),
      });
    }
    sm = { nodes, pipes };
    slideMeshesRef.current.set(note.id, sm);
    return sm;
  };

  const handlePointerInteraction = (px: number, py: number) => {
    if (isEditorModeRef.current) {
      const tool = activeToolRef.current;
      if (tool === 'place-tap' || tool === 'place-touch' || tool === 'place-slide') {
        const clampedX = Math.round(THREE.MathUtils.clamp(px, -2.4, 2.4) * 10) / 10;
        const clampedY = Math.round(THREE.MathUtils.clamp(py, -1.5, 1.5) * 10) / 10;
        onPlaceEditorNoteRef.current?.(clampedX, clampedY);
        return;
      }

      // Select / Move tool — heads and slide child nodes are all selectable near current time.
      const notes = resolvedRef.current;
      let clickedId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      // Read time from the audio clock when playing (same source as tick),
      // fall back to gameTimeRef when paused/editor scrubbing. Must NOT rely
      // solely on gameTimeRef because React.memo skips gameTime prop updates
      // during playback → ref stays stale → selection would target wrong beat.
      const curTime = (isPlayingRef.current && !isPausedRef.current)
        ? globalAudio.getCurrentTime()
        : gameTimeRef.current;
      const curBeat = chartTimeToBeat(curTime);

      for (const n of notes) {
        const candidates: Array<{ id: string; x: number; y: number; beat: number; r: number }> =
          n.type === 'slide'
            ? [
                { id: n.id, x: n.x, y: n.y, beat: n.beat, r: 0.7 },
                ...(n.resolvedNodes ?? []).map((sn, i) => ({
                  id: `${n.id}#${i + 1}`, x: sn.x, y: sn.y, beat: sn.beat, r: 0.7,
                })),
              ]
            : [{ id: n.id, x: n.x, y: n.y, beat: n.beat, r: n.type === 'tap' ? 0.85 : 0.65 }];
        for (const c of candidates) {
          // Changed: only allow selecting notes in the range of [curBeat - 0.1, curBeat + 0.5]
          // so the user cannot accidentally select overdue past notes that are already gone.
          if (c.beat < curBeat - 0.1 || c.beat > curBeat + 0.5) continue;
          const d = Math.hypot(px - c.x, py - c.y);
          if (d < c.r && d < bestDist) { clickedId = c.id; bestDist = d; }
        }
      }

      if (clickedId) {
        onSelectEditorNoteRef.current?.(clickedId);
        isDraggingRef.current = false;
      } else {
        onSelectEditorNoteRef.current?.(null);
      }
      return;
    }

    // Normal Gameplay: tap hit — earliest note wins when windows overlap
    if (!isPlayingRef.current || isPausedRef.current) return;
    // Read audio time directly from the audio clock. Must NOT use gameTimeRef
    // here because React.memo skips gameTime prop updates during playback →
    // ref stays at initial value → all notes appear outside the hit window →
    // taps never register. The tick() function uses the same source for motion,
    // so judgement and visuals are perfectly synchronized.
    const curTime = globalAudio.getCurrentTime();
    const notes = resolvedRef.current;
    // 方案二: overlap-aware tap judgment.
    // A tap is "hittable" if the touch point falls inside its own box OR any of
    // its merged extra hit regions. Among all hittable same-time taps, pick the
    // one closest to the touch point (tie-break by id) and consume it; then merge
    // the consumed tap's own box into every other hittable tap the point overlapped,
    // so subsequent presses on the overlap can still reach them.
    const overlapSet: ResolvedNote[] = [];
    for (const n of notes) {
      if (judgedNotesRef.current.has(n.id) || n.type !== 'tap') continue;
      const dt = Math.abs((curTime - n.timeSec) * 1000);
      if (dt >= HIT_WINDOW_MS) continue;
      const inOwn = Math.abs(px - n.x) < TAP_HIT_HALF && Math.abs(py - n.y) < TAP_HIT_HALF;
      const inExtra = (n.extraHitRegions ?? []).some(
        (r) => Math.abs(px - r.x) < r.half && Math.abs(py - r.y) < r.half
      );
      if (inOwn || inExtra) overlapSet.push(n);
    }
    let best: ResolvedNote | null = null;
    let bestDist = Infinity;
    // Selection rule (fixes late-tap swallow bug): when the touch point lands
    // inside the hitbox of taps at DIFFERENT times (neighbouring close taps with
    // overlapping TAP_HIT_HALF boxes), prefer the MOST LATE one — the tap closest
    // to its miss deadline is the one the player is racing to rescue. Judging the
    // nearer-but-later tap first would swallow the earlier late tap (e.g. note-291
    // late but note-292 closer → 292 got judged, 291 dropped). Within the chosen
    // time group (truly same-time overlapping taps) fall back to 方案二: pick the
    // closest to the touch point, then merge hitboxes. Times are numeric and
    // id-independent (ids can be arbitrary strings).
    let bestLate = -Infinity;
    let bestTimeSec = Infinity;
    for (const n of overlapSet) {
      const late = curTime - n.timeSec; // seconds, signed; larger = later
      if (late > bestLate) { bestLate = late; bestTimeSec = n.timeSec; }
    }
    for (const n of overlapSet) {
      if (n.timeSec !== bestTimeSec) continue; // only the most-late time group
      const d = Math.hypot(px - n.x, py - n.y);
      if (d < bestDist || (d === bestDist && best !== null && n.timeSec < best.timeSec)) {
        best = n;
        bestDist = d;
      }
    }
    if (best) {
      const dt = (curTime - best.timeSec) * 1000;
      const j = evaluateJudgement(dt);
      if (j) {
        commitJudgement(best, j, dt);
        // Merge the consumed tap's own box ONLY into other taps at the SAME
        // timeSec (方案二). Never cross time windows: a tap at a different beat
        // must keep its own hitbox, otherwise its hit area would be polluted and
        // trigger false/early hits later (e.g. note-9 / note-10 same position).
        const merged: HitRegion = { x: best.x, y: best.y, half: TAP_HIT_HALF };
        for (const other of overlapSet) {
          if (other === best || other.timeSec !== best.timeSec) continue;
          const regions = other.extraHitRegions ?? (other.extraHitRegions = []);
          const dup = regions.some((r) => r.x === merged.x && r.y === merged.y && r.half === merged.half);
          if (!dup) regions.push(merged);
        }
      }
    }
  };

  const tick = () => {
    const scene = sceneRef.current; const camera = cameraRef.current; const renderer = rendererRef.current;
    if (!scene || !camera || !renderer) return;
    const playing = isPlayingRef.current && !isPausedRef.current;
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
    const curScrollDist = getScrollDistance(curTime, speedPointsRef.current);
    const globalSpeed = speedRef.current;
    const unitPerSecond = 36 * globalSpeed; // scale: 1 "1x-second" = 36 world units * globalSpeed
    const notes = resolvedRef.current;
    const colorHex = currentNoteColorRef.current || chartRef.current.metadata.noteColor || '#00f0ff';

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
        const left = `${50 + normX * 40}%`;
        const top = `${50 + normY * 40}%`;
        const fs = `${txt.fontSize ?? 36}px`;
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
    if (isEditorModeRef.current && selectedNoteIdRef.current && dragPointerIdRef.current !== null && pointerDownStartRef.current) {
      const dragPointer = pointersRef.current.get(dragPointerIdRef.current);
      if (dragPointer && dragPointer.down) {
        const dDragX = dragPointer.x - pointerDownStartRef.current.x;
        const dDragY = dragPointer.y - pointerDownStartRef.current.y;
        if (Math.sqrt(dDragX * dDragX + dDragY * dDragY) > 0.05) {
          isDraggingRef.current = true;
          const clampedX = Math.round(THREE.MathUtils.clamp(dragPointer.x, -2.4, 2.4) * 10) / 10;
          const clampedY = Math.round(THREE.MathUtils.clamp(dragPointer.y, -1.5, 1.5) * 10) / 10;
          onMoveEditorNoteRef.current?.(selectedNoteIdRef.current, clampedX, clampedY);
        }
      }
    }

    // Selection gizmo — supports slide child ids "id#i", positioned at the node's own depth.
    const selGizmo = selectionGizmoRef.current;
    if (selGizmo) {
      let placed = false;
      if (isEditorModeRef.current && selectedNoteIdRef.current) {
        const selId = selectedNoteIdRef.current;
        const hashIdx = selId.indexOf('#');
        const base = hashIdx >= 0 ? selId.slice(0, hashIdx) : selId;
        const childIdx = hashIdx >= 0 ? parseInt(selId.slice(hashIdx + 1)) : 0;
        // tap/touch chains are expanded into standalone resolved notes whose id
        // already carries the "#i" suffix — prefer an exact match.
        const exact = hashIdx >= 0 ? notes.find((nn) => nn.id === selId) : undefined;
        const n = exact ?? notes.find((nn) => nn.id === base);
        if (n) {
          let px = n.x, py = n.y, pt = n.timeSec;
          if (!exact && childIdx >= 1 && n.resolvedNodes && n.resolvedNodes[childIdx - 1]) {
            const c = n.resolvedNodes[childIdx - 1];
            px = c.x; py = c.y; pt = c.timeSec;
          }
          const noteScrollDist = getScrollDistance(pt, speedPointsRef.current);
          const gz = JUDGE_Z - (noteScrollDist - curScrollDist) * unitPerSecond;
          selGizmo.position.set(px, py, gz + 0.1);
          selGizmo.visible = true;
          (selGizmo.material as THREE.LineBasicMaterial).opacity = 0.9;
          placed = true;
        }
      }
      if (!placed) selGizmo.visible = false;
    }

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
    let hasNegativeSpeed = false;
    for (const p of sp) { if (p.speed < 0) { hasNegativeSpeed = true; break; } }

    let firstIdx = 0;
    let lastIdx = notes.length;

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
      let minSpeed = 1;
      for (const p of sp) { if (p.speed < minSpeed) minSpeed = p.speed; }
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
    // When negative speed is present we iterate ALL notes every frame, so the
    // cleanup pass is unnecessary — every note's visibility is refreshed each
    // frame by the per-note `vis` check.
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
      lastWindowRef.current = { firstIdx, lastIdx, notes };
    }

    for (let noteIdx = firstIdx; noteIdx < lastIdx; noteIdx++) {
      const note = notes[noteIdx];
      const noteEffectiveColor = note.color || colorHex;

      // ---------- SLIDE ----------
      if (note.type === 'slide') {
        // Cached: avoids rebuilding [head, ...resolvedNodes] every frame.
        const allNodes = getAllNodes(note);
        if (playing && !isEditorModeRef.current) {
          processSlide(note, curTime);
        }
        const sm = ensureSlideMeshes(note, noteEffectiveColor);
        if (!sm) continue;
        const rt = playing && !isEditorModeRef.current ? getSlideRt(note.id, allNodes.length) : slideStateRef.current.get(note.id);

        _slideZs.length = 0;
        for (let i = 0; i < allNodes.length; i++) {
          const nodeScrollDist = getScrollDistance(allNodes[i].timeSec, speedPointsRef.current);
          const z = JUDGE_Z - (nodeScrollDist - curScrollDist) * unitPerSecond;
          _slideZs.push(z);
          const key = `${note.id}#${i}`;
          const judged = judgedNotesRef.current.has(key);
          const nodeRt = rt?.nodes[i];
          const isRed = !!nodeRt && (nodeRt.missLocked || nodeRt.redWarn) && !judged;
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
            nm.group.position.set(allNodes[i].x, allNodes[i].y, z);
            nm.group.scale.set(vScale, vScale, 1);
            // Rotate the node visual (note + cross-section) around its center by
            // the node's own angle. Three's rotation.z is counterclockwise for
            // +, but we want +angle = clockwise (matching the 2D editor), so negate.
            nm.group.rotation.z = -(allNodes[i].angle ?? 0);
            if (nm.proj) nm.proj.rotation.z = -(allNodes[i].angle ?? 0);
            nm.fill.color.set(isRed ? SLIDE_RED : noteEffectiveColor);
            // 内框跟随音符色；外框使用可自定义颜色（不随音符色变化）。
            nm.innerWire?.color.set(isRed ? SLIDE_RED : noteEffectiveColor);
            nm.outerWire?.color.set(defaultSkinOuterColorRef.current);

            // Smooth fade-in animation as note enters the render distance
            const fadeZone = 12;
            const fadeInAlpha = isEditorModeRef.current
              ? 1
              : THREE.MathUtils.clamp((z - spawnLimit) / fadeZone, 0, 1);
            // 皮肤贴图整块显示（不透明）；默认填充保持半透明（defaultFill 标记区分）。
            nm.fill.opacity = nm.fill.map && !nm.fill.userData.defaultFill ? fadeInAlpha : (isRed ? 0.4 : (i === 0 ? 0.2 : 0.26)) * fadeInAlpha;
            // 仅 slide 头节点显示边框：内框跟随音符色，外框使用自定义颜色+透明度。
            if (nm.innerWire) nm.innerWire.opacity = (i === 0 && defaultSkinInnerWidthRef.current > 0) ? 0.85 * fadeInAlpha : 0;
            if (nm.outerWire) nm.outerWire.opacity = (i === 0 && defaultSkinOuterWidthRef.current > 0) ? defaultSkinOuterAlphaRef.current * fadeInAlpha : 0;
          }
          if (nm.proj && nm.projMat) {
            const timeToHitMs = (allNodes[i].timeSec - curTime) * 1000;
            const leadMs = projectionLeadRef.current;
            // Same projection-toggle rule as tap/touch above.
            const projEnabled = effectTogglesRef.current.projection !== false;
            const po = !projEnabled || leadMs <= 0 || timeToHitMs < 0 || judged
              ? 0
              : THREE.MathUtils.clamp(1 - timeToHitMs / leadMs, 0, 0.95);
            nm.proj.visible = po > 0;
            nm.proj.position.set(allNodes[i].x, allNodes[i].y, JUDGE_Z + 0.01);
            nm.proj.scale.set(vScale, vScale, 1);
            nm.projMat.color.set(noteEffectiveColor);
            nm.projMat.opacity = po;
          }
        }

        // Pipes between consecutive nodes.
        // Editor + Auto-Play are always clipped. During manual play, contact makes the
        // clip engage immediately; leaving the cross-section releases it smoothly.
        const pipeFrameNow = performance.now();
        for (let i = 0; i < sm.pipes.length; i++) {
          const nextKey = `${note.id}#${i + 1}`;
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
          } else if (lowQualityModeRef.current) {
            // Low quality: binary on/off — skip the smooth exp release entirely.
            pipe.clipAmount = 0;
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
          let midSpeed = false;
          for (const p of sp) {
            if (p.timeSec > tA && p.timeSec < tB) { midSpeed = true; break; }
          }
          const scrollDistA = midSpeed ? getScrollDistance(tA, sp) : 0;
          const zAt = midSpeed
            ? (tauN: number) =>
                (scrollDistA - getScrollDistance(tA + tauN * segDur, sp)) * unitPerSecond
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
          let geoKey =
            `${angleStart.toFixed(4)}|${angleEnd.toFixed(4)}|${easing}|` +
            `${endX.toFixed(3)}|${endY.toFixed(3)}|${endZ.toFixed(3)}|${SLIDE_PIPE_HALF * vScale}`;
          if (midSpeed) {
            // Signature of the interior Z profile so different speed curves in the
            // segment get distinct cached geometries (4 interior samples suffice).
            const prof: string[] = [];
            for (let s = 1; s <= 4; s++) {
              prof.push(
                ((scrollDistA - getScrollDistance(tA + (s / 5) * segDur, sp)) * unitPerSecond).toFixed(3),
              );
            }
            geoKey += `|P:${prof.join(',')}`;
          }
          if (pipe.geoKey !== geoKey) {
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
            pipe.geoKey = geoKey;
          }
          pipe.mesh.position.set(ax, ay, az);
          pipe.mesh.scale.set(1, 1, 1);
          pipe.mesh.quaternion.identity();
          pipe.mesh.visible = true;
          // Cache world midpoint for the ultra light pool.
          pipe.mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);

          const nodeRt = rt?.nodes[i + 1];
          const isRed = !!nodeRt && (nodeRt.missLocked || nodeRt.redWarn) && !nextJudged;
          pipe.mat.color.set(isRed ? SLIDE_RED : noteEffectiveColor);
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
      const noteScrollDist = getScrollDistance(note.timeSec, speedPointsRef.current);
      const nz = JUDGE_Z - (noteScrollDist - curScrollDist) * unitPerSecond;
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
      if (vis) {
        if (!entry) {
          const ng = note.type === 'tap' ? mkTap(noteEffectiveColor) : mkTouch(noteEffectiveColor);
          const pg = mkProj(note.type, noteEffectiveColor); pg.position.set(note.x, note.y, JUDGE_Z + 0.01);
          scene.add(ng); scene.add(pg);
          entry = { group: ng, projectionGroup: pg }; noteMeshesRef.current.set(note.id, entry);
          // (Ultra note-light handled by ultraLightPoolRef — see render loop)
        }
        entry.group.position.set(note.x, note.y, nz);
        entry.group.scale.set(vScale, vScale, 1);
        entry.group.rotation.z = -(note.angle ?? 0);
        entry.group.visible = true;

        // Smooth fade-in animation as note enters the render distance
        const fadeZone = 12;
        const fadeInAlpha = isEditorModeRef.current
          ? 1
          : THREE.MathUtils.clamp((nz - spawnLimit) / fadeZone, 0, 1);
        entry.group.children.forEach((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            if (child.userData.isBorder === 'inner') {
              // 内框：颜色恒等于音符色，仅当宽度 > 0 时显示。
              child.material.color.set(noteEffectiveColor);
              child.material.opacity = defaultSkinInnerWidthRef.current > 0 ? 0.85 * fadeInAlpha : 0;
            } else if (child.userData.isBorder === 'outer') {
              // 外框：使用可自定义颜色与透明度，仅当宽度 > 0 时显示。
              child.material.color.set(defaultSkinOuterColorRef.current);
              child.material.opacity = defaultSkinOuterWidthRef.current > 0 ? defaultSkinOuterAlphaRef.current * fadeInAlpha : 0;
            } else {
              child.material.color.set(noteEffectiveColor);
              // 皮肤贴图整块显示（不透明）；默认填充保持半透明（defaultFill 标记区分）。
              child.material.opacity = child.material.map && !child.userData.defaultFill ? fadeInAlpha : (note.type === 'tap' ? 0.18 : 0.22) * fadeInAlpha;
            }
          }
          if (child instanceof THREE.Line && child.material instanceof THREE.LineBasicMaterial) {
            child.material.color.set(noteEffectiveColor);
            child.material.opacity = fadeInAlpha;
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
        entry.projectionGroup.position.set(note.x, note.y, JUDGE_Z + 0.01);
        entry.projectionGroup.scale.set(vScale, vScale, 1);
        entry.projectionGroup.rotation.z = -(note.angle ?? 0);
        entry.projectionGroup.children.forEach((c) => {
          const material = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | null;
          if (!material) return;
          // 判定框（投影引导）颜色恒等于音符色，不可修改，仅粗细可调。
          material.color.set(noteEffectiveColor);
          material.opacity = po;
        });
      } else if (entry) { entry.group.visible = false; entry.projectionGroup.visible = false; }

      if (playing && !judged && !isEditorModeRef.current) {
        if (autoPlayRef.current && note.type === 'tap') {
          const dt = (curTime - note.timeSec) * 1000;
          // AutoPlay: judge as soon as note has passed the plane (dt >= 0). The narrow
          // 15ms window used previously would miss entirely on lower-framerate devices.
          if (dt >= 0) { commitJudgement(note, 'S-Perfect', dt); continue; }
        }
        if (note.type === 'touch') {
          const dt = (curTime - note.timeSec) * 1000;
          const inside = isAnyPointerInside(note.x, note.y, TOUCH_HIT_HALF);
          let track = touchTrackRef.current.get(note.id);
          if (!track) { track = { lastInsideTime: null, arrivalChecked: false }; touchTrackRef.current.set(note.id, track); }
          if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && inside) track.lastInsideTime = curTime;
          // AutoPlay: judge as soon as note has passed the plane (dt >= 0). The narrow
          // 20ms window used previously would miss entirely on lower-framerate devices.
          if (autoPlayRef.current && dt >= 0) { commitJudgement(note, 'S-Perfect', dt); continue; }
          if (dt >= 0) {
            if (!track.arrivalChecked) {
              track.arrivalChecked = true;
              if (inside) { commitJudgement(note, 'S-Perfect', dt); continue; }
              if (track.lastInsideTime !== null) {
                const earlyDt = (track.lastInsideTime - note.timeSec) * 1000;
                const j = evaluateJudgement(earlyDt); if (j) { commitJudgement(note, j, earlyDt); continue; }
              }
            }
            if (inside && dt <= HIT_WINDOW_MS) { const j = evaluateJudgement(dt); if (j) { commitJudgement(note, j, dt); continue; } }
            if (dt > HIT_WINDOW_MS) commitJudgement(note, 'Miss', dt);
          }
        } else {
          const dt = (curTime - note.timeSec) * 1000;
          if (dt > HIT_WINDOW_MS) commitJudgement(note, 'Miss', dt);
        }
      }
    }

    // 300ms judgement feedback bursts
    const now = performance.now();

    // Ultra mode: drive the PointLight pool from the closest-to-judge-plane
    // visible notes. We reuse the noteMeshesRef map — entries that are
    // visible=true with group.visible === true are currently on screen.
    // Pick the 8 smallest |z| (closest to judge plane) and assign one
    // pool light each; park the rest far away with intensity 0.
    const pool = ultraLightPoolRef.current;
    if (pool.length > 0) {
      // Collect candidates: { z, x, y, color }
      const candidates: Array<{ z: number; x: number; y: number; color: THREE.Color }> = [];
      noteMeshesRef.current.forEach((entry) => {
        if (!entry.group.visible) return;
        // Read current world position (group.position is local; group has no parent transform).
        const p = entry.group.position;
        // Read fill mesh color (first Mesh child).
        let color: THREE.Color | null = null;
        entry.group.children.forEach((c) => {
          if (color) return;
          if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) {
            color = c.material.color;
          }
        });
        if (color) candidates.push({ z: p.z, x: p.x, y: p.y, color });
      });
      // Slide nodes also contribute — iterate slideMeshesRef.
      slideMeshesRef.current.forEach((sm) => {
        sm.nodes.forEach((nd) => {
          if (!nd.group.visible) return;
          const p = nd.group.position;
          candidates.push({ z: p.z, x: p.x, y: p.y, color: nd.fill.color });
        });
        // Slide PIPES also contribute light candidates — a long arc segment
        // is itself a colored body and should illuminate the walls along its
        // length. Use the pipe's midpoint (position + quat * (0, len/2, 0)).
        sm.pipes.forEach((pp) => {
          if (!pp.mesh.visible) return;
          _vLightMid.copy(pp.mid);
          const mat = pp.mat as THREE.MeshBasicMaterial;
          candidates.push({ z: _vLightMid.z, x: _vLightMid.x, y: _vLightMid.y, color: mat.color });
        });
      });
      // Sort by |z| ascending — closest to judge plane first.
      candidates.sort((a, b) => Math.abs(a.z) - Math.abs(b.z));
      // Assign pool lights.
      for (let i = 0; i < pool.length; i++) {
        const pl = pool[i];
        const c = candidates[i];
        if (c) {
          pl.position.set(c.x, c.y, c.z);
          pl.color.copy(c.color);
          // Brighter when closer to judge plane.
          pl.intensity = Math.max(0, 4.5 - Math.abs(c.z) * 0.18);
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
        scene.remove(b.group);
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
      // Compute instantaneous chart speed at current time
      let chartSpeed = 1;
      for (const p of speedPointsRef.current) {
        if (p.timeSec <= curTime) chartSpeed = p.speed;
        else break;
      }
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
        scene.remove(s.points);
        s.points.geometry.dispose();
        (s.points.material as THREE.Material).dispose();
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
        setTimeout(() => onSongEndRef.current?.(), 800);
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
  };

  // ====== Quick-Create gesture dispatcher =======================================
  /** Called on pointer DOWN in quick-create mode. Sets up a new QCTrack and
   *  does NOT dispatch any notes yet (note decisions happen on move / up).
   *  The existing place-tap/touch/slide flows are bypassed entirely for this
   *  pointer until release so that selection / move logic never kicks in. */
  const qcOnDown = (track: QCTrack) => {
    // No dispatch on press — we need the release to classify. But we DO
    // want to "eat" the event so handlePointerInteraction doesn't try to
    // place a single tap note or select anything.
    void track;
  };

  /** Called on pointer MOVE while in quick-create mode and a press is active.
   *  Emits touch-stream notes in real-time as the finger crosses grid lines,
   *  and appends slide nodes for slide-classified gestures. */
  const qcOnMove = (track: QCTrack, nowBeat: number) => {
    const totalHoldBeats = nowBeat - track.pressBeat;

    // ----- Decide the gesture ONCE, at the end of the first beat, and lock it.
    //  Per spec: SLIDE vs TOUCH is determined ONLY by the displacement during
    //  the first beat after pressing; later movement does not change it.
    if (track.gesture === 'undecided') {
      if (totalHoldBeats >= QC_FIRST_BEAT) {
        let maxDisp = 0;
        for (const s of track.trajectory) {
          maxDisp = Math.max(maxDisp, Math.hypot(s.x - track.pressX, s.y - track.pressY));
        }
        track.gesture = maxDisp > QC_STATIC_MOVE_PX ? 'touch-stream' : 'slide';
      } else {
        // Still within the first beat: nothing to emit yet (could become a tap).
        return;
      }
    }

    // ----- TOUCH stream: one touch note per snap-step, position follows finger.
    if (track.gesture === 'touch-stream') {
      const step = qcStep();
      const startBeat = track.lastPlacedBeat === null
        ? qcSnapBeat(track.pressBeat)
        : track.lastPlacedBeat + step;
      const endBeat = qcSnapBeat(nowBeat);
      const notesOut: Array<{ beat: number; x: number; y: number }> = [];
      // Sample the finger position from the recorded trajectory at each step
      // beat so the notes truly follow the finger (not piled at the cursor).
      for (let b = startBeat; b <= endBeat + 1e-6; b = +(b + step).toFixed(6)) {
        const sb = qcSnapBeat(b);
        const p = qcSampleAtBeat(track.trajectory, sb);
        notesOut.push({ beat: sb, x: roundXY(p.x), y: roundXY(p.y) });
      }
      if (notesOut.length > 0) {
        track.lastPlacedBeat = notesOut[notesOut.length - 1].beat;
        qcDispatchDelta({ touches: notesOut, suppressSelection: true });
      }
      return;
    }

    // ----- SLIDE: head at press beat, then one node per beat, position follows
    //  the finger trajectory (sampled at each node beat). The whole node list
    //  is recomputed every move so earlier nodes update as the finger moves.
    if (track.gesture === 'slide') {
      const headSnap = qcSnapBeat(track.pressBeat);
      const nodes: Array<{ beat: number; x: number; y: number }> = [];
      for (let n = 1; ; n++) {
        const nb = track.pressBeat + n; // one node per beat from press time
        if (nb > nowBeat + 1e-6) break;
        const sb = qcSnapBeat(nb);
        if (sb <= headSnap + 1e-6) continue;
        const p = qcSampleAtBeat(track.trajectory, sb);
        nodes.push({ beat: sb, x: roundXY(p.x), y: roundXY(p.y) });
      }
      qcDispatchDelta({
        slides: [{
          headBeat: headSnap,
          headX: roundXY(track.pressX),
          headY: roundXY(track.pressY),
          nodes,
        }],
        suppressSelection: true,
      });
      return;
    }
    // 'undecided' (within first beat) or 'tap' (tap only fires on release).
  };

  const roundXY = (v: number) => Math.round(THREE.MathUtils.clamp(v, -2.4, 2.4) * 10) / 10;

  /** Called on pointer UP in quick-create mode. Finalises classification and
   *  emits any pending notes (tap / slide tail). */
  const qcOnUp = (track: QCTrack) => {
    const last = track.trajectory[track.trajectory.length - 1];
    const totalHoldBeats = last.beat - track.pressBeat;

    // ----- Final classification if still undecided (released within first beat) -----
    if (track.gesture === 'undecided') {
      let maxDisp = 0;
      for (const s of track.trajectory) {
        maxDisp = Math.max(maxDisp, Math.hypot(s.x - track.pressX, s.y - track.pressY));
      }
      if (totalHoldBeats < QC_FIRST_BEAT && maxDisp < QC_STATIC_MOVE_PX * 2) {
        track.gesture = 'tap'; // quick press → release: a single TAP
      } else {
        // Held ≥ 1 beat (or moved a lot) but the move handler never locked it
        // (e.g. released exactly at ~1 beat). Decide now from whole-trajectory
        // displacement, then fall through to emit the gesture's notes.
        track.gesture = maxDisp > QC_STATIC_MOVE_PX ? 'touch-stream' : 'slide';
      }
    }

    switch (track.gesture) {
      case 'tap': {
        // Single beat-snapped TAP at press position & press time.
        qcDispatchDelta({
          taps: [{ beat: qcSnapBeat(track.pressBeat), x: roundXY(track.pressX), y: roundXY(track.pressY) }],
          suppressSelection: true,
        });
        return;
      }
      case 'slide': {
        // Head at press beat; one node per beat up to release time, each node's
        // position sampled from the finger trajectory (follows the finger).
        const headSnap = qcSnapBeat(track.pressBeat);
        const nodes: Array<{ beat: number; x: number; y: number }> = [];
        for (let n = 1; ; n++) {
          const nb = track.pressBeat + n;
          if (nb > last.beat + 1e-6) break;
          const sb = qcSnapBeat(nb);
          if (sb <= headSnap + 1e-6) continue;
          const p = qcSampleAtBeat(track.trajectory, sb);
          nodes.push({ beat: sb, x: roundXY(p.x), y: roundXY(p.y) });
        }
        qcDispatchDelta({
          slides: [{
            headBeat: headSnap,
            headX: roundXY(track.pressX),
            headY: roundXY(track.pressY),
            nodes,
          }],
          suppressSelection: true,
        });
        return;
      }
      case 'touch-stream': {
        // Final catch-up: emit touches for the remaining snap steps up to the
        // release beat, sampling finger positions from the trajectory.
        const step = qcStep();
        const startBeat = track.lastPlacedBeat === null
          ? qcSnapBeat(track.pressBeat)
          : track.lastPlacedBeat + step;
        const endBeat = qcSnapBeat(last.beat);
        if (startBeat <= endBeat + 1e-6) {
          const notesOut: Array<{ beat: number; x: number; y: number }> = [];
          for (let b = startBeat; b <= endBeat + 1e-6; b = +(b + step).toFixed(6)) {
            const sb = qcSnapBeat(b);
            const p = qcSampleAtBeat(track.trajectory, sb);
            notesOut.push({ beat: sb, x: roundXY(p.x), y: roundXY(p.y) });
          }
          if (notesOut.length > 0) {
            qcDispatchDelta({ touches: notesOut, suppressSelection: true });
          }
        }
        return;
      }
    }
  };

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
          qcOnDown(track);
          // capture the pointer so drags outside the viewport still produce
          // onpointerup events on this element.
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          e.preventDefault();
          return;
        }
        handlePointerInteraction(p.x, p.y);
      }}
      onPointerMove={(e) => {
        const existing = pointersRef.current.get(e.pointerId);
        const down = existing ? existing.down : false;
        updatePointer(e.pointerId, e.clientX, e.clientY, down, e.pointerType);
        const inQC = isEditorModeRef.current && activeToolRef.current === 'quick-create';
        if (!inQC) return;
        const track = qcTracksRef.current.get(e.pointerId);
        const p = pointersRef.current.get(e.pointerId);
        if (!track || !p) return;
        const playing = isPlayingRef.current && !isPausedRef.current;
        const tSec = playing ? globalAudio.getCurrentTime() : gameTimeRef.current;
        const beat = chartTimeToBeat(tSec);
        track.trajectory.push({ tSec, beat, x: p.x, y: p.y });
        // Keep trajectory from growing unbounded during long presses.
        if (track.trajectory.length > 120) track.trajectory.splice(0, track.trajectory.length - 120);
        qcOnMove(track, beat);
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
          if (p) track.trajectory.push({ tSec, beat, x: p.x, y: p.y });
          qcOnUp(track);
          qcTracksRef.current.delete(e.pointerId);
        }
        removePointer(e.pointerId);
      }}
      onPointerCancel={(e) => {
        qcTracksRef.current.delete(e.pointerId);
        removePointer(e.pointerId);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') {
          qcTracksRef.current.delete(e.pointerId);
          removePointer(e.pointerId);
        }
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
    if (prev[key] !== next[key]) return false;
  }
  return true;
};

export const GameCanvas = React.memo(GameCanvasImpl, arePropsEqual);
