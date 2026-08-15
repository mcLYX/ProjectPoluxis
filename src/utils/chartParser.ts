import { ChartData, NoteData, SlideNodeData, EventData, EasingType } from '../types/game';
import { EASING_TYPES } from './easing';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  /**
   * 非致命问题的说明。谱面仍然可用（已用缺省值修补或丢弃了坏数据），
   * 仅用于提示作者，不影响 valid。
   */
  warnings?: string[];
  chart?: ChartData;
}

const DEFAULT_BPM = 140;

/**
 * 宽容解析：只有「完全无法读取」的谱面才判定失败（JSON 语法错误、根元素不是对象）。
 * 其余问题一律尽量抢救：
 *  - metadata / title / bpm 缺失或非法 → 用缺省值补
 *  - notes 缺失或为空 → 允许空谱面（进入游戏后直接 0 分结算）
 *  - 负拍音符 → 放行（游玩时 lead-in 会处理负值时间）
 *  - 单个音符 / 子节点 / 事件缺少关键字段 → 能补的补，补不了的丢弃该条并记警告
 */
export function parseAndValidateChart(input: string | unknown): ValidationResult {
  let raw: unknown;
  try {
    // 兼容两种情况：传入 JSON 字符串，或已解析的对象（如 fetch 的 res.json()）。
    raw = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (err: unknown) {
    return { valid: false, error: `JSON 解析失败: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'JSON 文件格式不正确，根元素必须是一个对象。' };
  }
  const data = raw as Record<string, any>;
  const warnings: string[] = [];

  // ---- metadata：缺失一律补缺省值 ----
  const meta: Record<string, any> =
    data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  if (!data.metadata || typeof data.metadata !== 'object') {
    warnings.push('缺少 metadata，已使用默认元数据。');
  }

  let title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : '';
  if (!title) {
    title = 'Custom Track';
    warnings.push('metadata.title 缺失或非法，已使用 "Custom Track"。');
  }

  let bpm = typeof meta.bpm === 'number' && isFinite(meta.bpm) && meta.bpm > 0 ? meta.bpm : 0;
  if (!bpm) {
    bpm = DEFAULT_BPM;
    warnings.push(`metadata.bpm 缺失或非法，已使用 ${DEFAULT_BPM}。`);
  }

  // ---- notes：允许为空；逐条修补，无法修补则丢弃 ----
  const rawNotes: unknown[] = Array.isArray(data.notes) ? data.notes : [];
  if (!Array.isArray(data.notes)) {
    warnings.push('notes 缺失或不是数组，已视为空谱面。');
  }

  const notes: NoteData[] = [];
  for (let i = 0; i < rawNotes.length; i++) {
    const n = rawNotes[i] as Record<string, any> | null;
    if (!n || typeof n !== 'object') {
      warnings.push(`音符 #${i + 1} 不是对象，已丢弃。`);
      continue;
    }
    const beatRaw = n.beat ?? n.time;
    // beat 无法推断 → 只能丢弃这一个音符（负值合法，不做 clamp）。
    if (typeof beatRaw !== 'number' || !isFinite(beatRaw)) {
      warnings.push(`音符 #${i + 1} 缺少有效 beat，已丢弃。`);
      continue;
    }
    const x = typeof n.x === 'number' && isFinite(n.x) ? n.x : 0;
    const y = typeof n.y === 'number' && isFinite(n.y) ? n.y : 0;
    if (x !== n.x || y !== n.y) {
      warnings.push(`音符 #${i + 1} 坐标非法，已补为 (${x}, ${y})。`);
    }
    let type: NoteData['type'] = 'tap';
    if (n.type === 'tap' || n.type === 'touch' || n.type === 'slide') {
      type = n.type;
    } else if (n.type !== undefined) {
      warnings.push(`音符 #${i + 1} 的 type 非法，已补为 "tap"。`);
    }

    const base: NoteData = {
      id: typeof n.id === 'string' && n.id ? n.id : `note-${i + 1}`,
      beat: beatRaw,
      x,
      y,
      type,
      color: typeof n.color === 'string' && n.color.trim() ? n.color : undefined,
      angle: typeof n.angle === 'number' && isFinite(n.angle) ? n.angle : undefined,
      easing:
        typeof n.easing === 'string' && EASING_TYPES.includes(n.easing as EasingType)
          ? (n.easing as EasingType)
          : undefined,
    };

    const hasNodesField = n.nodes !== undefined;
    const rawNodes: unknown[] = Array.isArray(n.nodes) ? n.nodes : [];
    if (hasNodesField && !Array.isArray(n.nodes)) {
      warnings.push(`音符 #${i + 1} 的 nodes 不是数组，已忽略。`);
    }
    if (type === 'slide' || hasNodesField) {
      const nodes: SlideNodeData[] = [];
      for (let k = 0; k < rawNodes.length; k++) {
        const sn = rawNodes[k] as Record<string, any> | null;
        if (!sn || typeof sn !== 'object') {
          warnings.push(`音符 #${i + 1} 的子节点 #${k + 1} 非法，已丢弃。`);
          continue;
        }
        const snBeat = sn.beat ?? sn.time;
        if (typeof snBeat !== 'number' || !isFinite(snBeat)) {
          warnings.push(`音符 #${i + 1} 的子节点 #${k + 1} 缺少有效 beat，已丢弃。`);
          continue;
        }
        nodes.push({
          beat: snBeat,
          x: typeof sn.x === 'number' && isFinite(sn.x) ? sn.x : base.x,
          y: typeof sn.y === 'number' && isFinite(sn.y) ? sn.y : base.y,
          angle: typeof sn.angle === 'number' && isFinite(sn.angle) ? sn.angle : undefined,
          easing:
            typeof sn.easing === 'string' && EASING_TYPES.includes(sn.easing as EasingType)
              ? (sn.easing as EasingType)
              : undefined,
        });
      }
      nodes.sort((a, b) => a.beat - b.beat);
      notes.push({ ...base, nodes });
    } else {
      notes.push(base);
    }
  }

  const chart: ChartData = {
    metadata: {
      title,
      artist: typeof meta.artist === 'string' && meta.artist ? meta.artist : 'Unknown Artist',
      difficulty:
        typeof meta.difficulty === 'string' && meta.difficulty ? meta.difficulty : 'Custom Lv.9',
      bpm,
      offset: typeof meta.offset === 'number' && isFinite(meta.offset) ? meta.offset : 0,
      bgScheme:
        meta.bgScheme && typeof meta.bgScheme === 'object'
          ? meta.bgScheme
          : {
              gradientStart: '#050c1e',
              gradientEnd: '#1a0d2e',
              accentColor: '#00f0ff',
            },
      noteColor:
        typeof meta.noteColor === 'string' && meta.noteColor ? meta.noteColor : '#00f0ff',
      effectToggles: {
        bloom: true,
        particles: true,
        projection: true,
        gridLines: true,
        ...(meta.effectToggles && typeof meta.effectToggles === 'object' ? meta.effectToggles : {}),
      },
    },
    notes,
  };

  // ---- 事件：兼容旧格式 speedEvents；坏事件丢弃而非整谱失败 ----
  const events: EventData[] = [];

  if (Array.isArray(data.events)) {
    for (let i = 0; i < data.events.length; i++) {
      const e = data.events[i] as Record<string, any> | null;
      if (!e || typeof e !== 'object') {
        warnings.push(`事件 #${i + 1} 非法，已丢弃。`);
        continue;
      }
      const beatVal = e.beat ?? e.time;
      if (typeof beatVal !== 'number' || !isFinite(beatVal)) {
        warnings.push(`事件 #${i + 1} 缺少有效 beat，已丢弃。`);
        continue;
      }
      events.push({
        id: typeof e.id === 'string' && e.id ? e.id : `evt-${i + 1}`,
        type: 'event',
        eventType: (typeof e.eventType === 'string' && e.eventType) || 'speed_change',
        beat: beatVal,
        speed: typeof e.speed === 'number' && isFinite(e.speed) ? e.speed : undefined,
        text: typeof e.text === 'string' ? e.text : undefined,
        textDuration:
          typeof e.textDuration === 'number' && isFinite(e.textDuration) ? e.textDuration : undefined,
        color: typeof e.color === 'string' ? e.color : undefined,
      } as EventData);
    }
  }

  if (Array.isArray(data.speedEvents)) {
    for (let i = 0; i < data.speedEvents.length; i++) {
      const se = data.speedEvents[i] as Record<string, any> | null;
      if (!se || typeof se !== 'object') continue;
      const beatVal = se.beat ?? se.time;
      if (typeof beatVal === 'number' && isFinite(beatVal) && typeof se.speed === 'number') {
        events.push({
          id: `evt-speed-${i + 1}`,
          type: 'event',
          eventType: 'speed_change',
          beat: beatVal,
          speed: se.speed,
        });
      } else {
        warnings.push(`speedEvents #${i + 1} 数据非法，已丢弃。`);
      }
    }
  }

  if (events.length > 0) {
    events.sort((a, b) => a.beat - b.beat);
    chart.events = events;
  }

  if (notes.length === 0) {
    warnings.push('谱面没有任何可判定音符，进入游戏后将直接以 0 分结算。');
  }

  return { valid: true, chart, warnings: warnings.length > 0 ? warnings : undefined };
}

export function exportChartJson(chart: ChartData): string {
  return JSON.stringify(chart, null, 2);
}
