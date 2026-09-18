/**
 * GameCanvas2D — 2D Canvas 渲染器，用于画质档 'lite' 时替代 Three.js 3D 场景。
 *
 * 目的：让「现代浏览器但 3D/WebGL 性能差」的设备也能流畅游玩——完全不触碰 WebGL，
 * 用一块 2D canvas 画出音符流（透视投影数学与 3D 场景逐行等价）。
 *
 * 移植来源：Lite 版 `src/lite/components/08-renderer.js`（绘制/投影）与
 * `09-engine.js`（判定/输入/主循环）。差异：
 *  - 纯逻辑（谱面解析/计分）复用完整版的共享模块 `utils/beatTime` + `utils/scoring`
 *    + `shared/gameplaySpec`，不再自带一份。
 *  - 帧时间直接读 `globalAudio.getCurrentTime()`（与 GameCanvas 一致，保证音画同步）。
 *  - 判定结果经 `onJudgement` 回传 App，复用其既有的 stats/HUD 管线。
 *  - angle 由完整版 `resolveChart` 输出为 **弧度**，故绘制时直接 `ctx.rotate(angle)`。
 *
 * 设计约束：所有逐帧状态放在闭包/ref 里，绝不触发 React 重渲染（与 GameCanvas 同范式）。
 * 性能：DPR 固定为 1（低负载优先），指针移动走每帧合并缓冲（弱机多指不炸）。
 */

import { useEffect, useRef } from 'react';
import type {
  ChartData,
  EasingType,
  EventData,
  JudgementFeedback,
  JudgementType,
  NoteType,
  ResolvedNote,
  SkinImageSet,
} from '../types/game';
import { NOTE_X_RANGE, NOTE_Y_RANGE } from '../types/game';
import {
  countPlayableNotes,
  extractSpeedPoints,
  getScrollDistance,
  resolveChart,
  resolveEvents,
  secondsToBeatMultiBpm,
  type SpeedPoint,
} from '../utils/beatTime';
import { calculateNoteScore, evaluateJudgement } from '../utils/scoring';
import { EASING_FNS } from '../shared/easing';
import { JUDGE_COLORS, JUDGE_SCALE } from '../shared/gameplaySpec';
import {
  HIT_WINDOW_MS,
  SLIDE_HALF,
  SLIDE_HIT_HALF,
  SLIDE_SIZE,
  TAP_HIT_HALF,
  TAP_SIZE,
  TOUCH_HIT_HALF,
  TOUCH_SIZE,
} from '../shared/gameplaySpec';
import { globalAudio } from '../audio/AudioManager';

/* ------------------------------------------------------------------ *
 * 相机 / 投影常量（镜像 Three.js PerspectiveCamera 与 GameCanvas）。
 * 与 Lite 版 03-constants.js 保持一致；改动需同时核对该文件。
 * ------------------------------------------------------------------ */
const CAMERA_VFOV = 52;
const FIT_HALF = 2.42;
const CAMERA_AXIS_Y = 0;
const TAN_HALF_FOV = Math.tan((CAMERA_VFOV * Math.PI) / 180 / 2); // ≈0.4877
const FADE_ZONE = 12;
const PLANE_HALF_X = 3.8;
const PLANE_HALF_Y = 2.5;
const SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
const SLIDE_RED = '#ff0000';
const JUDGE_Z = 0;
const WORLD_UNITS_PER_SECOND = 36;

/** 屏幕空间投影点 */
interface P2 {
  x: number;
  y: number;
  scale: number;
  alpha: number;
}

/** 打击特效 */
interface Burst {
  x: number;
  y: number;
  start: number;
  dur: number;
  color: string;
  kind: NoteType;
  /** 判定面处的整幅像素尺寸（未乘动画倍率）。 */
  sizePx: number;
  /** 默认外观判定框环的线宽（像素，未乘动画倍率）。 */
  lineWidthPx: number;
  scaleTarget: number;
  angle: number;
}

/** slide 单节点运行态（镜像 GameCanvas slideStateRef / Lite getSlideRt） */
interface SlideNodeRt {
  judged: boolean;
  missLocked: boolean;
  everInZone: boolean;
  lastInsideTime: number | null;
  lastInsidePointerId: string | null;
  arrivalChecked: boolean;
  redWarn: boolean;
  tailLockedSPerfect: boolean;
}
interface SlideRt {
  boundPointerIds: Record<string, boolean>;
  nodes: SlideNodeRt[];
}
interface TouchRt {
  lastInsideTime: number | null;
  arrivalChecked: boolean;
}
interface PointerState {
  x: number;
  y: number;
  down: boolean;
  active: boolean;
  type: string;
}

/** 频闪渐变色的桥段（slide 管道 fill/stroke 需要在多个 alpha 带之间插值） */
type ResolvedEventEntry = EventData & { timeSec: number };

export type EditorToolKind = 'select' | 'place-tap' | 'place-touch' | 'place-slide' | 'quick-create';

export interface GameCanvas2DProps {
  chart: ChartData;
  /** 编辑器切到 2D 俯视模式时暂停本渲染器（与 3D 的 viewportActive 同义）。 */
  viewportActive?: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  /** 每次开始游玩自增，用于重置本局状态。 */
  playSession: number;
  speedMultiplier: number;
  projectionLeadMs: number;
  noteRenderDistance: number;
  noteSizeScale: number;
  autoPlay: boolean;
  onJudgement: (fb: JudgementFeedback) => void;
  onSongEnd: () => void;
  /* ---- 编辑器模式（quality 'lite' 时替代 3D 编辑器视口） ---- */
  isEditorMode?: boolean;
  activeEditorTool?: EditorToolKind;
  selectedNoteId?: string | null;
  /** 编辑器非播放态的时间轴位置（秒）。 */
  gameTime?: number;
  onSelectEditorNote?: (id: string | null) => void;
  onMoveEditorNote?: (id: string, x: number, y: number) => void;
  onPlaceEditorNote?: (x: number, y: number) => void;
  /* ---- 皮肤：自定义贴图 + 默认内外框 ---- */
  skinImages?: SkinImageSet | null;
  defaultSkinInnerEnabled?: boolean;
  defaultSkinOuterEnabled?: boolean;
  defaultSkinOuterWidth?: number;
  defaultSkinOuterColor?: string;
  defaultSkinOuterAlpha?: number;
  defaultSkinJudgeWidth?: number;
}

export function GameCanvas2D(props: GameCanvas2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 始终指向最新 props，供 rAF 闭包读取（避免重建 effect）。 */
  const propsRef = useRef(props);
  propsRef.current = props;
  /** 由 mount effect 注入的重置函数，供 playSession 变化时调用。 */
  const resetRef = useRef<((chart: ChartData) => void) | null>(null);

  /* playSession / chart 变化 → 重开一局。 */
  useEffect(() => {
    resetRef.current?.(props.chart);
  }, [props.playSession, props.chart]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    /* ---------------- 视图 / 投影 ---------------- */
    const view = { w: 0, h: 0, aspect: 1, cd: 4.96, dpr: 1, pxPerUnit: 0 };

    function fitCameraDistance(aspect: number): number {
      const dV = FIT_HALF / TAN_HALF_FOV;
      const dH = FIT_HALF / (TAN_HALF_FOV * Math.max(aspect, 0.2));
      return Math.max(dV, dH, 4.4);
    }

    function resize(): void {
      const w = canvas!.clientWidth || window.innerWidth;
      const h = canvas!.clientHeight || window.innerHeight;
      view.dpr = 1; // 低负载优先：不跟随 devicePixelRatio
      view.w = w;
      view.h = h;
      view.aspect = w / h;
      view.cd = fitCameraDistance(view.aspect);
      view.pxPerUnit = h / (2 * TAN_HALF_FOV * view.cd);
      const nw = Math.round(w * view.dpr);
      const nh = Math.round(h * view.dpr);
      if (canvas!.width !== nw || canvas!.height !== nh) {
        canvas!.width = nw;
        canvas!.height = nh;
        ctx!.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      }
    }
    window.addEventListener('resize', resize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas);
    }

    /** 世界坐标 (nx,ny,nz) → 屏幕 {x,y,scale,alpha}；超出近/远裁剪返回 null。 */
    function project(nx: number, ny: number, nz: number, spawnLimit: number): P2 | null {
      if (nz < spawnLimit) return null;
      const depth = view.cd - nz;
      if (depth <= 0.1) return null;
      const ndcX = nx / (TAN_HALF_FOV * view.aspect * depth);
      const ndcY = (ny - CAMERA_AXIS_Y) / (TAN_HALF_FOV * depth);
      const sx = view.w * 0.5 * (1 + ndcX);
      const sy = view.h * 0.5 * (1 - ndcY);
      const scale = view.cd / depth;
      const alpha = Math.max(0, Math.min(1, (nz - spawnLimit) / FADE_ZONE));
      return { x: sx, y: sy, scale, alpha };
    }

    const now = (): number => performance.now();

    /* ---------------- 颜色工具 ---------------- */
    /** 从 '#rrggbb' 拆出 rgb 分量（slide 管道渐变用）。 */
    function rgbParts(color: string): [number, number, number] {
      return [
        parseInt(color.substr(1, 2), 16),
        parseInt(color.substr(3, 2), 16),
        parseInt(color.substr(5, 2), 16),
      ];
    }

    /* ---------------- 皮肤（默认内外框 + 自定义贴图） ----------------
     * 镜像 GameCanvas：无贴图时画 内框(音符色) + 外框(自定义色/宽/透明) + 半透明填充；
     * 有贴图时整块替换为该类型的灰度贴图（按音符色染色）。 */
    const skin = {
      images: null as SkinImageSet | null,
      innerEnabled: true,
      outerEnabled: false,
      outerWidth: 0.05,
      outerColor: '#22d3ee',
      outerAlpha: 1,
      judgeWidth: 0.05,
    };

    /* 灰度贴图按音符色染色：multiply 保留明暗，destination-in 用原图 alpha 复原遮罩。
     * 结果按 (图源, 颜色) 缓存，避免每帧重建。 */
    const tintCache = new WeakMap<CanvasImageSource, Map<string, HTMLCanvasElement>>();
    function tintedImage(src: CanvasImageSource, color: string): HTMLCanvasElement {
      let byColor = tintCache.get(src);
      if (!byColor) {
        byColor = new Map<string, HTMLCanvasElement>();
        tintCache.set(src, byColor);
      }
      const hit = byColor.get(color);
      if (hit) return hit;
      const size = 128;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const c = cv.getContext('2d');
      if (c) {
        c.drawImage(src, 0, 0, size, size);
        c.globalCompositeOperation = 'multiply';
        c.fillStyle = color;
        c.fillRect(0, 0, size, size);
        c.globalCompositeOperation = 'destination-in';
        c.drawImage(src, 0, 0, size, size);
      }
      byColor.set(color, cv);
      return cv;
    }

    /** 以 (cx,cy) 为中心绘制一张按 `color` 染色、尺寸 sizePx、可旋转的贴图。 */
    function drawSkinImage(
      src: CanvasImageSource,
      cx: number,
      cy: number,
      sizePx: number,
      color: string,
      alpha: number,
      angle: number,
    ): void {
      if (sizePx < 2) return;
      const img = tintedImage(src, color);
      ctx!.save();
      ctx!.translate(cx, cy);
      if (angle) ctx!.rotate(angle);
      ctx!.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx!.drawImage(img, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
      ctx!.restore();
    }

    /** 投影引导贴图（按音符类型取；缺失回退到全局 projection）。 */
    function pickProjImage(nt: NoteType): CanvasImageSource | undefined {
      const s = skin.images;
      if (!s) return undefined;
      if (nt === 'tap') return s.projTap ?? s.projection;
      if (nt === 'touch') return s.projTouch ?? s.projection;
      return s.projSlide ?? s.projection;
    }

    /* ---------------- 形状绘制（镜像 GameCanvas mkTap/mkTouch/mkSlide） ---------------- */
    function drawTap(p: P2, color: string, vScale: number, angle: number, fade: number): void {
      const scale = view.pxPerUnit * p.scale * vScale;
      const tex = skin.images?.tap;
      if (tex) {
        drawSkinImage(tex, p.x, p.y, TAP_SIZE * scale, color, fade, angle);
        return;
      }
      const half = (TAP_SIZE / 2) * scale;
      if (half < 1) return;
      const w = Math.max(1, skin.outerWidth * scale);
      ctx!.save();
      ctx!.translate(p.x, p.y);
      if (angle) ctx!.rotate(angle); // angle 已是弧度
      if (skin.outerEnabled && skin.outerAlpha > 0) {
        ctx!.globalAlpha = skin.outerAlpha * fade;
        ctx!.strokeStyle = skin.outerColor;
        ctx!.lineWidth = w;
        const s = 2 * (half + w / 2);
        ctx!.strokeRect(-s / 2, -s / 2, s, s);
      }
      ctx!.globalAlpha = 0.18 * fade;
      ctx!.fillStyle = color;
      const f = half * 0.94;
      ctx!.fillRect(-f, -f, f * 2, f * 2);
      if (skin.innerEnabled) {
        ctx!.globalAlpha = 0.85 * fade;
        ctx!.strokeStyle = color;
        ctx!.lineWidth = 2;
        ctx!.strokeRect(-half, -half, half * 2, half * 2);
      }
      ctx!.restore();
    }

    function drawTouch(p: P2, color: string, vScale: number, fade: number): void {
      const scale = view.pxPerUnit * p.scale * vScale;
      const tex = skin.images?.touch;
      if (tex) {
        drawSkinImage(tex, p.x, p.y, TOUCH_SIZE * scale, color, fade, 0);
        return;
      }
      const r = (TOUCH_SIZE / 2) * scale;
      if (r < 1) return;
      const w = Math.max(1, skin.outerWidth * scale);
      ctx!.save();
      ctx!.translate(p.x, p.y);
      if (skin.outerEnabled && skin.outerAlpha > 0) {
        ctx!.globalAlpha = skin.outerAlpha * fade;
        ctx!.strokeStyle = skin.outerColor;
        ctx!.lineWidth = w;
        ctx!.beginPath();
        ctx!.arc(0, 0, r + w / 2, 0, Math.PI * 2);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 0.22 * fade;
      ctx!.fillStyle = color;
      ctx!.beginPath();
      ctx!.arc(0, 0, r * 0.92, 0, Math.PI * 2);
      ctx!.fill();
      if (skin.innerEnabled) {
        ctx!.globalAlpha = 0.85 * fade;
        ctx!.strokeStyle = color;
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.arc(0, 0, r, 0, Math.PI * 2);
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function drawSlideNode(p: P2, color: string, vScale: number, isHead: boolean, angle: number, fade: number): void {
      const scale = view.pxPerUnit * p.scale * vScale;
      const tex = skin.images?.slide;
      if (tex) {
        /* slide 皮肤贴图为 TAP_SIZE 见方、不旋转（内部自绘菱形），镜像 3D。 */
        drawSkinImage(tex, p.x, p.y, TAP_SIZE * scale, color, fade, 0);
        return;
      }
      const half = SLIDE_HALF * scale;
      if (half < 1) return;
      const w = Math.max(1, skin.outerWidth * scale);
      ctx!.save();
      ctx!.translate(p.x, p.y);
      if (angle) ctx!.rotate(angle);
      /* 外框（仅头节点，镜像 3D i===0） */
      if (isHead && skin.outerEnabled && skin.outerAlpha > 0) {
        const e = half + w / 2;
        ctx!.globalAlpha = skin.outerAlpha * fade;
        ctx!.strokeStyle = skin.outerColor;
        ctx!.lineWidth = w;
        ctx!.beginPath();
        ctx!.moveTo(0, -e);
        ctx!.lineTo(e, 0);
        ctx!.lineTo(0, e);
        ctx!.lineTo(-e, 0);
        ctx!.closePath();
        ctx!.stroke();
      }
      /* 半透明填充（头 0.2 / 子 0.26，镜像 3D） */
      const f = half * 0.94;
      ctx!.globalAlpha = (isHead ? 0.2 : 0.26) * fade;
      ctx!.fillStyle = color;
      ctx!.beginPath();
      ctx!.moveTo(0, -f);
      ctx!.lineTo(f, 0);
      ctx!.lineTo(0, f);
      ctx!.lineTo(-f, 0);
      ctx!.closePath();
      ctx!.fill();
      /* 内框（仅头节点） */
      if (isHead && skin.innerEnabled) {
        ctx!.globalAlpha = 0.85 * fade;
        ctx!.strokeStyle = color;
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.moveTo(0, -half);
        ctx!.lineTo(half, 0);
        ctx!.lineTo(0, half);
        ctx!.lineTo(-half, 0);
        ctx!.closePath();
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function drawPipeCap(p: P2, color: string, alpha: number, scale: number): void {
      if (!p) return;
      const half = Math.max(1.5, SLIDE_HALF * view.pxPerUnit * scale);
      ctx!.save();
      ctx!.globalAlpha = Math.min(1, alpha * 0.35);
      ctx!.fillStyle = color;
      ctx!.beginPath();
      ctx!.moveTo(p.x, p.y - half);
      ctx!.lineTo(p.x + half, p.y);
      ctx!.lineTo(p.x, p.y + half);
      ctx!.lineTo(p.x - half, p.y);
      ctx!.closePath();
      ctx!.fill();
      ctx!.restore();
    }

    /** 沿任意折线（eased 曲线采样）绘制锥形 ribbon 管道；两端独立按 alpha 渐隐。 */
    function drawPipeCurve(
      samples: { x: number; y: number; scale: number; alpha: number }[],
      color: string,
      brightness: number,
    ): void {
      if (!samples || samples.length < 2) return;
      brightness = brightness || 1.0;
      const [cr, cg, cb] = rgbParts(color);
      const n = samples.length;
      const hw: number[] = [];
      for (let i = 0; i < n; i++) hw.push(Math.max(1.5, SLIDE_PIPE_HALF * view.pxPerUnit * samples[i].scale));
      const left: { x: number; y: number }[] = [];
      const right: { x: number; y: number }[] = [];
      for (let i = 0; i < n; i++) {
        const pa = samples[Math.max(0, i - 1)];
        const pb = samples[Math.min(n - 1, i + 1)];
        const tx = pb.x - pa.x;
        const ty = pb.y - pa.y;
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = -ty / tl;
        const ny = tx / tl;
        left.push({ x: samples[i].x + nx * hw[i], y: samples[i].y + ny * hw[i] });
        right.push({ x: samples[i].x - nx * hw[i], y: samples[i].y - ny * hw[i] });
      }
      ctx!.save();
      /* 退化（管道几乎被消费殆尽）时 createLinearGradient 会变成零长渐变 →
       * 某些浏览器会在全透明/全不透明之间闪烁，改用纯色填充。 */
      const gDegenerate =
        Math.abs(samples[n - 1].x - samples[0].x) < 0.5 && Math.abs(samples[n - 1].y - samples[0].y) < 0.5;
      if (gDegenerate) {
        ctx!.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1, samples[Math.floor(n / 2)].alpha * 0.45 * brightness)})`;
      } else {
        const fillGrad = ctx!.createLinearGradient(samples[0].x, samples[0].y, samples[n - 1].x, samples[n - 1].y);
        for (let k = 0; k < n; k++) {
          const fa = Math.min(1, samples[k].alpha * 0.45 * brightness);
          fillGrad.addColorStop(k / (n - 1), `rgba(${cr},${cg},${cb},${fa})`);
        }
        ctx!.fillStyle = fillGrad;
      }
      ctx!.beginPath();
      ctx!.moveTo(left[0].x, left[0].y);
      for (let i = 1; i < n; i++) ctx!.lineTo(left[i].x, left[i].y);
      for (let i = n - 1; i >= 0; i--) ctx!.lineTo(right[i].x, right[i].y);
      ctx!.closePath();
      ctx!.fill();
      if (gDegenerate) {
        ctx!.strokeStyle = `rgba(${cr},${cg},${cb},${Math.min(1, samples[Math.floor(n / 2)].alpha * 0.6 * brightness)})`;
      } else {
        const strGrad = ctx!.createLinearGradient(samples[0].x, samples[0].y, samples[n - 1].x, samples[n - 1].y);
        for (let k = 0; k < n; k++) {
          const sa = Math.min(1, samples[k].alpha * 0.6 * brightness);
          strGrad.addColorStop(k / (n - 1), `rgba(${cr},${cg},${cb},${sa})`);
        }
        ctx!.strokeStyle = strGrad;
      }
      ctx!.lineWidth = 1.5;
      ctx!.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx!.moveTo(left[i].x, left[i].y);
        else ctx!.lineTo(left[i].x, left[i].y);
      }
      ctx!.stroke();
      ctx!.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx!.moveTo(right[i].x, right[i].y);
        else ctx!.lineTo(right[i].x, right[i].y);
      }
      ctx!.stroke();
      ctx!.restore();
    }

    /** 编辑器选中高亮（黄色外框）。 */
    function drawEditorSelection(p: P2, kind: NoteType, vScale: number, angle: number): void {
      ctx!.save();
      ctx!.translate(p.x, p.y);
      if (angle) ctx!.rotate(angle);
      ctx!.strokeStyle = '#ffd700';
      ctx!.lineWidth = 3;
      ctx!.globalAlpha = 0.95;
      if (kind === 'touch') {
        const r = (TOUCH_SIZE / 2) * view.pxPerUnit * p.scale * vScale * 1.18;
        ctx!.beginPath();
        ctx!.arc(0, 0, r, 0, Math.PI * 2);
        ctx!.stroke();
      } else if (kind === 'slide') {
        const h = SLIDE_HALF * view.pxPerUnit * p.scale * vScale * 1.18;
        ctx!.beginPath();
        ctx!.moveTo(0, -h);
        ctx!.lineTo(h, 0);
        ctx!.lineTo(0, h);
        ctx!.lineTo(-h, 0);
        ctx!.closePath();
        ctx!.stroke();
      } else {
        const s = TAP_SIZE * view.pxPerUnit * p.scale * vScale * 1.18;
        ctx!.strokeRect(-s / 2, -s / 2, s, s);
      }
      ctx!.restore();
    }

    function drawJudgePlane(): void {
      const corners = [
        project(-PLANE_HALF_X, -PLANE_HALF_Y, 0, -1000),
        project(PLANE_HALF_X, -PLANE_HALF_Y, 0, -1000),
        project(PLANE_HALF_X, PLANE_HALF_Y, 0, -1000),
        project(-PLANE_HALF_X, PLANE_HALF_Y, 0, -1000),
      ];
      if (!corners[0]) return;
      ctx!.save();
      ctx!.globalAlpha = 0.4;
      ctx!.strokeStyle = '#ffffff';
      ctx!.lineWidth = 2;
      ctx!.beginPath();
      ctx!.moveTo(corners[0]!.x, corners[0]!.y);
      for (let i = 1; i < 4; i++) ctx!.lineTo(corners[i]!.x, corners[i]!.y);
      ctx!.closePath();
      ctx!.stroke();
      ctx!.restore();
    }

    function drawTunnel(spawnLimit: number): void {
      const farZ = spawnLimit;
      const corners: [number, number][] = [
        [-PLANE_HALF_X, -PLANE_HALF_Y],
        [PLANE_HALF_X, -PLANE_HALF_Y],
        [PLANE_HALF_X, PLANE_HALF_Y],
        [-PLANE_HALF_X, PLANE_HALF_Y],
      ];
      ctx!.save();
      ctx!.globalAlpha = 0.18;
      ctx!.strokeStyle = game.accent;
      ctx!.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const near = project(corners[i][0], corners[i][1], 0, -1000);
        const far = project(corners[i][0], corners[i][1], farZ, -100000);
        if (!near || !far) continue;
        ctx!.beginPath();
        ctx!.moveTo(far.x, far.y);
        ctx!.lineTo(near.x, near.y);
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function drawBackground(): void {
      const g = ctx!.createLinearGradient(0, 0, 0, view.h);
      g.addColorStop(0, game.bgStart);
      g.addColorStop(1, game.bgEnd);
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, view.w, view.h);
    }

    /* ---------------- 运行时状态（全部在闭包里，不进 React） ---------------- */
    const game = {
      chart: null as ChartData | null,
      notes: [] as ResolvedNote[],
      events: [] as ResolvedEventEntry[],
      speedPoints: [] as SpeedPoint[],
      nextEventIdx: 0,
      currentSpeedMul: 1,
      currentNoteColor: null as string | null,
      currentText: null as string | null,
      currentTextTimeout: 0,
      speed: WORLD_UNITS_PER_SECOND,
      speedMul: 1,
      renderDist: 70,
      sizeScale: 1,
      autoPlay: false,
      curTime: 0,
      judged: {} as Record<string, boolean>,
      judgedCount: 0,
      totalNotes: 0,
      lastNoteTime: 0,
      maxSlideSpan: 0,
      score: 0,
      combo: 0,
      maxCombo: 0,
      counts: { 'S-Perfect': 0, Perfect: 0, Good: 0, Miss: 0 } as Record<JudgementType, number>,
      bursts: [] as Burst[],
      songEnded: false,
      pointers: {} as Record<string, PointerState>,
      slideStates: {} as Record<string, SlideRt>,
      touchStates: {} as Record<string, TouchRt>,
      accent: '#06b6d4',
      bgStart: '#050816',
      bgEnd: '#02040c',
      noteColor: '#00f0ff',
    };

    function resetGame(chart: ChartData): void {
      const md = chart.metadata as ChartData['metadata'] & {
        noteColor?: string;
        bgScheme?: { gradientStart?: string; gradientEnd?: string; accentColor?: string };
      };
      game.chart = chart;
      game.notes = resolveChart(chart);
      game.events = resolveEvents(chart) as ResolvedEventEntry[];
      game.speedPoints = extractSpeedPoints(game.events);
      game.nextEventIdx = 0;
      game.currentSpeedMul = 1;
      game.currentNoteColor = null;
      game.currentText = null;
      game.currentTextTimeout = 0;
      game.totalNotes = countPlayableNotes(chart);
      game.lastNoteTime = 0;
      /* maxSlideSpan：slide 头离开窗口 pastBuffer 后，其子节点仍可能未判定 →
       * 用最大 slide 跨度扩展过去窗口，避免子节点被漏判（移植自完整版 9f04e42）。 */
      let maxSlideSpan = 0;
      for (const n of game.notes) {
        if (n.timeSec > game.lastNoteTime) game.lastNoteTime = n.timeSec;
        if (n.resolvedNodes && n.resolvedNodes.length > 0) {
          const lastChildT = n.resolvedNodes[n.resolvedNodes.length - 1].timeSec;
          for (const c of n.resolvedNodes) if (c.timeSec > game.lastNoteTime) game.lastNoteTime = c.timeSec;
          const span = lastChildT - n.timeSec;
          if (span > maxSlideSpan) maxSlideSpan = span;
        }
      }
      game.maxSlideSpan = maxSlideSpan;
      game.judged = {};
      game.judgedCount = 0;
      game.score = 0;
      game.combo = 0;
      game.maxCombo = 0;
      game.counts = { 'S-Perfect': 0, Perfect: 0, Good: 0, Miss: 0 };
      game.bursts = [];
      game.songEnded = false;
      game.curTime = 0;
      game.pointers = {};
      game.slideStates = {};
      game.touchStates = {};
      const p = propsRef.current;
      game.speedMul = p.speedMultiplier;
      game.renderDist = p.noteRenderDistance;
      game.sizeScale = p.noteSizeScale;
      game.autoPlay = p.autoPlay;
      const bg = md.bgScheme;
      game.bgStart = (bg && bg.gradientStart) || '#050816';
      game.bgEnd = (bg && bg.gradientEnd) || '#02040c';
      game.accent = (bg && bg.accentColor) || '#06b6d4';
      game.noteColor = md.noteColor || '#00f0ff';
    }
    resetRef.current = resetGame;

    /* ---------------- 打击特效 ---------------- */
    function spawnBurst(wx: number, wy: number, j: JudgementType, nt: NoteType, angle: number): void {
      const p = project(wx, wy, 0, -1000);
      if (!p) return;
      const vs = game.sizeScale;
      /* 镜像 3D：特效平面 = projSize(nt) 见方；默认环线宽 = defaultSkinJudgeWidth。
       * z=0 处 p.scale 恒为 1。 */
      const sizeWorld = nt === 'touch' ? TOUCH_SIZE : nt === 'slide' ? SLIDE_SIZE : TAP_SIZE;
      const sizePx = sizeWorld * view.pxPerUnit * p.scale * vs;
      const lineWidthPx = Math.max(1, skin.judgeWidth * view.pxPerUnit * p.scale * vs);
      game.bursts.push({
        x: p.x,
        y: p.y,
        start: now(),
        dur: 300,
        color: JUDGE_COLORS[j],
        kind: nt,
        sizePx,
        lineWidthPx,
        scaleTarget: JUDGE_SCALE[j] || 1.0,
        angle: typeof angle === 'number' ? angle : 0,
      });
    }

    function drawBursts(): void {
      const t = now();
      const kept: Burst[] = [];
      for (const b of game.bursts) {
        const prog = (t - b.start) / b.dur;
        if (prog >= 1) continue;
        const multiplier = 1 + (b.scaleTarget - 1) * Math.sin(prog * Math.PI * 0.5);
        const size = b.sizePx * multiplier;
        const alpha = 1 - prog;
        /* 镜像 3D spawnBurst：有 projection 贴图时用贴图（按判定色染色），
         * 否则用默认判定框环（线宽 = defaultSkinJudgeWidth）。 */
        const tex = pickProjImage(b.kind);
        if (tex) {
          drawSkinImage(tex, b.x, b.y, size, b.color, alpha, b.angle);
        } else {
          const half = size / 2;
          ctx!.save();
          ctx!.globalAlpha = alpha;
          ctx!.strokeStyle = b.color;
          ctx!.lineWidth = b.lineWidthPx * multiplier;
          ctx!.translate(b.x, b.y);
          if (b.angle) ctx!.rotate(b.angle);
          if (b.kind === 'touch') {
            ctx!.beginPath();
            ctx!.arc(0, 0, half, 0, Math.PI * 2);
            ctx!.stroke();
          } else if (b.kind === 'slide') {
            ctx!.beginPath();
            ctx!.moveTo(0, -half);
            ctx!.lineTo(half, 0);
            ctx!.lineTo(0, half);
            ctx!.lineTo(-half, 0);
            ctx!.closePath();
            ctx!.stroke();
          } else {
            ctx!.strokeRect(-half, -half, half * 2, half * 2);
          }
          ctx!.restore();
        }
        kept.push(b);
      }
      game.bursts = kept;
    }

    /* ---------------- 判定提交 ---------------- */
    function commitJudge(
      id: string,
      j: JudgementType,
      dt: number,
      wx?: number,
      wy?: number,
      nt?: NoteType,
      angle?: number,
    ): void {
      if (game.judged[id]) return;
      game.judged[id] = true;
      game.judgedCount++;
      const sc = calculateNoteScore(j, game.totalNotes);
      game.score += sc;
      if (j === 'Miss') game.combo = 0;
      else {
        game.combo++;
        if (game.combo > game.maxCombo) game.maxCombo = game.combo;
      }
      game.counts[j]++;
      if (typeof wx === 'number' && typeof wy === 'number' && nt) {
        spawnBurst(wx, wy, j, nt, angle ?? 0);
      }
      /* 回流 App：驱动其 stats/HUD（与 GameCanvas onJudgement 语义一致）。 */
      propsRef.current.onJudgement({
        id,
        type: j,
        x: wx ?? 0,
        y: wy ?? 0,
        deltaT: dt,
        scoreGained: sc,
        createdAt: now(),
        noteType: nt ?? 'tap',
      });
    }

    /* ---------------- 窗口搜索 / z 推导（镜像 GameCanvas） ---------------- */
    function findWindow(curTime: number, spawnLimit: number): { first: number; last: number } {
      const sp = game.speedPoints;
      let hasNegative = false;
      for (const s of sp) {
        if (s.speed < 0) {
          hasNegative = true;
          break;
        }
      }
      if (hasNegative) return { first: 0, last: game.notes.length };
      const speed = game.speed * game.speedMul;
      const pastBuffer = 0.3 + (game.maxSlideSpan || 0);
      const futureBuffer = -spawnLimit / speed + 0.3;
      const pastTh = curTime - pastBuffer;
      const futureTh = curTime + futureBuffer;
      let lo = 0;
      let hi = game.notes.length;
      let mid = 0;
      while (lo < hi) {
        mid = (lo + hi) >> 1;
        if (game.notes[mid].timeSec < pastTh) lo = mid + 1;
        else hi = mid;
      }
      const first = lo;
      lo = first;
      hi = game.notes.length;
      while (lo < hi) {
        mid = (lo + hi) >> 1;
        if (game.notes[mid].timeSec <= futureTh) lo = mid + 1;
        else hi = mid;
      }
      return { first, last: lo };
    }

    function noteZPos(noteTimeSec: number, curTime: number, baseSpeed: number): number {
      const noteDist = getScrollDistance(noteTimeSec, game.speedPoints);
      const curDist = getScrollDistance(curTime, game.speedPoints);
      return JUDGE_Z - (noteDist - curDist) * baseSpeed;
    }

    /* ---------------- slide 运行态助手 ---------------- */
    function getAllSlideNodes(note: ResolvedNote): { x: number; y: number; timeSec: number; angle: number; easing?: EasingType }[] {
      const nodes: { x: number; y: number; timeSec: number; angle: number; easing?: EasingType }[] = [
        { x: note.x, y: note.y, timeSec: note.timeSec, angle: note.angle ?? 0, easing: note.easing },
      ];
      if (note.resolvedNodes) {
        for (const rn of note.resolvedNodes) {
          nodes.push({ x: rn.x, y: rn.y, timeSec: rn.timeSec, angle: rn.angle ?? 0, easing: rn.easing });
        }
      }
      return nodes;
    }

    function getSlideRt(noteId: string, nodeCount: number): SlideRt {
      let rt = game.slideStates[noteId];
      if (!rt || rt.nodes.length !== nodeCount) {
        rt = { boundPointerIds: {}, nodes: [] };
        for (let i = 0; i < nodeCount; i++) {
          rt.nodes.push({
            judged: false,
            missLocked: false,
            everInZone: false,
            lastInsideTime: null,
            lastInsidePointerId: null,
            arrivalChecked: false,
            redWarn: false,
            tailLockedSPerfect: false,
          });
        }
        game.slideStates[noteId] = rt;
      }
      return rt;
    }

    /* ---------------- 事件处理 ---------------- */
    function processEvents(curTime: number): void {
      const evts = game.events;
      while (game.nextEventIdx < evts.length && evts[game.nextEventIdx].timeSec <= curTime) {
        const evt = evts[game.nextEventIdx];
        if (evt.eventType === 'speed_change' && typeof evt.speed === 'number') {
          game.currentSpeedMul = evt.speed;
        } else if (evt.eventType === 'text_display') {
          game.currentText = evt.text || '';
          const dur = typeof evt.textDuration === 'number' ? evt.textDuration : 2;
          game.currentTextTimeout = curTime + dur;
        } else if (evt.eventType === 'note_color_change' && evt.noteColor) {
          game.currentNoteColor = evt.noteColor;
        }
        game.nextEventIdx++;
      }
      if (game.currentText && curTime > game.currentTextTimeout) game.currentText = null;
    }

    /* ---------------- slide 判定（移植自 GameCanvas.processSlide） ---------------- */
    function processSlide(note: ResolvedNote, curTime: number): void {
      const allNodes = getAllSlideNodes(note);
      const rt = getSlideRt(note.id, allNodes.length);

      /* 1) 超窗 Miss（含 missLocked） */
      for (let i = 0; i < allNodes.length; i++) {
        const ns = rt.nodes[i];
        if (ns.judged) continue;
        const dtI = (curTime - allNodes[i].timeSec) * 1000;
        if (dtI > HIT_WINDOW_MS) {
          ns.judged = true;
          ns.redWarn = false;
          commitJudge(note.id + '#' + i, 'Miss', dtI, allNodes[i].x, allNodes[i].y, 'slide', allNodes[i].angle);
        }
      }

      let nextIdx = -1;
      for (let k0 = 0; k0 < rt.nodes.length; k0++) {
        if (!rt.nodes[k0].judged) {
          nextIdx = k0;
          break;
        }
      }
      const ndForCheck = nextIdx >= 0 ? allNodes[nextIdx] : null;

      /* 2) 松手检测 + 离节点剪枝 */
      const boundKeys = Object.keys(rt.boundPointerIds);
      if (boundKeys.length > 0) {
        let allReleased = true;
        for (const bpid of boundKeys) {
          const bp = game.pointers[bpid];
          if (bp && bp.down) allReleased = false;
          else delete rt.boundPointerIds[bpid];
        }
        if (ndForCheck && Object.keys(rt.boundPointerIds).length > 0) {
          const onNode: string[] = [];
          const offNode: string[] = [];
          for (const pidc of Object.keys(rt.boundPointerIds)) {
            const bpc = game.pointers[pidc];
            const isOn =
              !!bpc &&
              bpc.down &&
              Math.abs(bpc.x - ndForCheck.x) < SLIDE_HIT_HALF &&
              Math.abs(bpc.y - ndForCheck.y) < SLIDE_HIT_HALF;
            (isOn ? onNode : offNode).push(pidc);
          }
          if (onNode.length > 0) for (const o of offNode) delete rt.boundPointerIds[o];
        }
        if (allReleased && Object.keys(rt.boundPointerIds).length === 0 && nextIdx >= 0) {
          const nns = rt.nodes[nextIdx];
          if (!nns.judged && !nns.tailLockedSPerfect) {
            nns.missLocked = true;
            nns.redWarn = false;
          }
        }
      }

      if (nextIdx < 0) return;
      const cns = rt.nodes[nextIdx];
      const cnd = allNodes[nextIdx];
      const dt = (curTime - cnd.timeSec) * 1000;

      if (game.autoPlay) {
        if (dt >= 0 && !cns.judged) {
          cns.judged = true;
          commitJudge(note.id + '#' + nextIdx, 'S-Perfect', dt);
          globalAudio.playHitSound('slide');
          spawnBurst(cnd.x, cnd.y, 'S-Perfect', 'slide', cnd.angle);
        }
        cns.redWarn = false;
        return;
      }

      if (cns.missLocked) {
        cns.redWarn = false;
        return;
      }

      /* tail 节点放宽：判定窗内任一绑定指针仍按住即锁 S-Perfect */
      const isTail = nextIdx === allNodes.length - 1;
      if (isTail && !cns.tailLockedSPerfect && dt >= -HIT_WINDOW_MS) {
        let hasBound = false;
        for (const tpid of Object.keys(rt.boundPointerIds)) {
          hasBound = true;
          const bpp = game.pointers[tpid];
          if (bpp && bpp.down) {
            cns.tailLockedSPerfect = true;
            break;
          }
        }
        if (!hasBound) {
          for (const tpid of Object.keys(game.pointers)) {
            if (game.pointers[tpid].down) {
              cns.tailLockedSPerfect = true;
              break;
            }
          }
        }
      }

      const boundCount = Object.keys(rt.boundPointerIds).length;
      const onNodePids: string[] = [];
      if (boundCount > 0) {
        for (const bpid3 of Object.keys(rt.boundPointerIds)) {
          const p = game.pointers[bpid3];
          if (
            p &&
            p.down &&
            Math.abs(p.x - cnd.x) < SLIDE_HIT_HALF &&
            Math.abs(p.y - cnd.y) < SLIDE_HIT_HALF
          ) {
            onNodePids.push(bpid3);
          }
        }
      } else {
        for (const pid of Object.keys(game.pointers)) {
          const p2 = game.pointers[pid];
          if (!p2.down) continue;
          if (Math.abs(p2.x - cnd.x) < SLIDE_HIT_HALF && Math.abs(p2.y - cnd.y) < SLIDE_HIT_HALF) onNodePids.push(pid);
        }
      }

      if (boundCount > 0 && onNodePids.length > 0) cns.everInZone = true;

      if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && onNodePids.length > 0) {
        cns.lastInsideTime = curTime;
        cns.lastInsidePointerId = onNodePids[0];
      }

      if (dt >= 0 && !cns.judged) {
        if (isTail && cns.tailLockedSPerfect) {
          cns.judged = true;
          if (boundCount === 0) {
            for (const tpid of Object.keys(game.pointers)) {
              if (game.pointers[tpid].down) rt.boundPointerIds[tpid] = true;
            }
          }
          commitJudge(note.id + '#' + nextIdx, 'S-Perfect', dt);
          globalAudio.playHitSound('slide');
          spawnBurst(cnd.x, cnd.y, 'S-Perfect', 'slide');
        } else if (!cns.arrivalChecked) {
          cns.arrivalChecked = true;
          if (onNodePids.length > 0) {
            cns.judged = true;
            for (const pid of onNodePids) rt.boundPointerIds[pid] = true;
            commitJudge(note.id + '#' + nextIdx, 'S-Perfect', dt);
            globalAudio.playHitSound('slide');
            spawnBurst(cnd.x, cnd.y, 'S-Perfect', 'slide');
          }
        } else if (onNodePids.length > 0 && dt <= HIT_WINDOW_MS) {
          const j2 = evaluateJudgement(dt);
          if (j2) {
            cns.judged = true;
            for (const pid of onNodePids) rt.boundPointerIds[pid] = true;
            commitJudge(note.id + '#' + nextIdx, j2, dt);
            globalAudio.playHitSound('slide');
            spawnBurst(cnd.x, cnd.y, j2, 'slide', cnd.angle);
          }
        }
      }

      /* 4) 红警：绑定的指针都不在节点上，但有其它按下的指针在节点上 */
      cns.redWarn = false;
      if (!cns.judged && boundCount > 0 && onNodePids.length === 0 && dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS) {
        for (const pid2 of Object.keys(game.pointers)) {
          if (rt.boundPointerIds[pid2]) continue;
          const p3 = game.pointers[pid2];
          if (!p3.down) continue;
          if (Math.abs(p3.x - cnd.x) < SLIDE_HIT_HALF && Math.abs(p3.y - cnd.y) < SLIDE_HIT_HALF) {
            cns.redWarn = true;
            break;
          }
        }
      }
    }

    /* ---------------- touch 判定（悬停触发） ---------------- */
    function isAnyPointerInside(x: number, y: number, half: number): boolean {
      for (const pid of Object.keys(game.pointers)) {
        const p = game.pointers[pid];
        if (!p.active) continue;
        if (Math.abs(p.x - x) < half && Math.abs(p.y - y) < half) return true;
      }
      return false;
    }

    function processTouchNote(note: ResolvedNote, curTime: number): void {
      const dt = (curTime - note.timeSec) * 1000;
      const inside = isAnyPointerInside(note.x, note.y, TOUCH_HIT_HALF);
      let track = game.touchStates[note.id];
      if (!track) {
        track = { lastInsideTime: null, arrivalChecked: false };
        game.touchStates[note.id] = track;
      }
      if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && inside) track.lastInsideTime = curTime;
      if (game.autoPlay && dt >= 0) {
        commitJudge(note.id, 'S-Perfect', dt);
        globalAudio.playHitSound('touch');
        spawnBurst(note.x, note.y, 'S-Perfect', 'touch', note.angle ?? 0);
        return;
      }
      if (dt >= 0) {
        if (!track.arrivalChecked) {
          track.arrivalChecked = true;
          if (inside) {
            commitJudge(note.id, 'S-Perfect', dt);
            globalAudio.playHitSound('touch');
            spawnBurst(note.x, note.y, 'S-Perfect', 'touch', note.angle ?? 0);
            return;
          }
          if (track.lastInsideTime !== null) {
            const earlyDt = (track.lastInsideTime - note.timeSec) * 1000;
            const j = evaluateJudgement(earlyDt);
            if (j) {
              commitJudge(note.id, j, earlyDt);
              globalAudio.playHitSound('touch');
              spawnBurst(note.x, note.y, j, 'touch', note.angle ?? 0);
              return;
            }
          }
        }
        if (inside && dt <= HIT_WINDOW_MS) {
          const j2 = evaluateJudgement(dt);
          if (j2) {
            commitJudge(note.id, j2, dt);
            globalAudio.playHitSound('touch');
            spawnBurst(note.x, note.y, j2, 'touch', note.angle ?? 0);
            return;
          }
        }
        if (dt > HIT_WINDOW_MS) commitJudge(note.id, 'Miss', dt, note.x, note.y, 'touch', note.angle ?? 0);
      }
    }

    /* ---------------- 每帧判定遍历 ---------------- */
    function processAllNotes(curTime: number): void {
      const win = findWindow(curTime, -game.renderDist);
      for (let i = win.first; i < win.last; i++) {
        const n = game.notes[i];
        if (n.type === 'slide') {
          processSlide(n, curTime);
        } else if (n.type === 'touch') {
          if (!game.judged[n.id]) processTouchNote(n, curTime);
        } else {
          if (!game.autoPlay && !game.judged[n.id] && curTime > n.timeSec + HIT_WINDOW_MS / 1000) {
            commitJudge(n.id, 'Miss', 0, n.x, n.y, 'tap', n.angle ?? 0);
          } else if (game.autoPlay && !game.judged[n.id] && curTime >= n.timeSec) {
            const dt = (curTime - n.timeSec) * 1000;
            commitJudge(n.id, 'S-Perfect', dt);
            globalAudio.playHitSound('tap');
            spawnBurst(n.x, n.y, 'S-Perfect', 'tap', n.angle ?? 0);
          }
        }
      }
    }

    /* ---------------- 渲染 ---------------- */
    function drawProjection(note: { type: NoteType; timeSec: number; x: number; y: number; angle?: number }, color: string, vScale: number, curTime: number): void {
      if (propsRef.current.isEditorMode) return; /* 编辑器不画落地投影引导 */
      const md = (game.chart && game.chart.metadata) as
        | (ChartData['metadata'] & { effectToggles?: { projection?: boolean } })
        | null;
      const toggles = (md && md.effectToggles) || {};
      if (toggles.projection === false) return;
      const leadMs = propsRef.current.projectionLeadMs;
      if (leadMs <= 0) return;
      const timeToHitMs = (note.timeSec - curTime) * 1000;
      if (timeToHitMs < 0 || timeToHitMs > leadMs) return;
      const po = Math.max(0, Math.min(0.95, 1 - timeToHitMs / leadMs));
      if (po <= 0.01) return;
      const p = project(note.x, note.y, 0, -1000);
      if (!p) return;
      const projTex = pickProjImage(note.type);
      if (projTex) {
        const szWorld = note.type === 'tap' ? TAP_SIZE : note.type === 'touch' ? TOUCH_SIZE : SLIDE_SIZE;
        drawSkinImage(projTex, p.x, p.y, szWorld * view.pxPerUnit * p.scale * vScale, color, po, note.angle ?? 0);
        return;
      }
      ctx!.save();
      ctx!.globalAlpha = po;
      ctx!.strokeStyle = color;
      ctx!.lineWidth = Math.max(1, skin.judgeWidth * view.pxPerUnit * p.scale * vScale);
      ctx!.translate(p.x, p.y);
      if (note.angle) ctx!.rotate(note.angle);
      if (note.type === 'tap') {
        const sz = TAP_SIZE * view.pxPerUnit * p.scale * vScale;
        ctx!.strokeRect(-sz / 2, -sz / 2, sz, sz);
      } else if (note.type === 'touch') {
        const r = (TOUCH_SIZE / 2) * view.pxPerUnit * p.scale * vScale;
        ctx!.beginPath();
        ctx!.arc(0, 0, r * 0.92, 0, Math.PI * 2);
        ctx!.stroke();
      } else {
        const half = SLIDE_HALF * view.pxPerUnit * p.scale * vScale;
        ctx!.beginPath();
        ctx!.moveTo(0, -half);
        ctx!.lineTo(half, 0);
        ctx!.lineTo(0, half);
        ctx!.lineTo(-half, 0);
        ctx!.closePath();
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function render(): void {
      const chart = game.chart;
      if (!chart) return;
      const curTime = game.curTime;
      const baseSpeed = game.speed * game.speedMul;
      const spawnLimit = -game.renderDist;
      const vScale = game.sizeScale;
      const colorHex = game.currentNoteColor || game.noteColor;

      processEvents(curTime);
      if (!propsRef.current.isEditorMode) processAllNotes(curTime);

      drawBackground();
      const toggles = ((chart.metadata as ChartData['metadata'] & { effectToggles?: { gridLines?: boolean } }).effectToggles) || {};
      if (toggles.gridLines !== false) drawTunnel(spawnLimit);

      const win = findWindow(curTime, spawnLimit);
      const toDraw: {
        p: P2;
        kind: NoteType;
        color: string;
        id: string;
        noteId: string;
        nodeIdx: number;
        isHead: boolean;
        angle: number;
      }[] = [];

      for (let i = win.first; i < win.last; i++) {
        const note = game.notes[i];
        const nc = note.color || colorHex;

        if (note.type === 'slide') {
          const allNodes = getAllSlideNodes(note);
          for (let pi = 0; pi < allNodes.length - 1; pi++) {
            const nodeA = allNodes[pi];
            const nodeB = allNodes[pi + 1];
            const zA = noteZPos(nodeA.timeSec, curTime, baseSpeed);
            const zB = noteZPos(nodeB.timeSec, curTime, baseSpeed);
            const judgedA = !!game.judged[note.id + '#' + pi];
            const judgedB = !!game.judged[note.id + '#' + (pi + 1)];
            if (judgedA && judgedB) continue;
            if (zA < spawnLimit && zB < spawnLimit) continue;
            if (zA > 0 && zB > 0) continue;

            const ex = nodeB.x - nodeA.x;
            const ey = nodeB.y - nodeA.y;
            const dz = zB - zA;
            const segDur = Math.max(1e-4, nodeB.timeSec - nodeA.timeSec);
            let tau = (curTime - nodeA.timeSec) / segDur;
            if (tau < 0) tau = 0;
            else if (tau > 1) tau = 1;
            if (tau >= 0.999) continue;
            const easeFn = EASING_FNS[nodeB.easing || 'linear'] || EASING_FNS.linear;

            const spArr = game.speedPoints;
            let midSpeed = false;
            for (const s of spArr) {
              if (s.timeSec > nodeA.timeSec && s.timeSec < nodeB.timeSec) {
                midSpeed = true;
                break;
              }
            }
            const scrollDistA = midSpeed ? getScrollDistance(nodeA.timeSec, spArr) : 0;
            const zAtTau = (tt: number): number => {
              if (!midSpeed) return zA + tt * dz;
              return zA - (getScrollDistance(nodeA.timeSec + tt * segDur, spArr) - scrollDistA) * baseSpeed;
            };

            let tauBandLo: number;
            let tauBandHi: number;
            if (!midSpeed) {
              if (Math.abs(dz) > 1e-6) {
                const tf = (spawnLimit - zA) / dz;
                const tj = (0 - zA) / dz;
                tauBandLo = Math.min(tf, tj);
                tauBandHi = Math.max(tf, tj);
              } else {
                tauBandLo = -Infinity;
                tauBandHi = Infinity;
              }
            } else {
              let blo = Infinity;
              let bhi = -Infinity;
              for (let bq = 0; bq <= 24; bq++) {
                const bzq = zAtTau(bq / 24);
                if (bzq >= spawnLimit && bzq <= 0) {
                  if (bq / 24 < blo) blo = bq / 24;
                  if (bq / 24 > bhi) bhi = bq / 24;
                }
              }
              if (blo === Infinity) continue;
              tauBandLo = blo;
              tauBandHi = bhi;
            }
            const visLo = Math.max(tau, tauBandLo, 0);
            const visHi = Math.min(1, tauBandHi);
            if (visLo >= visHi) continue;

            const SEGS = 16;
            const samples: { x: number; y: number; scale: number; alpha: number }[] = [];
            for (let sk = 0; sk <= SEGS; sk++) {
              const tt = visLo + (visHi - visLo) * (sk / SEGS);
              const wx = nodeA.x + easeFn(tt) * ex;
              const wy = nodeA.y + easeFn(tt) * ey;
              const wz = zAtTau(tt);
              const p = project(wx, wy, wz, spawnLimit);
              if (!p) continue;
              const a = Math.max(0.1, Math.min(1, (wz - spawnLimit) / FADE_ZONE));
              samples.push({ x: p.x, y: p.y, scale: p.scale, alpha: a });
            }
            if (samples.length < 2) continue;

            /* 管道颜色/亮度：红警/按住高亮 */
            const slideRt = getSlideRt(note.id, allNodes.length);
            const nextNodeRt = slideRt.nodes[pi + 1];
            const isRed = !!nextNodeRt && (nextNodeRt.missLocked || nextNodeRt.redWarn) && !judgedB;
            let isHolding = false;
            if (!isRed) {
              let hasAnyBound = false;
              const straddles = (zA > 0 && zB < 0) || (zA < 0 && zB > 0);
              let tCross: number | null = null;
              if (straddles) {
                if (!midSpeed) tCross = (0 - zA) / dz;
                else {
                  let ca = 0;
                  let cb = 1;
                  for (let bi = 0; bi < 20; bi++) {
                    const bm = (ca + cb) / 2;
                    if ((zAtTau(bm) > 0) === (zA > 0)) ca = bm;
                    else cb = bm;
                  }
                  tCross = (ca + cb) / 2;
                }
              }
              for (const hbpid of Object.keys(slideRt.boundPointerIds)) {
                hasAnyBound = true;
                const hbp = game.pointers[hbpid];
                if (hbp && hbp.down && tCross !== null) {
                  const cx = nodeA.x + easeFn(tCross) * ex;
                  const cy = nodeA.y + easeFn(tCross) * ey;
                  if (Math.abs(hbp.x - cx) < SLIDE_HIT_HALF && Math.abs(hbp.y - cy) < SLIDE_HIT_HALF) {
                    isHolding = true;
                    break;
                  }
                }
              }
              if (!hasAnyBound) isHolding = false;
            }
            let brightness = 1.0;
            if (isHolding) brightness = isRed ? 2.7 : 2.3;
            else if (isRed) brightness = 1.7;
            const pipeColor = isRed ? SLIDE_RED : nc;
            drawPipeCurve(samples, pipeColor, brightness);

            /* 两端截面 cap，靠近判定面时平滑淡入 */
            const capZ = 0.4;
            const wz0 = zAtTau(visLo);
            const wzN = zAtTau(visHi);
            const capA0 = Math.max(0, 1 - Math.abs(wz0) / capZ);
            const capAN = Math.max(0, 1 - Math.abs(wzN) / capZ);
            if (capA0 > 0.01) {
              const cp0 = project(nodeA.x + easeFn(visLo) * ex, nodeA.y + easeFn(visLo) * ey, wz0, spawnLimit);
              if (cp0) drawPipeCap(cp0, pipeColor, capA0 * Math.min(1, brightness), cp0.scale);
            }
            if (capAN > 0.01) {
              const cpN = project(nodeA.x + easeFn(visHi) * ex, nodeA.y + easeFn(visHi) * ey, wzN, spawnLimit);
              if (cpN) drawPipeCap(cpN, pipeColor, capAN * Math.min(1, brightness), cpN.scale);
            }
          }
          /* slide 节点 + 落地投影引导 */
          for (let nj = 0; nj < allNodes.length; nj++) {
            if (game.judged[note.id + '#' + nj]) continue;
            const nz = noteZPos(allNodes[nj].timeSec, curTime, baseSpeed);
            const np = project(allNodes[nj].x, allNodes[nj].y, nz, spawnLimit);
            if (np) {
              toDraw.push({
                p: np,
                kind: 'slide',
                color: nc,
                id: nj === 0 ? note.id : note.id + '#' + nj,
                noteId: note.id,
                nodeIdx: nj,
                isHead: nj === 0,
                angle: allNodes[nj].angle,
              });
            }
            if (nj === 0) {
              drawProjection(
                { type: 'slide', timeSec: allNodes[0].timeSec, x: allNodes[0].x, y: allNodes[0].y, angle: allNodes[0].angle },
                nc,
                vScale,
                curTime,
              );
            }
          }
        } else {
          if (game.judged[note.id]) continue;
          const tz = noteZPos(note.timeSec, curTime, baseSpeed);
          const tp = project(note.x, note.y, tz, spawnLimit);
          if (tp) {
            toDraw.push({
              p: tp,
              kind: note.type,
              color: nc,
              id: note.id,
              noteId: note.id,
              nodeIdx: 0,
              isHead: true,
              angle: note.angle ?? 0,
            });
            drawProjection(note, nc, vScale, curTime);
          }
        }
      }

      if (toggles.gridLines !== false) drawJudgePlane();

      const inEditor = propsRef.current.isEditorMode;
      for (const item of toDraw) {
        const fade = inEditor ? 1 : item.p.alpha;
        if (item.kind === 'tap') drawTap(item.p, item.color, vScale, item.angle, fade);
        else if (item.kind === 'touch') drawTouch(item.p, item.color, vScale, fade);
        else {
          const rt = game.slideStates[item.noteId];
          const isRed = !!(rt && rt.nodes[item.nodeIdx] && rt.nodes[item.nodeIdx].redWarn);
          drawSlideNode(item.p, isRed ? SLIDE_RED : item.color, vScale, item.isHead, item.angle, fade);
        }
      }

      /* 编辑器：选中音符高亮 */
      if (propsRef.current.isEditorMode && propsRef.current.selectedNoteId) {
        const sel = propsRef.current.selectedNoteId;
        for (const item of toDraw) {
          if (item.id === sel) drawEditorSelection(item.p, item.kind, vScale, item.angle);
        }
      }

      drawBursts();

      /* 事件文字（镜像 GameCanvas 事件文本叠层） */
      if (game.currentText) {
        ctx!.save();
        const fontSize = Math.round(view.h * 0.05);
        ctx!.font = `bold ${fontSize}px "Rajdhani", sans-serif`;
        ctx!.textAlign = 'center';
        ctx!.textBaseline = 'middle';
        ctx!.fillStyle = game.accent;
        ctx!.shadowColor = 'rgba(0,0,0,0.8)';
        ctx!.shadowBlur = 10;
        ctx!.fillText(game.currentText, view.w / 2, view.h * 0.35);
        ctx!.restore();
      }

      /* 歌曲结束检测 */
      if (!propsRef.current.isEditorMode && propsRef.current.isPlaying && !game.songEnded && game.totalNotes > 0) {
        if (game.judgedCount >= game.totalNotes || curTime > game.lastNoteTime + 1.5) {
          game.songEnded = true;
          window.setTimeout(() => propsRef.current.onSongEnd(), 600);
        }
      }
    }

    /* ---------------- 输入：屏幕 → 世界（project 的逆运算） ---------------- */
    function screenToWorld(sx: number, sy: number): { x: number; y: number } {
      const depth = view.cd;
      const ndcX = (2 * sx) / view.w - 1;
      const ndcY = 1 - (2 * sy) / view.h;
      return {
        x: ndcX * TAN_HALF_FOV * view.aspect * depth,
        y: ndcY * TAN_HALF_FOV * depth + CAMERA_AXIS_Y,
      };
    }

    /** tap 命中（pointerdown 即时判定）；含同刻重叠合并（方案二）。 */
    function findHitTapNote(wx: number, wy: number, curTime: number): ResolvedNote | null {
      const overlapSet: ResolvedNote[] = [];
      const win = findWindow(curTime, -game.renderDist);
      for (let i = win.first; i < win.last; i++) {
        const n = game.notes[i];
        if (n.type !== 'tap') continue;
        if (game.judged[n.id]) continue;
        const dtMs = Math.abs((curTime - n.timeSec) * 1000);
        if (dtMs >= HIT_WINDOW_MS) continue;
        const inOwn = Math.abs(n.x - wx) < TAP_HIT_HALF && Math.abs(n.y - wy) < TAP_HIT_HALF;
        let inExtra = false;
        if (n.extraHitRegions) {
          for (const e of n.extraHitRegions) {
            if (Math.abs(e.x - wx) < e.half && Math.abs(e.y - wy) < e.half) {
              inExtra = true;
              break;
            }
          }
        }
        if (inOwn || inExtra) overlapSet.push(n);
      }
      if (overlapSet.length === 0) return null;
      /* 优先选「最晚」的时间组（抢救将 miss 的 tap），再按距离取最近。 */
      let bestLate = -Infinity;
      let bestTimeSec = Infinity;
      for (const m of overlapSet) {
        const lat = curTime - m.timeSec;
        if (lat > bestLate) {
          bestLate = lat;
          bestTimeSec = m.timeSec;
        }
      }
      let best: ResolvedNote | null = null;
      let bestDist = Infinity;
      for (const m of overlapSet) {
        if (m.timeSec !== bestTimeSec) continue;
        const dxm = m.x - wx;
        const dym = m.y - wy;
        const d = Math.sqrt(dxm * dxm + dym * dym);
        if (d < bestDist || (d === bestDist && best !== null && m.timeSec < best.timeSec)) {
          best = m;
          bestDist = d;
        }
      }
      if (best) {
        const chosen = best as ResolvedNote;
        const merged = { x: chosen.x, y: chosen.y, half: TAP_HIT_HALF };
        for (const other of overlapSet) {
          if (other === chosen || other.timeSec !== chosen.timeSec) continue;
          if (!other.extraHitRegions) other.extraHitRegions = [];
          const dup = other.extraHitRegions.some(
            (reg) => reg.x === merged.x && reg.y === merged.y && reg.half === merged.half,
          );
          if (!dup) other.extraHitRegions.push(merged);
        }
      }
      return best;
    }

    function handleTapInput(sx: number, sy: number, pid: string, type: string): void {
      if (propsRef.current.isEditorMode) {
        handleEditorDown(sx, sy, pid);
        return;
      }
      if (!propsRef.current.isPlaying || game.autoPlay) return;
      const w = screenToWorld(sx, sy);
      game.pointers[pid] = { x: w.x, y: w.y, down: true, active: true, type };
      const curTime = game.curTime;
      const n = findHitTapNote(w.x, w.y, curTime);
      if (!n) return;
      const dtMs = (curTime - n.timeSec) * 1000;
      const j = evaluateJudgement(dtMs);
      if (!j) return;
      commitJudge(n.id, j, dtMs);
      globalAudio.playHitSound('tap');
      spawnBurst(n.x, n.y, j, 'tap', n.angle ?? 0);
    }

    function handleReleaseInput(pid: string): void {
      delete game.pointers[pid];
    }

    /* 每帧合并的指针移动缓冲（IE11/弱机多指不炸主线程）。 */
    const pendingMoves: Record<string, { sx: number; sy: number; down: boolean; active: boolean; type: string }> = {};
    function flushPointerMoves(): void {
      for (const pid of Object.keys(pendingMoves)) {
        const pm = pendingMoves[pid];
        const w = screenToWorld(pm.sx, pm.sy);
        const ex = game.pointers[pid];
        if (ex) {
          ex.x = w.x;
          ex.y = w.y;
          ex.down = pm.down;
          ex.active = pm.active;
          ex.type = pm.type;
        } else {
          game.pointers[pid] = { x: w.x, y: w.y, down: pm.down, active: pm.active, type: pm.type };
        }
      }
    }

    /* ---------------- 编辑器交互（镜像 GameCanvas 的 useEditorGestures） ---------------- */
    let editorDragging = false;
    let editorDragPid: string | null = null;
    /* 命中即记住拖拽目标 id（不依赖 props.selectedNoteId —— 后者要等 React 更新，
     * 首个 pointermove 可能仍读到旧值，导致拖动错误音符）。 */
    let editorDragTargetId: string | null = null;

    /** 编辑器当前时间轴（播放态读音频时钟，否则读 gameTime）。 */
    function editorCurTime(): number {
      const p = propsRef.current;
      return p.isPlaying ? globalAudio.getCurrentTime() : (p.gameTime ?? 0);
    }

    /** 命中最近的音符/子节点 id（判定面世界坐标；仅限 [curBeat-0.1, curBeat+0.5]）。 */
    function hitTestEditorNote(wx: number, wy: number): string | null {
      const chart = game.chart;
      if (!chart) return null;
      const md = chart.metadata;
      const curBeat = secondsToBeatMultiBpm(editorCurTime(), md.bpm, md.offset || 0, md.bpmlist);
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const n of game.notes) {
        const cands =
          n.type === 'slide'
            ? [
                { id: n.id, x: n.x, y: n.y, beat: n.beat, r: 0.7 },
                ...(n.resolvedNodes ?? []).map((sn, i) => ({
                  id: `${n.id}#${i + 1}`,
                  x: sn.x,
                  y: sn.y,
                  beat: sn.beat,
                  r: 0.7,
                })),
              ]
            : [{ id: n.id, x: n.x, y: n.y, beat: n.beat, r: n.type === 'tap' ? 0.85 : 0.65 }];
        for (const c of cands) {
          if (c.beat < curBeat - 0.1 || c.beat > curBeat + 0.5) continue;
          const d = Math.hypot(wx - c.x, wy - c.y);
          if (d < c.r && d < bestDist) {
            bestId = c.id;
            bestDist = d;
          }
        }
      }
      return bestId;
    }

    /** pointerdown：放置工具就放置，否则选择（选中即进入拖拽）。 */
    function handleEditorDown(sx: number, sy: number, pid: string): void {
      const p = propsRef.current;
      const w = screenToWorld(sx, sy);
      const tool = p.activeEditorTool || 'select';
      if (tool === 'place-tap' || tool === 'place-touch' || tool === 'place-slide') {
        const cx = Math.round(Math.max(-NOTE_X_RANGE, Math.min(NOTE_X_RANGE, w.x)) * 10) / 10;
        const cy = Math.round(Math.max(-NOTE_Y_RANGE, Math.min(NOTE_Y_RANGE, w.y)) * 10) / 10;
        p.onPlaceEditorNote?.(cx, cy);
        return;
      }
      const id = hitTestEditorNote(w.x, w.y);
      p.onSelectEditorNote?.(id);
      if (id) {
        editorDragging = true;
        editorDragPid = pid;
        editorDragTargetId = id;
      }
    }

    /** 绑定指针/触摸/鼠标输入；返回解绑函数。
     *  StrictMode 下 effect 会执行两次（mount→cleanup→mount）。若不在 cleanup 里解绑，
     *  同一 canvas 上会叠加两份监听 → 一次点击触发两次（编辑器表现为"一次放两个音符"）。 */
    function bindInput(el: HTMLCanvasElement): () => void {
      const removers: Array<() => void> = [];
      const add = (
        target: EventTarget,
        type: string,
        fn: EventListener,
        opts?: AddEventListenerOptions | boolean,
      ): void => {
        target.addEventListener(type, fn, opts);
        removers.push(() => target.removeEventListener(type, fn, opts));
      };

      let cachedRect: DOMRect | null = null;
      const rect = (): DOMRect => {
        if (!cachedRect) cachedRect = el.getBoundingClientRect();
        return cachedRect;
      };
      const invalidate = (): void => {
        cachedRect = null;
      };
      add(window, 'resize', invalidate);
      add(window, 'scroll', invalidate, true);
      add(window, 'orientationchange', invalidate);
      const offset = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
        const r = rect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };

      if (window.PointerEvent) {
        add(el, 'pointerdown', (e) => {
          const ev = e as PointerEvent;
          const p = offset(ev);
          if (ev.preventDefault) ev.preventDefault();
          try {
            el.setPointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
          handleTapInput(p.x, p.y, String(ev.pointerId), ev.pointerType || 'mouse');
          pendingMoves[String(ev.pointerId)] = {
            sx: p.x,
            sy: p.y,
            down: true,
            active: true,
            type: ev.pointerType || 'mouse',
          };
        });
        add(el, 'contextmenu', (e) => {
          const ev = e as MouseEvent;
          if (ev.preventDefault) ev.preventDefault();
        });
        add(el, 'pointermove', (e) => {
          const ev = e as PointerEvent;
          const p = offset(ev);
          const pr = propsRef.current;
          /* 编辑器拖拽：仅发起拖拽的那个指针可移动选中音符。 */
          if (pr.isEditorMode && editorDragging && editorDragPid === String(ev.pointerId) && editorDragTargetId) {
            const w = screenToWorld(p.x, p.y);
            pr.onMoveEditorNote?.(editorDragTargetId, w.x, w.y);
            return;
          }
          const prev = pendingMoves[String(ev.pointerId)];
          if (prev) {
            prev.sx = p.x;
            prev.sy = p.y;
          } else {
            const type = ev.pointerType || 'mouse';
            pendingMoves[String(ev.pointerId)] = { sx: p.x, sy: p.y, down: false, active: type === 'mouse', type };
          }
        });
        const release = (pid: number): void => {
          try {
            el.releasePointerCapture(pid);
          } catch {
            /* ignore */
          }
          if (editorDragPid === String(pid)) {
            editorDragging = false;
            editorDragPid = null;
            editorDragTargetId = null;
          }
          delete pendingMoves[String(pid)];
          handleReleaseInput(String(pid));
        };
        add(el, 'pointerup', (e) => release((e as PointerEvent).pointerId));
        add(el, 'pointercancel', (e) => release((e as PointerEvent).pointerId));
        add(el, 'pointerleave', (e) => release((e as PointerEvent).pointerId));
        return () => removers.forEach((r) => r());
      }

      /* 旧 Safari 的 Touch 回退 */
      add(el, 'touchstart', (e) => {
        const ev = e as TouchEvent;
        ev.preventDefault();
        for (let i = 0; i < ev.changedTouches.length; i++) {
          const t = ev.changedTouches[i];
          const r = rect();
          handleTapInput(t.clientX - r.left, t.clientY - r.top, String(t.identifier), 'touch');
        }
      });
      add(el, 'touchmove', (e) => {
        const ev = e as TouchEvent;
        ev.preventDefault();
        for (let i = 0; i < ev.changedTouches.length; i++) {
          const t = ev.changedTouches[i];
          const r = rect();
          pendingMoves[String(t.identifier)] = {
            sx: t.clientX - r.left,
            sy: t.clientY - r.top,
            down: true,
            active: true,
            type: 'touch',
          };
        }
      });
      add(el, 'touchend', (e) => {
        const ev = e as TouchEvent;
        for (let i = 0; i < ev.changedTouches.length; i++) {
          delete pendingMoves[String(ev.changedTouches[i].identifier)];
          handleReleaseInput(String(ev.changedTouches[i].identifier));
        }
      });
      add(el, 'touchcancel', (e) => {
        const ev = e as TouchEvent;
        for (let i = 0; i < ev.changedTouches.length; i++) {
          delete pendingMoves[String(ev.changedTouches[i].identifier)];
          handleReleaseInput(String(ev.changedTouches[i].identifier));
        }
      });
      /* 鼠标回退（hover 触发 touch note） */
      add(el, 'mousedown', (e) => {
        const ev = e as MouseEvent;
        const r = rect();
        handleTapInput(ev.clientX - r.left, ev.clientY - r.top, 'mouse', 'mouse');
      });
      add(el, 'mousemove', (e) => {
        const ev = e as MouseEvent;
        const r = rect();
        pendingMoves['mouse'] = {
          sx: ev.clientX - r.left,
          sy: ev.clientY - r.top,
          down: false,
          active: true,
          type: 'mouse',
        };
      });
      add(el, 'mouseleave', () => handleReleaseInput('mouse'));
      add(document, 'mouseup', () => handleReleaseInput('mouse'));
      return () => removers.forEach((r) => r());
    }

    /* ---------------- 主循环 ---------------- */
    resize();
    const unbindInput = bindInput(canvas);
    resetGame(propsRef.current.chart);

    let raf = 0;
    function loop(): void {
      const p = propsRef.current;
      if (p.viewportActive === false) {
        raf = requestAnimationFrame(loop);
        return;
      }
      game.autoPlay = p.autoPlay;
      game.speedMul = p.speedMultiplier;
      game.renderDist = p.noteRenderDistance;
      game.sizeScale = p.noteSizeScale;
      /* 皮肤状态同步（每帧，开销可忽略）。 */
      skin.images = p.skinImages ?? null;
      skin.innerEnabled = p.defaultSkinInnerEnabled ?? true;
      skin.outerEnabled = p.defaultSkinOuterEnabled ?? false;
      skin.outerWidth = p.defaultSkinOuterWidth ?? 0.05;
      skin.outerColor = p.defaultSkinOuterColor ?? '#22d3ee';
      skin.outerAlpha = p.defaultSkinOuterAlpha ?? 1;
      skin.judgeWidth = p.defaultSkinJudgeWidth ?? 0.05;
      if (p.isEditorMode) {
        /* 编辑器：始终渲染（未播放时按 gameTime 静态预览，播放时跟音频时钟）。 */
        game.curTime = p.isPlaying ? globalAudio.getCurrentTime() : (p.gameTime ?? 0);
        render();
      } else if (p.isPlaying) {
        game.curTime = globalAudio.getCurrentTime();
        flushPointerMoves();
        render();
      } else if (p.isPaused) {
        render();
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unbindInput();
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      resetRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full touch-none" data-renderer="2d" />;
}
