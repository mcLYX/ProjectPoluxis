/**
 * 快速制谱（quick-create）手势引擎 —— 渲染器无关。
 *
 * 背景：该逻辑原本只存在于 3D 渲染器 `GameCanvas.tsx`。当完整版切到 'lite'
 * 画质改用 `GameCanvas2D.tsx` 时，2D 画布完全不认识 'quick-create' 工具，
 * 表现就是"快速制谱无效"。与其把 ~170 行分类逻辑再抄一份到 2D（两边随时
 * 漂移），这里把它收敛为单一实现：
 *
 *   3D / 2D 只负责 —— 把指针的 (beat, x, y) 喂进来、把产出的 delta 交给上层。
 *
 * 不依赖 three.js / React，纯函数式，两个渲染器（含 Lite 版）都可复用。
 */

/** 一批由单次手势产出的音符。 */
export interface QuickCreateDelta {
  /** Tap to create (single note). */
  taps?: Array<{ beat: number; x: number; y: number }>;
  /** Touches to create (touch stream, one note per grid position). */
  touches?: Array<{ beat: number; x: number; y: number }>;
  /** Slide to create (one slide note, with beat-snapped head + nodes). */
  slides?: Array<{
    headBeat: number; headX: number; headY: number;
    nodes: Array<{ beat: number; x: number; y: number }>;
  }>;
  /** 手势进行中：上层不要选中新音符、不要弹出浮动编辑面板。 */
  suppressSelection?: boolean;
}

export type QCGesture = 'undecided' | 'tap' | 'slide' | 'touch-stream';

export interface QCSample {
  tSec: number;
  beat: number;
  x: number;
  y: number;
}

export interface QCTrack {
  pressBeat: number;
  pressX: number;
  pressY: number;
  trajectory: QCSample[];
  /** 最近一次落音的 beat —— 保证吸附间隔内不重复落音。 */
  lastPlacedBeat: number | null;
  gesture: QCGesture;
}

/** x 钳位边界（判定面 X 半宽）。 */
const QC_CLAMP_X = 2.4;
/** y 钳位边界（判定面 Y 半宽）。原 3D 实现把 x/y 都钳到 ±2.4，会把 y 放到
 *  合法范围（±1.5）之外，故这里按各自的半宽分别钳位。 */
const QC_CLAMP_Y = 1.5;
/** 首个 beat 内位移超过该值判定为 touch-stream，否则为 slide（约判定面半宽的 14%）。 */
const QC_STATIC_MOVE = 0.22;
/** 按下后经过多少 beat 锁定 slide/touch 分类（此后不再可能是 tap）。 */
const QC_FIRST_BEAT = 1.0;
/** 轨迹采样上限，防止长按无限增长。 */
export const QC_MAX_TRAJECTORY = 120;

export interface QuickCreateControllerOptions {
  /** 当前吸附细分（beat）。以 getter 形式传入，保证每次读到最新值。 */
  getSnapSubdivision: () => number;
  /** 把生成的 delta 交给上层写入谱面。 */
  dispatch: (delta: QuickCreateDelta) => void;
}

export interface QuickCreateController {
  /** 按下：建立轨迹（此时还不落音，需等抬起才能分类）。 */
  createTrack(tSec: number, beat: number, x: number, y: number): QCTrack;
  /** 移动：追加采样点（内含长度上限裁剪）。 */
  pushSample(track: QCTrack, tSec: number, beat: number, x: number, y: number): void;
  /** 移动：按当前分类实时产出 touch 流 / slide 节点。 */
  move(track: QCTrack, nowBeat: number): void;
  /** 抬起：最终分类并补齐剩余音符。 */
  up(track: QCTrack): void;
}

export function createQuickCreateController(
  opts: QuickCreateControllerOptions
): QuickCreateController {
  const step = (): number => {
    const snap = opts.getSnapSubdivision();
    // 用户设置粗于 1/16 时听用户的，否则下限 1/16（见原实现注释）。
    return Math.max(1 / 16, snap > 0 ? snap : 1 / 16);
  };

  const snapBeat = (beat: number): number => {
    const s = step();
    return Math.round(beat / s) * s;
  };

  /** 钳到判定面 X 半宽并按 0.1 取整。 */
  const roundX = (v: number): number =>
    Math.round(Math.max(-QC_CLAMP_X, Math.min(QC_CLAMP_X, v)) * 10) / 10;
  /** 钳到判定面 Y 半宽并按 0.1 取整（注意：Y 半宽比 X 小，不可共用）。 */
  const roundY = (v: number): number =>
    Math.round(Math.max(-QC_CLAMP_Y, Math.min(QC_CLAMP_Y, v)) * 10) / 10;

  /** 在轨迹上按 beat 线性插值取位置，使音符真正跟随手指而不是堆在光标处。 */
  const sampleAtBeat = (traj: QCSample[], beat: number): { x: number; y: number } => {
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

  /** 手势期间相对按下点的最大位移。 */
  const maxDisplacement = (track: QCTrack): number => {
    let m = 0;
    for (const s of track.trajectory) {
      m = Math.max(m, Math.hypot(s.x - track.pressX, s.y - track.pressY));
    }
    return m;
  };

  const buildSlide = (track: QCTrack, endBeat: number) => {
    const headSnap = snapBeat(track.pressBeat);
    const headX = roundX(track.pressX);
    const headY = roundY(track.pressY);
    const nodes: Array<{ beat: number; x: number; y: number }> = [];
    // 上一个已落点的位置（首个节点与头节点比较）。手指静止时每拍采到的
    // 坐标完全相同，若不跳过就会生成一串重合节点 —— 表现为 slide 尾部
    // 堆成一坨零长度片段。跳过重合点后，静止段由「前一点 → 再次移动时
    // 的那一点」一条长线段表示，时间跨度不丢失。
    let prevX = headX;
    let prevY = headY;
    for (let n = 1; ; n++) {
      const nb = track.pressBeat + n; // 每拍一个节点
      if (nb > endBeat + 1e-6) break;
      const sb = snapBeat(nb);
      if (sb <= headSnap + 1e-6) continue;
      const p = sampleAtBeat(track.trajectory, sb);
      const nx = roundX(p.x);
      const ny = roundY(p.y);
      if (nx === prevX && ny === prevY) continue; // 与上一个节点重合 → 跳过
      nodes.push({ beat: sb, x: nx, y: ny });
      prevX = nx;
      prevY = ny;
    }
    return {
      headBeat: headSnap,
      headX,
      headY,
      nodes,
    };
  };

  /** 补齐 [fromBeat, toBeat] 区间内剩余的 touch 音符。 */
  const emitTouches = (track: QCTrack, endBeat: number): void => {
    const s = step();
    const startBeat = track.lastPlacedBeat === null
      ? snapBeat(track.pressBeat)
      : track.lastPlacedBeat + s;
    const toBeat = snapBeat(endBeat);
    if (startBeat > toBeat + 1e-6) return;
    const notesOut: Array<{ beat: number; x: number; y: number }> = [];
    for (let b = startBeat; b <= toBeat + 1e-6; b = +(b + s).toFixed(6)) {
      const sb = snapBeat(b);
      const p = sampleAtBeat(track.trajectory, sb);
      notesOut.push({ beat: sb, x: roundX(p.x), y: roundY(p.y) });
    }
    if (notesOut.length === 0) return;
    track.lastPlacedBeat = notesOut[notesOut.length - 1].beat;
    opts.dispatch({ touches: notesOut, suppressSelection: true });
  };

  return {
    createTrack(tSec: number, beat: number, x: number, y: number): QCTrack {
      return {
        pressBeat: beat,
        pressX: x,
        pressY: y,
        trajectory: [{ tSec, beat, x, y }],
        lastPlacedBeat: null,
        gesture: 'undecided',
      };
    },

    pushSample(track: QCTrack, tSec: number, beat: number, x: number, y: number): void {
      track.trajectory.push({ tSec, beat, x, y });
      if (track.trajectory.length > QC_MAX_TRAJECTORY) {
        track.trajectory.splice(0, track.trajectory.length - QC_MAX_TRAJECTORY);
      }
    },

    move(track: QCTrack, nowBeat: number): void {
      const totalHoldBeats = nowBeat - track.pressBeat;

      // 分类只在「按下后第一个 beat 结束时」锁定一次，之后不再改变。
      if (track.gesture === 'undecided') {
        if (totalHoldBeats >= QC_FIRST_BEAT) {
          track.gesture = maxDisplacement(track) > QC_STATIC_MOVE ? 'touch-stream' : 'slide';
        } else {
          return; // 首个 beat 内还可能是 tap，暂不落音
        }
      }

      if (track.gesture === 'touch-stream') {
        emitTouches(track, nowBeat);
        return;
      }

      if (track.gesture === 'slide') {
        // 每次移动都重算整条节点链，让先前的节点跟着手指更新。
        opts.dispatch({
          slides: [buildSlide(track, nowBeat)],
          suppressSelection: true,
        });
        return;
      }
    },

    up(track: QCTrack): void {
      const last = track.trajectory[track.trajectory.length - 1];
      if (!last) return;
      const totalHoldBeats = last.beat - track.pressBeat;

      // 仍未分类（首个 beat 内就抬起）：按整体位移补一次判定。
      if (track.gesture === 'undecided') {
        const md = maxDisplacement(track);
        if (totalHoldBeats < QC_FIRST_BEAT && md < QC_STATIC_MOVE * 2) {
          track.gesture = 'tap'; // 快速点按 → 单个 TAP
        } else {
          track.gesture = md > QC_STATIC_MOVE ? 'touch-stream' : 'slide';
        }
      }

      switch (track.gesture) {
        case 'tap': {
          opts.dispatch({
            taps: [{
              beat: snapBeat(track.pressBeat),
              x: roundX(track.pressX),
              y: roundY(track.pressY),
            }],
            suppressSelection: true,
          });
          return;
        }
        case 'slide': {
          opts.dispatch({ slides: [buildSlide(track, last.beat)], suppressSelection: true });
          return;
        }
        case 'touch-stream': {
          emitTouches(track, last.beat);
          return;
        }
      }
    },
  };
}
