import { ChartData, NoteData, SlideNodeData, EventData } from '../types/game';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  chart?: ChartData;
}

export function parseAndValidateChart(jsonText: string): ValidationResult {
  try {
    const data = JSON.parse(jsonText);
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'JSON 文件格式不正确，根元素必须是一个对象。' };
    }

    if (!data.metadata || typeof data.metadata !== 'object') {
      return { valid: false, error: '缺少 metadata 元数据对象 (含 title, artist, bpm 等)。' };
    }

    const { title, bpm } = data.metadata;
    if (!title || typeof title !== 'string') {
      return { valid: false, error: 'metadata.title 必须为非空字符串。' };
    }
    if (typeof bpm !== 'number' || bpm <= 0) {
      return { valid: false, error: 'metadata.bpm 必须为大于 0 的数字。' };
    }

    if (!Array.isArray(data.notes) || data.notes.length === 0) {
      return { valid: false, error: 'notes 数组不能为空，请至少包含一个音符。' };
    }

    for (let i = 0; i < data.notes.length; i++) {
      const n = data.notes[i];
      const beatVal = n.beat ?? n.time;
      if (typeof beatVal !== 'number' || beatVal < 0) {
        return { valid: false, error: `音符 #${i + 1} 的 beat (节拍数) 必须为有效正数。` };
      }
      if (typeof n.x !== 'number' || typeof n.y !== 'number') {
        return { valid: false, error: `音符 #${i + 1} 的 (x, y) 坐标必须为数字。` };
      }
      if (n.type !== 'tap' && n.type !== 'touch' && n.type !== 'slide') {
        return { valid: false, error: `音符 #${i + 1} 的 type 必须为 "tap"、"touch" 或 "slide"。` };
      }
      if (n.type === 'slide' && n.nodes !== undefined) {
        if (!Array.isArray(n.nodes)) {
          return { valid: false, error: `Slide 音符 #${i + 1} 的 nodes 必须为数组。` };
        }
        for (let k = 0; k < n.nodes.length; k++) {
          const sn = n.nodes[k];
          const snBeat = sn.beat ?? sn.time;
          if (typeof snBeat !== 'number' || snBeat < 0) {
            return { valid: false, error: `Slide 音符 #${i + 1} 的子节点 #${k + 1} 缺少有效 beat。` };
          }
          if (typeof sn.x !== 'number' || typeof sn.y !== 'number') {
            return { valid: false, error: `Slide 音符 #${i + 1} 的子节点 #${k + 1} 坐标必须为数字。` };
          }
        }
      }
    }

      const chart: ChartData = {
      metadata: {
        title: data.metadata.title || 'Custom Track',
        artist: data.metadata.artist || 'Unknown Artist',
        difficulty: data.metadata.difficulty || 'Custom Lv.9',
        bpm: data.metadata.bpm || 140,
        offset: data.metadata.offset || 0,
        bgScheme: data.metadata.bgScheme || {
          gradientStart: '#050c1e',
          gradientEnd: '#1a0d2e',
          accentColor: '#00f0ff',
        },
        noteColor: data.metadata.noteColor || '#00f0ff',
        effectToggles: {
          bloom: true,
          particles: true,
          projection: true,
          gridLines: true,
          ...(data.metadata.effectToggles || {}),
        },
      },
      notes: data.notes.map((n: Record<string, unknown>, idx: number) => {
        const base: NoteData = {
          id: (n.id as string) || `note-${idx + 1}`,
          beat: ((n.beat ?? n.time) as number),
          x: n.x as number,
          y: n.y as number,
          type: (n.type as 'tap' | 'touch' | 'slide') || 'tap',
          color: typeof n.color === 'string' && n.color.trim() ? (n.color as string) : undefined,
        };
        if (base.type === 'slide') {
          const rawNodes = (n.nodes as Array<Record<string, unknown>> | undefined) ?? [];
          const nodes: SlideNodeData[] = rawNodes
            .map((sn) => ({
              beat: ((sn.beat ?? sn.time) as number),
              x: sn.x as number,
              y: sn.y as number,
            }))
            .sort((a, b) => a.beat - b.beat);
          return { ...base, nodes };
        }
        return base;
      }),
    };

    // 处理事件（兼容旧格式 speedEvents）
    const events: EventData[] = [];

    // 先处理新格式 events
    if (Array.isArray(data.events) && data.events.length > 0) {
      for (let i = 0; i < data.events.length; i++) {
        const e = data.events[i] as Record<string, unknown>;
        const beatVal = e.beat ?? e.time;
        if (typeof beatVal !== 'number') {
          return { valid: false, error: `事件 #${i + 1} 缺少有效的 beat 字段。` };
        }
        events.push({
          id: (e.id as string) || `evt-${i + 1}`,
          type: 'event',
          eventType: (e.eventType as string) || 'speed_change',
          beat: beatVal as number,
          speed: typeof e.speed === 'number' ? e.speed : undefined,
          text: typeof e.text === 'string' ? e.text : undefined,
          textDuration: typeof e.textDuration === 'number' ? e.textDuration : undefined,
          color: typeof e.color === 'string' ? (e.color as string) : undefined,
        } as EventData);
      }
    }

    // 再处理旧格式 speedEvents（转换为 speed_change 事件）
    if (Array.isArray(data.speedEvents) && data.speedEvents.length > 0) {
      for (let i = 0; i < data.speedEvents.length; i++) {
        const se = data.speedEvents[i] as Record<string, unknown>;
        const beatVal = se.beat ?? se.time;
        if (typeof beatVal === 'number' && typeof se.speed === 'number') {
          events.push({
            id: `evt-speed-${i + 1}`,
            type: 'event',
            eventType: 'speed_change',
            beat: beatVal as number,
            speed: se.speed as number,
          });
        }
      }
    }

    // 按 beat 排序事件
    if (events.length > 0) {
      events.sort((a, b) => a.beat - b.beat);
      chart.events = events;
    }

    return { valid: true, chart };
  } catch (err: unknown) {
    return { valid: false, error: `JSON 解析失败: ${(err as Error).message}` };
  }
}

export function exportChartJson(chart: ChartData): string {
  return JSON.stringify(chart, null, 2);
}
