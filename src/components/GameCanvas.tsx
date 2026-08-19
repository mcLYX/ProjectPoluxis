import React, { useEffect, useRef, useMemo, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ChartData, ResolvedNote, ResolvedEvent, JudgementFeedback, NoteType, QualityMode, EasingType, SkinTextureSet, NOTE_X_RANGE, NOTE_Y_RANGE } from '../types/game';
import { evaluateJudgement } from '../utils/scoring';
import { resolveChart, resolveEvents, extractSpeedPoints, getScrollDistance, secondsToBeatMultiBpm } from '../utils/beatTime';
import { EASING_FNS } from '../utils/easing';
import { WORLD_UNITS_PER_SECOND, withinHitWindow } from '../systems/judge';
import { expandRing, type RingPt } from '../systems/geometry';
import { TAP_SIZE, TOUCH_SIZE, SLIDE_SIZE, SLIDE_HALF, BLOOM_LAYER, JUDGE_Z, SLIDE_HIT_HALF, HIT_WINDOW_MS, TAP_RING_OUTER, TOUCH_RING_OUTER, SLIDE_RING_OUTER } from '../gameplayConstants';
import { createSceneGroups, disposeSceneGroups, type SceneGroups } from '../scenes/sceneGroups';
import { usePropRefs } from '../hooks/usePropRefs';
import type { JudgeSystemContext } from '../hooks/judgeContext';
import { useJudgeSystem } from '../hooks/useJudgeSystem';
import { useNoteEffects } from '../hooks/useNoteEffects';
import { useEditorGestures } from '../hooks/useEditorGestures';

import { globalAudio } from '../audio/AudioManager';
import { liveDragStore } from '../liveDragStore';

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
  /** 多选集合（note base id；可能含子节点 id#i）。用于在 3D 视图为所有
   *  选中的 note 绘制选中框（金色）。 */
  selectedNoteIds?: string[];
  /** 是否处于多选模式（含 Ctrl 临时）。为 true 时绘制多选框。 */
  isMultiSelect?: boolean;
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
  defaultSkinInnerEnabled?: boolean;
  defaultSkinOuterEnabled?: boolean;
  defaultSkinOuterWidth?: number;
  defaultSkinOuterColor?: string;
  defaultSkinOuterAlpha?: number;
  defaultSkinJudgeWidth?: number;
}

// 共享游戏常数（TAP_SIZE/SLIDE_HALF/BLOOM_LAYER/JUDGE_Z/判定窗口/ring 外观等）
// 已统一收敛到 ../gameplayConstants，此处仅保留本地派生项。
// Pipe cross-section is a diamond slightly smaller than the slide node itself.
const SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
const TOUCH_HIT_HALF = 1.0;
const SLIDE_RED = '#ff0000';

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
export interface SlideRt {
  boundPointerIds: Set<number>;
  nodes: SlideNodeRt[];
}

interface SlideMeshSet {
  nodes: Array<{
    group: THREE.Group;
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
    /** Geometry cache key; rebuilt only when the segment shape actually changes. */
    geoKey: string | null;
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
function liveMoveResolvedNote(noteIndex: Map<string, ResolvedNote>, id: string, x: number, y: number): void {
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
  viewportActive = true,
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
  selectedNoteIds,
  isMultiSelect = false,
  snapSubdivision = 0.25,
  onJudgement,
  onSongEnd,
  onSelectEditorNote,
  onMoveEditorNote,
  onPlaceEditorNote,
  onApplyQuickCreateDelta,
  skinTextures,
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
  // 命名场景图分组句柄（setup 内创建并写入，运行时 ensure*/spawnBurst 经此挂载）。
  const groupsRef = useRef<SceneGroups | null>(null);
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
  // 多选 gizmo 池：为每个选中的 note（头节点）绘制一个金色选中框。
  const multiGizmosRef = useRef<THREE.Line[]>([]);
  const selectedNoteIdsRef = useRef<string[]>(selectedNoteIds ?? []);
  useEffect(() => { selectedNoteIdsRef.current = selectedNoteIds ?? []; }, [selectedNoteIds]);
  const isMultiSelectRef = useRef(isMultiSelect);
  useEffect(() => { isMultiSelectRef.current = isMultiSelect; }, [isMultiSelect]);
  const activeBurstsRef = useRef<Array<{
    group: THREE.Group;
    startTime: number;
    duration: number;
    scaleTarget: number;
    baseScale: number;
  }>>([]);

  const resolvedNotes = useMemo(() => resolveChart(chart), [chart]);
  const resolvedRef = useRef(resolvedNotes);
  // id → ResolvedNote 索引（P2-6）：把编辑器 gizmo 每帧的 O(N) notes.find 改为 O(1) 查表。
  // 仅在 resolvedNotes 变化时重建；in-place 编辑改的是同一 note 对象引用，Map 取到的是最新值。
  const noteIndexRef = useRef<Map<string, ResolvedNote>>(new Map());
  useEffect(() => {
    resolvedRef.current = resolvedNotes;
    const idx = new Map<string, ResolvedNote>();
    for (const n of resolvedNotes) idx.set(n.id, n);
    noteIndexRef.current = idx;
  }, [resolvedNotes]);

  const resolvedEvents = useMemo(() => resolveEvents(chart), [chart]);
  const eventsRef = useRef(resolvedEvents);
  useEffect(() => { eventsRef.current = resolvedEvents; }, [resolvedEvents]);

  // Pre-computed speed change points for scroll distance calculation.
  // This ensures note spacing is visually correct BEFORE a speed change
  // reaches the judge line (no teleportation artifacts).
  const speedPoints = useMemo(() => extractSpeedPoints(chart), [chart]);
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

  // R4-3：批量同步纯 prop→ref 镜像（带副作用的 skinTextures/defaultSkin/effectToggles 仍保留独立 effect）。
  usePropRefs(
    {
      isPlaying, isPaused, gameTime, speedMultiplier, projectionLeadMs, noteRenderDistance, noteSizeScale,
      lowQuality: qualityMode === 'low', antialias, renderScale, allowBloom, allowParticles,
      allowDynamicLighting, allowHitEffects, autoPlay, isEditorMode, activeEditorTool, snapSubdivision,
      selectedNoteId, chart, speedPoints,
      onSelectEditorNote, onMoveEditorNote, onPlaceEditorNote, onApplyQuickCreateDelta, onJudgement, onSongEnd,
    },
    {
      isPlaying: isPlayingRef, isPaused: isPausedRef, gameTime: gameTimeRef, speedMultiplier: speedRef,
      projectionLeadMs: projectionLeadRef, noteRenderDistance: renderDistRef, noteSizeScale: sizeScaleRef,
      lowQuality: lowQualityModeRef, antialias: antialiasRef, renderScale: renderScaleRef, allowBloom: allowBloomRef,
      allowParticles: allowParticlesRef, allowDynamicLighting: allowDynamicLightingRef, allowHitEffects: allowHitEffectsRef,
      autoPlay: autoPlayRef, isEditorMode: isEditorModeRef, activeEditorTool: activeToolRef, snapSubdivision: snapSubdivisionRef,
      selectedNoteId: selectedNoteIdRef, chart: chartRef, speedPoints: speedPointsRef,
      onSelectEditorNote: onSelectEditorNoteRef, onMoveEditorNote: onMoveEditorNoteRef, onPlaceEditorNote: onPlaceEditorNoteRef,
      onApplyQuickCreateDelta: onApplyQuickCreateDeltaRef, onJudgement: onJudgementRef, onSongEnd: onSongEndRef,
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
    activeBurstsRef.current.forEach((b) => { b.group.removeFromParent(); });
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

  // Pause/resume the render loop when the editor switches between 3D and 2D
  // view. While inactive the loop self-stops (see `loop` in the setup effect);
  // flipping back to active re-arms it. The WebGL scene + meshes are preserved
  // so the switch-back is instant instead of rebuilding everything.
  useEffect(() => {
    viewportActiveRef.current = viewportActive;
    if (viewportActive) startLoopRef.current();
  }, [viewportActive]);

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
    let scheduled = false;
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // 合并高频 RO 回调到每帧一次，避免持续 resize 时反复读取 layout（P2-10）。
      requestAnimationFrame(() => {
        scheduled = false;
        const visible = el.clientWidth > 0 && el.clientHeight > 0;
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
    let animId = 0;
    // Self-scheduling render loop. When the viewport is inactive (editor in 2D
    // view) the loop stops scheduling itself entirely — the WebGL scene, note
    // meshes and all refs stay alive, just no tick/render runs. The
    // `startLoopRef` closure re-arms it when the viewport becomes active again.
    const loop = () => {
      if (!viewportActiveRef.current) return;
      animId = requestAnimationFrame(loop);
      tick();
    };
    startLoopRef.current = () => {
      if (viewportActiveRef.current) animId = requestAnimationFrame(loop);
    };
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
        particleFieldRef.current.removeFromParent();
        particleFieldRef.current.geometry.dispose();
        (particleFieldRef.current.material as THREE.Material).dispose();
        particleFieldRef.current = null;
        particleVelRef.current = null;
      }
      shatterSystemsRef.current.forEach((s) => {
        s.points.removeFromParent();
        s.points.geometry.dispose();
        (s.points.material as THREE.Material).dispose();
      });
      shatterSystemsRef.current.length = 0;
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
  }, [chart.metadata.bgScheme.accentColor, chart.metadata.bgScheme.gradientStart, chart.metadata.bgScheme.gradientEnd, chart.metadata.noteColor, chart.metadata.effectToggles?.bloom, chart.metadata.effectToggles?.particles, chart.metadata.effectToggles?.gridLines, chart.metadata.effectToggles?.projection, qualityMode, antialias, renderScale, allowBloom, allowParticles, allowDynamicLighting, allowHitEffects, vpKey]);

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
      activeToolRef.current = type === 'tap' ? 'place-tap' : 'place-touch';
      onPlaceEditorNoteRef.current?.(x, y);
      activeToolRef.current = oldTool;
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
  const judgeCtx: JudgeSystemContext = {
    sceneRef, groupsRef, sizeScaleRef, defaultSkinJudgeWidthRef, activeBurstsRef,
    allowHitEffectsRef, speedRef, particleSpriteRef, shatterSystemsRef,
    isEditorModeRef, judgedNotesRef, judgedCountRef, chartRef, currentNoteColorRef,
    onJudgementRef, slideStateRef, playStartTimeRef, pointersRef, autoPlayRef,
    resolvedRef, isPlayingRef, isPausedRef, gameTimeRef, activeToolRef,
    onPlaceEditorNoteRef, onSelectEditorNoteRef, isDraggingRef,
    getAllNodes, makeRingMesh, pickProj, projSize, chartTimeToBeat,
  };
  const spawnBurst = useNoteEffects(judgeCtx);
  const { commitJudgement, getSlideRt, processSlide } = useJudgeSystem(judgeCtx, spawnBurst);
  const handlePointerInteraction = useEditorGestures(judgeCtx, commitJudgement);

  const ensureSlideMeshes = (note: ResolvedNote, colorHex: string): SlideMeshSet | null => {
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
        geoKey: null,
        mid: new THREE.Vector3(),
      });
    }
    sm = { nodes, pipes };
    slideMeshesRef.current.set(note.id, sm);
    return sm;
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
    const unitPerSecond = WORLD_UNITS_PER_SECOND * globalSpeed; // scale: 1 "1x-second" = 36 world units * globalSpeed
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
    if (isEditorModeRef.current && selectedNoteIdRef.current && dragPointerIdRef.current !== null && pointerDownStartRef.current) {
      const dragPointer = pointersRef.current.get(dragPointerIdRef.current);
      if (dragPointer && dragPointer.down) {
        const dDragX = dragPointer.x - pointerDownStartRef.current.x;
        const dDragY = dragPointer.y - pointerDownStartRef.current.y;
        if (Math.sqrt(dDragX * dDragX + dDragY * dDragY) > DRAG_START_THRESHOLD) {
          isDraggingRef.current = true;
          const clampedX = Math.round(THREE.MathUtils.clamp(dragPointer.x, -NOTE_X_RANGE, NOTE_X_RANGE) * 10) / 10;
          const clampedY = Math.round(THREE.MathUtils.clamp(dragPointer.y, -NOTE_Y_RANGE, NOTE_Y_RANGE) * 10) / 10;
          // Live-follow: mutate the dragged note's resolved position directly so
          // the windowed render loop below places its mesh correctly THIS frame.
          // The authoritative React commit happens ONLY on pointer release (the
          // dragFinalCommitRef block below) — committing every frame would
          // re-resolve the whole ~2000-note chart through React state and saturate
          // the main thread (single-digit FPS during fast drags, even on flagship
          // Android). The mesh still follows the pointer perfectly every frame via
          // this live override, so the drag looks smooth.
          liveMoveResolvedNote(noteIndexRef.current, selectedNoteIdRef.current, clampedX, clampedY);
          dragLiveXRef.current = clampedX;
          dragLiveYRef.current = clampedY;
          // Push the live position to the editor side panel so its x/y inputs
          // update in real time during the drag. This only re-renders the panel
          // (it subscribes to the store); it does NOT touch React chart state or
          // re-render this canvas. Dedup inside the store keeps notifications to
          // one per visible grid-step change.
          liveDragStore.set({ id: selectedNoteIdRef.current, x: clampedX, y: clampedY });
        }
      }
    }

    // Final commit after the drag pointer is released — guarantees the last
    // live position is persisted to React state once (the only commit during a
    // drag, so the full chart is never re-resolved mid-move).
    if (dragFinalCommitRef.current && selectedNoteIdRef.current) {
      dragFinalCommitRef.current = false;
      if (!Number.isNaN(dragLiveXRef.current)) {
        onMoveEditorNoteRef.current?.(selectedNoteIdRef.current, dragLiveXRef.current, dragLiveYRef.current);
      }
      // Drop the live override now that the authoritative position is committed
      // to React state; the panel will show the committed value from `chart`.
      liveDragStore.clear();
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
        const exact = hashIdx >= 0 ? noteIndexRef.current.get(selId) : undefined;
        const n = exact ?? noteIndexRef.current.get(base);
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

    // Multi-select gizmos: gold outline at each EXACTLY selected unit
    // (head id or child id "id#i"), independent selection. Only editor mode
    // + multi-select mode (so a single focused note doesn't get a double box).
    const multiGizmos = multiGizmosRef.current;
    const multiSel = selectedNoteIdsRef.current;
    let mi = 0;
    if (multiGizmos.length > 0 && isEditorModeRef.current && isMultiSelectRef.current && multiSel.length > 0) {
      for (const selId of multiSel) {
        // 焦点 note 由单选 gizmo 绘制，避免双框重叠。
        if (selId === selectedNoteIdRef.current) continue;
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
        const noteScrollDist = getScrollDistance(pt, speedPointsRef.current);
        const gz = JUDGE_Z - (noteScrollDist - curScrollDist) * unitPerSecond;
        const g = multiGizmos[mi++];
        g.position.set(px, py, gz + 0.1);
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
            nm.proj.position.set(allNodes[i].x, allNodes[i].y, JUDGE_Z + 0.01);
            nm.proj.scale.set(vScale, vScale, 1);
            nm.projMat.color.set(noteEffectiveColor);
            nm.projMat.opacity = po;
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
          groupsRef.current?.gameplay.add(ng); groupsRef.current?.gameplay.add(pg);
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
          // 内/外框为 Line（默认皮肤描边）或旧式 Mesh（兼容），统一按 isBorder 处理。
          if (child.userData.isBorder === 'inner') {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
              const m = child.material;
              if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.LineBasicMaterial) {
                // 内框：颜色恒等于音符色，由开关控制显示。
                m.color.set(noteEffectiveColor);
                m.opacity = defaultSkinInnerEnabledRef.current ? 0.85 * fadeInAlpha : 0;
              }
            }
          } else if (child.userData.isBorder === 'outer') {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
              const m = child.material;
              if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.LineBasicMaterial) {
                // 外框：使用可自定义颜色与透明度，由开关控制显示。
                m.color.set(defaultSkinOuterColorRef.current);
                m.opacity = defaultSkinOuterEnabledRef.current ? defaultSkinOuterAlphaRef.current * fadeInAlpha : 0;
              }
            }
          } else if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            child.material.color.set(noteEffectiveColor);
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
          if (withinHitWindow(dt, HIT_WINDOW_MS) && inside) track.lastInsideTime = curTime;
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
        // Read the note's own color. The FIRST Mesh child is now the OUTER border
        // (soft-texture ring) whose color is the customizable `defaultSkinOuterColor`
        // — using it would light the walls with the outer-border color instead of
        // the note color. Prefer the INNER border (color always tracks the note
        // color every frame), then fall back to the fill mesh / skin texture.
        let color: THREE.Color | null = null;
        for (const c of entry.group.children) {
          if (c.userData.isBorder === 'inner') {
            if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) {
              color = c.material.color;
              break;
            }
            if (c instanceof THREE.Line && c.material instanceof THREE.LineBasicMaterial) {
              color = c.material.color;
              break;
            }
          }
        }
        if (!color) {
          entry.group.children.forEach((c) => {
            if (color) return;
            if (c.userData.isBorder === 'outer') return;
            if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) {
              color = c.material.color;
            }
          });
        }
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
        b.group.removeFromParent();
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
        s.points.removeFromParent();
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
    // quality 派生 props（qualityMode/antialias/allow*/renderScale）为低频稳定项，
    // 仅设置弹窗变更（R4-6 起经 qualityStore 驱动），此处浅比较已正确避免误重渲。
    if (prev[key] !== next[key]) return false;
  }
  return true;
};

export const GameCanvas = React.memo(GameCanvasImpl, arePropsEqual);
