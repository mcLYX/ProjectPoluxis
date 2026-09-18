/**
 * Single source of truth for chart *validation / normalization*, shared by the
 * full app (src/utils/chartParser.ts re-exports this) and the Lite ES5 build
 * (inlined verbatim by scripts/build-lite.mjs).
 *
 * Rules:
 *  - Pure logic only (no DOM, no TS-only runtime features). Survives an esbuild
 *    ES5 transpile so the Lite build can inline it into its shared-scope IIFE.
 *  - Declarations use `var` / `export var` on purpose (see gameplaySpec.ts).
 *  - If you change a validation rule here, BOTH versions update — no manual resync.
 *
 * Messages are Chinese on purpose: both the full app and the Lite editor surface
 * them directly, so no per-version i18n layer is needed.
 */

/** Note types valid in a chart. Mirrors NoteType in src/types/game.ts. */
export var CHART_NOTE_TYPES = ['tap', 'touch', 'slide'];
/** Easing identifiers valid in chart `easing` fields.
 *  SINGLE SOURCE OF TRUTH — src/utils/easing.ts and the Lite build both read
 *  this (the Lite build inlines it via scripts/build-lite.mjs). Do NOT redefine
 *  EASING_TYPES anywhere else. */
export var EASING_TYPES = ['linear', 'sine-in', 'sine-out', 'sine-io'] as const;

var DEFAULT_BPM = 140;

function isNum(v: any): boolean {
  return typeof v === 'number' && isFinite(v);
}

/**
 * Tolerant parse: only a chart that is completely unreadable fails (JSON syntax
 * error, or root that is not an object). Everything else is salvaged:
 *  - missing/illegal metadata → default values
 *  - missing notes → empty chart (0-score clear)
 *  - a single bad note / node / event → dropped with a warning
 * Returns { valid, chart, error?, warnings? }.
 */
export function parseAndValidateChart(input: unknown): {
  valid: boolean;
  error?: string;
  warnings?: string[];
  chart?: any;
} {
  var raw: any;
  try {
    raw = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (err) {
    var msg = err && (err as any).message ? (err as any).message : String(err);
    return { valid: false, error: 'JSON 解析失败: ' + msg };
  }
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'JSON 文件格式不正确，根元素必须是一个对象。' };
  }
  var data: any = raw;
  var warnings: string[] = [];

  // ---- metadata: fill defaults for anything missing ----
  var meta: any =
    data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  if (!data.metadata || typeof data.metadata !== 'object') {
    warnings.push('缺少 metadata，已使用默认元数据。');
  }
  var title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : '';
  if (!title) {
    title = 'Custom Track';
    warnings.push('metadata.title 缺失或非法，已使用 "Custom Track"。');
  }
  var bpm = isNum(meta.bpm) && meta.bpm > 0 ? meta.bpm : 0;
  if (!bpm) {
    bpm = DEFAULT_BPM;
    warnings.push('metadata.bpm 缺失或非法，已使用 ' + DEFAULT_BPM + '。');
  }

  // ---- notes: allow empty; salvage per note, drop the unrecoverable ----
  var rawNotes: any[] = Array.isArray(data.notes) ? data.notes : [];
  if (!Array.isArray(data.notes)) {
    warnings.push('notes 缺失或不是数组，已视为空谱面。');
  }
  var notes: any[] = [];
  for (var i = 0; i < rawNotes.length; i++) {
    var n: any = rawNotes[i];
    if (!n || typeof n !== 'object') {
      warnings.push('音符 #' + (i + 1) + ' 不是对象，已丢弃。');
      continue;
    }
    var beatRaw = n.beat !== undefined ? n.beat : n.time;
    if (!isNum(beatRaw)) {
      warnings.push('音符 #' + (i + 1) + ' 缺少有效 beat，已丢弃。');
      continue;
    }
    var x = isNum(n.x) ? n.x : 0;
    var y = isNum(n.y) ? n.y : 0;
    if (x !== n.x || y !== n.y) {
      warnings.push('音符 #' + (i + 1) + ' 坐标非法，已补为 (' + x + ', ' + y + ')。');
    }
    var type = 'tap';
    if (n.type === 'tap' || n.type === 'touch' || n.type === 'slide') {
      type = n.type;
    } else if (n.type !== undefined) {
      warnings.push('音符 #' + (i + 1) + ' 的 type 非法，已补为 "tap"。');
    }
    var base: any = {
      id: typeof n.id === 'string' && n.id ? n.id : 'note-' + (i + 1),
      beat: beatRaw,
      x: x,
      y: y,
      type: type,
      color: typeof n.color === 'string' && n.color.trim() ? n.color : undefined,
      angle: isNum(n.angle) ? n.angle : undefined,
      easing:
        typeof n.easing === 'string' && EASING_TYPES.indexOf(n.easing) >= 0
          ? n.easing
          : undefined,
    };
    var hasNodesField = n.nodes !== undefined;
    var rawNodes: any[] = Array.isArray(n.nodes) ? n.nodes : [];
    if (hasNodesField && !Array.isArray(n.nodes)) {
      warnings.push('音符 #' + (i + 1) + ' 的 nodes 不是数组，已忽略。');
    }
    if (type === 'slide' || hasNodesField) {
      var childNodes: any[] = [];
      for (var k = 0; k < rawNodes.length; k++) {
        var sn: any = rawNodes[k];
        if (!sn || typeof sn !== 'object') {
          warnings.push('音符 #' + (i + 1) + ' 的子节点 #' + (k + 1) + ' 非法，已丢弃。');
          continue;
        }
        var snBeat = sn.beat !== undefined ? sn.beat : sn.time;
        if (!isNum(snBeat)) {
          warnings.push('音符 #' + (i + 1) + ' 的子节点 #' + (k + 1) + ' 缺少有效 beat，已丢弃。');
          continue;
        }
        childNodes.push({
          beat: snBeat,
          x: isNum(sn.x) ? sn.x : base.x,
          y: isNum(sn.y) ? sn.y : base.y,
          angle: isNum(sn.angle) ? sn.angle : undefined,
          easing:
            typeof sn.easing === 'string' && EASING_TYPES.indexOf(sn.easing) >= 0
              ? sn.easing
              : undefined,
        });
      }
      childNodes.sort(function (a: any, b: any) { return a.beat - b.beat; });
      notes.push({
        id: base.id,
        beat: base.beat,
        x: base.x,
        y: base.y,
        type: base.type,
        color: base.color,
        angle: base.angle,
        easing: base.easing,
        nodes: childNodes,
      });
    } else {
      notes.push(base);
    }
  }

  var chart: any = {
    metadata: {
      title: title,
      artist: typeof meta.artist === 'string' && meta.artist ? meta.artist : 'Unknown Artist',
      difficulty:
        typeof meta.difficulty === 'string' && meta.difficulty ? meta.difficulty : 'Custom Lv.9',
      bpm: bpm,
      offset: isNum(meta.offset) ? meta.offset : 0,
      bgScheme:
        meta.bgScheme && typeof meta.bgScheme === 'object'
          ? meta.bgScheme
          : { gradientStart: '#050c1e', gradientEnd: '#1a0d2e', accentColor: '#00f0ff' },
      noteColor: typeof meta.noteColor === 'string' && meta.noteColor ? meta.noteColor : '#00f0ff',
      effectToggles: {
        bloom: true,
        particles: true,
        projection: true,
        gridLines: true,
        ...(meta.effectToggles && typeof meta.effectToggles === 'object' ? meta.effectToggles : {}),
      },
    },
    notes: notes,
  };

  // ---- events: migrate legacy speedEvents; drop bad events ----
  var events: any[] = [];
  if (Array.isArray(data.events)) {
    for (var ei = 0; ei < data.events.length; ei++) {
      var e: any = data.events[ei];
      if (!e || typeof e !== 'object') {
        warnings.push('事件 #' + (ei + 1) + ' 非法，已丢弃。');
        continue;
      }
      var eBeat = e.beat !== undefined ? e.beat : e.time;
      if (!isNum(eBeat)) {
        warnings.push('事件 #' + (ei + 1) + ' 缺少有效 beat，已丢弃。');
        continue;
      }
      events.push({
        id: typeof e.id === 'string' && e.id ? e.id : 'evt-' + (ei + 1),
        type: 'event',
        eventType: typeof e.eventType === 'string' && e.eventType ? e.eventType : 'speed_change',
        beat: eBeat,
        speed: isNum(e.speed) ? e.speed : undefined,
        text: typeof e.text === 'string' ? e.text : undefined,
        textDuration: isNum(e.textDuration) ? e.textDuration : undefined,
        color: typeof e.color === 'string' ? e.color : undefined,
      });
    }
  }
  if (Array.isArray(data.speedEvents)) {
    for (var si = 0; si < data.speedEvents.length; si++) {
      var se: any = data.speedEvents[si];
      if (!se || typeof se !== 'object') continue;
      var seBeat = se.beat !== undefined ? se.beat : se.time;
      if (isNum(seBeat) && isNum(se.speed)) {
        events.push({
          id: 'evt-speed-' + (si + 1),
          type: 'event',
          eventType: 'speed_change',
          beat: seBeat,
          speed: se.speed,
        });
      } else {
        warnings.push('speedEvents #' + (si + 1) + ' 数据非法，已丢弃。');
      }
    }
  }
  if (events.length > 0) {
    events.sort(function (a: any, b: any) { return a.beat - b.beat; });
    chart.events = events;
  }

  if (notes.length === 0) {
    warnings.push('谱面没有任何可判定音符，进入游戏后将直接以 0 分结算。');
  }

  return { valid: true, chart: chart, warnings: warnings.length > 0 ? warnings : undefined };
}
