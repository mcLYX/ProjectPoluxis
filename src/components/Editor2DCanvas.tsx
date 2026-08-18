import { useCallback, useEffect, useRef } from 'react';
import { globalAudio } from '../audio/AudioManager';
import { beatToSecondsMultiBpm, secondsToBeatMultiBpm } from '../utils/beatTime';
import { EASING_FNS } from '../utils/easing';
import type { ChartData, NoteData, EasingType } from '../types/game';
import type { EditorTool, MarqueeMode } from './VisualChartEditor';
import { liveDragStore } from '../liveDragStore';

/** World X range used by the game's judgement plane. */
const X_MIN = -2.4;
const X_MAX = 2.4;
const X_SPAN = X_MAX - X_MIN;
/** Round to at most 9 decimal places to avoid floating-point jitter in coords/beats. */
const round9 = (v: number) => Math.round(v * 1000000000) / 1000000000;
const NOTE_R = 11;
/** Fraction of the canvas width used by the centered playfield. */
const FIELD_WIDTH_RATIO = 0.62;
/** Horizontal inner padding (px) so edge notes (x = ±2.4) aren't clipped. */
const FIELD_INNER_PAD_X = 30;
/** Vertical position of the judgement line (fraction of field height from top).
 *  More room above for upcoming (future) notes. */
const JUDGE_FRAC = 0.8;

interface Editor2DCanvasProps {
  chart: ChartData;
  gameTime: number;
  isPlaying: boolean;
  snapSubdivision: number;
  activeTool: EditorTool;
  selectedNoteId: string | null;
  /** 多选模式开启时，在画布空白处拖动变为框选而非移动时间轴。 */
  isMultiSelect: boolean;
  /** 当前多选集合（note base id）。 */
  selectedNoteIds: string[];
  /** 框选合并方式。 */
  marqueeMode: MarqueeMode;
  /** Number of vertical grid lines (incl. both edges); sets X snap columns. */
  vlineCount: number;
  /** Vertical pixels between adjacent integer beats (横向 zoom for the time axis). */
  pxPerBeat: number;
  /** Place a note. Returns the placed note/child id and its actual x/y/beat
   *  (after DSL) — or null on failure. y defaults to 0 in 2D but can be
   *  adjusted by dragging vertically immediately after placing. */
  onPlaceNote: (x: number, y: number, beat: number) => { id: string; x: number; y: number; beat: number } | null;
  /** Move/resize a note or slide child node. beat may be undefined to keep it. */
  onMoveNote: (id: string, x: number, y: number, beat: number) => void;
  onSelectNote: (id: string | null) => void;
  onSeekBeat: (beat: number) => void;
  /** 覆盖式设置多选集合（null = 清空）。 */
  onSelectNotes: (ids: string[] | null) => void;
  /** 按当前 marqueeMode 合并框选命中的 note id 到多选集合。 */
  onMarqueeSelect: (hitIds: string[], mode: MarqueeMode) => void;
  /** 多选批量移动：写入一组绝对位置（头节点与子节点 id 均可）。 */
  onMoveNotes: (positions: Array<{ id: string; x: number; y: number; beat: number }>) => void;
}

/* Beat <-> chart-time conversion. Both directions delegate to the shared
 * implementation in beatTime.ts — this file used to carry its own segment
 * walker, which was a third copy of the same maths and drifted from the
 * canonical one. `Tempo` is just the metadata slice they need, cached in a ref
 * so it only changes when the chart's tempo map does. */
type Tempo = { bpm: number; offset: number; bpmlist?: ChartData['metadata']['bpmlist'] };

function buildSegments(chart: ChartData): Tempo {
  const { bpm, offset, bpmlist } = chart.metadata;
  return { bpm, offset: offset || 0, bpmlist };
}

function timeToBeat(t: number, tempo: Tempo): number {
  return secondsToBeatMultiBpm(t, tempo.bpm, tempo.offset, tempo.bpmlist);
}

function beatToSecondsLocal(beat: number, tempo: Tempo): number {
  return beatToSecondsMultiBpm(beat, tempo.bpm, tempo.offset, tempo.bpmlist);
}

function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export const Editor2DCanvas: React.FC<Editor2DCanvasProps> = ({
  chart,
  gameTime,
  isPlaying,
  snapSubdivision,
  activeTool,
  selectedNoteId,
  isMultiSelect,
  selectedNoteIds,
  marqueeMode,
  vlineCount,
  pxPerBeat,
  onPlaceNote,
  onMoveNote,
  onSelectNote,
  onSeekBeat,
  onSelectNotes,
  onMarqueeSelect,
  onMoveNotes,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const chartRef = useRef(chart);
  chartRef.current = chart;
  const segsRef = useRef(buildSegments(chart));
  useEffect(() => {
    segsRef.current = buildSegments(chart);
  }, [chart]);

  const snapRef = useRef(snapSubdivision);
  snapRef.current = snapSubdivision;
  const toolRef = useRef(activeTool);
  toolRef.current = activeTool;
  const selectedRef = useRef(selectedNoteId);
  selectedRef.current = selectedNoteId;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const gameTimeRef = useRef(gameTime);
  gameTimeRef.current = gameTime;

  const onPlaceRef = useRef(onPlaceNote);
  onPlaceRef.current = onPlaceNote;
  const onMoveRef = useRef(onMoveNote);
  onMoveRef.current = onMoveNote;
  const onSelectRef = useRef(onSelectNote);
  onSelectRef.current = onSelectNote;
  const onSeekRef = useRef(onSeekBeat);
  onSeekRef.current = onSeekBeat;
  const onSelectNotesRef = useRef(onSelectNotes);
  onSelectNotesRef.current = onSelectNotes;
  const onMarqueeSelectRef = useRef(onMarqueeSelect);
  onMarqueeSelectRef.current = onMarqueeSelect;
  const onMoveNotesRef = useRef(onMoveNotes);
  onMoveNotesRef.current = onMoveNotes;

  const multiSelectRef = useRef(isMultiSelect);
  multiSelectRef.current = isMultiSelect;
  const selectedIdsRef = useRef<string[]>(selectedNoteIds);
  selectedIdsRef.current = selectedNoteIds;
  const marqueeModeRef = useRef<MarqueeMode>(marqueeMode);
  marqueeModeRef.current = marqueeMode;

  // Live-drag override: while a note is being dragged we keep its position in
  // a ref and let the canvas draw loop render it every frame — this gives
  // real-time visual feedback WITHOUT re-rendering the React tree (which, with
  // ~2000 notes, is far too expensive to do at 60–120Hz, especially on Android
  // Chromium). State is committed (throttled) so the side panel stays roughly
  // in sync, and final-committed on pointer up.
  const dragLiveRef = useRef<{ id: string; x: number; y: number; beat: number } | null>(null);
  const lastCommitRef = useRef(0);
  const commitMove = useCallback(() => {
    const m = dragLiveRef.current;
    if (m) onMoveRef.current(m.id, m.x, m.y, m.beat);
  }, []);

  const vlineRef = useRef(vlineCount);
  vlineRef.current = vlineCount;
  const pxPerBeatRef = useRef(pxPerBeat);
  pxPerBeatRef.current = pxPerBeat;

  // Drag state
  const dragRef = useRef<{
    id: string | null;
    isNew: boolean;
    isScrub: boolean;
    isMarquee: boolean;
    isMultiDrag: boolean;
    offBeat: number;
    offX: number;
    y0: number;
    lastPy: number;
    moved: boolean;
    /** Marquee start pixel (for drawing the selection rectangle). */
    mx0: number;
    my0: number;
    /** Multi-drag: snapshot of all selected notes' (id, beat, x, y) at drag start. */
    multiSnapshot?: Array<{ id: string; beat: number; x: number; y: number }>;
    /** Multi-drag: the grabbed note's id (child id may be grabbed; used for delta). */
    multiGrabId?: string;
    /** Multi-drag: base (head) id of the grabbed note — used to toggle selection off. */
    multiGrabBaseId?: string;
    /** Placing mode: the just-placed note can be vertically dragged to adjust Y
     *  before releasing. */
    isPlacing?: boolean;
    /** Y-adjust: pointer Y at placement start (pixels). */
    placeStartPy?: number;
    /** Y-adjust: current applied Y value (world units). */
    placeY?: number;
    /** Y-adjust: original X (world units) of the placed note — kept constant. */
    placeX?: number;
    /** Y-adjust: original beat of the placed note — kept constant. */
    placeBeat?: number;
  } | null>(null);

  /** Current marquee rectangle in CSS pixels (for drawing during drag). */
  const marqueeRectRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  /** Multi-drag live positions: id (head or child "head#i") -> absolute position.
   *  Read by the render loop for real-time drawing; committed once on release. */
  const multiLiveRef = useRef<Map<string, { x: number; y: number; beat: number }> | null>(null);

  /** Compute the centered playfield rect in CSS pixels. */
  const fieldRect = useCallback((w: number, h: number) => {
    const fieldW = Math.max(120, Math.min(w, w * FIELD_WIDTH_RATIO));
    const left = (w - fieldW) / 2;
    return { left, width: fieldW, top: 0, height: h };
  }, []);

  /** Convert canvas pixel -> { time(sec), worldX } using beat-space + pxPerBeat. */
  const pixelToWorld = useCallback((px: number, py: number, w: number, h: number, curTime: number) => {
    const { left, width, top, height } = fieldRect(w, h);
    const fl = left + FIELD_INNER_PAD_X;
    const fw = width - FIELD_INNER_PAD_X * 2;
    const segs = segsRef.current;
    const curBeat = timeToBeat(curTime, segs);
    const judgeY = top + height * JUDGE_FRAC;
    const beat = curBeat + (judgeY - py) / pxPerBeatRef.current;
    const t = beatToSecondsLocal(beat, segs);
    const lx = Math.max(0, Math.min(1, (px - fl) / fw));
    const worldX = X_MIN + lx * X_SPAN;
    return { t, worldX };
  }, [fieldRect]);

  const worldToPixel = useCallback((t: number, worldX: number, w: number, h: number, curTime: number) => {
    const { left, width, top, height } = fieldRect(w, h);
    const fl = left + FIELD_INNER_PAD_X;
    const fw = width - FIELD_INNER_PAD_X * 2;
    const segs = segsRef.current;
    const curBeat = timeToBeat(curTime, segs);
    const judgeY = top + height * JUDGE_FRAC;
    const beat = timeToBeat(t, segs);
    const py = judgeY - (beat - curBeat) * pxPerBeatRef.current;
    const lx = (worldX - X_MIN) / X_SPAN;
    const px = fl + lx * fw;
    return { px, py };
  }, [fieldRect]);

  // ===== Render loop =====
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    // Backing-store scale capped at 2 for crisp grid/beat text. Frame rate on
    // Android is now protected by unmounting the 3D viewport while in 2D mode,
    // so the old dpr-1 workaround (which traded sharpness for FPS) is unnecessary.
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = () => {
      const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
      const chart = chartRef.current;
      const segs = segsRef.current;
      const { bpm, offset, bpmlist, noteColor } = chart.metadata;
      const w = canvas.width;
      const h = canvas.height;

      ctx.save();
      ctx.scale(dpr, dpr);
      const cssW = w / dpr;
      const cssH = h / dpr;

      // Background (whole canvas)
      ctx.fillStyle = '#070a0f';
      ctx.fillRect(0, 0, cssW, cssH);

      const field = fieldRect(cssW, cssH);
      // Clip drawing to the centered playfield
      ctx.save();
      ctx.beginPath();
      ctx.rect(field.left, field.top, field.width, field.height);
      ctx.clip();
      // Playfield background
      ctx.fillStyle = 'rgba(10,16,24,0.9)';
      ctx.fillRect(field.left, field.top, field.width, field.height);

      // Lane separators (vertical) — same inner inset as notes, so they align.
      ctx.lineWidth = 1;
      const vlines = Math.max(2, vlineRef.current | 0);
      const xStep = X_SPAN / (vlines - 1);
      for (let i = 0; i < vlines; i++) {
        const lx = X_MIN + i * xStep;
        const lx01 = (lx - X_MIN) / X_SPAN;
        const px = field.left + FIELD_INNER_PAD_X + lx01 * (field.width - FIELD_INNER_PAD_X * 2);
        ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)';
        ctx.beginPath();
        ctx.moveTo(px, field.top);
        ctx.lineTo(px, field.top + field.height);
        ctx.stroke();
      }

      // Beat grid lines (horizontal) — derived from the pxPerBeat vertical scale.
      const fl = field.left + FIELD_INNER_PAD_X;
      const fw = field.width - FIELD_INNER_PAD_X * 2;
      const judgeY = field.top + field.height * JUDGE_FRAC;
      const curBeat = timeToBeat(curTime, segs);
      const topBeat = curBeat + (judgeY - field.top) / pxPerBeatRef.current;
      const botBeat = curBeat + (judgeY - (field.top + field.height)) / pxPerBeatRef.current;
      const startBeat = Math.floor(Math.min(topBeat, botBeat)) - 1;
      const endBeat = Math.ceil(Math.max(topBeat, botBeat)) + 1;
      const subdiv = snapRef.current;
      for (let b = startBeat; b <= endBeat; b += subdiv) {
        const tb = beatToSecondsMultiBpm(b, bpm, offset, bpmlist);
        const py = worldToPixel(tb, 0, cssW, cssH, curTime).py;
        if (py < field.top - 2 || py > field.top + field.height + 2) continue;
        const isInteger = Number.isInteger(Math.round(b * 1000) / 1000);
        ctx.strokeStyle = isInteger ? 'rgba(120,200,255,0.18)' : 'rgba(120,200,255,0.07)';
        ctx.lineWidth = isInteger ? 1.2 : 0.6;
        ctx.beginPath();
        ctx.moveTo(fl, py);
        ctx.lineTo(fl + fw, py);
        ctx.stroke();
        if (isInteger && b >= 0) {
          ctx.fillStyle = 'rgba(150,210,255,0.5)';
          ctx.font = `${10 * dpr}px monospace`;
          ctx.fillText(`${Math.round(b)}`, fl + 4, py - 3);
        }
      }

      // Judgement line (current time) — sits at judgeY.
      ctx.strokeStyle = 'rgba(0,240,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fl, judgeY);
      ctx.lineTo(fl + fw, judgeY);
      ctx.stroke();
      // glow
      ctx.fillStyle = 'rgba(0,240,255,0.10)';
      ctx.fillRect(fl, judgeY - 8, fw, 16);

      // Notes
      const drawNoteShape = (
        type: 'tap' | 'touch' | 'slide',
        px: number,
        py: number,
        color: string,
        selected: boolean,
        angle = 0
      ) => {
        ctx.save();
        ctx.translate(px, py);
        // Canvas positive rotation is clockwise; we keep +angle = clockwise and
        // align the 3D view to this convention (3D negates angle on rotation.z).
        ctx.rotate((angle * Math.PI) / 180);
        if (selected) {
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 14;
        }
        ctx.fillStyle = color;
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.5)';
        ctx.lineWidth = selected ? 2.5 : 1.5;
        if (type === 'touch') {
          ctx.beginPath();
          ctx.arc(0, 0, NOTE_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (type === 'slide') {
          ctx.rotate(Math.PI / 4); // square → diamond, on top of the node angle
          ctx.fillRect(-NOTE_R * 0.85, -NOTE_R * 0.85, NOTE_R * 1.7, NOTE_R * 1.7);
          ctx.strokeRect(-NOTE_R * 0.85, -NOTE_R * 0.85, NOTE_R * 1.7, NOTE_R * 1.7);
        } else {
          // tap = square
          ctx.fillRect(-NOTE_R, -NOTE_R, NOTE_R * 2, NOTE_R * 2);
          ctx.strokeRect(-NOTE_R, -NOTE_R, NOTE_R * 2, NOTE_R * 2);
        }
        ctx.restore();
      };

      // Visible beat window for culling: only build/draw what's on screen.
      const CULL_MARGIN = 8; // beats of slack around the visible field
      const winMin = Math.min(topBeat, botBeat) - CULL_MARGIN;
      const winMax = Math.max(topBeat, botBeat) + CULL_MARGIN;

      // Build a flat list of drawable items: head + slide nodes.
      // While a note is being dragged, override its (head) position with the
      // live-drag ref so the canvas reflects the drag in real time without any
      // React state update. Notes (and their slide chains) outside the visible
      // beat window are culled so per-frame work scales with what's on screen
      // rather than the whole chart — critical for long charts on mobile Blink.
      const live = dragLiveRef.current;
      const multiLive = multiLiveRef.current;
      const multiPos = (id: string) => (multiLive ? multiLive.get(id) : undefined);
      type Item = { id: string; type: NoteData['type']; beat: number; x: number; color: string; angle: number };
      const items: Item[] = [];
      const slideChains: Array<{ id: string; type: NoteData['type']; color: string; pts: Array<{ x: number; beat: number; easing: EasingType }> }> = [];
      for (const n of chart.notes) {
        const color = n.color || noteColor;
        const headAngle = n.angle ?? 0;
        const mp = multiPos(n.id);
        const isLive = (live != null && n.id === live.id) || mp != null;
        const headX = mp ? mp.x : (live != null && n.id === live.id ? live.x : n.x);
        const headBeat = mp ? mp.beat : (live != null && n.id === live.id ? live.beat : n.beat);
        // Cull notes outside the visible window (always keep the live-dragged one).
        let inView = isLive || (headBeat >= winMin && headBeat <= winMax);
        if (!inView && n.nodes && n.nodes.length > 0) {
          for (const nd of n.nodes) {
            if (nd.beat >= winMin && nd.beat <= winMax) { inView = true; break; }
          }
        }
        if (!inView) continue;
        items.push({ id: n.id, type: n.type, beat: headBeat, x: headX, color, angle: headAngle });
        if (n.nodes && n.nodes.length > 0) {
          const pts = [
            { x: headX, beat: headBeat, easing: n.easing ?? 'linear' },
            ...n.nodes.map((nd, i) => {
              const childId = `${n.id}#${i + 1}`;
              const mc = multiPos(childId);
              const liveChild = live != null && childId === live.id ? live : null;
              return {
                x: mc ? mc.x : (liveChild ? liveChild.x : nd.x),
                beat: mc ? mc.beat : (liveChild ? liveChild.beat : nd.beat),
                easing: nd.easing ?? n.easing ?? 'linear',
              };
            }),
          ];
          slideChains.push({ id: n.id, type: n.type, color, pts });
          n.nodes.forEach((nd, k) => {
            const childId = `${n.id}#${k + 1}`;
            const mc = multiPos(childId);
            const liveChild = live != null && childId === live.id ? live : null;
            items.push({
              id: childId,
              type: n.type,
              beat: mc ? mc.beat : (liveChild ? liveChild.beat : nd.beat),
              x: mc ? mc.x : (liveChild ? liveChild.x : nd.x),
              color,
              angle: nd.angle ?? headAngle,
            });
          });
        }
      }

      // Slide connectors + playhead markers. The connector is drawn as the easing
      // curve: the travel axis (horizontal = world x) follows EASING_FNS[easing](τ)
      // while the time axis (vertical) advances linearly with τ. This bows *along*
      // the direction of travel, so a left/right slide bows left/right (matching the
      // 3D pipe). The playhead dot uses the same mapping: eased x, linear-time y.
      const EASE_STEPS = 24;
      for (const chain of slideChains) {
        const pxPts = chain.pts.map((pt) => {
          const tb = beatToSecondsMultiBpm(pt.beat, bpm, offset, bpmlist);
          return worldToPixel(tb, pt.x, cssW, cssH, curTime);
        });
        // 非 Slide 链（tap/touch 链）用更细的虚线连接，以示与 Slide 链区分。
        const isSlide = chain.type === 'slide';
        ctx.strokeStyle = chain.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = isSlide ? 3 : 1.5;
        if (!isSlide) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        for (let s = 0; s < pxPts.length - 1; s++) {
          const a = pxPts[s], b = pxPts[s + 1];
          const ease = EASING_FNS[chain.pts[s + 1].easing ?? 'linear'] ?? EASING_FNS.linear;
          if (s === 0) ctx.moveTo(a.px, a.py);
          for (let k = 1; k <= EASE_STEPS; k++) {
            const tau = k / EASE_STEPS;
            const e = ease(tau);
            const x = a.px + (b.px - a.px) * e;
            const y = a.py + (b.py - a.py) * tau;
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        ctx.fillStyle = chain.color;
        for (let s = 0; s < pxPts.length - 1; s++) {
          const a = pxPts[s], b = pxPts[s + 1];
          const tA = beatToSecondsMultiBpm(chain.pts[s].beat, bpm, offset, bpmlist);
          const tB = beatToSecondsMultiBpm(chain.pts[s + 1].beat, bpm, offset, bpmlist);
          const segDur = Math.max(1e-4, tB - tA);
          const tau = Math.min(1, Math.max(0, (curTime - tA) / segDur));
          if (tau <= 0 || tau >= 1) continue;
          const e = EASING_FNS[chain.pts[s + 1].easing ?? 'linear'](tau);
          const mx = a.px + (b.px - a.px) * e;
          const my = a.py + (b.py - a.py) * tau;
          ctx.beginPath();
          ctx.arc(mx, my, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw notes (future first so near-line notes draw on top)
      const multiIds = selectedIdsRef.current;
      const multiSet = multiIds.length > 0 ? new Set(multiIds) : null;
      for (const it of items) {
        const tb = beatToSecondsMultiBpm(it.beat, bpm, offset, bpmlist);
        const { px, py } = worldToPixel(tb, it.x, cssW, cssH, curTime);
        if (py < field.top - 60 || py > field.top + field.height + 60) continue;
        // 高亮精确选中的单位（头节点或子节点独立高亮）。
        const selected = it.id === selectedRef.current || (multiSet != null && multiSet.has(it.id));
        drawNoteShape(it.type, px, py, it.color, selected, it.angle);
      }

      // Draw marquee selection rectangle (if active).
      const mq = marqueeRectRef.current;
      if (mq) {
        const x = Math.min(mq.x0, mq.x1);
        const y = Math.min(mq.y0, mq.y1);
        const ww = Math.abs(mq.x1 - mq.x0);
        const hh = Math.abs(mq.y1 - mq.y0);
        ctx.save();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
        ctx.fillStyle = 'rgba(251, 191, 36, 0.1)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.fillRect(x, y, ww, hh);
        ctx.strokeRect(x, y, ww, hh);
        ctx.restore();
      }

      // close field clip
      ctx.restore();
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      // Drop any live-drag override so the side panel doesn't show a frozen
      // value if this canvas unmounts mid-drag (e.g. switching to 3D).
      liveDragStore.clear();
    };
  }, [worldToPixel]);

  // ===== Pointer interaction =====
  const hitTest = (px: number, py: number): { id: string; beat: number; x: number; y: number } | null => {
    const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
    const chart = chartRef.current;
    const { bpm, offset, bpmlist } = chart.metadata;
    const wrap = wrapRef.current!;
    const r = wrap.getBoundingClientRect();
    const cssW = r.width;
    const cssH = r.height;
    type Hit = { id: string; beat: number; x: number; y: number; d: number };
    let best: Hit | null = null;
    const candidates: Hit[] = [];
    const consider = (id: string, beat: number, x: number, y: number) => {
      const tb = beatToSecondsMultiBpm(beat, bpm, offset, bpmlist);
      const { px: ix, py: iy } = worldToPixel(tb, x, cssW, cssH, curTime);
      const d = Math.hypot(ix - px, iy - py);
      if (d <= NOTE_R + 6) candidates.push({ id, beat, x, y, d });
    };
    for (const n of chart.notes) {
      consider(n.id, n.beat, n.x, n.y);
      if (n.nodes) {
        n.nodes.forEach((nd, i) => consider(`${n.id}#${i + 1}`, nd.beat, nd.x, nd.y));
      }
    }
    for (const c of candidates) {
      if (!best || c.d < best.d) best = c;
    }
    const result: { id: string; beat: number; x: number; y: number } | null = best
      ? { id: best.id, beat: best.beat, x: best.x, y: best.y }
      : null;
    return result;
  };

  const getPos = (e: React.PointerEvent) => {
    const wrap = wrapRef.current!;
    const r = wrap.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { px, py, w, h } = getPos(e);
    const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
    const { bpm, offset, bpmlist } = chartRef.current.metadata;

    const hit = hitTest(px, py);
    const tool = toolRef.current;

    if (tool === 'select') {
      const isMulti = multiSelectRef.current;
      if (hit) {
        if (isMulti) {
          // 多选模式：点击音符。子节点与头节点独立选中（不带动整条链）。
          const alreadySelected = selectedIdsRef.current.includes(hit.id);
          if (alreadySelected) {
            // 已选中 → 开始多选拖拽（只移动被选中的单位：头节点或子节点）。
            // 点击时暂不 toggle；若 pointerup 时未移动，则在 up 中 toggle 取消选中。
            const selSet = new Set(selectedIdsRef.current);
            const snapshot: Array<{ id: string; beat: number; x: number; y: number }> = [];
            for (const n of chartRef.current.notes) {
              if (selSet.has(n.id)) snapshot.push({ id: n.id, beat: n.beat, x: n.x, y: n.y });
              if (n.nodes) {
                n.nodes.forEach((nd, i) => {
                  const cid = `${n.id}#${i + 1}`;
                  if (selSet.has(cid)) snapshot.push({ id: cid, beat: nd.beat, x: nd.x, y: nd.y });
                });
              }
            }
            const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
            const hitSec = beatToSecondsMultiBpm(hit.beat, bpm, offset, bpmlist);
            dragRef.current = {
              id: hit.id, isNew: false, isScrub: false, isMarquee: false, isMultiDrag: true,
              offBeat: t - hitSec, offX: worldX - hit.x, y0: hit.y, lastPy: py, moved: false,
              mx0: 0, my0: 0,
              multiSnapshot: snapshot, multiGrabId: hit.id, multiGrabBaseId: hit.id,
            };
            // 初始化所有选中音符的 live-drag（用各自当前位置，后续 move 更新）。
            for (const s of snapshot) {
              liveDragStore.set({ id: s.id, x: s.x, y: s.y, beat: s.beat });
            }
          } else {
            // 未选中 → 加入多选集合（App 的 onSelectNote 会 toggle 添加）。
            onSelectRef.current(hit.id);
          }
        } else {
          // 单选模式：选中并开始拖拽。
          onSelectRef.current(hit.id);
          const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
          const hitSec = beatToSecondsMultiBpm(hit.beat, bpm, offset, bpmlist);
          dragRef.current = { id: hit.id, isNew: false, isScrub: false, isMarquee: false, isMultiDrag: false, offBeat: t - hitSec, offX: worldX - hit.x, y0: hit.y, lastPy: py, moved: false, mx0: 0, my0: 0 };
          dragLiveRef.current = { id: hit.id, x: hit.x, y: hit.y, beat: hit.beat };
        }
      } else {
        // 空白处：
        // 框选仅在“音符编辑区域”（居中 playfield）内生效；区域外（左右空白）
        // 即使在多选模式也仍为移动时间轴（scrub）。
        const fr = fieldRect(w, h);
        const inField = px >= fr.left && px <= fr.left + fr.width;
        if (isMulti && inField) {
          // 多选模式 → 框选（不 scrub，不清除选中）。
          dragRef.current = { id: null, isNew: false, isScrub: false, isMarquee: true, isMultiDrag: false, offBeat: 0, offX: 0, y0: 0, lastPy: py, moved: false, mx0: px, my0: py };
          marqueeRectRef.current = { x0: px, y0: py, x1: px, y1: py };
        } else {
          // 区域外 / 单选模式 → 移动时间轴（scrub）。
          onSelectRef.current(null);
          dragRef.current = { id: null, isNew: false, isScrub: true, isMarquee: false, isMultiDrag: false, offBeat: 0, offX: 0, y0: 0, lastPy: py, moved: false, mx0: 0, my0: 0 };
        }
      }
      return;
    }

    // placement tools
    const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
    const beat = round9(snap(timeToBeat(t, segsRef.current), snapRef.current));
    const xStep = X_SPAN / Math.max(1, (vlineRef.current | 0) - 1);
    const x = round9(snap(worldX, xStep));
    // 放置音符；返回新 note/子节点 id，以便按住不放上下拖动调整 Y 值。
    const placed = onPlaceRef.current(x, 0, beat);
    if (placed) {
      // 进入 Y 调整模式：垂直拖动超过死区后按 0.1 步进调整 y。
      // 基准为 DSL 处理后的实际 x/y/beat（placed.*）——规则可能改写 x/beat，
      // 拖动调 Y 时保持规则结果不变，仅调整 y。
      dragRef.current = {
        id: placed.id, isNew: true, isScrub: false, isMarquee: false, isMultiDrag: false,
        offBeat: 0, offX: 0, y0: placed.y, lastPy: py, moved: false, mx0: 0, my0: 0,
        isPlacing: true, placeStartPy: py, placeY: placed.y, placeX: placed.x, placeBeat: placed.beat,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { px, py, w, h } = getPos(e);
    const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;

    // Scrub mode: vertical drag on empty space moves the playhead.
    if (drag.isScrub) {
      const pxPerBeat = pxPerBeatRef.current;
      const dy = py - drag.lastPy;
      drag.lastPy = py;
      // Drag down = forward through the chart (playhead advances).
      const dBeat = (dy / pxPerBeat);
      const curBeat = timeToBeat(curTime, segsRef.current);
      onSeekRef.current(curBeat + dBeat);
      drag.moved = true;
      return;
    }

    // Placing mode: dragging vertically after placing adjusts the note's Y.
    // A dead zone must be exceeded before any change takes effect; Y steps by 0.1.
    // Placement rules (DSL) are unaffected — they already ran when the note was
    // placed; this only nudges the resulting note's y.
    if (drag.isPlacing && drag.id) {
      const dy = py - (drag.placeStartPy ?? py);
      const DEAD_ZONE = 15; // px before Y adjustment kicks in
      const PX_PER_STEP = 20; // px of travel per 0.1 Y step
      // 方向：向下拖（dy>0）减小 y，向上拖（dy<0）增大 y（下减上增）。
      const effDy = dy > 0 ? Math.max(0, dy - DEAD_ZONE) : Math.min(0, dy + DEAD_ZONE);
      const steps = -Math.trunc(effDy / PX_PER_STEP);
      // 基准固定为放置时 DSL 处理后的实际 y（drag.y0），每次 move 计算绝对目标值，
      // 而非基于已更新的 placeY 累加（否则会犯与批量拖动相同的增量累积错误）。
      const y = round9(Math.max(-1.5, Math.min(1.5, (drag.y0 ?? 0) + steps * 0.1)));
      if (y !== drag.placeY) {
        drag.placeY = y;
        drag.moved = true;
        // Live-update visual + commit (throttled, same cadence as normal drag).
        // x / beat are kept at their placed values; only y changes.
        dragLiveRef.current = { id: drag.id, x: drag.placeX ?? 0, y, beat: drag.placeBeat ?? 0 };
        liveDragStore.set({ id: drag.id, x: drag.placeX ?? 0, y, beat: drag.placeBeat ?? 0 });
        const now = performance.now();
        if (now - lastCommitRef.current > 90) {
          lastCommitRef.current = now;
          commitMove();
        }
      }
      return;
    }

    // Marquee box-selection: update the rectangle (drawn by the render loop).
    if (drag.isMarquee) {
      marqueeRectRef.current = { x0: drag.mx0, y0: drag.my0, x1: px, y1: py };
      drag.moved = true;
      return;
    }

    // Multi-drag: move all selected notes by the same world-space delta.
    // Live positions are kept in multiLiveRef (drawn by the render loop) and
    // committed to React state ONCE on release with absolute positions — no
    // incremental commits, so deltas can never accumulate.
    if (drag.isMultiDrag && drag.multiSnapshot) {
      const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
      const grabBeat = round9(snap(timeToBeat(t - drag.offBeat, segsRef.current), snapRef.current));
      const grabX = round9(snap(worldX - drag.offX, X_SPAN / Math.max(1, (vlineRef.current | 0) - 1)));
      // Delta from the grabbed note's original position.
      const grabSnap = drag.multiSnapshot.find((s) => s.id === drag.multiGrabId);
      if (!grabSnap) return;
      const dBeat = grabBeat - grabSnap.beat;
      const dx = grabX - grabSnap.x;
      drag.moved = true;
      // Update live positions for all selected notes (head + children).
      const liveMap = new Map<string, { x: number; y: number; beat: number }>();
      for (const s of drag.multiSnapshot) {
        const nx = Math.max(-2.4, Math.min(2.4, s.x + dx));
        liveMap.set(s.id, { x: nx, y: s.y, beat: s.beat + dBeat });
      }
      multiLiveRef.current = liveMap;
      // Keep the side panel / external consumers in sync (dedup'd by the store).
      for (const [id, p] of liveMap) {
        liveDragStore.set({ id, x: p.x, y: p.y, beat: p.beat });
      }
      return;
    }

    if (!drag.id) return;
    const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
    let beat = round9(snap(timeToBeat(t - drag.offBeat, segsRef.current), snapRef.current));
    const xStep = X_SPAN / Math.max(1, (vlineRef.current | 0) - 1);
    let x = round9(snap(worldX - drag.offX, xStep));
    drag.moved = true;
    // Preserve the note's original y (2D ignores y, but keep it intact on drag).
    // Update the live-drag ref so the canvas draws the note in real time,
    // and commit to React state only at a throttled cadence (keeps the side
    // panel in sync without re-rendering the whole editor tree every move).
    dragLiveRef.current = { id: drag.id, x, y: drag.y0, beat };
    // Push live position to the editor side panel so its x/y/beat inputs update
    // in real time (the panel subscribes to this store; it does not re-render the
    // canvas). The authoritative chart state still commits at the throttled cadence.
    liveDragStore.set({ id: drag.id, x, y: drag.y0, beat });
    const now = performance.now();
    if (now - lastCommitRef.current > 90) {
      lastCommitRef.current = now;
      commitMove();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const drag = dragRef.current;

    // Marquee: collect hit notes and apply via onMarqueeSelect.
    if (drag && drag.isMarquee && marqueeRectRef.current) {
      const r = marqueeRectRef.current;
      const x0 = Math.min(r.x0, r.x1);
      const x1 = Math.max(r.x0, r.x1);
      const y0 = Math.min(r.y0, r.y1);
      const y1 = Math.max(r.y0, r.y1);
      if (drag.moved && x1 - x0 > 3 && y1 - y0 > 3) {
        // Hit-test all notes against the rectangle.
        const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
        const chart = chartRef.current;
        const { bpm, offset, bpmlist } = chart.metadata;
        const wrap = wrapRef.current!;
        const rect = wrap.getBoundingClientRect();
        const cssW = rect.width;
        const cssH = rect.height;
        const hitIds: string[] = [];
        for (const n of chart.notes) {
          // 头节点 + 每个子节点分别参与框选命中（独立单位）。
          const tb = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
          const { px: ix, py: iy } = worldToPixel(tb, n.x, cssW, cssH, curTime);
          if (ix >= x0 && ix <= x1 && iy >= y0 && iy <= y1) hitIds.push(n.id);
          if (n.nodes) {
            n.nodes.forEach((nd, k) => {
              const ctb = beatToSecondsMultiBpm(nd.beat, bpm, offset, bpmlist);
              const { px: cx, py: cy } = worldToPixel(ctb, nd.x, cssW, cssH, curTime);
              if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) hitIds.push(`${n.id}#${k + 1}`);
            });
          }
        }
        if (hitIds.length > 0) {
          onMarqueeSelectRef.current(hitIds, marqueeModeRef.current);
        }
      }
      marqueeRectRef.current = null;
      dragRef.current = null;
      return;
    }

    // Multi-drag: commit the final absolute positions ONCE and clear live overrides.
    if (drag && drag.isMultiDrag && drag.multiSnapshot) {
      if (drag.moved) {
        const liveMap = multiLiveRef.current;
        if (liveMap) {
          const positions: Array<{ id: string; x: number; y: number; beat: number }> = [];
          for (const [id, p] of liveMap) positions.push({ id, x: p.x, y: p.y, beat: p.beat });
          if (positions.length > 0) onMoveNotesRef.current(positions);
        }
        multiLiveRef.current = null;
        liveDragStore.clear();
      } else {
        // No move = it was a click on an already-selected note → toggle it off.
        multiLiveRef.current = null;
        liveDragStore.clear();
        if (drag.multiGrabBaseId) onSelectRef.current(drag.multiGrabBaseId);
      }
      dragRef.current = null;
      return;
    }

    // Single-note drag: commit the final dragged position once and clear live override.
    if (dragLiveRef.current) {
      commitMove();
      dragLiveRef.current = null;
      liveDragStore.clear();
    }
    dragRef.current = null;
  };

  // Mouse wheel scrubs the playhead: one notch = one snap subdivision.
  // Attached as a NATIVE non-passive listener: React (17+) binds synthetic wheel
  // events passively, so e.preventDefault() there throws
  // "Unable to preventDefault inside passive event listener invocation" — and
  // worse, the page/container would still scroll. `{ passive: false }` lets us
  // actually prevent default (blocks trackpad inertia / parent scrolling too).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY > 0 ? 1 : -1; // scroll down = forward through chart
      const deltaBeats = dir * (snapRef.current || 0.25);
      const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
      const curBeat = timeToBeat(curTime, segsRef.current);
      onSeekRef.current(curBeat + deltaBeats);
    };
    cv.addEventListener('wheel', onWheelNative, { passive: false });
    return () => cv.removeEventListener('wheel', onWheelNative);
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 touch-none"
        style={{ cursor: activeTool === 'select' ? 'pointer' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
};
