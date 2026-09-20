/* === 7. UI wiring === */
  var menuScreen = document.getElementById('menu-screen');
  var pauseScreen = document.getElementById('pause-screen');
  var resultScreen = document.getElementById('result-screen');
  var resultCard = document.getElementById('result-card');
  var hud = document.getElementById('hud');
  var chartListEl = document.getElementById('chart-list');
  var settingsModal = document.getElementById('settings-modal');
  var editorModal = document.getElementById('editor-modal');
  var editorTextarea = document.getElementById('editor-textarea');
  var editorError = document.getElementById('editor-error');
  var selectedKey = null;
  var selectedDiffIdx = 0;
  var customChartKey = null; /* key of currently-loaded custom chart, if any */

  /* Beatmaps manifest state */
  var manifestItems = []; /* top-level items: albums + songs */
  var currentAlbumId = null; /* null = root, string = album id */
  var currentSongItem = null; /* currently selected song item (from manifest) */
  var loadedChartCache = {}; /* cache for loaded chart JSON: songId_diffIdx → chart */
  var loadingChart = false;

  /* XHR helper (IE11-compatible, no fetch/Promise needed) */
  function loadJson(url, onSuccess, onError) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url + '?t=' + Date.now(), true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var data = JSON.parse(xhr.responseText);
            onSuccess && onSuccess(data);
          } catch (e) { onError && onError(e); }
        } else {
          onError && onError(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function () { onError && onError(new Error('Network error')); };
      xhr.send();
    } catch (e) { onError && onError(e); }
  }

  /* === Server connection (IE9-compatible, mirrors full version) ===
   * 服务器地址 = 谱面所在目录（baseUrl）。连接时依次尝试 baseUrl/beatmaps.json、
   * baseUrl/manifest.json，都失败才失败。清单内相对路径（chartFile/audio/cover）
   * 按 baseUrl 重写为绝对地址。连接成功后**替换**当前谱面列表（仅保留内置 DEMO）。
   * 不持久化（刷新即失效）。输入框留空 = 使用默认地址（当前部署的 beatmaps 目录）。 */
  var currentServerBase = null; /* 当前服务器基地址（用于重写相对路径） */

  /* 把清单内的相对路径按当前服务器基地址重写为绝对地址；已是绝对 URL 原样返回。
   * 未连接自定义服务器时（currentServerBase 为初始默认目录）也正确工作。 */
  function resolveServerUrl(u) {
    if (!u) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;  /* http/https/blob/idb 等绝对 */
    if (u.indexOf('//') === 0) return u;           /* 协议相对 //host */
    if (currentServerBase) return currentServerBase + '/' + u.replace(/^\//, '');
    return '../beatmaps/' + u;                     /* 兜底（通常不会走到） */
  }

  /* 默认服务器地址：当前部署的 beatmaps 目录。
   * lite 版挂在 /lite/ 子目录下，谱面目录在其上一级 /beatmaps。
   * 基于页面路径推导：去掉末尾的 index.html 与 lite 一级后拼 beatmaps。 */
  function defaultServerBaseUrl() {
    var path = location.pathname || '/';
    if (path.slice(-10) === 'index.html') path = path.slice(0, -10);
    if (path.slice(-1) === '/') path = path.slice(0, -1);
    /* 若末尾是 /lite，去掉一级目录 */
    if (path.slice(-5) === '/lite') path = path.slice(0, -5);
    if (!path) path = '';
    return (location.protocol + '//' + location.host) + path + '/beatmaps';
  }

  /* 连接服务器：目录地址 → 依次尝试 beatmaps.json / manifest.json，成功后回调 items */
  function loadServerManifest(baseUrl, onOk, onErr) {
    var base = baseUrl.replace(/\/+$/, '');
    var candidates = [base + '/beatmaps.json', base + '/manifest.json'];
    var idx = 0;
    var tryNext = function () {
      if (idx >= candidates.length) { onErr && onErr(new Error(L('srvFail'))); return; }
      var url = candidates[idx];
      idx++;
      loadJson(url, function (data) {
        if (data && data.items) {
          onOk && onOk(data.items);
        } else {
          tryNext(); /* 拿到但无 items → 试下一个候选 */
        }
      }, function () {
        tryNext(); /* 请求失败 → 试下一个候选 */
      });
    };
    tryNext();
  }

  /* 连接按钮文字反馈辅助：成功/失败写入按钮文字，恢复正常后恢复为"连接"。 */
  function setSrvBtnText(text, ok) {
    var srvBtn = document.getElementById('btn-srv-connect');
    if (!srvBtn) return;
    srvBtn.textContent = text;
    srvBtn.disabled = false;
    srvBtn.style.color = ok ? '#10b981' : '#ef4444';
  }

  /* 连接按钮：用目录地址获取清单并替换当前谱面列表（保留内置 DEMO）。
   * 结果通过按钮文字反馈（避免 alert 在部分浏览器上阻塞不继续执行）。 */
  function connectServer(inputUrl) {
    var srvBtn = document.getElementById('btn-srv-connect');
    if (srvBtn) { srvBtn.disabled = true; srvBtn.textContent = L('srvConnecting'); srvBtn.style.color = '#67e8f9'; }
    loadServerManifest(inputUrl, function (items) {
      currentServerBase = inputUrl.replace(/\/+$/, '');
      var list = [];
      /* 内置 DEMO 专辑保留在最前 */
      var builtinSongs = [];
      for (var k in DEMO_CHARTS) {
        if (!DEMO_CHARTS.hasOwnProperty(k)) continue;
        var ch = DEMO_CHARTS[k];
        builtinSongs.push({
          type: 'song', id: k, title: ch.metadata.title, artist: ch.metadata.artist,
          bpm: ch.metadata.bpm, difficulties: [{ name: ch.metadata.difficulty, level: 0, chartFile: null }],
          isBuiltin: true
        });
      }
      list.push({ type: 'album', id: 'builtin', title: 'Built-in', artist: 'Various Artists', songs: builtinSongs });
      /* 服务器谱面（不建独立文件夹，直接替换原有外部项） */
      for (var i = 0; i < items.length; i++) list.push(items[i]);
      manifestItems = list;
      currentAlbumId = null;
      buildMenu();
      setSrvBtnText(L('srvOk'), true);
    }, function (err) {
      setSrvBtnText(L('srvFail'), false);
    });
  }

  /* Load the default server manifest (current deployment's beatmaps dir).
   * Includes built-in DEMO_CHARTS as "Built-in" album, then server items.
   * 刚进游戏本质就是获取默认地址的谱面索引（与完整版一致）。 */
  function loadBeatmapsManifest(callback) {
    var base = defaultServerBaseUrl();
    currentServerBase = base;
    loadServerManifest(base, function (items) {
      var list = [];
      /* Built-in album first */
      var builtinSongs = [];
      for (var k in DEMO_CHARTS) {
        if (!DEMO_CHARTS.hasOwnProperty(k)) continue;
        var ch = DEMO_CHARTS[k];
        builtinSongs.push({
          type: 'song', id: k, title: ch.metadata.title, artist: ch.metadata.artist,
          bpm: ch.metadata.bpm, difficulties: [{ name: ch.metadata.difficulty, level: 0, chartFile: null }],
          isBuiltin: true
        });
      }
      list.push({ type: 'album', id: 'builtin', title: 'Built-in', artist: 'Various Artists', songs: builtinSongs });
      /* Server items (replace external part) */
      for (var i = 0; i < items.length; i++) list.push(items[i]);
      manifestItems = list;
      callback && callback(null, list);
    }, function (err) {
      /* Default server unreachable — just use built-in */
      console.warn('[Lite] Failed to load default beatmaps manifest:', err);
      var list = [];
      var builtinSongs = [];
      for (var k in DEMO_CHARTS) {
        if (!DEMO_CHARTS.hasOwnProperty(k)) continue;
        var ch = DEMO_CHARTS[k];
        builtinSongs.push({
          type: 'song', id: k, title: ch.metadata.title, artist: ch.metadata.artist,
          bpm: ch.metadata.bpm, difficulties: [{ name: ch.metadata.difficulty, level: 0, chartFile: null }],
          isBuiltin: true
        });
      }
      list.push({ type: 'album', id: 'builtin', title: 'Built-in', artist: 'Various Artists', songs: builtinSongs });
      manifestItems = list;
      callback && callback(null, list);
    });
  }

  /* Get current list of items to display (depends on currentAlbumId) */
  function getCurrentListItems() {
    if (currentAlbumId === null) return manifestItems;
    for (var i = 0; i < manifestItems.length; i++) {
      if (manifestItems[i].id === currentAlbumId && manifestItems[i].songs) return manifestItems[i].songs;
    }
    return [];
  }

  function showMenu() {
    audio.stop();
    game.state = STATE.MENU;
    menuScreen.classList.remove('hidden');
    resultScreen.classList.add('hidden');
    pauseScreen.classList.add('hidden');
    hud.classList.remove('active');
  }
  function startGame() {
    if (!selectedKey) return;

    /* Built-in chart: use DEMO_CHARTS directly */
    if (DEMO_CHARTS[selectedKey]) {
      startGameWithChart(DEMO_CHARTS[selectedKey]);
      return;
    }

    /* Online chart: load from chartFile + audio */
    if (!currentSongItem) return;
    var diff = currentSongItem.difficulties && currentSongItem.difficulties[selectedDiffIdx];
    if (!diff || !diff.chartFile) return;

    var cacheKey = currentSongItem.id + '_' + selectedDiffIdx;
    if (loadedChartCache[cacheKey]) {
      startGameWithChart(loadedChartCache[cacheKey], currentSongItem);
      return;
    }

    /* Show loading state — resolve remote server URLs (serverBase) when present */
    loadingChart = true;
    loadJson(resolveServerUrl(diff.chartFile), function (chart) {
      loadingChart = false;
      if (!chart || !chart.metadata || !chart.notes) {
        alert(L('chartErrFormat'));
        return;
      }
      loadedChartCache[cacheKey] = chart;
      startGameWithChart(chart, currentSongItem);
    }, function (err) {
      loadingChart = false;
      alert(L('chartLoadFail') + (err.message || err));
    });
  }

  function startGameWithChart(chart, songItem) {
    Theme.apply(chart.metadata.bgScheme);
    resetGame(chart);
    game.autoPlay = document.getElementById('autoplay-toggle').checked;
    audio.init();
    audio.setMusicVolume(settings.musicVolume);
    audio.setEffectVolume(settings.effectVolume);
    audio.setOffset(settings.audioOffsetMs / 1000);

    /* Reset audio state before loading new song to avoid playing previous song's audio.
     * If the new song has no audio file, we must NOT reuse the old buffer.
     * Exception: if user uploaded an audio file in the editor, keep it. */
    if (!audio.hasUploadedAudio) {
      audio.bgmBuffer = null;
      if (audio.htmlAudioEl) {
        try { audio.htmlAudioEl.pause(); audio.htmlAudioEl.src = ''; } catch (e) {}
        audio.htmlAudioEl = null;
      }
    }
    audio.forceSynth = false;
    audio.stop();

    /* In-game difficulty display uses the chart file's own metadata.difficulty;
       manifest (beatmaps.json) difficulty names are for the song-select menu only */
    var diffName = chart.metadata.difficulty || '';

    /* Lead-in is a pure wall-clock delay before the song starts; the audio
     * offset is not part of it (LiteAudio applies the offset internally). */
    var firstNoteTime = getFirstNoteTime(chart);
    var leadIn = Math.max(0, 2 - firstNoteTime);

    var startPlaying = function () {
      manualClock.time = 0; manualClock.lastStamp = 0;
      game.state = STATE.PLAYING;
      menuScreen.classList.add('hidden');
      pauseScreen.classList.add('hidden');
      resultScreen.classList.add('hidden');
      hud.classList.add('active');
      document.getElementById('hud-chart-info').innerHTML =
        '<div class="ci-title">' + chart.metadata.title + '</div>' +
        '<div>' + diffName + ' · BPM ' + chart.metadata.bpm + '</div>';
      audio.play(0, leadIn);
    };

    /* Load audio if song has audio file — wait for it to finish loading before starting.
     * This prevents notes from being judged before audio is ready, and avoids the
     * "snapping back" effect when audio time syncs in.
     * If user uploaded an audio file in the editor, use that directly. */
    if (songItem && songItem.audio) {
      var startBtn = document.getElementById('btn-start');
      var origBtnText = startBtn.textContent;
      startBtn.textContent = L('loading');
      startBtn.disabled = true;

      audio.loadAudioUrl(resolveServerUrl(songItem.audio), function () {
        startBtn.textContent = origBtnText;
        startBtn.disabled = false;
        startPlaying();
      }, function (err) {
        console.warn('[Lite] Audio load failed, using synth:', err);
        startBtn.textContent = origBtnText;
        startBtn.disabled = false;
        audio.hasUploadedAudio = false;
        audio.forceSynth = true;
        audio.setSynthesizedTrack(chart.metadata.bpm);
        startPlaying();
      });
    } else if (audio.hasUploadedAudio && audio.bgmBuffer) {
      // User uploaded audio file in the editor — use it directly
      startPlaying();
    } else {
      audio.setSynthesizedTrack(chart.metadata.bpm);
      startPlaying();
    }
  }
  function pauseGame() {
    if (game.state !== STATE.PLAYING) return;
    audio.pause();
    game.state = STATE.PAUSED;
    pauseScreen.classList.remove('hidden');
  }
  function resumeGame() {
    if (game.state !== STATE.PAUSED) return;
    /* pauseTime came from getCurrentTime() and play() takes the same
     * chart-time coordinate, so it round-trips as-is. */
    audio.play(audio.pauseTime);
    game.state = STATE.PLAYING;
    pauseScreen.classList.add('hidden');
  }
  function endSong(g) {
    g.state = STATE.RESULT;
    audio.stop();
    hud.classList.remove('active');
    var rank = calculateRank(g.score);
    var acc = g.judgedCount > 0
      ? ((g.counts['S-Perfect'] + g.counts['Perfect'] + g.counts['Good'] * 0.5) / g.judgedCount) * 100 : 0;
    /* Song metadata — mirrors ResultModal.tsx L55-60:
     *   title, artist // difficulty. (BPM badge removed per user spec.) */
    var meta = g.chart ? g.chart.metadata : null;
    var metaHtml = '';
    if (meta) {
      metaHtml = '<h2 class="result-title">' + (meta.title || 'Unknown') + '</h2>' +
        '<p class="result-meta">' + (meta.artist || '') + ' // ' + (meta.difficulty || '') + '</p>';
    }
    /* S-Perfect is merged into Perfect per user spec: display the combined
     * count, with an orange "(+N)" suffix showing how many were S-Perfect.
     * Example: 21 S-Perfect + 17 Perfect → "Perfect: 38(+21)".
     * Mirrors ResultModal.tsx L21-23 (perfectTotal / sPerfectExtra). */
    var totalPerfect = g.counts['S-Perfect'] + g.counts['Perfect'];
    var sPerfectHtml = g.counts['S-Perfect'] > 0
      ? '<span class="s-perfect-indicator">(+' + g.counts['S-Perfect'] + ')</span>'
      : '';
    resultCard.innerHTML =
      metaHtml +
      '<div class="result-rank">' + rank + '</div>' +
      '<p class="result-score">' + formatInt(g.score) + '</p>' +
      '<div class="result-row"><span class="p">Perfect</span><span>' + totalPerfect + sPerfectHtml + '</span></div>' +
      '<div class="result-row"><span class="g">Good</span><span>' + g.counts['Good'] + '</span></div>' +
      '<div class="result-row"><span class="m">Miss</span><span>' + g.counts['Miss'] + '</span></div>' +
      '<div class="result-row"><span>Max Combo</span><span>' + g.maxCombo + '</span></div>' +
      '<div class="result-row"><span>' + L('resultAcc') + '</span><span>' + acc.toFixed(2) + '%</span></div>' +
      '<div class="result-actions"><button class="btn-tool" id="btn-retry">' + L('resultRetry') + '</button>' +
      '<button class="btn-tool" id="btn-back-menu">' + L('resultBack') + '</button></div>';
    resultScreen.classList.remove('hidden');
    document.getElementById('btn-retry').onclick = function () { resultScreen.classList.add('hidden'); startGame(); };
    document.getElementById('btn-back-menu').onclick = function () { resultScreen.classList.add('hidden'); showMenu(); };
  }

  function buildMenu() {
    chartListEl.innerHTML = '';
    var items = getCurrentListItems();

    /* Back button when inside an album */
    if (currentAlbumId !== null) {
      var backCard = document.createElement('div');
      backCard.className = 'chart-card';
      backCard.style.borderStyle = 'dashed';
      backCard.innerHTML = '<p class="chart-title">' + L('backUp') + '</p><p class="chart-meta">' + L('backAlbum') + '</p>';
      backCard.onclick = function () {
        currentAlbumId = null;
        currentSongItem = null;
        selectedKey = null;
        buildMenu();
      };
      chartListEl.appendChild(backCard);
    }

    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var card = document.createElement('div');
        card.className = 'chart-card';
        var title = item.title || 'Unknown';
        var meta = '';
        if (item.type === 'album') {
          meta = (item.artist || 'Various Artists') + ' · ' + (item.songs ? item.songs.length : 0) + L('songsSuffix');
          title = '📁 ' + title;
        } else {
          meta = (item.artist || 'Unknown');
          if (item.bpm) meta += ' · BPM ' + item.bpm;
        }
        var selected = false;
        if (item.type === 'song' && currentSongItem && currentSongItem.id === item.id) selected = true;

        var cardHtml = '<p class="chart-title">' + title + '</p>' +
          '<p class="chart-meta">' + meta + '</p>';

        /* Difficulty selector — shown when song is selected */
        if (selected && item.type === 'song' && item.difficulties && item.difficulties.length > 0) {
          var diffButtons = '<div class="diff-selector" style="margin-top:8px;display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;gap:4px;">';
          for (var di = 0; di < item.difficulties.length; di++) {
            var diff = item.difficulties[di];
            var isCurDiff = di === selectedDiffIdx;
            var diffLevel = (typeof diff.level === 'number' && diff.level > 0) ? ' Lv.' + diff.level : '';
            /* Glass style, accent-aware (inline because these are built per render) */
            var dAcc = Theme.accent();
            var diffStyle = isCurDiff
              ? 'background:' + withAlpha(dAcc, 0.28) + ';border-color:' + withAlpha(dAcc, 0.75) +
                ';color:' + adjustBrightness(dAcc, 1.5) + ';box-shadow:0 0 12px ' + withAlpha(dAcc, 0.3) +
                ',inset 0 1px 0 rgba(255,255,255,0.16);'
              : 'background:' + withAlpha(dAcc, 0.08) + ';border-color:' + withAlpha(dAcc, 0.35) +
                ';color:' + adjustBrightness(dAcc, 1.2) + ';box-shadow:inset 0 1px 0 rgba(255,255,255,0.06);';
            diffButtons += '<button class="diff-btn" data-idx="' + di + '" style="' + diffStyle +
              'padding:2px 8px;border-radius:6px;border:1px solid;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;">' +
              (diff.name || (L('diff') + (di + 1))) + diffLevel + '</button>';
          }
          diffButtons += '</div>';
          cardHtml += diffButtons;
        }

        card.innerHTML = cardHtml;

        card.onclick = function (e) {
          /* If clicking a difficulty button, handle it instead of selecting the card */
          if (e && e.target && e.target.className && e.target.className.indexOf('diff-btn') >= 0) {
            var idx = parseInt(e.target.getAttribute('data-idx'), 10);
            if (!isNaN(idx)) {
              selectedDiffIdx = idx;
              buildMenu(); /* re-render to update selected diff button */
            }
            return;
          }
          if (item.type === 'album') {
            currentAlbumId = item.id;
            currentSongItem = null;
            selectedKey = null;
            buildMenu();
          } else {
          currentSongItem = item;
          selectedDiffIdx = 0;
          selectedKey = item.id;
          var _scheme = (DEMO_CHARTS[item.id] && DEMO_CHARTS[item.id].metadata && DEMO_CHARTS[item.id].metadata.bgScheme) || item.bgScheme || null;
          if (_scheme) Theme.apply(_scheme);
          buildMenu(); /* re-render to show difficulty selector */
          }
        };

        if (selected) card.classList.add('selected');
        chartListEl.appendChild(card);
      })(items[i]);
    }
  }

  /* --- Settings modal --- */
  function openSettings() {
    /* Sync slider values from settings */
    var map = [
      ['set-speed', settings.speedMul, 'val-speed', function (v) { return v.toFixed(1) + 'x'; }],
      ['set-size', settings.sizeScale, 'val-size', function (v) { return v.toFixed(1) + 'x'; }],
      ['set-render', settings.renderDist, 'val-render', function (v) { return String(v); }],
      ['set-offset', settings.audioOffsetMs, 'val-offset', function (v) { return v + 'ms'; }],
      ['set-proj', settings.projectionLeadMs, 'val-proj', function (v) { return v + 'ms'; }],
      ['set-music', settings.musicVolume, 'val-music', function (v) { return Math.round(v * 100) + '%'; }],
      ['set-sfx', settings.effectVolume, 'val-sfx', function (v) { return Math.round(v * 100) + '%'; }]
    ];
    for (var i = 0; i < map.length; i++) {
      document.getElementById(map[i][0]).value = map[i][1];
      document.getElementById(map[i][2]).textContent = map[i][3](map[i][1]);
    }
    try { document.getElementById('set-compat').checked = !!settings.compatMode; } catch (e) {}
    settingsModal.classList.add('active');
  }
  function closeSettings() { settingsModal.classList.remove('active'); }
  /* Range slider live binding */
  (function () {
    var cfg = [
      ['set-speed', 'val-speed', 'speedMul', function (v) { return v.toFixed(1) + 'x'; }, function (v) { game.speedMul = parseFloat(v); }],
      ['set-size', 'val-size', 'sizeScale', function (v) { return v.toFixed(1) + 'x'; }, function (v) { game.sizeScale = parseFloat(v); }],
      ['set-render', 'val-render', 'renderDist', function (v) { return String(v); }, function (v) { game.renderDist = parseFloat(v); }],
      ['set-offset', 'val-offset', 'audioOffsetMs', function (v) { return v + 'ms'; }, function (v) { audio.setOffset(parseFloat(v) / 1000); }],
      ['set-proj', 'val-proj', 'projectionLeadMs', function (v) { return v + 'ms'; }, function (v) {}],
      ['set-music', 'val-music', 'musicVolume', function (v) { return Math.round(v * 100) + '%'; }, function (v) { audio.setMusicVolume(parseFloat(v)); }],
      ['set-sfx', 'val-sfx', 'effectVolume', function (v) { return Math.round(v * 100) + '%'; }, function (v) { audio.setEffectVolume(parseFloat(v)); }]
    ];
    for (var i = 0; i < cfg.length; i++) {
      (function (sliderId, valId, key, fmt, applyFn) {
        var el = document.getElementById(sliderId);
        var valEl = document.getElementById(valId);
        /* Read min/max/step from HTML attributes so IE9 (which renders
         * type=range as a plain text input) still has range constraints. */
        var mn = parseFloat(el.getAttribute('min'));
        var mx = parseFloat(el.getAttribute('max'));
        var st = parseFloat(el.getAttribute('step'));
        function clamp(v) {
          if (isNaN(v)) v = settings[key];   /* preserve old value on garbage */
          if (!isNaN(mn) && v < mn) v = mn;
          if (!isNaN(mx) && v > mx) v = mx;
          if (!isNaN(st) && st > 0) {
            /* Quantize to nearest step, anchored at min. */
            var base = isNaN(mn) ? 0 : mn;
            v = base + Math.round((v - base) / st) * st;
            /* Round tiny floating point artifacts back to step precision */
            var decimals = (String(st).split('.')[1] || '').length;
            v = parseFloat(v.toFixed(decimals));
          }
          return v;
        }
        function update() {
          var raw = parseFloat(el.value);
          var v = clamp(raw);
          /* If clamp changed it (e.g. IE9 text user typed out of range),
           * write the corrected value back so the user sees it. */
          if (el.value !== '' && (isNaN(raw) || raw !== v)) {
            try { el.value = String(v); } catch (e) {}
          }
          settings[key] = v;
          valEl.textContent = fmt(v);
          applyFn(v);
          saveSettings();
        }
        /* IE9 (text input): fires 'change' on blur; 'input' may fire on keystroke.
         * IE11+ (real range): 'input' continuous + 'change' on release.
         * Bind both to cover all browsers. */
        el.addEventListener('input', update);
        el.addEventListener('change', update);
        /* IE9 only: if the user pressed Enter in the text box, commit immediately
         * (without waiting for blur → change). */
        el.addEventListener('keydown', function (e) {
          if (e && (e.keyCode === 13 || e.key === 'Enter')) {
            try { e.preventDefault(); } catch (err) {}
            update();
            el.blur();
          }
        });
      })(cfg[i][0], cfg[i][1], cfg[i][2], cfg[i][3], cfg[i][4]);
    }
  })();
  /* Compat-mode checkbox: 谱面改用 performance.now() 墙钟，与音频解耦（应对
   * 部分现代浏览器音频时间不精确 / 低帧率时谱面随音频定格的问题）。 */
  (function () {
    var el = document.getElementById('set-compat');
    function update() {
      var on = !!el.checked;
      settings.compatMode = on;
      audio.setCompatMode(on);
      saveSettings();
    }
    el.addEventListener('change', update);
  })();

  /* --- Chart editor (text JSON) --- */
  /* Shared chart validator (single source of truth: src/shared/chartSchema.ts,
   * inlined into this build by scripts/build-lite.mjs). It mirrors the full
   * app's parseAndValidateChart; this wrapper adapts its {valid, chart, error}
   * shape to the {ok, chart, error} shape the editor expects. */
  function validateChart(obj) {
    var r = parseAndValidateChart(obj);
    return { ok: r.valid, chart: r.chart, error: r.error };
  }
  function openEditor() {
    editorError.textContent = '';
    /* Pre-fill with the currently-selected chart if textarea is empty */
    if (!editorTextarea.value && selectedKey && DEMO_CHARTS[selectedKey]) {
      editorTextarea.value = JSON.stringify(DEMO_CHARTS[selectedKey], null, 2);
    }
    editorModal.classList.add('active');
  }
  function closeEditor() { editorModal.classList.remove('active'); }
  function loadChartFromEditor() {
    var txt = editorTextarea.value;
    var obj;
    try { obj = JSON.parse(txt); }
    catch (e) { editorError.textContent = L('errJsonParse') + e.message; return; }
    var res = validateChart(obj);
    if (!res.ok) { editorError.textContent = res.error; return; }
    var key = customChartKey || ('custom-' + Date.now());
    DEMO_CHARTS[key] = res.chart;
    customChartKey = key;
    selectedKey = key;
    buildMenu();
    editorError.style.color = '#10b981';
    editorError.textContent = L('errLoaded') + res.chart.metadata.title + ' (' + res.chart.notes.length + ')';
    window.setTimeout(function () { editorError.style.color = ''; closeEditor(); }, 800);
  }
  /* File import */
  document.getElementById('editor-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      editorTextarea.value = String(reader.result || '');
      editorError.textContent = L('errReadFile') + file.name + L('errClickLoad');
    };
    reader.onerror = function () { editorError.textContent = L('errRead'); };
    reader.readAsText(file);
    e.target.value = ''; /* allow re-selecting same file */
  });

  /* Audio file import — mirrors full version's loadAudioFile.
   * decodeAudioData is async; show status on the upload button label. */
  var editorAudioLabel = document.getElementById('editor-audio-label');
  document.getElementById('editor-audio-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    editorAudioLabel.textContent = L('errDecoding');
    audio.loadAudioFile(file, function (buffer) {
      editorAudioLabel.textContent = L('errAudioLoaded') + Math.round(buffer.duration) + 's)';
    }, function (err) {
      editorAudioLabel.textContent = L('errImportFail');
      window.setTimeout(function () { editorAudioLabel.textContent = L('edImportAudio'); }, 2000);
    });
    e.target.value = ''; /* allow re-selecting same file */
  });

  /* --- Button wiring --- */
  document.getElementById('btn-start').onclick = startGame;
  document.getElementById('btn-switch-full').onclick = function () { window.location.href = '../index.html'; };
  document.getElementById('btn-pause').onclick = pauseGame;
  document.getElementById('btn-resume').onclick = resumeGame;
  document.getElementById('btn-restart').onclick = function () { pauseScreen.classList.add('hidden'); startGame(); };
  document.getElementById('btn-pause-menu').onclick = showMenu;
  document.getElementById('btn-settings').onclick = openSettings;
  document.getElementById('btn-settings-close').onclick = closeSettings;
  /* Server connection — input is prefilled with the default (current deployment)
   * beatmaps dir; leaving it empty reconnects to the same default. */
  var srvUrlInput = document.getElementById('srv-url');
  if (srvUrlInput) srvUrlInput.value = defaultServerBaseUrl();
  /* 玩家点击输入框时，把连接按钮文字恢复为"连接"（清除上次成功/失败反馈） */
  if (srvUrlInput) {
    srvUrlInput.onfocus = function () {
      var srvBtn = document.getElementById('btn-srv-connect');
      if (srvBtn) { srvBtn.textContent = L('srvConnect'); srvBtn.style.color = ''; srvBtn.disabled = false; }
    };
  }
  /* 服务器入口可能在构建期被剔除（平台构建），故此处必须做空值守卫。 */
  var srvConnectBtn = document.getElementById('btn-srv-connect');
  if (srvConnectBtn) srvConnectBtn.onclick = function () {
    var url = (srvUrlInput && srvUrlInput.value) ? srvUrlInput.value.replace(/^\s+|\s+$/g, '') : '';
    if (!url) url = defaultServerBaseUrl(); /* 留空 = 默认 */
    connectServer(url);
  };
  document.getElementById('btn-editor').onclick = openEditor;
  document.getElementById('btn-editor-close').onclick = closeEditor;
  document.getElementById('btn-editor-load').onclick = loadChartFromEditor;

  /* --- Language switch (self-contained i18n) --- */
  function highlightLang() {
    var cur = getLang();
    var btns = document.querySelectorAll('#lang-switch button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].style.fontWeight = (btns[i].getAttribute('data-lang') === cur) ? '700' : '400';
      btns[i].style.opacity = (btns[i].getAttribute('data-lang') === cur) ? '1' : '0.6';
    }
  }
  var langBtns = document.querySelectorAll('#lang-switch button');
  for (var li = 0; li < langBtns.length; li++) {
    langBtns[li].onclick = function () {
      setLang(this.getAttribute('data-lang'));
      applyI18n();
      highlightLang();
    };
  }
  applyI18n();
  highlightLang();

  /* --- Keyboard shortcuts --- */
  document.addEventListener('keydown', function (e) {
    /* Escape / 'P' toggles pause during gameplay. Modals (settings/editor)
     * swallow Escape themselves via their close buttons, so only act when no
     * modal is active. Enter starts a game from the menu. */
    var modalActive = settingsModal.classList.contains('active') || editorModal.classList.contains('active');
    if (modalActive) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeSettings(); closeEditor();
      }
      return;
    }
    var k = e.key || String.fromCharCode(e.keyCode || 0);
    if (k === 'Escape' || k === 'Esc' || k === 'p' || k === 'P') {
      if (game.state === STATE.PLAYING) { e.preventDefault(); pauseGame(); }
      else if (game.state === STATE.PAUSED) { e.preventDefault(); resumeGame(); }
    } else if (k === 'Enter') {
      if (game.state === STATE.MENU) { e.preventDefault(); startGame(); }
    }
  });

  /* === 8. Demo charts ===
   * Provided by the inlined shared module src/shared/demoCharts.ts (single source
   * of truth, also used by the full app — including the "event-showcase" chart
   * that used to be missing here). Do NOT keep a copy in this file. */
