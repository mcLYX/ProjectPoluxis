import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartData } from '../types/game';
import { buildChartDensity } from '../utils/chartDensity';
import { useEditorTime } from '../editorTimeStore';
import { useI18n } from '../i18n';

/**
 * 热力时间轴（紧凑版）：谱面按拍切桶，柱高 = 该区间音符密度，柱体按
 * tap / touch / slide 三类堆叠着色；播放头为贯穿竖线 + 顶部菱形标记。
 *
 * 布局压缩：当前拍 / 总长直接画进条内（带暗色胶囊底衬保证在柱体上仍可读），
 * 不再占用独立信息行；拖动时柱体转为半透明以强化 scrub 反馈。
 *
 * ## 性能
 * 直方图与播放无关，**只有播放头在动**：
 *  - 柱体只在 (chart, maxBeat, 桶数, 尺寸, dpr) 变化时重算并重绘到**离屏 canvas**；
 *  - 每帧只做 clearRect + drawImage(离屏) + 文字/竖线 → 每帧 O(1)。
 * 桶数由容器宽度经 ResizeObserver 决定（48~192），宽度不变则不重算。
 * 播放头经 useEditorTime 订阅（~30fps），不触发编辑器本体重渲染。
 */

const BAR_H = 30;
/** 基线下方留白（0：进度条底边即轴线，不留白）。 */
const BASE_PAD = 0;
/** 柱体顶部余量：留出播放头顶部菱形指示针的高度（≈7px）+少许间隙，
 *  保证最高柱略低于指示针、顶端菱形清晰可读。 */
const TOP_PAD = 8;
/** 非空桶的最小可见高度（px），避免稀疏处柱体细到看不见。 */
const MIN_BAR_H = 1.5;
/** 热度柱常驻透明度（半透明，避免喧宾夺主；拍数文字另用不透明绘制）。 */
const BAR_ALPHA = 0.5;

const TYPE_FILL = {
  tap: 'rgba(34,211,238,0.72)',
  touch: 'rgba(251,191,36,0.72)',
  slide: 'rgba(167,139,250,0.72)',
} as const;
const ACCENT = '#00F0FF';

const FONT = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';

interface EditorHeatScrubberProps {
  chart: ChartData;
  /** 时间窗口上界（拍）。 */
  maxBeat: number;
  /** 点击/拖拽定位的吸附步长（拍）。 */
  snapSubdivision: number;
  onSeek: (beat: number) => void;
}

export const EditorHeatScrubber: React.FC<EditorHeatScrubberProps> = ({
  chart,
  maxBeat,
  snapSubdivision,
  onSeek,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const [size, setSize] = useState({ w: 0, h: BAR_H });
  const { beat } = useEditorTime();
  const { t } = useI18n();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      // 高度跟随容器（容器被 flex 拉伸时占满整行，消除上下留白）。
      const h = el.clientHeight || BAR_H;
      if (w > 0) setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bucketCount = useMemo(() => {
    if (size.w <= 0) return 64;
    return Math.max(48, Math.min(192, Math.floor(size.w / 4)));
  }, [size.w]);

  const density = useMemo(
    () => buildChartDensity(chart, maxBeat, bucketCount),
    [chart, maxBeat, bucketCount]
  );

  const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

  /** 把堆叠柱画进离屏 canvas（缓存层）。 */
  const renderBars = () => {
    const cssW = size.w;
    const cssH = size.h;
    if (cssW <= 0 || cssH <= 0) return;
    let off = offRef.current;
    if (!off) {
      off = document.createElement('canvas');
      offRef.current = off;
    }
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (off.width !== pw || off.height !== ph) {
      off.width = pw;
      off.height = ph;
    }
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, cssW, cssH);

    const n = density.bucketCount;
    const maxCount = density.maxCount;
    if (maxCount <= 0) return;

    const usableH = Math.max(1, cssH - BASE_PAD - TOP_PAD);
    const unit = usableH / maxCount;
    const slot = cssW / n;
    const barW = Math.max(1, slot - 1);
    // 进度条底边即轴线（无额外留白、无淡色基线）。
    const baseline = cssH;

    for (let i = 0; i < n; i++) {
      const tot = density.total[i];
      if (tot <= 0) continue;
      const rawH = tot * unit;
      // 极小值抬到最小可见高度（保持三类构成比例不变）。
      const scale = rawH < MIN_BAR_H ? MIN_BAR_H / rawH : 1;
      const x = i * slot;
      let y = baseline;
      const stack: Array<[Uint32Array, string]> = [
        [density.tap, TYPE_FILL.tap],
        [density.touch, TYPE_FILL.touch],
        [density.slide, TYPE_FILL.slide],
      ];
      for (const [arr, color] of stack) {
        const c = arr[i];
        if (c <= 0) continue;
        const h = c * unit * scale;
        octx.fillStyle = color;
        octx.fillRect(x, y - h, barW, h);
        y -= h;
      }
    }
  };

  /** 每帧合成：离屏柱体 + 条内文字 + 播放头。 */
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssW = size.w;
    const cssH = size.h;
    if (cssW <= 0 || cssH <= 0) return;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 热度柱常驻半透明。
    ctx.globalAlpha = BAR_ALPHA;
    const off = offRef.current;
    if (off && off.width > 0) ctx.drawImage(off, 0, 0, cssW, cssH);

    // 文字 / 播放头恢复不透明（文字必须在 globalAlpha=1 下绘制）。
    ctx.globalAlpha = 1;

    // ---- 条内文字：左=当前拍，右=总长（去掉暗底，改用阴影保证可读）----
    ctx.font = FONT;
    const span = maxBeat > 0 ? maxBeat : 1;
    const cy = cssH / 2;
    drawShadowText(ctx, `Beat ${beat.toFixed(2)}`, 6, cy, ACCENT, 'left');
    drawShadowText(ctx, span.toFixed(2), cssW - 6, cy, 'rgba(255,255,255,0.9)', 'right');

    // ---- 播放头 ----
    const px = Math.max(0, Math.min(cssW, (beat / span) * cssW));
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, cssH);
    ctx.stroke();
    // 顶部菱形标记（呼应 slide 的菱形语言）
    ctx.shadowBlur = 4;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(px, 0.5);
    ctx.lineTo(px + 3, 3.5);
    ctx.lineTo(px, 6.5);
    ctx.lineTo(px - 3, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // 柱体缓存：谱面 / 尺寸 / 桶数变化时才重绘离屏层。
  useEffect(() => {
    renderBars();
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density, size.w, size.h, dpr]);

  // 播放头：每次渲染（beat 更新）重绘薄层。
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const beatFromClientX = (clientX: number): number => {
    const el = canvasRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    const span = maxBeat > 0 ? maxBeat : 1;
    let b = (x / Math.max(1, r.width)) * span;
    const snap = snapSubdivision > 0 ? snapSubdivision : 1 / 16;
    b = Math.round(b / snap) * snap;
    return Math.max(0, Math.min(span, b));
  };

  return (
    <div ref={wrapRef} className="w-full h-full">
      <canvas
        ref={canvasRef}
        className="block w-full cursor-pointer"
        style={{ height: size.h || BAR_H, touchAction: 'none' }}
        title={t('editor.seekHint')}
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
          onSeek(beatFromClientX(e.clientX));
          draw();
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          onSeek(beatFromClientX(e.clientX));
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          (e.currentTarget as HTMLCanvasElement).releasePointerCapture?.(e.pointerId);
          draw();
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
          draw();
        }}
      />
    </div>
  );
};

/** 阴影文字：去掉暗色底衬，改用「黑色描边 + 投影」保证可读。
 *  纯黑投影在深色底上看不见，故先以黑色描边（硬阴影轮廓）勾边，
 *  再填色，深浅柱体上均清晰。 */
function drawShadowText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: 'left' | 'right'
): void {
  ctx.font = FONT;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 3;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
