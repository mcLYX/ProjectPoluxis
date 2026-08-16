import { useCallback, useEffect, useRef } from 'react';
import { globalAudio } from '../audio/AudioManager';
import { beatToSecondsMultiBpm, secondsToBeatMultiBpm } from '../utils/beatTime';
import { EASING_FNS } from '../utils/easing';
import type { ChartData, NoteData, EasingType } from '../types/game';
import type { EditorTool } from './VisualChartEditor';
import { liveDragStore } from '../liveDragStore';

/** World X range used by the game's judgement plane. */
const X_MIN = -2.4;
const X_MAX = 2.4;
const X_SPAN = X_MAX - X_MIN;
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
  /** Number of vertical grid lines (incl. both edges); sets X snap columns. */
  vlineCount: number;
  /** Vertical pixels between adjacent integer beats (横向 zoom for the time axis). */
  pxPerBeat: number;
  /** Place a note. y is forced to 0 in 2D (top-down, y-axis ignored). */
  onPlaceNote: (x: number, y: number, beat: number) => void;
  /** Move/resize a note or slide child node. beat may be undefined to keep it. */
  onMoveNote: (id: string, x: number, y: number, beat: number) => void;
  onSelectNote: (id: string | null) => void;
  onSeekBeat: (beat: number) => void;
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
  vlineCount,
  pxPerBeat,
  onPlaceNote,
  onMoveNote,
  onSelectNote,
  onSeekBeat,
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
    offBeat: number;
    offX: number;
    y0: number;
    lastPy: number;
    moved: boolean;
  } | null>(null);

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
      type Item = { id: string; type: NoteData['type']; beat: number; x: number; color: string; angle: number };
      const items: Item[] = [];
      const slideChains: Array<{ id: string; color: string; pts: Array<{ x: number; beat: number; easing: EasingType }> }> = [];
      for (const n of chart.notes) {
        const color = n.color || noteColor;
        const headAngle = n.angle ?? 0;
        const isLive = live != null && n.id === live.id;
        const headX = isLive ? live.x : n.x;
        const headBeat = isLive ? live.beat : n.beat;
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
              const liveChild = live != null && childId === live.id ? live : null;
              return {
                x: liveChild ? liveChild.x : nd.x,
                beat: liveChild ? liveChild.beat : nd.beat,
                easing: nd.easing ?? n.easing ?? 'linear',
              };
            }),
          ];
          slideChains.push({ id: n.id, color, pts });
          n.nodes.forEach((nd, k) => {
            const childId = `${n.id}#${k + 1}`;
            const liveChild = live != null && childId === live.id ? live : null;
            items.push({
              id: childId,
              type: n.type,
              beat: liveChild ? liveChild.beat : nd.beat,
              x: liveChild ? liveChild.x : nd.x,
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
        ctx.strokeStyle = chain.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 3;
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
      for (const it of items) {
        const tb = beatToSecondsMultiBpm(it.beat, bpm, offset, bpmlist);
        const { px, py } = worldToPixel(tb, it.x, cssW, cssH, curTime);
        if (py < field.top - 60 || py > field.top + field.height + 60) continue;
        drawNoteShape(it.type, px, py, it.color, it.id === selectedRef.current, it.angle);
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
      if (hit) {
        onSelectRef.current(hit.id);
        // start drag: record grab offset in world space (time in seconds, x in world units)
        const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
        const hitSec = beatToSecondsMultiBpm(hit.beat, bpm, offset, bpmlist);
        dragRef.current = { id: hit.id, isNew: false, isScrub: false, offBeat: t - hitSec, offX: worldX - hit.x, y0: hit.y, lastPy: py, moved: false };
        dragLiveRef.current = { id: hit.id, x: hit.x, y: hit.y, beat: hit.beat };
      } else {
        // grab empty space -> vertical scrub (touch swipe / mouse drag).
        // No jump-to-click: avoids conflicting with the scrub gesture.
        onSelectRef.current(null);
        dragRef.current = { id: null, isNew: false, isScrub: true, offBeat: 0, offX: 0, y0: 0, lastPy: py, moved: false };
      }
      return;
    }

    // placement tools
    const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
    const beat = snap(timeToBeat(t, segsRef.current), snapRef.current);
    const xStep = X_SPAN / Math.max(1, (vlineRef.current | 0) - 1);
    const x = snap(worldX, xStep);
    onPlaceRef.current(x, 0, beat);
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

    if (!drag.id) return;
    const { t, worldX } = pixelToWorld(px, py, w, h, curTime);
    let beat = snap(timeToBeat(t - drag.offBeat, segsRef.current), snapRef.current);
    const xStep = X_SPAN / Math.max(1, (vlineRef.current | 0) - 1);
    let x = snap(worldX - drag.offX, xStep);
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
    // Commit the final dragged position once and clear the live override.
    if (dragLiveRef.current) {
      commitMove();
      dragLiveRef.current = null;
      liveDragStore.clear();
    }
    dragRef.current = null;
  };

  // Mouse wheel scrubs the playhead: one notch = one snap subdivision.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY > 0 ? 1 : -1; // scroll down = forward through chart
    const deltaBeats = dir * (snapRef.current || 0.25);
    const curTime = isPlayingRef.current ? globalAudio.getCurrentTime() : gameTimeRef.current;
    const curBeat = timeToBeat(curTime, segsRef.current);
    onSeekRef.current(curBeat + deltaBeats);
  };

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
        onWheel={onWheel}
      />
    </div>
  );
};
