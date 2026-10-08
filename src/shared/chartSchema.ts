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
    // 扩展字段透传：上面已显式规整的字段之外，其余字段原样保留（改造前这里只有
    // 一份白名单，新增字段会被静默丢弃 —— 图层 id 就必须在这里活下来）。
    // `speedMul` 是已废弃的逐音符流速（仅存在于类型里、从未实现），按方案读取时忽略。
    // 注意：**不对 x/y 做范围裁剪** —— 图层偏移生效后，base 坐标可以合法地
    // 超出判定面范围（例：偏移 -1 时要显示在 x=2.4，base 就是 3.4）。
    for (var nk in n) {
      if (!n.hasOwnProperty(nk)) continue;
      if (
        nk === 'id' || nk === 'beat' || nk === 'time' || nk === 'x' || nk === 'y' ||
        nk === 'type' || nk === 'color' || nk === 'angle' || nk === 'easing' ||
        nk === 'nodes' || nk === 'speedMul'
      ) continue;
      base[nk] = n[nk];
    }
    // layerId：省略 = 默认根图层。存在但非法的一律丢弃。
    if (base.layerId !== undefined) {
      if (typeof base.layerId === 'string' && base.layerId) {
        // ok
      } else {
        warnings.push('音符 #' + (i + 1) + ' 的 layerId 非法，已视为默认根图层。');
        delete base.layerId;
      }
    }
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
      // 以 base 为蓝本复制（保留 layerId 等扩展字段），再挂上规整后的子节点。
      var outNote: any = {};
      for (var bk in base) {
        if (base.hasOwnProperty(bk)) outNote[bk] = base[bk];
      }
      outNote.nodes = childNodes;
      notes.push(outNote);
    } else {
      notes.push(base);
    }
  }

  // bgScheme：保留输入的原有键（旧谱导出逐字一致），但**剥离媒体背景字段**
  // （bgType/bgImage/bgVideo/bgFit/bgOpacity）——背景媒体改由歌曲目录约定文件提供，
  // 不再写入谱面（读取时也忽略）。
  var outScheme: any = { gradientStart: '#050c1e', gradientEnd: '#1a0d2e', accentColor: '#00f0ff' };
  if (meta.bgScheme && typeof meta.bgScheme === 'object') {
    for (var sk in meta.bgScheme) {
      if (
        (meta.bgScheme as any).hasOwnProperty(sk) &&
        sk !== 'bgType' && sk !== 'bgImage' && sk !== 'bgVideo' && sk !== 'bgFit' && sk !== 'bgOpacity'
      ) {
        outScheme[sk] = (meta.bgScheme as any)[sk];
      }
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
      bgScheme: outScheme,
      noteColor: typeof meta.noteColor === 'string' && meta.noteColor ? meta.noteColor : '#00f0ff',
      // 仅当输入里原本就有才写出：保证旧谱面解析后导出仍与旧格式逐字一致。
      schemaVersion:
        typeof meta.schemaVersion === 'string' && meta.schemaVersion ? meta.schemaVersion : undefined,
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
      // 复制事件的全部自有字段（含 bg_change 的 gradientStart/gradientEnd、
      // text_display 的 x/y/fontSize 等），再统一规整 id/type/eventType/beat。
      // 原先只显式列出 speed/text/textDuration/color，会丢弃 bg_change 的渐变色，
      // 导致 bg_change 事件虽被解析却不携带任何颜色而静默失效。
      // bgImage/bgVideo（旧版事件级媒体背景）不再支持：剥离，不写入谱面。
      var outEvt: any = { beat: eBeat };
      for (var ek in e) {
        if (
          e.hasOwnProperty(ek) && ek !== 'beat' && ek !== 'time' &&
          ek !== 'bgImage' && ek !== 'bgVideo'
        ) {
          outEvt[ek] = (e as any)[ek];
        }
      }
      outEvt.id = typeof e.id === 'string' && e.id ? e.id : 'evt-' + (ei + 1);
      outEvt.type = 'event';
      outEvt.eventType = typeof e.eventType === 'string' && e.eventType ? e.eventType : 'speed_change';
      events.push(outEvt);
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

  // ---- layers（v2 图层树）----
  // 缺省/空 = 旧形态（只有默认根图层），此时不给 chart 加任何字段 ——
  // 这是「单根图层的导出与旧格式逐字兼容」的另一半保证。
  var seenIds: { [k: string]: boolean } = {};
  var rawLayers: any[] = Array.isArray(data.layers) ? data.layers : [];
  if (rawLayers.length > 0) {
    var keptLayers: any[] = [];
    for (var li = 0; li < rawLayers.length; li++) {
      var L: any = rawLayers[li];
      if (!L || typeof L !== 'object') {
        warnings.push('图层 #' + (li + 1) + ' 不是对象，已丢弃。');
        continue;
      }
      var lid = typeof L.id === 'string' && L.id ? L.id : '';
      if (!lid) {
        warnings.push('图层 #' + (li + 1) + ' 缺少有效 id，已丢弃。');
        continue;
      }
      if (seenIds[lid]) {
        warnings.push('图层 id "' + lid + '" 重复，重复项已丢弃。');
        continue;
      }
      seenIds[lid] = true;
      keptLayers.push(L);
    }

    var outLayers: any[] = [];
    var rawById: { [k: string]: any } = {};
    for (var ci = 0; ci < keptLayers.length; ci++) {
      var C: any = keptLayers[ci];
      rawById[C.id] = C;
      var outLayer: any = { id: C.id };
      var pid = typeof C.parentId === 'string' && C.parentId ? C.parentId : '';
      if (pid && pid !== C.id && seenIds[pid]) outLayer.parentId = pid;
      else if (pid) warnings.push('图层 "' + C.id + '" 的 parentId 无效，已降级为根图层。');
      if (typeof C.name === 'string' && C.name) outLayer.name = C.name;
      if (isNum(C.offsetX)) outLayer.offsetX = C.offsetX;
      if (isNum(C.offsetY)) outLayer.offsetY = C.offsetY;
      if (isNum(C.speedMul)) outLayer.speedMul = C.speedMul;
      if (typeof C.noteColor === 'string' && C.noteColor) outLayer.noteColor = C.noteColor;
      outLayers.push(outLayer);
    }

    // 环检测：沿 parentId 上溯，若回到已访问过的节点 → 处于环中，降级为根图层。
    // ⚠️ 判定必须基于**快照**：边改边判会漏判（A→B→A 时先降级 A，B 就变成
    // 「挂在根上的合法子节点」，环被悄悄保留下来并原样写回导出）。
    var parentOf: { [k: string]: string } = {};
    for (var pi2 = 0; pi2 < outLayers.length; pi2++) {
      if (outLayers[pi2].parentId) parentOf[outLayers[pi2].id] = outLayers[pi2].parentId;
    }
    for (var cd = 0; cd < outLayers.length; cd++) {
      var seenUp: { [k: string]: boolean } = {};
      var curUp: string = outLayers[cd].id;
      var cyclic = false;
      for (var g2 = 0; curUp && g2 < 128; g2++) {
        if (seenUp[curUp]) { cyclic = true; break; }
        seenUp[curUp] = true;
        curUp = parentOf[curUp];
      }
      if (cyclic) {
        warnings.push('图层 "' + outLayers[cd].id + '" 处于循环引用中，已降级为根图层。');
        delete outLayers[cd].parentId;
      }
    }

    // 连通性修复：从根出发 BFS，任何不可达的图层降级为根图层。
    var reachable: { [k: string]: boolean } = {};
    var stack: string[] = [];
    for (var ri = 0; ri < outLayers.length; ri++) {
      if (!outLayers[ri].parentId) {
        reachable[outLayers[ri].id] = true;
        stack.push(outLayers[ri].id);
      }
    }
    if (stack.length === 0 && outLayers.length > 0) {
      warnings.push('图层树没有根图层，已将 "' + outLayers[0].id + '" 降级为根图层。');
      delete outLayers[0].parentId;
      reachable[outLayers[0].id] = true;
      stack.push(outLayers[0].id);
    }
    while (stack.length > 0) {
      var curId = stack.pop();
      for (var rj = 0; rj < outLayers.length; rj++) {
        var cand = outLayers[rj];
        if (cand.parentId === curId && !reachable[cand.id]) {
          reachable[cand.id] = true;
          stack.push(cand.id);
        }
      }
    }
    for (var rk = 0; rk < outLayers.length; rk++) {
      if (!reachable[outLayers[rk].id]) {
        warnings.push(
          '图层 "' + outLayers[rk].id + '" 在图层树中不可达（可能循环引用），已降级为根图层。'
        );
        delete outLayers[rk].parentId;
      }
    }

    // 图层事件：与顶层事件同一套规整规则。
    for (var ei2 = 0; ei2 < outLayers.length; ei2++) {
      var lay: any = outLayers[ei2];
      var srcRaw: any = rawById[lay.id];
      var rawLE: any[] = srcRaw && Array.isArray(srcRaw.events) ? srcRaw.events : [];
      var layerEvents: any[] = [];
      for (var lj = 0; lj < rawLE.length; lj++) {
        var le: any = rawLE[lj];
        if (!le || typeof le !== 'object') continue;
        var leBeat = le.beat !== undefined ? le.beat : le.time;
        if (!isNum(leBeat)) continue;
        var outLE: any = { beat: leBeat };
        for (var lk in le) {
          if (le.hasOwnProperty(lk) && lk !== 'beat' && lk !== 'time') outLE[lk] = le[lk];
        }
        outLE.id = typeof le.id === 'string' && le.id ? le.id : lay.id + '-evt-' + (lj + 1);
        outLE.type = 'event';
        outLE.eventType =
          typeof le.eventType === 'string' && le.eventType ? le.eventType : 'speed_change';
        // 背景色是全局的：写在任何图层都生效，但写在非根图层属于不良写法 → warning。
        if (outLE.eventType === 'bg_change' && lay.parentId) {
          warnings.push(
            '图层 "' + lay.id + '" 不是根图层但含 bg_change 事件；背景色是全局的，建议移到根图层。'
          );
        }
        layerEvents.push(outLE);
      }
      if (layerEvents.length > 0) {
        layerEvents.sort(function (a: any, b: any) { return a.beat - b.beat; });
        lay.events = layerEvents;
      }
    }
    // 全部图层都被丢弃时不写 `layers`：保持「缺省 = 只有默认根图层的旧形态」，
    // 否则会留一个空数组，语义上与「有图层」无法区分。
    if (outLayers.length > 0) chart.layers = outLayers;
  }

  // 音符引用的图层若不存在（或谱面根本没有 layers），一律归到默认根图层。
  for (var ni = 0; ni < notes.length; ni++) {
    if (notes[ni].layerId && !seenIds[notes[ni].layerId]) {
      warnings.push(
        '音符引用了不存在的图层 "' + notes[ni].layerId + '"，已归到默认根图层。'
      );
      delete notes[ni].layerId;
    }
  }

  if (notes.length === 0) {
    warnings.push('谱面没有任何可判定音符，进入游戏后将直接以 0 分结算。');
  }

  return { valid: true, chart: chart, warnings: warnings.length > 0 ? warnings : undefined };
}
