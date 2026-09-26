import type { ChartData, NoteType } from '../types/game';

/**
 * 谱面「热度」（音符密度）统计 —— 供编辑器底部热力时间轴使用。
 *
 * 口径：每个**可判定单位**计 1（各类音符的头节点 + 各自的全部子节点），
 * 各自按自己的 beat 落桶。这样柱高真实反映「这一刻有几个要打的东西」，
 * 与 countPlayableNotes 的语义一致。
 *
 * 注意：**tap / touch 链同样可以有子节点**（resolveChart 会把任何带 nodes 的音符
 * 展开成 `id#i` 子节点，tap/touch 链在 2D 编辑器里以虚线连接），因此不能只算 slide。
 *
 * 纯函数、不依赖 DOM，可在任意环境调用/单测。
 */

export interface ChartDensity {
  /** 桶数（由容器宽度决定）。 */
  bucketCount: number;
  /** 时间窗口上界（拍）。 */
  maxBeat: number;
  /** 每桶可判定单位总数。 */
  total: Uint32Array;
  tap: Uint32Array;
  touch: Uint32Array;
  slide: Uint32Array;
  /** total 的最大值，用于归一化；0 表示空谱面。 */
  maxCount: number;
  /** 全谱三类计数（图例占比）。 */
  counts: Record<NoteType, number>;
}

/** beat → 桶下标。负拍（编辑器允许）钳入首桶，越界钳到末桶。 */
function bucketOf(beat: number, span: number, n: number): number {
  let i = Math.floor((beat / span) * n);
  if (!Number.isFinite(i)) i = 0;
  if (i < 0) i = 0;
  else if (i > n - 1) i = n - 1;
  return i;
}

export function buildChartDensity(
  chart: ChartData,
  maxBeat: number,
  bucketCount: number
): ChartDensity {
  const n = Math.max(1, bucketCount | 0);
  const span = maxBeat > 0 ? maxBeat : 1;
  const total = new Uint32Array(n);
  const tap = new Uint32Array(n);
  const touch = new Uint32Array(n);
  const slide = new Uint32Array(n);
  const counts: Record<NoteType, number> = { tap: 0, touch: 0, slide: 0 };

  const bucketOfType: Record<NoteType, Uint32Array> = { tap, touch, slide };

  const notes = chart.notes ?? [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const type: NoteType =
      note.type === 'touch' ? 'touch' : note.type === 'slide' ? 'slide' : 'tap';
    const arr = bucketOfType[type];
    // 头节点
    const b = bucketOf(note.beat, span, n);
    total[b] += 1;
    arr[b] += 1;
    counts[type] += 1;
    // 子节点（tap / touch / slide 链都可能有），各自落在自己的拍上。
    const kids = note.nodes ?? [];
    for (let k = 0; k < kids.length; k++) {
      const kb = bucketOf(kids[k].beat, span, n);
      total[kb] += 1;
      arr[kb] += 1;
      counts[type] += 1;
    }
  }

  let maxCount = 0;
  for (let i = 0; i < n; i++) {
    if (total[i] > maxCount) maxCount = total[i];
  }

  return { bucketCount: n, maxBeat, total, tap, touch, slide, maxCount, counts };
}

/** 全谱三类音符计数（图例占比用；O(n)，仅在谱面变化时调用）。
 *  头节点 + 各自全部子节点（tap / touch / slide 链一致）。 */
export function countNoteTypes(chart: ChartData): Record<NoteType, number> {
  const counts: Record<NoteType, number> = { tap: 0, touch: 0, slide: 0 };
  const notes = chart.notes ?? [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const type: NoteType =
      note.type === 'touch' ? 'touch' : note.type === 'slide' ? 'slide' : 'tap';
    counts[type] += 1 + (note.nodes?.length ?? 0);
  }
  return counts;
}
