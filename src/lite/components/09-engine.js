/* === 6. Game loop === */
  var STATE = { MENU: 0, PLAYING: 1, PAUSED: 2, RESULT: 3 };
  var game = {
    state: STATE.MENU,
    chart: null, notes: [], totalNotes: 0, lastNoteTime: 0,
    events: [], speedPoints: [], nextEventIdx: 0,
    /* 图层（Layer）：树 + 每帧偏移 + 各图层滚动距离时间轴 / 当前距离。 */
    layerTree: null, layerOffs: [], layerDist: [], layerCurDist: [], minLayerSpeed: 1,
    currentSpeedMul: 1.0, currentNoteColor: null, currentText: null, currentTextTimeout: 0,
    /* 背景媒体层（§3.6，仅图片）。 */
    bgImage: null, bgImgEl: null, bgFit: 'cover', bgOpacity: 1,
    /* 触发器 { ref } 的 id→事件表（resetGame 建）。 */
    eventById: {},
    /* 背景渐变当前状态：随 bg_change 事件变化（见 processEvents），开局用谱面 bgScheme 初始化。 */
    bgStart: null, bgEnd: null,
    speed: 36, speedMul: 1.0, renderDist: 70, sizeScale: 1.0, autoPlay: false,
    curTime: 0, judged: {}, judgedCount: 0,
    score: 0, combo: 0, maxCombo: 0, counts: { 'S-Perfect': 0, 'Perfect': 0, 'Good': 0, 'Miss': 0 },
    bursts: [], songEnded: false,
    /* Pointer tracking (mirrors GameCanvas pointersRef). pid → {x,y,down,active}.
     * Used by per-frame processSlide/processTouchNote to detect hover-style hits. */
    pointers: {},
    /* Slide chain state (mirrors GameCanvas slideStateRef): noteId → SlideRt.
     * Each SlideRt tracks boundPointerIds (multiple) + per-node flags so nodes are judged
     * only when they reach the plane (dt>=0), not early on pointer proximity. */
    slideStates: {},
    /* Touch note state (mirrors GameCanvas touchTrackRef): noteId →
     * {lastInsideTime, arrivalChecked}. Touch notes are hover-triggered. */
    touchStates: {}
  };
  /* Settings — persisted to localStorage when changed. Mirrors the full version's
   * SettingsModal defaults so both versions feel the same. */
  var settings = {
    speedMul: 1.0,
    audioOffsetMs: 0,
    projectionLeadMs: 500,
    renderDist: 70,
    sizeScale: 1.0,
    musicVolume: 0.8,
    effectVolume: 0.9,
    /* 默认开启：多数设备关闭后音画同步更好，但部分设备音频时钟不稳会出问题，
     * 故以兼容模式为默认，异常时反而更稳。仅改默认值，文案与完整版不同步。 */
    compatMode: true,
    /* 禁用附加内容：勾选后不再加载歌曲目录的背景图（bg.jpg），画面退回渐变背景。
     * Lite 的"附加内容"只有背景图这一种（无视频、无故事板）。低配设备或只想读谱时
     * 用它省内存 —— 与完整版设置同名，便于两版互相迁移认知。 */
    disableExtraContent: false,
    /* Render frame-rate cap (0 = unlimited). Mirrors the full version's
     * qualityStore.maxFps default: on 90/120/144Hz screens this drops the drawn
     * frame count (and with it power draw) with almost no visual difference. */
    maxFps: 60
  };
  try {
    var saved = window.localStorage && localStorage.getItem('poluxis-lite-settings');
    if (saved) {
      var parsed = JSON.parse(saved);
      if (parsed) for (var sk in parsed) if (Object.prototype.hasOwnProperty.call(settings, sk))
        settings[sk] = parsed[sk];
    }
  } catch (e) { /* private mode / old browser — keep defaults */ }
  audio.setCompatMode(settings.compatMode);
  function saveSettings() {
    try { window.localStorage && localStorage.setItem('poluxis-lite-settings', JSON.stringify(settings)); } catch (e) {}
  }

  function resetGame(chart) {
    game.chart = chart;
    game.notes = resolveChart(chart);
    game.events = resolveEvents(chart);
    /* 传入 easing：speed_change 的 duration>0 时间过渡需要它来离散斜坡。 */
    game.speedPoints = extractSpeedPoints(game.events, easeLite);
    /* ---- 谱面预处理（一次性，镜像完整版 utils/chartRuntime）----
     *  - 预计算每个音符 / slide 子节点的滚动距离（timeSec 一局内恒定）；
     *  - 预计算 hasNegativeSpeed / minSpeed，省掉每帧对变速点的两遍全扫；
     *  - 按滚动距离排序的音符索引 notesByDist + maxSlideScrollSpan，供负流速下
     *    的「距离窗口」二分（时间窗口在负流速下不再连续）。 */
    var _sp = game.speedPoints;
    /* 变速点前缀表：使「任意时刻的滚动距离」可 O(log N)（原为每帧 / 每图层线性扫描）。
     * 与完整版 utils/chartRuntime 共用同一份实现（共享 beatTime.ts，Lite 侧内联）。 */
    game.speedPrefix = buildSpeedPrefix(_sp);
    var _hasNeg = false;
    var _minSpeed = 1;
    for (var _si = 0; _si < _sp.length; _si++) {
      if (_sp[_si].speed < 0) _hasNeg = true;
      if (_sp[_si].speed < _minSpeed) _minSpeed = _sp[_si].speed;
    }
    game.hasNegativeSpeed = _hasNeg;
    game.minSpeed = _minSpeed;
    /* 图层（Layer）运行时：树随谱面重建。
     * 流速是 Π 相乘，各层自身的 speed_change 会让倍率**时变**，因此每个图层要有
     * 自己的滚动距离时间轴 S_layer(t) = ∫(speed_global × Π 各层自身 speed × Π speedMul)；
     * 只有链上各层都没有自身变速事件时，才退化为「全局距离 × 常数倍率」。 */
    game.layerTree = buildLayerTreeLite(chart);
    game.layerOffs = [];
    game.layerDist = [];
    var _minLayerSpeed = 1;
    for (var _lt = 0; _lt < game.layerTree.nodes.length; _lt++) {
      game.layerOffs.push({ x: 0, y: 0 });
      var _lmul = layerSpeedMul(game.layerTree, _lt);
      var _lpts = layerHasOwnSpeed(game.layerTree, _lt)
        ? layerSpeedTimeline(game.layerTree, _lt, _sp)
        : null;
      game.layerDist.push({
        mul: _lmul, globalBase: _lt === 0, points: _lpts,
        /* 图层自身时间轴的前缀表（无自身变速事件时 points/prefix 均为 null）。 */
        prefix: _lpts ? buildSpeedPrefix(_lpts) : null
      });
      var _lrel = layerMinRelSpeed(game.layerTree, _lt);
      if (_lrel > 0 && _lrel < _minLayerSpeed) _minLayerSpeed = _lrel;
    }
    game.minLayerSpeed = _minLayerSpeed;
    var _maxSlideScrollSpan = 0;
    for (var _ni = 0; _ni < game.notes.length; _ni++) {
      var _n = game.notes[_ni];
      var _li = noteLayerIdx(game.layerTree, _n);
      _n.layerIdx = _li;
      _n.globalDist = prefixDistanceAt(game.speedPrefix, _n.timeSec);
      var _nd = layerDistAt(_li, _n.timeSec);
      _n.scrollDist = _nd;
      if (_n.resolvedNodes) {
        for (var _ci = 0; _ci < _n.resolvedNodes.length; _ci++) {
          var _cn = _n.resolvedNodes[_ci];
          _cn.globalDist = prefixDistanceAt(game.speedPrefix, _cn.timeSec);
          _cn.scrollDist = layerDistAt(_li, _cn.timeSec);
          var _ds = _cn.scrollDist - _nd;
          if (_ds < 0) _ds = -_ds;
          if (_ds > _maxSlideScrollSpan) _maxSlideScrollSpan = _ds;
        }
      }
    }
    game.maxSlideScrollSpan = _maxSlideScrollSpan;
    var _order = [];
    for (var _oi = 0; _oi < game.notes.length; _oi++) _order.push(_oi);
    /* 各图层距离尺度不同，排序统一走 globalDist（窗口另按 minLayerSpeed 扩宽）。 */
    _order.sort(function (a, b) { return game.notes[a].globalDist - game.notes[b].globalDist; });
    game.notesByDist = _order;
    game.nextEventIdx = 0;
    game.currentSpeedMul = 1.0;
    game.currentNoteColor = null;
    game.currentText = null;
    game.currentTextTimeout = 0;
    /* 初始化背景渐变：用谱面 bgScheme 作为基础配色（bg_change 事件会覆盖）。 */
    var _bg = (chart.metadata && chart.metadata.bgScheme) || {};
    game.bgStart = typeof _bg.gradientStart === 'string' ? _bg.gradientStart : '#050816';
    game.bgEnd = typeof _bg.gradientEnd === 'string' ? _bg.gradientEnd : '#02040c';
    /* 背景媒体层：图片来自歌曲目录约定文件 bg.jpg（由 10-ui 的 startGameWithChart
     * 依据 songItem.bgImage 注入，Lite 仅支持图片）；谱面不再携带媒体背景。 */
    game.bgFit = 'cover';
    game.bgOpacity = 1;
    setBgImageLite(null);
    game.totalNotes = countPlayableNotes(chart);
    /* id→音符表供 commitJudge 查 noScore（图层树 / 图层距离已在上面建好）。 */
    game.noteById = {};
    for (var _nn = 0; _nn < game.notes.length; _nn++) game.noteById[game.notes[_nn].id] = game.notes[_nn];
    /* 触发器 { ref } 查找表：顶层 events + 各图层事件轴。 */
    game.eventById = {};
    var _regEvt = function (ev) { if (ev && ev.id) game.eventById[ev.id] = ev; };
    for (var _re = 0; _re < game.events.length; _re++) _regEvt(game.events[_re]);
    var _lyrs = chart.layers;
    if (_lyrs) {
      for (var _rl = 0; _rl < _lyrs.length; _rl++) {
        var _lev = _lyrs[_rl].events || [];
        for (var _rl2 = 0; _rl2 < _lev.length; _rl2++) _regEvt(_lev[_rl2]);
      }
    }
    slideViewCache = {};
    game.lastNoteTime = 0;
    /* maxSlideSpan = max over slides of (lastChildTime - headTime).
     * Ported from full version commit 9f04e42: without this, a slide whose
     * head has left the sliding window's pastBuffer drops out of iteration
     * while its later child nodes are still upcoming → children never judged. */
    var maxSlideSpan = 0;
    for (var i = 0; i < game.notes.length; i++) {
      var n = game.notes[i];
      if (n.timeSec > game.lastNoteTime) game.lastNoteTime = n.timeSec;
      if (n.resolvedNodes && n.resolvedNodes.length > 0) {
        var lastChildT = n.resolvedNodes[n.resolvedNodes.length - 1].timeSec;
        for (var k = 0; k < n.resolvedNodes.length; k++)
          if (n.resolvedNodes[k].timeSec > game.lastNoteTime) game.lastNoteTime = n.resolvedNodes[k].timeSec;
        var span = lastChildT - n.timeSec;
        if (span > maxSlideSpan) maxSlideSpan = span;
      }
    }
    game.maxSlideSpan = maxSlideSpan;
    game.judged = {}; game.judgedCount = 0;
    game.score = 0; game.combo = 0; game.maxCombo = 0;
    game.counts = { 'S-Perfect': 0, 'Perfect': 0, 'Good': 0, 'Miss': 0 };
    game.bursts = []; game.songEnded = false; game.curTime = 0;
    game.pointers = {}; game.slideStates = {}; game.touchStates = {};
    /* Clear per-game visual feedback so markers/bursts don't bleed across songs. */
    timingMarkers = []; comboBursts = [];
    /* Apply persisted settings to per-game runtime fields */
    game.speedMul = settings.speedMul;
    game.renderDist = settings.renderDist;
    game.sizeScale = settings.sizeScale;
  }

  /* Spawn a hit burst at world (wx,wy). The 4th arg `nt` is the note type
   * ('tap'/'touch'/'slide') so the burst shape matches the note (mirrors
   * full version spawnBurst using _tapOutlineGeo/_touchOutlineGeo/_slideOutlineGeo).
   * baseSize = the note's projected size at the judge plane (z=0).
   * scaleTarget = per-judgment growth factor (1.2/1.1/1.05/1.0) from JUDGE_SCALE.
   * Animation: size = baseSize * (1 + (scaleTarget-1) * sin(p*π/2)), 300ms, linear fade.
   * 与 GameCanvas 的命中爆发动画同口径（缓动与 300ms 时长）。 */
  var burstPool = [];
  /* 复用 P2 / 采样缓冲：消除每帧每音符 / 每采样点的临时对象分配。
   * 各缓冲即用即弃、单线程顺序消费 —— 复用安全。 */
  var _burstP2 = { x: 0, y: 0, scale: 0, alpha: 0 };
  var _projP2 = { x: 0, y: 0, scale: 0, alpha: 0 };
  var _capP2a = { x: 0, y: 0, scale: 0, alpha: 0 };
  var _capP2b = { x: 0, y: 0, scale: 0, alpha: 0 };
  var _samples = [];
  var _samplePool = [];
  function _sampleAt(i) {
    var o = _samplePool[i];
    if (!o) { o = { x: 0, y: 0, scale: 0, alpha: 0 }; _samplePool[i] = o; }
    return o;
  }
  function spawnBurst(wx, wy, jType, nt, angle) {
    if (!projectInto(_burstP2, wx, wy, 0, -1000)) return;
    var kind = nt || 'tap';
    var vs = game.sizeScale;
    /* Same formula as drawProjection at z=0 (p.scale = 1).
     * NOTE: drawBursts uses `r` as the HALF-size for shapes:
     *   tap  → strokeRect(-r, -r, r*2, r*2) → r is half-width
     *   touch→ arc(0, 0, r) → r is radius (already half)
     *   slide→ diamond with r as half-diagonal (already half)
     * So tap's baseSize must be HALVED to match the projection guide. */
    var baseSize;
    if (kind === 'touch') {
      baseSize = (TOUCH_SIZE / 2) * view.pxPerUnit * _burstP2.scale * vs;
    } else if (kind === 'slide') {
      baseSize = SLIDE_HALF * view.pxPerUnit * _burstP2.scale * vs;
    } else {
      baseSize = (TAP_SIZE / 2) * view.pxPerUnit * _burstP2.scale * vs;
    }
    var b = burstPool.pop() || {};
    b.x = _burstP2.x; b.y = _burstP2.y; b.start = now(); b.dur = 300;
    b.color = JUDGE_COLORS[jType]; b.kind = kind; b.baseSize = baseSize;
    b.scaleTarget = JUDGE_SCALE[jType] || 1.0;
    b.angle = (typeof angle === 'number') ? angle : 0;
    game.bursts.push(b);
  }
  /* Draw active bursts. Shape varies by note type:
   *   tap → square, touch → circle, slide → diamond.
   * Size: starts at baseSize (note size at judge plane), grows to
   *   baseSize * scaleTarget via sine curve (1.2× max for S-Perfect).
   *   与 GameCanvas 的命中爆发动画同口径。 */
  function drawBursts() {
    var t = now();
    /* 原地压缩（代替每帧 new kept 数组）——无 burst 时也零分配。 */
    var bursts = game.bursts;
    var write = 0;
    for (var i = 0; i < bursts.length; i++) {
      var b = bursts[i];
      var prog = (t - b.start) / b.dur;
      if (prog >= 1) { burstPool.push(b); continue; }
      /* Sine-eased scale: 1 at start → scaleTarget at end (p=1).
       * multiplier = 1 + (scaleTarget - 1) * sin(p * π / 2) */
      var multiplier = 1 + (b.scaleTarget - 1) * Math.sin(prog * Math.PI * 0.5);
      var r = b.baseSize * multiplier;
      ctx.save();
      ctx.globalAlpha = (1 - prog) * 0.95;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 3;
      ctx.translate(b.x, b.y);
      /* Rotate the burst outline to match the note's direction (angle in degrees,
       * +angle = clockwise, consistent with the note visuals and full version). */
      if (b.angle) ctx.rotate(b.angle * Math.PI / 180);
      if (b.kind === 'touch') {
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      } else if (b.kind === 'slide') {
        /* diamond (45° square) */
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
        ctx.stroke();
      } else {
        /* tap: square */
        ctx.strokeRect(-r, -r, r * 2, r * 2);
      }
      ctx.restore();
      bursts[write++] = b;
    }
    bursts.length = write;
  }

  function commitJudge(id, j, dt, wx, wy, nt, angle) {
    if (game.judged[id]) return;
    game.judged[id] = true;
    /* 不计分音符（noScore）：参与判定，但不计分 / 不计数量（judgedCount）/ 不计连击。
     * id 形如 `headId` 或 `headId#idx`，按头节点查旗标（slide 子节点继承头语义）。 */
    var _hn = game.noteById ? game.noteById[id.split('#')[0]] : null;
    var noScore = !!(_hn && _hn.noScore);
    if (!noScore) game.judgedCount++;
    var sc = noScore ? 0 : calculateNoteScore(j, game.totalNotes);
    if (!noScore) {
      game.score += sc;
      if (j === 'Miss') { game.combo = 0; } else { game.combo++; if (game.combo > game.maxCombo) game.maxCombo = game.combo; }
      game.counts[j]++;
      if (j !== 'Miss' && game.combo > 0 && game.combo % 10 === 0) {
        comboBursts.push({ value: game.combo, start: now(), dur: 600 });
      }
    }
    if (typeof wx === 'number' && typeof wy === 'number' && nt) {
      spawnBurst(wx, wy, j, nt, angle);
    }
    /* 音符触发器（§3.4）：slide 子节点沿用头节点的 trigger。 */
    if (_hn) dispatchTriggerLite(_hn, j);
    addTimingMarker(j, dt);
    return sc;
  }

  /* === 音符触发器（§3.4，ES5；与 3D/2D 同语义）===
   * { ref } 形式需要 id → 事件表（顶层 + 各图层事件轴），在 resetGame 里建好。
   * 只执行运行时可即时生效的类型：文本 / 音符色 / 背景。
   * 变速与偏移已预先积分进滚动距离与落点，判定时刻无法改变 → 忽略。 */
  function dispatchTriggerLite(note, j) {
    if (!note.trigger) return;
    var evts = resolveTriggerEvents(note, j, function (id) { return game.eventById[id]; });
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (isTriggerEventUnsupported(e)) continue;
      if (e.eventType === 'text_display') {
        game.currentText = e.text || '';
        var dur = (typeof e.textDuration === 'number') ? e.textDuration : 2;
        game.currentTextTimeout = game.curTime + dur;
      } else if (e.eventType === 'note_color_change' && e.noteColor) {
        game.currentNoteColor = e.noteColor;
      } else if (e.eventType === 'bg_change') {
        if (typeof e.gradientStart === 'string') game.bgStart = e.gradientStart;
        if (typeof e.gradientEnd === 'string') game.bgEnd = e.gradientEnd;
      }
    }
  }

  /* === Combo 显示 + 线框爆发（与 App.tsx 的 combo 显示同口径） ===
   * Large semi-transparent combo number drawn at screen center, BEHIND notes.
   * Every 10 combo: a wireframe outline number scales up 1→1.8 and fades. */
  var comboBursts = [];
  function drawCombo() {
    if (game.combo <= 0) return;
    var cx = view.w * 0.5, cy = view.h * 0.5;
    var size = Math.min(view.w, view.h) * 0.22;
    ctx.save();
    ctx.font = '900 ' + size + 'px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(game.combo), cx, cy);
    ctx.globalAlpha = 0.12;
    ctx.font = '700 ' + (size * 0.1) + 'px Consolas, "Courier New", monospace';
    ctx.fillText('COMBO', cx, cy + size * 0.45);
    ctx.restore();
  }
  function drawComboBursts() {
    var t = now();
    /* 原地压缩（代替每帧 new kept 数组）。 */
    var cx = view.w * 0.5, cy = view.h * 0.5;
    var baseSize = Math.min(view.w, view.h) * 0.18;
    var write = 0;
    for (var i = 0; i < comboBursts.length; i++) {
      var b = comboBursts[i];
      var prog = (t - b.start) / b.dur;
      if (prog >= 1) continue;
      var scale = 1 + 0.8 * prog;            /* 1 → 1.8 (mirrors comboBurstAnim) */
      var alpha = 0.7 * (1 - prog);
      var sz = baseSize * scale;
      ctx.save();
      ctx.font = '900 ' + sz + 'px Consolas, "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = withAlpha(Theme.accent(), 0.85); /* follows chart accentColor */
      ctx.lineWidth = 2;
      ctx.strokeText(String(b.value), cx, cy);
      ctx.restore();
      comboBursts[write++] = b;
    }
    comboBursts.length = write;
  }

  /* === Rainbow timing bar (mirrors TimingBar.tsx) ===
   * ADOFAI-style accuracy bar at the top: red-blue-yellow-orange-yellow-blue-red
   * gradient. Each hit drops a dot at its dt position; miss pins to far right. */
  var TIMING_RANGE_MS = 240;
  var timingMarkers = [];
  /* 边界刻度（常量，避免每帧重建数组 + forEach 闭包）。 */
  var TIMING_TICKS = [41.67, 58.33, 33.33, 66.67];
  var TIMING_BAR_GRADIENT = (function () {
    /* Pre-compute gradient stops as RGB so we can build it per-frame (canvas
     * gradients are tied to coordinates and IE11 has no CSS-style string). */
    return [
      [0,    '#ef4444'], [8,  '#ef4444'],
      [16.7, '#38bdf8'], [26, '#38bdf8'],
      [33.3, '#ffd700'], [37, '#ffd700'],
      [44,   '#ff8c00'], [56, '#ff8c00'],
      [63,   '#ffd700'], [66.7,'#ffd700'],
      [74,   '#38bdf8'], [83.3,'#38bdf8'],
      [92,   '#ef4444'], [100, '#ef4444']
    ];
  })();
  function addTimingMarker(j, dt) {
    var pct;
    if (j === 'Miss') pct = 100;
    else {
      var clamped = Math.max(-TIMING_RANGE_MS, Math.min(TIMING_RANGE_MS, dt));
      pct = ((clamped + TIMING_RANGE_MS) / (TIMING_RANGE_MS * 2)) * 100;
    }
    timingMarkers.push({ pct: pct, color: JUDGE_COLORS[j], start: now(), dur: 1150 });
    /* Cap marker count to avoid unbounded growth in long songs. */
    if (timingMarkers.length > 40) timingMarkers.shift();
  }
  function drawTimingBar() {
    var barH = 10, barY = 4, barX = view.w * 0.15, barW = view.w * 0.7;
    if (barW < 100) { barX = 10; barW = view.w - 20; }
    ctx.save();
    /* Rainbow gradient track */
    var grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    for (var i = 0; i < TIMING_BAR_GRADIENT.length; i++) {
      grad.addColorStop(TIMING_BAR_GRADIENT[i][0] / 100, TIMING_BAR_GRADIENT[i][1]);
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW, barH);
    /* Center tick (0ms) */
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(barX + barW * 0.5 - 1, barY - 3, 2, barH + 6);
    /* Boundary ticks at ±40ms / ±80ms */
    ctx.globalAlpha = 0.25;
    for (var ti = 0; ti < TIMING_TICKS.length; ti++) {
      ctx.fillRect(barX + barW * TIMING_TICKS[ti] / 100 - 0.5, barY - 2, 1, barH + 4);
    }
    /* Marker dots — animate in then fade (mirrors timingMarkerAnim 1.15s) */
    var t = now();
    /* 原地压缩（代替每帧 new kept 数组）。 */
    var write = 0;
    for (var m = 0; m < timingMarkers.length; m++) {
      var mk = timingMarkers[m];
      var prog = (t - mk.start) / mk.dur;
      if (prog >= 1) continue;
      var mx = barX + barW * mk.pct / 100;
      var my = barY + barH * 0.5;
      var appear = Math.min(1, prog * 8);     /* quick fade-in */
      var alpha = appear * (1 - prog);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      ctx.arc(mx, my, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      timingMarkers[write++] = mk;
    }
    timingMarkers.length = write;
    ctx.restore();
  }

  /* === Note landing projection guide (mirrors mkProj) ===
   * Faint outline of the note at the judge plane (z=0) that fades in as the
   * note approaches. Opacity = clamp(1 - timeToHitMs / leadMs, 0, 0.95).
   * leadMs is configurable via settings.projectionLeadMs (0 = disabled).
   * If chart.metadata.effectToggles.projection === false, the projection guide
   * is forcibly disabled regardless of the user's leadMs setting. */
  function drawProjection(note, color, vScale, curTime) {
    /* game.chart is the global chart reference (render() uses a local `chart`
     * shadow which we cannot see here — must access via game.chart). */
    var md = (game.chart && game.chart.metadata) || {};
    var toggles = md.effectToggles || {};
    var projEnabled = toggles.projection !== false;
    if (!projEnabled) return; /* chart disabled projection guide */
    var leadMs = settings.projectionLeadMs;
    if (leadMs <= 0) return; /* 0 = projection guide disabled */
    var timeToHitMs = (note.timeSec - curTime) * 1000;
    if (timeToHitMs < 0 || timeToHitMs > leadMs) return;
    var po = Math.max(0, Math.min(0.95, 1 - timeToHitMs / leadMs));
    if (po <= 0.01) return;
    /* 投影引导 = 落点提示，钉在「最终落位」（base + 音符自己 timeSec 的图层偏移），
     * 不随播放中的整列平移跑动（与完整版一致）。 */
    landingOffOfLiteInto(note, _projOffLite);
    if (!projectInto(_projP2, note.x + _projOffLite.x, note.y + _projOffLite.y, 0, -1000)) return;
    ctx.save();
    ctx.globalAlpha = po;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    /* Rotate the projection guide to match the note's direction (angle in
     * degrees, +angle = clockwise) so the player can read the orientation
     * before the note falls. */
    ctx.translate(_projP2.x, _projP2.y);
    if (note.angle) ctx.rotate(note.angle * Math.PI / 180);
    if (note.type === 'tap') {
      var sz = TAP_SIZE * view.pxPerUnit * _projP2.scale * vScale;
      ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
    } else if (note.type === 'touch') {
      var r = (TOUCH_SIZE / 2) * view.pxPerUnit * _projP2.scale * vScale;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2); ctx.stroke();
    } else {
      var half = SLIDE_HALF * view.pxPerUnit * _projP2.scale * vScale;
      ctx.beginPath();
      ctx.moveTo(0, -half); ctx.lineTo(half, 0);
      ctx.lineTo(0, half); ctx.lineTo(-half, 0); ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Time window [firstIdx, lastIdx): notes are sorted by timeSec so a plain
   * binary search suffices. Time-based ⇒ valid for ANY speed sign; used for
   * judgement (miss / autoplay / hit-testing). Mirrors full version. */
  function findWindow(curTime, spawnLimit) {
    var speed = game.speed * game.speedMul;
    var pastBuffer = 0.3 + (game.maxSlideSpan || 0), futureBuffer = -spawnLimit / speed + 0.3;
    var pastTh = curTime - pastBuffer, futureTh = curTime + futureBuffer;
    var lo = 0, hi = game.notes.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (game.notes[mid].timeSec < pastTh) lo = mid + 1; else hi = mid; }
    var first = lo; lo = first; hi = game.notes.length;
    while (lo < hi) { mid = (lo + hi) >> 1; if (game.notes[mid].timeSec <= futureTh) lo = mid + 1; else hi = mid; }
    return { first: first, last: lo };
  }

  /* Render window. Without negative speed events it is just the time window
   * (order = null → iterate game.notes by index). With negative speed, S(t) is
   * non-monotonic so the visible set is NOT a time interval; but z depends only
   * on S(noteTime) - S(curTime), hence the visible set IS a contiguous interval
   * in **scroll-distance** space → binary search the precomputed notesByDist.
   * maxSlideScrollSpan widens the band so a slide whose head is outside but whose
   * child is inside is still visited. Returns `order` (notesByDist) in that case. */
  function renderWindow(curTime, spawnLimit) {
    if (!game.hasNegativeSpeed) {
      var w0 = findWindow(curTime, spawnLimit);
      return { first: w0.first, last: w0.last, order: null };
    }
    var baseSpeed = game.speed * game.speedMul;
    var curDist = game.curScrollDist;
    /* z = JUDGE_Z - (nd - curDist) * baseSpeed; visible band z ∈ [spawnLimit, view.cd). */
    var loD = (JUDGE_Z - view.cd) / baseSpeed;
    var hiD = (JUDGE_Z - spawnLimit) / baseSpeed;
    if (loD > hiD) { var tmp = loD; loD = hiD; hiD = tmp; }
    var span = game.maxSlideScrollSpan || 0;
    var dLo = curDist + loD - span, dHi = curDist + hiD + span;
    var order = game.notesByDist, notes = game.notes;
    var a = 0, b = order.length, mid2;
    while (a < b) { mid2 = (a + b) >> 1; if (notes[order[mid2]].scrollDist < dLo) a = mid2 + 1; else b = mid2; }
    var first2 = a; b = order.length;
    while (a < b) { mid2 = (a + b) >> 1; if (notes[order[mid2]].scrollDist <= dHi) a = mid2 + 1; else b = mid2; }
    return { first: first2, last: a, order: order };
  }

  /* Compute z position using scroll distance integral (mirrors GameCanvas).
   * This ensures note spacing reflects speed changes before the event visually arrives,
   * preventing teleportation artifacts when speed_change events trigger.
   * `noteDist` is the note's precomputed scroll distance (see resetGame) — passing
   * it avoids a per-note getScrollDistance() linear scan over speed points. */
  /* curDist = 该音符**所属图层**在当前时刻的滚动距离（图层流速已积分在内），
   * 缺省时回退全局当前距离。判定时刻两者相等 → z = JUDGE_Z（不受流速影响）。 */
  function noteZPos(noteTimeSec, curTime, baseSpeed, noteDist, curDist) {
    var nd = (noteDist === undefined || noteDist === null) ? globalDistAt(noteTimeSec) : noteDist;
    var cd = (curDist === undefined || curDist === null)
      ? ((game.curScrollDist === undefined) ? globalDistAt(curTime) : game.curScrollDist)
      : curDist;
    return JUDGE_Z - (nd - cd) * baseSpeed;
  }

  /* 该音符**所属图层**在当前时刻的滚动距离（slide 子节点沿用头节点图层）。
   * 无图层树时 layerCurDist 为空数组 → 取到 undefined，由 noteZPos 回退全局距离。 */
  function layerCurDistOf(note) {
    return game.layerCurDist[note.layerIdx];
  }

  /* —— 图层（Layer）运行时（与完整版 GameCanvas 同构；ES5）—— */
  var ZERO_OFF_LITE = { x: 0, y: 0 };
  /* shared/layers.ts 禁止运行时 import，beat→秒 / easing / 斜坡步进都要在这注入
   * （完整版由 src/utils/layers.ts 注入）。⚠️ 直接调用 buildLayerTree(chart) 会因
   * deps 缺失而抛错 —— 必须走这个包装。 */
  function easeLite(name, t) {
    var fn = EASING_FNS[name] || EASING_FNS.linear;
    return fn(t);
  }
  function buildLayerTreeLite(chart) {
    var meta = (chart && chart.metadata) || {};
    return buildLayerTree(chart, {
      beatToSec: function (beat) {
        return beatToSecondsMultiBpm(beat, meta.bpm, meta.offset, meta.bpmlist);
      },
      ease: easeLite,
      rampSteps: SPEED_RAMP_STEPS
    });
  }
  /** 全局（默认根图层基底）在时刻 t 的累计滚动距离（前缀表 → O(log N)）。 */
  function globalDistAt(t) {
    return game.speedPrefix
      ? prefixDistanceAt(game.speedPrefix, t)
      : getScrollDistance(t, game.speedPoints);
  }
  /* 图层 li 在时刻 t 的滚动距离：有自身变速事件时走该层的时间轴，否则「全局 × 常数倍率」。 */
  function layerDistAt(li, t) {
    var ld = game.layerDist ? game.layerDist[li] : null;
    if (ld && ld.points) {
      return ld.prefix ? prefixDistanceAt(ld.prefix, t) : getScrollDistance(t, ld.points);
    }
    /* 只有默认根图层以顶层 events 为基底；其余图层基底 = 常数 1（距离 = t）。 */
    var base = (ld && ld.globalBase) ? globalDistAt(t) : t;
    return (ld && ld.mul !== 1) ? ld.mul * base : base;
  }
  var slideViewCache = {};
  function layerIdxOfLite(note) {
    return game.layerTree ? noteLayerIdx(game.layerTree, note) : 0;
  }
  function offOfLite(note) {
    if (!game.layerTree) return ZERO_OFF_LITE;
    var idx = layerIdxOfLite(note);
    var offs = game.layerOffs;
    return idx >= 0 && idx < offs.length ? offs[idx] : ZERO_OFF_LITE;
  }
  function layerOffAtIdxLite(idx, t) {
    return game.layerTree ? layerOffsetAt(game.layerTree, idx, t) : ZERO_OFF_LITE;
  }
  /* 判定落位偏移（按音符自己 timeSec）——投影引导/打击特效钉落位用。 */
  function landingOffOfLite(note) {
    if (!game.layerTree) return ZERO_OFF_LITE;
    var t = (note && typeof note.timeSec === 'number') ? note.timeSec : 0;
    return layerOffAtIdxLite(layerIdxOfLite(note), t);
  }
  /* 写入式变体：热路径（每可见音符每帧 / 每图层每帧）用，避免每次分配 {x,y}。
   * 共享 layers.ts 已提供零分配的 layerOffsetAtInto（与完整版同一份实现）。
   * 各调用点用各自的 scratch，避免被中途调用串改。 */
  var _projOffLite = { x: 0, y: 0 };
  var _touchOffLite = { x: 0, y: 0 };
  function layerOffAtIdxLiteInto(idx, t, out) {
    if (!game.layerTree) { out.x = 0; out.y = 0; return; }
    layerOffsetAtInto(game.layerTree, idx, t, out);
  }
  function landingOffOfLiteInto(note, out) {
    if (!game.layerTree) { out.x = 0; out.y = 0; return; }
    var t = (note && typeof note.timeSec === 'number') ? note.timeSec : 0;
    layerOffAtIdxLiteInto(layerIdxOfLite(note), t, out);
  }

  function render() {
    var chart = game.chart;
    if (!chart || !ctx) return;
    var curTime = game.curTime;
    var baseSpeed = game.speed * game.speedMul;
    var spawnLimit = -game.renderDist;
    /* 当前时刻的滚动距离：每帧只算一次（原实现 noteZPos 每音符都算一遍 → O(音符×变速点)）。 */
    game.curScrollDist = globalDistAt(curTime);
    var vScale = game.sizeScale;
    var colorHex = game.currentNoteColor || chart.metadata.noteColor || '#00f0ff';

    /* 图层偏移 + 各图层当前滚动距离：每帧每图层一次（与完整版同构）。 */
    if (game.layerTree) {
      if (!game.layerCurDist) game.layerCurDist = [];
      for (var _li = 0; _li < game.layerTree.nodes.length; _li++) {
        /* 直接写入 game.layerOffs[_li]，不再每次 new {x,y}（原为 layerOffsetAt 返回新对象）。 */
        layerOffsetAtInto(game.layerTree, _li, curTime, game.layerOffs[_li]);
        game.layerCurDist[_li] = layerDistAt(_li, curTime);
      }
    }

    /* Process events first (speed changes, text, note color, etc.) */
    processEvents(curTime);

    /* Per-frame judgment pass (slides + touch hover + tap miss + AutoPlay).
     * Replaces the inline AutoPlay/miss logic that previously lived here. */
    processAllNotes(curTime);

    drawBackground(chart);
    /* effectToggles.gridLines === false hides both the tunnel perspective lines
     * and the judge plane border. Default true if chart omits effectToggles. */
    var _toggles = (chart.metadata && chart.metadata.effectToggles) || {};
    if (_toggles.gridLines !== false) {
      drawTunnel(spawnLimit);
    }

    /* Combo number BEHIND everything (mirrors full version z-[1] layer). */
    drawCombo();

    var win = renderWindow(curTime, spawnLimit);
    var _ord = win.order;

    /* Two-pass: pipes + projections first (behind), then notes (front). */
    var toDrawNotes = [];
    for (var i = win.first; i < win.last; i++) {
      var note = _ord === null ? game.notes[i] : game.notes[_ord[i]];
      /* 有效音符色：note.color → 图层色（就近继承 / 图层内 note_color_change）→ 全局 */
    var nc = note.color || (game.layerTree ? layerColorAt(game.layerTree, layerIdxOfLite(note), curTime, colorHex) : colorHex);

      if (note.type === 'slide') {
        var allNodes = getAllSlideNodes(note);
        /* Pipes between consecutive nodes — drawn as tapered ribbons with
         * perspective-scaled width for a 3D "pipe in space" look.
         *
         * CROSS-SECTION APPROACH:
         *   Imagine a physical pipe from A to B. We cut it with two planes:
         *   the judge plane (z=0) and the far render plane (z=spawnLimit).
         *   The visible pipe segment is the portion between these cuts.
         *   Each endpoint's x/y is interpolated along the A→B segment at
         *   the cut z — NOT the node's own position. This ensures the pipe
         *   follows the slide path exactly, even when nodes are judged or
         *   beyond the render distance. */
        for (var pi = 0; pi < allNodes.length - 1; pi++) {
          var nodeA = allNodes[pi];
          var nodeB = allNodes[pi + 1];
          /* 图层滚动距离：slide 子节点沿用头节点图层。 */
          var slideCD = layerCurDistOf(note);
          var zA = noteZPos(nodeA.timeSec, curTime, baseSpeed, nodeA.scrollDist, slideCD);
          var zB = noteZPos(nodeB.timeSec, curTime, baseSpeed, nodeB.scrollDist, slideCD);
          var keyA = note.id + '#' + pi;
          var keyB = note.id + '#' + (pi + 1);
          var judgedA = !!game.judged[keyA];
          var judgedB = !!game.judged[keyB];

          /* Skip when both judged, both far, or both past plane */
          if (judgedA && judgedB) continue;
          if (zA < spawnLimit && zB < spawnLimit) continue;
          if (zA > 0 && zB > 0) continue;

          /* Curve-eased slide pipe (mirrors GameCanvas slide tube).
           * The pipe CENTRELINE is a curve: x/y follow ease(τ), while the depth
           * z follows the scroll-distance profile (linear in time when no
           * speed_change sits inside the segment). So the pipe still connects
           * nodes A and B exactly but BOWS along the travel direction — NOT a
           * straight line. The visible pipe is the portion from the playhead
           * (τ = linear time fraction) to node B, clamped to [spawnLimit, 0].
           * CRITICAL: easing must NOT touch z (time) — only x/y. */
          var ex = nodeB.x - nodeA.x, ey = nodeB.y - nodeA.y;
          var dz = zB - zA;
          var segDur = Math.max(1e-4, nodeB.timeSec - nodeA.timeSec);
          var tau = (curTime - nodeA.timeSec) / segDur;
          if (tau < 0) tau = 0; else if (tau > 1) tau = 1;
          /* Gate on TIME, not eased position: for sine-out etc. ease(τ) hits
           * ~0.999 well before τ=1, which would hide a long tail too early. */
          if (tau >= 0.999) continue;
          var easeFn = EASING_FNS[nodeB.easing || 'linear'] || EASING_FNS.linear;

          /* A speed_change strictly between A and B makes z(τ) non-linear; sample
           * the real scroll-distance profile so the pipe length / playhead honour
           * the speed change (mirrors GameCanvas's zAt). Otherwise cheap linear. */
          /* 用该音符**所属图层**的时间轴采样（含图层自身的 speed_change）。 */
          var nli2 = note.layerIdx;
          var ld2 = game.layerDist[nli2];
          var spArr = (ld2 && ld2.points) ? ld2.points : game.speedPoints;
          var midSpeed = false;
          for (var si = 0; si < spArr.length; si++) {
            if (spArr[si].timeSec > nodeA.timeSec && spArr[si].timeSec < nodeB.timeSec) { midSpeed = true; break; }
          }
          var scrollDistA = midSpeed ? layerDistAt(nli2, nodeA.timeSec) : 0;
          function zAtTau(tt) {
            if (!midSpeed) return zA + tt * dz;
            return zA - (layerDistAt(nli2, nodeA.timeSec + tt * segDur) - scrollDistA) * baseSpeed;
          }

          /* Visible z-band τ-range (z ∈ [spawnLimit, 0]). Linear case solves
           * directly; midSpeed scans (z monotonic for non-negative speeds). */
          var tauBandLo, tauBandHi;
          if (!midSpeed) {
            if (Math.abs(dz) > 1e-6) {
              var tf = (spawnLimit - zA) / dz;   /* z = spawnLimit (far plane) */
              var tj = (0 - zA) / dz;            /* z = 0 (judge plane) */
              tauBandLo = Math.min(tf, tj);
              tauBandHi = Math.max(tf, tj);
            } else {
              tauBandLo = -Infinity; tauBandHi = Infinity;
            }
          } else {
            var blo = Infinity, bhi = -Infinity;
            for (var bq = 0; bq <= 24; bq++) {
              var bzq = zAtTau(bq / 24);
              if (bzq >= spawnLimit && bzq <= 0) {
                if (bq / 24 < blo) blo = bq / 24;
                if (bq / 24 > bhi) bhi = bq / 24;
              }
            }
            if (blo === Infinity) continue;
            tauBandLo = blo; tauBandHi = bhi;
          }
          /* Intersect band with [0,1] and with [τ,1] (nothing before playhead). */
          var visLo = Math.max(tau, tauBandLo, 0);
          var visHi = Math.min(1, tauBandHi);
          if (visLo >= visHi) continue;

          /* Sample the eased curve within the visible band. */
          var SEGS = 16;
          /* 采样点复用缓冲（每段重置；drawPipeCurve 即时消费，可跨段复用）。 */
          var samples = _samples;
          samples.length = 0;
          for (var sk = 0; sk <= SEGS; sk++) {
            var tt = visLo + (visHi - visLo) * (sk / SEGS);
            var wx = nodeA.x + easeFn(tt) * ex;
            var wy = nodeA.y + easeFn(tt) * ey;
            var wz = zAtTau(tt);
            /* Tail node not yet visible → visible band ends exactly at the far
             * plane (spawnLimit). Floating-point error makes zAtTau(visHi) fall
             * marginally below spawnLimit on some frames, so project() rejects
             * it and the sample count flickers 16↔17. That re-spaces the
             * k/(n-1) gradient stops in drawPipeCurve → the whole pipe gradient
             * twinkles. Clamp out-of-range samples to the plane (never skip) so
             * the sample count — and the gradient — stays stable. */
            var sp = _sampleAt(samples.length);
            if (!projectInto(sp, wx, wy, wz, spawnLimit)
              && !projectInto(sp, wx, wy, Math.max(spawnLimit, wz), spawnLimit)) continue;
            sp.alpha = Math.max(0.1, Math.min(1, (wz - spawnLimit) / FADE_ZONE));
            samples.push(sp);
          }
          if (samples.length < 2) continue;

          /* --- Slide pipe color/brightness effects (mirrors GameCanvas.tsx) ---
           * 1. Red: destination node has missLocked → SLIDE_RED.
           * 2. Holding: ANY bound pointer is down AND within the hit zone of the
           *    judge-plane cross-section (curve point at z=0, not the chord). */
          var slideRt = getSlideRt(note.id, allNodes.length);
          var nextNodeRt = slideRt.nodes[pi + 1];
          var isRed = !!nextNodeRt && nextNodeRt.missLocked && !judgedB;
          var isHolding = false;
          if (!isRed) {
            var hasAnyBound = false;
            var straddles = (zA > 0 && zB < 0) || (zA < 0 && zB > 0);
            var tCross = null;
            if (straddles) {
              if (!midSpeed) {
                tCross = (0 - zA) / dz;
              } else {
                /* Bisection for the τ where z(τ)=0 (z monotonic for non-neg speed). */
                var ca = 0, cb = 1;
                for (var bi = 0; bi < 20; bi++) {
                  var bm = (ca + cb) / 2;
                  if ((zAtTau(bm) > 0) === (zA > 0)) ca = bm; else cb = bm;
                }
                tCross = (ca + cb) / 2;
              }
            }
            for (var hbpid in slideRt.boundPointerIds) {
              if (!slideRt.boundPointerIds.hasOwnProperty(hbpid)) continue;
              hasAnyBound = true;
              var hbp = game.pointers[hbpid];
              if (hbp && hbp.down && tCross !== null) {
                var cx = nodeA.x + easeFn(tCross) * ex;
                var cy = nodeA.y + easeFn(tCross) * ey;
                if (Math.abs(hbp.x - cx) < SLIDE_HIT_HALF && Math.abs(hbp.y - cy) < SLIDE_HIT_HALF) {
                  isHolding = true;
                  break;
                }
              }
            }
            if (!hasAnyBound) isHolding = false;
          }
          var brightness = 1.0;
          if (isHolding) brightness = isRed ? 2.7 : 2.3;
          else if (isRed) brightness = 1.7;
          var pipeColor = isRed ? SLIDE_RED : nc;
          drawPipeCurve(samples, pipeColor, brightness, vScale);

          /* Cross-section caps at the pipe ENDS (playhead edge + node B), fading
           * in smoothly as each end nears the judge plane (z≈0). Drawing the cap at
           * the *ends* — a fixed node position, or the smoothly-moving playhead —
           * (instead of a point that slides along the curve at z=0) is what removes
           * the previous cross-section flicker. Cap alpha ∝ 1-|z|/capZ so it eases
           * in/out with no pop. */
          var capZ = 0.4;
          var wz0 = zAtTau(visLo), wzN = zAtTau(visHi);
          var capA0 = Math.max(0, 1 - Math.abs(wz0) / capZ);
          var capAN = Math.max(0, 1 - Math.abs(wzN) / capZ);
          if (capA0 > 0.01
            && projectInto(_capP2a, nodeA.x + easeFn(visLo) * ex, nodeA.y + easeFn(visLo) * ey, wz0, spawnLimit)) {
            drawPipeCap(_capP2a, pipeColor, capA0 * Math.min(1, brightness), _capP2a.scale, vScale);
          }
          if (capAN > 0.01
            && projectInto(_capP2b, nodeA.x + easeFn(visHi) * ex, nodeA.y + easeFn(visHi) * ey, wzN, spawnLimit)) {
            drawPipeCap(_capP2b, pipeColor, capAN * Math.min(1, brightness), _capP2b.scale, vScale);
          }
        }
        /* Slide nodes + projection guides */
        for (var nj = 0; nj < allNodes.length; nj++) {
          var slideNodeKey = note.id + '#' + nj;
          if (game.judged[slideNodeKey]) continue;
          var nz = noteZPos(allNodes[nj].timeSec, curTime, baseSpeed, allNodes[nj].scrollDist, layerCurDistOf(note));
          var np = project(allNodes[nj].x, allNodes[nj].y, nz, spawnLimit);
          if (np) toDrawNotes.push({ p: np, kind: 'slide', color: nc, isHead: nj === 0, noteId: note.id, nodeIdx: nj, angle: allNodes[nj].angle });
          /* Projection guide for slide head only (children inherit head's path).
           * 传头节点原始 base（allNodes 已嵌入 curTime 偏移），由 drawProjection 内部钉落位。 */
          if (nj === 0) drawProjection({ type: 'slide', timeSec: note.timeSec, x: note.x, y: note.y, angle: note.angle }, nc, vScale, curTime);
        }
      } else {
        /* tap / touch */
        var tkey = note.id;
        if (game.judged[tkey]) continue;
        var tz = noteZPos(note.timeSec, curTime, baseSpeed, note.scrollDist, layerCurDistOf(note));
        var tOff = offOfLite(note);
        var tp = project(note.x + tOff.x, note.y + tOff.y, tz, spawnLimit);
        if (tp) {
          toDrawNotes.push({ p: tp, kind: note.type, color: nc, noteId: note.id, wx: note.x, wy: note.y, timeSec: note.timeSec, angle: note.angle });
          /* Landing projection guide at the judge plane. */
          drawProjection(note, nc, vScale, curTime);
        }
      }
    }

    if (_toggles.gridLines !== false) {
      drawJudgePlane();
    }

    for (var d = 0; d < toDrawNotes.length; d++) {
      var item = toDrawNotes[d];
      if (item.kind === 'tap') drawTap(item.p, item.color, vScale, item.angle);
      else if (item.kind === 'touch') drawTouch(item.p, item.color, vScale, item.angle);
      else {
        drawSlideNode(item.p, item.color, vScale, item.isHead, item.angle);
      }
    }

    drawBursts();
    drawComboBursts();
    drawTimingBar();

    /* Event text display (mirrors GameCanvas event text overlay) */
    if (game.currentText) {
      ctx.save();
      var fontSize = Math.round(view.h * 0.05);
      ctx.font = 'bold ' + fontSize + 'px "Rajdhani", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = chart.metadata.bgScheme ? (chart.metadata.bgScheme.accentColor || '#00f0ff') : '#00f0ff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 10;
      ctx.fillText(game.currentText, view.w / 2, view.h * 0.35);
      ctx.restore();
    }

    /* Song-end check */
    if (game.state === STATE.PLAYING && !game.songEnded && game.totalNotes > 0) {
      if (game.judgedCount >= game.totalNotes || curTime > game.lastNoteTime + 1.5) {
        game.songEnded = true;
        var self = game;
        window.setTimeout(function () { endSong(self); }, 600);
      }
    }
  }

  /* HUD 元素引用与「上次写入值」缓存。
   * 原实现每帧 4 次 document.getElementById（未缓存）+ 无条件写 textContent / style.width
   * （style.width 每帧写还会触发样式/布局计算）。HUD 节点在 index.template.html 里静态存在
   * （10-ui.js 只增删 #hud 的 .active class 与 #hud-chart-info 的内容，不重建这些节点），
   * 故引用可缓存；值未变时跳过写入。 */
  var _hudEl = null;
  var _hudPrev = { score: '', acc: '', rank: '', pct: -1 };
  function updateHUD() {
    if (!_hudEl) {
      _hudEl = {
        score: document.getElementById('hud-score'),
        acc: document.getElementById('hud-acc'),
        rank: document.getElementById('hud-rank'),
        fill: document.getElementById('hud-progress-fill'),
      };
    }
    var scoreTxt = formatInt(game.score);
    if (scoreTxt !== _hudPrev.score) { _hudEl.score.textContent = scoreTxt; _hudPrev.score = scoreTxt; }
    var judged = game.judgedCount;
    var acc = judged > 0
      ? ((game.counts['S-Perfect'] + game.counts['Perfect'] + game.counts['Good'] * 0.5) / judged) * 100
      : 100;
    /* ACC 保留 2 位小数，与完整版 App 同口径。 */
    var accTxt = acc.toFixed(2) + '%';
    if (accTxt !== _hudPrev.acc) { _hudEl.acc.textContent = accTxt; _hudPrev.acc = accTxt; }
    /* RANK: shows the HIGHEST rank still achievable, not current rank.
     * Assumes all remaining notes will be S-Perfect — 与完整版 App 的 potentialRank 同口径：
     *   potentialRank = calculateRank(score + remainingNotes * sPerfectScore) */
    var totalNotes = game.totalNotes || 1;
    var remaining = Math.max(0, totalNotes - judged);
    var sPerfectScore = calculateNoteScore('S-Perfect', Math.max(1, totalNotes));
    var potentialScore = game.score + remaining * sPerfectScore;
    var rankTxt = calculateRank(potentialScore);
    if (rankTxt !== _hudPrev.rank) { _hudEl.rank.textContent = rankTxt; _hudPrev.rank = rankTxt; }
    /* Progress bar — mirrors full version's TimingBar */
    var dur = game.lastNoteTime + 1.5;
    var pct = dur > 0 ? Math.max(0, Math.min(1, game.curTime / dur)) * 100 : 0;
    if (pct !== _hudPrev.pct) { _hudEl.fill.style.width = pct + '%'; _hudPrev.pct = pct; }
  }

  /* Combo number + wireframe burst are drawn on canvas by drawCombo/drawComboBursts
   * (called from render). Judgment feedback is the rainbow timing bar at the top,
   * also drawn on canvas. The old text popup (hud-judge-text) has been removed. */

  var animId = 0;
  var manualClock = { time: 0, lastStamp: 0, paused: true };
  function getGameTime() {
    if (audio.useHtml5 && audio.isPlaying) return audio.getCurrentTime();
    if (!audio.disabled && audio.ctx && audio.isPlaying) {
      return audio.getCurrentTime();
    }
    return manualClock.time;
  }
  /* ---- Frame-rate gate (mirrors the full version's utils/frameLimiter) ----
   * A PHASE ACCUMULATOR, not a "compare against the previous frame" check: the
   * latter drifts low on non-integer refresh ratios (144Hz targeting 60fps lands
   * on 48). Here an ideal "next allowed time" is advanced by a fixed
   * 1000/maxFps step, so the average rate equals maxFps on 90/120/144/165Hz.
   * A skipped frame does NO work (no render, no judgment pass, no HUD write) but
   * the rAF chain keeps running, which is where the saving comes from.
   * `maxFps <= 0` = unlimited. */
  var _fpsInterval = -1; /* -1 = not initialised */
  var _fpsNext = 0;
  var _fpsLastTick = 0;
  var _fpsTickMs = 0; /* smoothed display frame period (ms) */
  function frameGateAllows(t, maxFps) {
    /* Track the display's own frame period (EWMA, gaps > 100ms ignored so a
     * backgrounded tab can't distort it). Used for the pass-through below. */
    if (_fpsLastTick > 0) {
      var d = t - _fpsLastTick;
      if (d > 0 && d < 100) _fpsTickMs = _fpsTickMs ? (_fpsTickMs * 0.9 + d * 0.1) : d;
    }
    _fpsLastTick = t;

    var iv = (maxFps > 0 && isFinite(maxFps)) ? 1000 / maxFps : 0;
    /* One refinement over the plain phase accumulator: a cap that is at or above
     * the actual refresh rate passes straight through. Otherwise a 60 cap on a
     * 60Hz panel fights the 16.67ms rounding and silently drops ~1 frame in 10
     * (measured 54fps instead of 60) — the gate must only ever LOWER the rate. */
    if (iv === 0 || (_fpsTickMs > 0 && iv <= _fpsTickMs * 1.05)) {
      _fpsInterval = 0;
      return true;
    }
    if (iv !== _fpsInterval) {
      /* First gated call / the cap changed: reset the phase, let this frame run. */
      _fpsInterval = iv;
      _fpsNext = t + iv;
      return true;
    }
    if (t < _fpsNext - 0.5) return false;
    /* Advance by whole steps so the average rate stays exact and a long stall
     * (backgrounded tab) never bursts a queue of frames. */
    do { _fpsNext += iv; } while (_fpsNext <= t);
    return true;
  }

  function loop() {
    /* Frame-rate cap. Skipped frames do nothing at all; game time comes from the
     * wall clock / audio position, so dropping frames never slows the chart down.
     * Only applied with a real rAF (see hasNativeRAF in 02-polyfills): the IE9
     * setTimeout fallback is already ~60Hz and too jittery for an exact gate. */
    if (hasNativeRAF && !frameGateAllows(now(), settings.maxFps)) {
      animId = rAF(loop);
      return;
    }
    if (game.state === STATE.PLAYING) {
      var t = now();
      if (!manualClock.lastStamp) manualClock.lastStamp = t;
      var dt = (t - manualClock.lastStamp) / 1000;
      manualClock.lastStamp = t;
      if (dt > 0 && dt < 1) manualClock.time += dt;
      game.curTime = getGameTime();
      /* Apply coalesced multi-touch moves once per frame, right before the
       * per-frame judgment pass (processAllNotes) reads game.pointers. This
       * is the single flush point for the IE11 pointermove buffer. */
      flushPointerMoves();
      render();
      updateHUD();
    }
    animId = rAF(loop);
  }

  /* === 6.5 Input handling — pointer/touch/mouse unified ===
   * Mirrors GameCanvas.tsx hit detection. Inverse of project() at z=0:
   *   depth = cd (since z=0)
   *   ndcX = 2*sx/W - 1   →   wx = ndcX * TAN_HALF_FOV * aspect * depth
   *   ndcY = 1 - 2*sy/H   →   wy = ndcY * TAN_HALF_FOV * depth + CAMERA_AXIS_Y
   * For tap/touch: nearest unjudged note within (HIT_WINDOW_MS, hitRadius).
   * For slide: once a pointer enters a slide's head zone, it "owns" that slide
   * and subsequent nodes are judged by proximity along the drag path. */
  function screenToWorld(sx, sy) {
    var depth = view.cd;
    var ndcX = (2 * sx / view.w) - 1;
    var ndcY = 1 - (2 * sy / view.h);
    return {
      x: ndcX * TAN_HALF_FOV * view.aspect * depth,
      y: ndcY * TAN_HALF_FOV * depth + CAMERA_AXIS_Y
    };
  }

  /* Find the best TAP note to hit at (wx,wy) near curTime (pointerdown only).
   * Touch notes are hover-triggered and handled per-frame by processTouchNote,
   * NOT by tap. Returns the note object or null.
   *
   * Overlap-merge judgment (mirrors full version 方案二): a tap is hittable if the
   * touch point is inside its own TAP_HIT_HALF box OR any merged extraHitRegions.
   * Among all hittable same-time taps, pick the closest to the touch point
   * (tie-break by id). After consuming `best`, merge its own box into the other
   * hittable same-time taps so subsequent presses on the overlap can still reach
   * them. Does NOT cross into later time windows. */
  var tapNotesCache = null, tapNotesCacheKey = null;
  function getTapNotes() {
    if (tapNotesCache && tapNotesCacheKey === game.notes) return tapNotesCache;
    tapNotesCache = game.notes.filter(function (n) { return n.type === 'tap'; });
    tapNotesCacheKey = game.notes;
    return tapNotesCache;
  }
  function findWindowOf(notes, curTime, spawnLimit) {
    var speed = game.speed * game.speedMul;
    var pastBuffer = 0.3 + (game.maxSlideSpan || 0), futureBuffer = -spawnLimit / speed + 0.3;
    var pastTh = curTime - pastBuffer, futureTh = curTime + futureBuffer;
    var lo = 0, hi = notes.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (notes[mid].timeSec < pastTh) lo = mid + 1; else hi = mid; }
    var first = lo; lo = first; hi = notes.length;
    while (lo < hi) { mid = (lo + hi) >> 1; if (notes[mid].timeSec <= futureTh) lo = mid + 1; else hi = mid; }
    return { first: first, last: lo };
  }
  function findHitTapNote(wx, wy, curTime) {
    var tapNotes = getTapNotes();
    var overlapSet = [];
    var win = findWindowOf(tapNotes, curTime, -game.renderDist);
    for (var i = win.first; i < win.last; i++) {
      var n = tapNotes[i];
      if (game.judged[n.id] || n.fake) continue;
      var dtMs = Math.abs((curTime - n.timeSec) * 1000);
      if (dtMs >= HIT_WINDOW_MS) continue;
      /* 图层偏移：命中判定用「合成后位置」（渲染与判定同一份值） */
      var nOff = offOfLite(n);
      var inOwn = Math.abs(n.x + nOff.x - wx) < TAP_HIT_HALF && Math.abs(n.y + nOff.y - wy) < TAP_HIT_HALF;
      var extra = n.extraHitRegions;
      var inExtra = false;
      if (extra) {
        for (var e = 0; e < extra.length; e++) {
          if (Math.abs(extra[e].x - wx) < extra[e].half && Math.abs(extra[e].y - wy) < extra[e].half) { inExtra = true; break; }
        }
      }
      if (inOwn || inExtra) overlapSet.push(n);
    }
    var best = null, bestDist = Infinity;
    // Selection rule (fixes late-tap swallow bug): when the touch point lands
    // inside hitboxes of taps at DIFFERENT times (neighbouring close taps whose
    // TAP_HIT_HALF boxes overlap), prefer the MOST LATE one — closest to its miss
    // deadline, the tap the player is racing to rescue. Judging the nearer-but-
    // later tap first would swallow the earlier late tap (e.g. note-291 late but
    // note-292 closer → 292 judged, 291 dropped). Within the chosen time group
    // (truly same-time overlapping taps) fall back to 方案二: closest to touch
    // point wins; then merge hitboxes. Times numeric & id-independent.
    var bestLate = -Infinity, bestTimeSec = Infinity;
    for (var k = 0; k < overlapSet.length; k++) {
      var lat = curTime - overlapSet[k].timeSec; // seconds, signed; larger = later
      if (lat > bestLate) { bestLate = lat; bestTimeSec = overlapSet[k].timeSec; }
    }
    for (var k2 = 0; k2 < overlapSet.length; k2++) {
      var m = overlapSet[k2];
      if (m.timeSec !== bestTimeSec) continue; // only the most-late time group
      var mOff = offOfLite(m);
      var dxm = m.x + mOff.x - wx, dym = m.y + mOff.y - wy;
      var d = Math.sqrt(dxm * dxm + dym * dym);
      if (d < bestDist || (d === bestDist && best !== null && m.timeSec < best.timeSec)) { best = m; bestDist = d; }
    }
    if (best) {
      var bOff = offOfLite(best);
      var merged = { x: best.x + bOff.x, y: best.y + bOff.y, half: TAP_HIT_HALF };
      for (var j = 0; j < overlapSet.length; j++) {
        var other = overlapSet[j];
        // 方案二: merge ONLY into taps at the SAME timeSec. Never cross time
        // windows, otherwise a tap at a different beat would gain a polluted hit
        // area and trigger false/early hits later (e.g. note-9 / note-10 same pos).
        if (other === best || other.timeSec !== best.timeSec) continue;
        if (!other.extraHitRegions) other.extraHitRegions = [];
        var dup = false;
        for (var r = 0; r < other.extraHitRegions.length; r++) {
          var reg = other.extraHitRegions[r];
          if (reg.x === merged.x && reg.y === merged.y && reg.half === merged.half) { dup = true; break; }
        }
        if (!dup) other.extraHitRegions.push(merged);
      }
    }
    return best;
  }

  /* Is any active pointer within square half-size `half` of (x,y)?
   * Uses `active` (not `down`): mouse pointers are active on hover (no click),
   * touch/pen pointers are active only while pressed — matches full version's
   * `active = isTouchLike ? down : true`. Used for touch notes (hover-trigger). */
  function isAnyPointerInside(x, y, half) {
    for (var pid in game.pointers) {
      if (!game.pointers.hasOwnProperty(pid)) continue;
      var p = game.pointers[pid];
      if (!p.active) continue;
      if (Math.abs(p.x - x) < half && Math.abs(p.y - y) < half) return true;
    }
    return false;
  }

  /* Slide chain state helpers — mirror GameCanvas slideStateRef. */
  function getAllSlideNodes(note) {
    var cached = slideViewCache[note.id];
    if (!cached) {
      cached = [{ x: note.x, y: note.y, timeSec: note.timeSec, scrollDist: note.scrollDist }];
      if (note.resolvedNodes) {
        for (var s = 0; s < note.resolvedNodes.length; s++) {
          var rn = note.resolvedNodes[s];
          cached.push({ x: rn.x, y: rn.y, timeSec: rn.timeSec, scrollDist: rn.scrollDist });
        }
      }
      slideViewCache[note.id] = cached;
    }
    /* 每帧重同步：base + 当前帧图层偏移（与完整版 getAllNodesEff 同构——
     * 渲染（节点/管线采样/截面/端帽）与判定共用同一份「合成后坐标」）。
     * 注意不能直接改写 resolvedNodes 原对象（那是谱面数据），这里全是副本。 */
    var off = offOfLite(note);
    cached[0].x = note.x + off.x;
    cached[0].y = note.y + off.y;
    if (note.resolvedNodes) {
      for (var i = 0; i < note.resolvedNodes.length; i++) {
        cached[i + 1].x = note.resolvedNodes[i].x + off.x;
        cached[i + 1].y = note.resolvedNodes[i].y + off.y;
      }
    }
    return cached;
  }
  function getSlideRt(noteId, nodeCount) {
    var rt = game.slideStates[noteId];
    if (!rt || rt.nodes.length !== nodeCount) {
      rt = { boundPointerIds: {}, nodes: [] };
      for (var i = 0; i < nodeCount; i++) {
        rt.nodes.push({
          judged: false, missLocked: false, everInZone: false,
          lastInsideTime: null, lastInsidePointerId: null,
          arrivalChecked: false, tailLockedSPerfect: false,
          earlySPLocked: false, earlyTouchIds: []
        });
      }
      game.slideStates[noteId] = rt;
    }
    return rt;
  }

  /* Point on the slide segment A→B at fraction f∈[0,1] — kept for reference /
   * potential editor use. The gameplay pipe now samples the eased curve
   * directly (see the slide-pipe block in render()), so this is unused there. */
  function slideSegPoint(nodeA, nodeB, zA, zB, spawnLimit, f) {
    var z = zA + f * (zB - zA);
    var x = nodeA.x + f * (nodeB.x - nodeA.x);
    var y = nodeA.y + f * (nodeB.y - nodeA.y);
    var dz = zB - zA;
    if (z > 0) {
      var t0 = dz !== 0 ? (0 - zA) / dz : 0;
      x = nodeA.x + t0 * (nodeB.x - nodeA.x);
      y = nodeA.y + t0 * (nodeB.y - nodeA.y);
      z = 0;
    } else if (z < spawnLimit) {
      var t1 = dz !== 0 ? (spawnLimit - zA) / dz : 1;
      x = nodeA.x + t1 * (nodeB.x - nodeA.x);
      y = nodeA.y + t1 * (nodeB.y - nodeA.y);
      z = spawnLimit;
    }
    return { x: x, y: y, z: z };
  }

  /* === processSlide 的复用缓冲与无闭包 helper ===
   * 原实现「每个活跃 slide 每帧」会新建 3 个数组 + 2 个闭包 + 6 次 Object.keys +
   * 5 次 .slice()，是密集 slide 谱的主要 GC 源。这里改为模块级 scratch + helper。
   * processSlide 同步、不可重入，且每 slide 顺序处理 —— 复用安全。 */
  var _allDown = [];
  var _onNode = [];
  var _boundOffNode = [];
  var _boundKeysScratch = [];
  var _EMPTY_IDS = [];
  var _slideLandTmp = { x: 0, y: 0 };
  var _slideLandOut = { x: 0, y: 0 };
  /** 绑定数（for..in 计数，避免每帧 Object.keys 分配）。 */
  function _boundCount(obj) {
    var n = 0;
    for (var k in obj) { if (obj.hasOwnProperty(k)) n++; }
    return n;
  }
  /** 落点偏移 = base - 当前帧偏移 + 该节点 timeSec 的落点偏移；写入复用缓冲（无分配）。 */
  function _slideLanding(note, nd) {
    layerOffAtIdxLiteInto(layerIdxOfLite(note), nd.timeSec, _slideLandTmp);
    var hoff = offOfLite(note);
    _slideLandOut.x = nd.x - hoff.x + _slideLandTmp.x;
    _slideLandOut.y = nd.y - hoff.y + _slideLandTmp.y;
    return _slideLandOut;
  }
  /** 提交一个 slide 节点判定（取代原先内联的 judge 闭包；语义逐字保留，含命中音效）。 */
  function _commitSlideNode(boundObj, cns, note, nextIdx, dt, cnd, j, bindPids) {
    cns.judged = true;
    for (var bi = 0; bi < bindPids.length; bi++) boundObj[bindPids[bi]] = true;
    commitJudge(note.id + '#' + nextIdx, j, dt);
    audio.playHitSound('slide');
    var lp = _slideLanding(note, cnd);
    spawnBurst(lp.x, lp.y, j, 'slide', cnd.angle);
  }

  /* Per-frame slide judgment — faithful port of GameCanvas.processSlide.
   * Key rule: nodes are judged ONLY when dt>=0 (node reached the plane),
   * never early on proximity alone. This fixes the "early judgment" bug. */
  function processSlide(note, curTime) {
    if (note.fake) return; /* 假音符：整条 slide 链不判定、不产生 Miss */
    var allNodes = getAllSlideNodes(note);
    var rt = getSlideRt(note.id, allNodes.length);
    /* 特效/反馈钉落位：allNodes 已嵌入 curTime 偏移，反解 base 再加该节点
     * 自己 timeSec 的落点偏移（与完整版一致）。 */
    /* 落点统一走模块级 _slideLanding（写入复用缓冲），不再每次 new {x,y}。 */
    /* 1) Late-miss every unjudged node past +160ms (incl. missLocked ones) */
    for (var i = 0; i < allNodes.length; i++) {
      var ns = rt.nodes[i];
      if (ns.judged) continue;
      var dtI = (curTime - allNodes[i].timeSec) * 1000;
      if (dtI > HIT_WINDOW_MS) {
        ns.judged = true;
        var _lm = _slideLanding(note, allNodes[i]);
        commitJudge(note.id + '#' + i, 'Miss', dtI, _lm.x, _lm.y, 'slide', allNodes[i].angle);
      }
    }

    /* 头节点特殊逻辑的生效区间：默认持续到「头节点时间 + HIT_WINDOW_MS」；
     * 若第一子节点与头节点相距不足 HIT_WINDOW_MS，则只持续到第一子节点的时间，
     * 避免宽松窗口越界覆盖子节点自身的判定。 */
    var headT = allNodes[0].timeSec;
    var child1T = allNodes.length > 1 ? allNodes[1].timeSec : Infinity;
    var headWindowEnd = Math.min(headT + HIT_WINDOW_MS / 1000, child1T);
    var headSpecialActive = curTime < headWindowEnd;

    /* 2) 头节点开放绑定窗口：头节点一旦被命中（judged），在上述区间内持续把
     * 「处于头节点判定盒内」的手指自由加入链上绑定。这样即便划过的 A 先被判定、
     * 真正要接的 B 晚一帧才按下（甚至 A 已抬起），B 仍能在窗口内加入接管；
     * 交叉 slide 中划过且仍在盒内的 A 也能自由加绑（多一个绑定只更安全）。
     * 仅在头已被命中后才加绑，避免早期窗口（-160..0）提前产生绑定而误触发红锁。 */
    if (rt.nodes[0].judged && headSpecialActive) {
      var hx = allNodes[0].x;
      var hy = allNodes[0].y;
      for (var hk in game.pointers) {
        if (!game.pointers.hasOwnProperty(hk)) continue;
        var hp = game.pointers[hk];
        if (!hp.down) continue;
        if (Math.abs(hp.x - hx) < SLIDE_HIT_HALF && Math.abs(hp.y - hy) < SLIDE_HIT_HALF) {
          rt.boundPointerIds[hk] = true;
        }
      }
    }

    /* Determine the next unjudged node early — needed for the off-node pruning
     * below AND for step 3. Mirrors GameCanvas.processSlide. */
    var nextIdx = -1;
    for (var k0 = 0; k0 < rt.nodes.length; k0++) { if (!rt.nodes[k0].judged) { nextIdx = k0; break; } }
    if (nextIdx < 0) return;
    var cns = rt.nodes[nextIdx];
    var cnd = allNodes[nextIdx];
    var dt = (curTime - cnd.timeSec) * 1000;
    var isTail = nextIdx === allNodes.length - 1;
    var isHead = nextIdx === 0;

    if (game.autoPlay) {
      if (dt >= 0 && !cns.judged) {
        _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect', _EMPTY_IDS);
      }
      return;
    }

    if (cns.missLocked) return;

    /* Unified per-frame scan: maintain bindings AND classify every down finger.
     * 三个数组改用模块级 scratch（见文件顶部说明），每帧重置。 */
    var hadBinding = _boundCount(rt.boundPointerIds) > 0;
    var anyDown = false;
    var allDown = _allDown;
    var onNode = _onNode;
    var boundOnNode = 0;
    var boundOffNode = _boundOffNode;
    allDown.length = 0;
    onNode.length = 0;
    boundOffNode.length = 0;
    for (var pk in game.pointers) {
      if (!game.pointers.hasOwnProperty(pk)) continue;
      var pp = game.pointers[pk];
      var isBound = rt.boundPointerIds.hasOwnProperty(pk);
      if (isBound && !pp.down) { delete rt.boundPointerIds[pk]; continue; }
      if (!pp.down) continue;
      anyDown = true;
      allDown.push(pk);
      var inBox = Math.abs(pp.x - cnd.x) < SLIDE_HIT_HALF && Math.abs(pp.y - cnd.y) < SLIDE_HIT_HALF;
      var elig = hadBinding ? isBound : true;
      if (inBox && elig) onNode.push(pk);
      if (isBound) { if (inBox) boundOnNode++; else boundOffNode.push(pk); }
    }
    /* Drop bound pointers that have lifted. This runtime deletes lifted pointers
     * from game.pointers entirely, so the scan above never sees them — remove
     * them here so the chain can detect a full release (→ red lock / Miss). */
    var boundKeys2 = _boundKeysScratch;
    boundKeys2.length = 0;
    for (var bk in rt.boundPointerIds) {
      if (rt.boundPointerIds.hasOwnProperty(bk)) boundKeys2.push(bk);
    }
    for (var dk = 0; dk < boundKeys2.length; dk++) {
      var bp2 = game.pointers[boundKeys2[dk]];
      if (!bp2 || !bp2.down) delete rt.boundPointerIds[boundKeys2[dk]];
    }
    if (boundOnNode > 0) for (var bo = 0; bo < boundOffNode.length; bo++) delete rt.boundPointerIds[boundOffNode[bo]];
    var allReleased = _boundCount(rt.boundPointerIds) === 0;

    /* Tail relaxed rule: held through the end. */
    if (isTail && !cns.tailLockedSPerfect && dt >= -HIT_WINDOW_MS) {
      if (_boundCount(rt.boundPointerIds) > 0 || anyDown) cns.tailLockedSPerfect = true;
    }

    /* Red lock on full release (tail exempt).
     * 头节点特殊窗口内不立即落锤：只记录「发生过全松手」，等窗口结束再裁定
     * （期间允许目标手指 B 自由加绑接管，避免划过的 A 抬起就误判 misslock）。 */
    if (hadBinding && allReleased && nextIdx >= 0 && !cns.judged && !cns.tailLockedSPerfect) {
      if (headSpecialActive) rt.headReleasePending = true;
      else cns.missLocked = true;
    }
    if (!headSpecialActive && rt.headReleasePending) {
      rt.headReleasePending = false;
      /* 窗口结束时仍无人绑定 → 链确已放弃，才红锁下一个未判定节点。 */
      if (_boundCount(rt.boundPointerIds) === 0 && nextIdx >= 0 && !cns.judged && !cns.tailLockedSPerfect) {
        cns.missLocked = true;
      }
    }
    if (cns.missLocked) return;

    /* Bookkeeping. */
    if (_boundCount(rt.boundPointerIds) > 0 && onNode.length > 0) cns.everInZone = true;
    if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && onNode.length > 0) {
      cns.lastInsideTime = curTime;
      cns.lastInsidePointerId = onNode[0];
    }

    /* Pre-window early S-Perfect lock (lenient early sweep). */
    if (!cns.judged && !cns.earlySPLocked && dt < 0 && dt >= -HIT_WINDOW_MS && onNode.length > 0) {
      cns.earlySPLocked = true;
      if (isHead) for (var ei = 0; ei < onNode.length; ei++) {
        if (cns.earlyTouchIds.indexOf(onNode[ei]) === -1) cns.earlyTouchIds.push(onNode[ei]);
      }
    }

    if (dt >= 0 && !cns.judged) {
      var sPerfect = false;
      if (cns.earlySPLocked) {
        if (isHead) {
          /* 优先绑定「当前仍在判定盒内」的手指：这把真正在头节点处按下的手指
           * （B）以及仍停在盒内的合法早扫 / 拖入手指判给头节点，避免被只是扫过的
           * A 抢走。仅当盒内当前无人时，才回退到宽松早锁（早扫过但手指仍按着）。 */
          if (onNode.length > 0) {
            sPerfect = true;
            _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect', onNode);
          } else {
            var earlyAnyDown = false;
            for (var et = 0; et < cns.earlyTouchIds.length; et++) {
              var etp = game.pointers[cns.earlyTouchIds[et]];
              if (etp && etp.down) { earlyAnyDown = true; break; }
            }
            if (earlyAnyDown) { sPerfect = true; _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect', cns.earlyTouchIds); }
            else { cns.earlySPLocked = false; cns.earlyTouchIds = []; }
          }
        } else {
          sPerfect = true; _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect', _EMPTY_IDS);
        }
      }
      if (!cns.judged && !sPerfect) {
        if (isTail && cns.tailLockedSPerfect) {
          _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect',
            _boundCount(rt.boundPointerIds) > 0 ? _EMPTY_IDS : allDown);
        } else if (!cns.arrivalChecked) {
          cns.arrivalChecked = true;
          if (onNode.length > 0) _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, 'S-Perfect', onNode);
        } else if (onNode.length > 0 && dt <= HIT_WINDOW_MS) {
          var j2 = evaluateJudgement(dt);
          if (j2) _commitSlideNode(rt.boundPointerIds, cns, note, nextIdx, dt, cnd, j2, onNode);
        }
      }
    }

  }

  /* Per-frame touch note judgment — 与 GameCanvas 的 touch 判定同口径。
   * Touch notes are hover-triggered: any held pointer inside the zone during
   * the timing window counts. No tap/click required. */
  function processTouchNote(note, curTime) {
    if (note.fake) return; /* 假音符：完全不参与判定 */
    var off = offOfLite(note);
    landingOffOfLiteInto(note, _touchOffLite);
    var lo = _touchOffLite; /* 复用缓冲（本函数私有） */
    var dt = (curTime - note.timeSec) * 1000;
    var inside = isAnyPointerInside(note.x + off.x, note.y + off.y, TOUCH_HIT_HALF);
    var track = game.touchStates[note.id];
    if (!track) { track = { lastInsideTime: null, arrivalChecked: false }; game.touchStates[note.id] = track; }
    if (dt >= -HIT_WINDOW_MS && dt <= HIT_WINDOW_MS && inside) track.lastInsideTime = curTime;
    if (game.autoPlay && dt >= 0) {
      commitJudge(note.id, 'S-Perfect', dt);
      audio.playHitSound('touch'); spawnBurst(note.x + lo.x, note.y + lo.y, 'S-Perfect', 'touch', note.angle);
      return;
    }
    if (dt >= 0) {
      if (!track.arrivalChecked) {
        track.arrivalChecked = true;
        if (inside) {
          commitJudge(note.id, 'S-Perfect', dt);
          audio.playHitSound('touch'); spawnBurst(note.x + lo.x, note.y + lo.y, 'S-Perfect', 'touch', note.angle); return;
        }
        if (track.lastInsideTime !== null) {
          var earlyDt = (track.lastInsideTime - note.timeSec) * 1000;
          var j = evaluateJudgement(earlyDt);
          if (j) { commitJudge(note.id, j, earlyDt); audio.playHitSound('touch'); spawnBurst(note.x + lo.x, note.y + lo.y, j, 'touch', note.angle); return; }
        }
      }
      if (inside && dt <= HIT_WINDOW_MS) {
        var j2 = evaluateJudgement(dt);
        if (j2) { commitJudge(note.id, j2, dt); audio.playHitSound('touch'); spawnBurst(note.x + lo.x, note.y + lo.y, j2, 'touch', note.angle); return; }
      }
      if (dt > HIT_WINDOW_MS) commitJudge(note.id, 'Miss', dt, note.x + lo.x, note.y + lo.y, 'touch', note.angle);
    }
  }

  /* Per-frame judgment pass for ALL notes (slides + touch + tap miss).
   * Replaces the inline AutoPlay/miss logic that was in render(). Tap notes
   * are still hit via findHitTapNote on pointerdown; here we only detect misses. */
  /* 处理已发生的事件（与 GameCanvas 的事件循环同口径）。
   * 支持 speed_change / text_display / note_color_change；
   * bg_change 在 Lite 无效（Lite 没有背景层实现），仅留空处理。 */
  function processEvents(curTime) {
    var evts = game.events;
    if (!evts || evts.length === 0) return;
    while (game.nextEventIdx < evts.length && evts[game.nextEventIdx].timeSec <= curTime) {
      var evt = evts[game.nextEventIdx];
      if (evt.eventType === 'speed_change' && typeof evt.speed === 'number') {
        /* Note: visual spacing is precomputed via scroll distance, so speedMul here
         * only affects future movement speed, not current note positions. */
        game.currentSpeedMul = evt.speed;
      } else if (evt.eventType === 'bg_change') {
        /* 只改渐变色；媒体层由歌曲文件决定（旧谱面的 bgImage 字段忽略）。 */
        if (typeof evt.gradientStart === 'string') game.bgStart = evt.gradientStart;
        if (typeof evt.gradientEnd === 'string') game.bgEnd = evt.gradientEnd;
      } else if (evt.eventType === 'text_display') {
        game.currentText = evt.text || '';
        var dur = typeof evt.textDuration === 'number' ? evt.textDuration : 2;
        game.currentTextTimeout = curTime + dur;
      } else if (evt.eventType === 'note_color_change' && evt.noteColor) {
        game.currentNoteColor = evt.noteColor;
      }
      game.nextEventIdx++;
    }
    /* Clear text if timeout expired */
    if (game.currentText && curTime > game.currentTextTimeout) {
      game.currentText = null;
    }
  }

  function processAllNotes(curTime) {
    var win = findWindow(curTime, -game.renderDist);
    for (var i = win.first; i < win.last; i++) {
      var n = game.notes[i];
      if (n.fake) continue; /* 假音符：不判定（仍渲染） */
      if (n.type === 'slide') {
        processSlide(n, curTime);
      } else if (n.type === 'touch') {
        if (!game.judged[n.id]) processTouchNote(n, curTime);
      } else {
        /* tap: only miss detection here; hits via findHitTapNote on pointerdown */
        if (!game.autoPlay && !game.judged[n.id] && curTime > n.timeSec + HIT_WINDOW_MS / 1000) {
          var lo = landingOffOfLite(n);
          commitJudge(n.id, 'Miss', 0, n.x + lo.x, n.y + lo.y, 'tap', n.angle);
        } else if (game.autoPlay && !game.judged[n.id] && curTime >= n.timeSec) {
          var dt = (curTime - n.timeSec) * 1000;
          var lo = landingOffOfLite(n);
          commitJudge(n.id, 'S-Perfect', dt);
          audio.playHitSound('tap'); spawnBurst(n.x + lo.x, n.y + lo.y, 'S-Perfect', 'tap', n.angle);
        }
      }
    }
  }

  /* `type` is 'mouse'/'touch'/'pen'. For mouse, active=true always (hover works
   * for touch notes); for touch/pen, active = down (must be pressed). This
   * mirrors the full version's updatePointer active logic. */
  function handleTapInput(sx, sy, pid, type) {
    if (game.state !== STATE.PLAYING || game.autoPlay) return;
    var w = screenToWorld(sx, sy);
    var isMouse = type === 'mouse';
    game.pointers[pid] = { x: w.x, y: w.y, down: true, active: true, type: type };
    var curTime = game.curTime;
    /* Tap notes are click-triggered (immediate judgment on pointerdown).
     * Slide/touch are hover-triggered and handled per-frame by processAllNotes. */
    var n = findHitTapNote(w.x, w.y, curTime);
    if (!n) return;
    var dtMs = (curTime - n.timeSec) * 1000;
    var j = evaluateJudgement(dtMs);
    if (!j) return; /* outside judgement window → leave for per-frame miss detection (matches full version) */
    commitJudge(n.id, j, dtMs);
    audio.playHitSound('tap'); spawnBurst(n.x, n.y, j, 'tap', n.angle);
  }
  function handleMoveInput(sx, sy, pid, type) {
    if (game.state !== STATE.PLAYING) return;
    /* Always track pointer position — slides (check down) & touch notes (check
     * active) read it per-frame. For mouse we track even when not pressing, so
     * hover can trigger touch notes (mirrors full version mouse active=true). */
    var existing = game.pointers[pid];
    var w = screenToWorld(sx, sy);
    var isMouse = type === 'mouse';
    var down = existing ? existing.down : false;
    game.pointers[pid] = { x: w.x, y: w.y, down: down, active: isMouse ? true : down, type: type };
  }
  function handleReleaseInput(pid) { delete game.pointers[pid]; }

  /* Per-frame coalesced pointer-move buffer. IE11 does NOT coalesce pointermove
   * events (no getCoalescedEvents API), so multi-touch floods the main thread
   * with one event per hardware touch sample per finger. pointermove writes
   * only the latest position here; flushPointerMoves() applies them once per
   * rAF frame before render(). Render reads pointer state once per frame, so
   * coalescing loses no precision. Used only by the PointerEvent path. */
  var pendingMoves = {};
  function flushPointerMoves() {
    for (var pid in pendingMoves) {
      var pm = pendingMoves[pid];
      /* Convert screen→world ONCE per frame per pointer (not per event). */
      var w = screenToWorld(pm.sx, pm.sy);
      var ex = game.pointers[pid];
      if (ex) { ex.x = w.x; ex.y = w.y; ex.down = pm.down; ex.active = pm.active; ex.type = pm.type; }
      else game.pointers[pid] = { x: w.x, y: w.y, down: pm.down, active: pm.active, type: pm.type };
    }
  }

  /* Unified pointer/touch/mouse binding. Pointer Events cover most modern
   * browsers; fall back to Touch Events then Mouse Events for IE11/Safari<13. */
  function bindInput() {
    var canvasEl = document.getElementById('game-canvas');
    /* Cached canvas rect. Recomputing getBoundingClientRect() on every
     * pointermove is expensive on IE11: updateHUD() dirties layout each frame
     * (progress bar style.width + score/acc/rank textContent), so each per-event
     * getBoundingClientRect forces a synchronous layout reflow. With IE11
     * firing one pointermove per hardware touch sample per finger (no
     * coalescing — IE11 has no getCoalescedEvents), multi-touch produced
     * hundreds of forced reflows/sec → framerate collapse on weak CPUs like
     * the Atom Z3735G. Cache the rect; invalidate on resize/scroll/orientation. */
    var cachedRect = null;
    function rect() { if (!cachedRect) cachedRect = canvasEl.getBoundingClientRect(); return cachedRect; }
    function invalidateRect() { cachedRect = null; }
    window.addEventListener('resize', invalidateRect);
    window.addEventListener('scroll', invalidateRect, true);
    window.addEventListener('orientationchange', invalidateRect);
    function offset(e) { var r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function touchOffset(t) { var r = rect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }

    /* iOS: kill the "double-tap and hold" magnifier bubble (loupe).
       Same approach as the full build's 3D canvas (GameCanvas.tsx) — all three
       parts are needed:
         1) CSS `-webkit-touch-callout: none` (see styles/base.css) turns off
            the long-press callout;
         2) a NON-PASSIVE touchstart whose preventDefault() actually suppresses
            the loupe. Browsers default touchstart to passive on the root but
            also honour `{passive:true}` if anything sets it, and in a passive
            listener preventDefault() is a silent no-op — so the option object
            must be explicit. CSS alone still pops the bubble on some iOS
            versions;
         3) touch-action / -webkit-touch-select / -webkit-touch-callout are set
            on the canvas itself, since that is the real hit target and none of
            these inherit reliably.
       Legacy engines (IE9/IE11) treat the options object as a truthy `capture`
       flag, which is harmless — the listener just runs in the capture phase. */
    if (canvasEl.addEventListener) {
      canvasEl.addEventListener('touchstart', function (e) {
        if (e.preventDefault) e.preventDefault();
      }, { passive: false });
    }

    if (window.PointerEvent) {
      /* IE11 (and modern) Pointer Events. pointerdown judges taps immediately
       * (timing-critical). pointermove only updates the per-frame coalesced
       * buffer (pendingMoves) — flushed once per rAF frame via
       * flushPointerMoves() in loop(). Collapses N_fingers × ~100Hz events
       * down to one update per pointer per frame, with no precision loss
       * (render reads pointer state once per frame anyway). */
      canvasEl.addEventListener('pointerdown', function (e) {
        var p = offset(e);
        if (e.preventDefault) e.preventDefault();
        /* setPointerCapture routes ALL subsequent events for this pointer
         * straight to canvasEl, so IE11's touch-input stack stops hit-testing
         * every ancestor on every move. This cuts per-move routing cost (a real
         * multiplier under 2+ fingers on weak Atoms). Also stops pointerleave
         * firing as the finger slides across child/edge regions. */
        try { canvasEl.setPointerCapture(e.pointerId); } catch (err) {}
        handleTapInput(p.x, p.y, e.pointerId, e.pointerType || 'mouse');
        /* Store raw SCREEN coords in pendingMoves — defer screenToWorld to the
         * once-per-frame flush. On IE11 (no coalesced events) multi-touch floods
         * pointermove at ~100Hz/finger, and screenToWorld costs a matrix multiply
         * per event. Doing it per-frame-per-pointer instead of per-event is a
         * large CPU win for 2+ fingers on weak Atoms (the "multi-touch slows
         * down over time" symptom). */
        var prev = pendingMoves[e.pointerId];
        if (prev) { prev.sx = p.x; prev.sy = p.y; prev.down = true; prev.active = true; prev.type = e.pointerType || 'mouse'; }
        else pendingMoves[e.pointerId] = { sx: p.x, sy: p.y, down: true, active: true, type: e.pointerType || 'mouse' };
      });
      /* Disable the right-click context menu — long-press on IE / touch also
       * fires contextmenu, which would pop a menu mid-play. */
      canvasEl.addEventListener('contextmenu', function (e) {
        if (e.preventDefault) e.preventDefault();
        return false;
      });
      canvasEl.addEventListener('pointermove', function (e) {
        var p = offset(e);
        var prev = pendingMoves[e.pointerId];
        if (prev) { prev.sx = p.x; prev.sy = p.y; }       /* mutate in place — no per-event allocation, no per-event world transform */
        else {
          var type = e.pointerType || 'mouse';
          pendingMoves[e.pointerId] = { sx: p.x, sy: p.y, down: false, active: type === 'mouse', type: type };
        }
      });
      /* Function *expression*, not a declaration: IE11 strict mode forbids
       * function declarations nested inside a block (SCRIPT1044). */
      var release = function (pid) {
        try { canvasEl.releasePointerCapture(pid); } catch (err) {}
        delete pendingMoves[pid]; handleReleaseInput(pid);
      };
      canvasEl.addEventListener('pointerup', function (e) { release(e.pointerId); });
      canvasEl.addEventListener('pointercancel', function (e) { release(e.pointerId); });
      canvasEl.addEventListener('pointerleave', function (e) { release(e.pointerId); });
      return;
    }
    /* Touch fallback (old Safari — IE11 uses Pointer Events above). Cached
     * rect still applies, so no per-event reflow here either. */
    canvasEl.addEventListener('touchstart', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var p = touchOffset(e.changedTouches[i]);
        handleTapInput(p.x, p.y, e.changedTouches[i].identifier, 'touch');
      }
    }, false);
    canvasEl.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var p = touchOffset(e.changedTouches[i]);
        handleMoveInput(p.x, p.y, e.changedTouches[i].identifier, 'touch');
      }
    }, false);
    canvasEl.addEventListener('touchend', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) handleReleaseInput(e.changedTouches[i].identifier);
    }, false);
    canvasEl.addEventListener('touchcancel', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) handleReleaseInput(e.changedTouches[i].identifier);
    }, false);
    /* Mouse fallback (no touch at all). Track movement even when not pressing
     * so hover can trigger touch notes (active=true for mouse). */
    var mouseDown = false;
    canvasEl.addEventListener('mousedown', function (e) {
      mouseDown = true;
      var p = offset(e);
      handleTapInput(p.x, p.y, 'mouse', 'mouse');
    });
    canvasEl.addEventListener('mousemove', function (e) {
      var p = offset(e);
      handleMoveInput(p.x, p.y, 'mouse', 'mouse');
    });
    canvasEl.addEventListener('mouseleave', function () { handleReleaseInput('mouse'); });
    document.addEventListener('mouseup', function () { mouseDown = false; handleReleaseInput('mouse'); });
  }
  bindInput();
