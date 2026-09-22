/* === 7. UI wiring === */
  var menuScreen = document.getElementById('menu-screen');
  var pauseScreen = document.getElementById('pause-screen');
  var resultScreen = document.getElementById('result-screen');
  var resultCard = document.getElementById('result-card');
  var hud = document.getElementById('hud');
  var chartListEl = document.getElementById('chart-list');
  /* Menu top-left cluster (brand + album nav) and its album-name label. */
  var menuTopEl = document.getElementById('menu-top');
  var menuNavTitleEl = document.getElementById('menu-nav-title');
  var menuStatusEl = document.getElementById('menu-status');
  var settingsModal = document.getElementById('settings-modal');
  var editorModal = document.getElementById('editor-modal');
  var editorTextarea = document.getElementById('editor-textarea');
  var editorError = document.getElementById('editor-error');
  var selectedKey = null;
  var selectedDiffIdx = 0;
  var customChartKey = null; /* key of currently-loaded custom chart, if any */
  /* START button of the currently-selected card (assigned by buildMenu). The old
   * global #btn-start is gone — every card owns its own button — so the loading
   * state has to target that card's button instead of a fixed id. */
  var activeStartBtn = null;
  /* Currently highlighted menu card — a song OR an album. Kept separate from
   * currentSongItem because album cards need the same "select, then its action
   * button appears" treatment (otherwise their Enter button could never show). */
  var selectedItem = null;

  /* data-role lookup: walks up from an event target. IE9 has no
   * Element.closest(), so this ES5 helper replaces the old fragile
   * `className.indexOf('diff-btn')` sniffing. */
  function closestRole(node, role) {
    for (var depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      if (node.getAttribute && node.getAttribute('data-role') === role) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* The button currently showing a download state. Pinned for the WHOLE load
   * cycle: the selection can change (or be cleared) while a download is in
   * flight, and looking up `activeStartBtn` on every update would then leave the
   * pressed card stuck on "加载中…" with no owner left to restore it. */
  var busyBtn = null;

  /* Put a card's START button into / out of its busy state.
   * `text === null` restores the original label. The original is remembered on
   * the element so prefetch/retry cycles can't lose it. */
  function setStartLoading(text) {
    if (!text) {
      if (!busyBtn) return;
      var prev = busyBtn.getAttribute('data-label');
      if (prev !== null) busyBtn.textContent = prev;
      busyBtn.disabled = false;
      busyBtn = null;
      return;
    }
    if (!busyBtn) busyBtn = activeStartBtn;
    if (!busyBtn) return;
    if (busyBtn.getAttribute('data-label') === null) {
      busyBtn.setAttribute('data-label', busyBtn.textContent);
    }
    busyBtn.textContent = text;
    busyBtn.disabled = true;
  }

  /* Non-blocking status line under the carousel. This replaces alert(): a modal
   * alert blocks the touch UI, and before this a failed load could also fail
   * completely silently. */
  function setStatus(msg) {
    if (!menuStatusEl) return;
    menuStatusEl.textContent = msg || '';
    menuStatusEl.className = msg ? 'menu-status menu-status--on' : 'menu-status';
  }
  function clearStatus() { setStatus(''); }

  /* "谱面 42%" / "音频 87%" for the START button while a download runs. */
  function loadProgressText(phaseKey, loaded, total, fallbackKey) {
    if (!total) return L(fallbackKey);
    var pct = Math.round((loaded / total) * 100);
    if (pct < 0) pct = 0;
    else if (pct > 100) pct = 100;
    return L(phaseKey) + ' ' + pct + '%';
  }

  /* --- De-duplicated downloads --------------------------------------------
   * `start(succeed, fail, progress, decoding)` performs the actual request; the
   * first caller starts it and everyone else attaches to the same one.
   * IMPORTANT: `progress` / `decoding` only reach listeners that are registered
   * when the event fires — a prefetch (no listeners at all) therefore consumes
   * the early events, and a later START that joins a *finished* entry gets no
   * events simply because the transfer is already over. */
  function joinOrStart(store, key, start, onDone, onFail, onProgress, onDecode) {
    var e = store[key];
    if (e && e.state === 'done') { if (onDone) onDone(e.value); return; }
    if (e) {
      /* Already in flight (typically a prefetch) — queue behind it. */
      if (onDone) e.done.push(onDone);
      if (onFail) e.fail.push(onFail);
      if (onProgress) e.prog.push(onProgress);
      if (onDecode) e.dec.push(onDecode);
      return;
    }
    e = store[key] = { state: 'loading', value: null, done: [], fail: [], prog: [], dec: [] };
    if (onDone) e.done.push(onDone);
    if (onFail) e.fail.push(onFail);
    if (onProgress) e.prog.push(onProgress);
    if (onDecode) e.dec.push(onDecode);
    start(function (value) {
      e.state = 'done';
      e.value = value;
      var d = e.done; e.done = []; e.fail = []; e.prog = []; e.dec = [];
      for (var i = 0; i < d.length; i++) d[i](value);
    }, function (err) {
      delete store[key]; /* drop the entry so the next attempt retries */
      var f = e.fail; e.done = []; e.fail = []; e.prog = []; e.dec = [];
      for (var i = 0; i < f.length; i++) f[i](err);
    }, function (loaded, total) {
      for (var i = 0; i < e.prog.length; i++) e.prog[i](loaded, total);
    }, function () {
      for (var i = 0; i < e.dec.length; i++) e.dec[i]();
    });
  }

  function loadChartCached(cacheKey, url, onDone, onFail, onProgress) {
    joinOrStart(chartCache, cacheKey, function (ok, bad, prog) {
      loadJson(url, function (chart) {
        if (!chart || !chart.metadata || !chart.notes) { bad(new Error(L('chartErrFormat'))); return; }
        ok(chart);
      }, bad, prog);
    }, onDone, onFail, onProgress);
  }

  function loadAudioCached(url, onDone, onFail, onProgress, onDecode) {
    /* Keep at most ONE decoded buffer. An AudioBuffer is decompressed PCM (a few
     * minutes of stereo float32 is tens of MB), so holding several would be a
     * real memory hazard on the weak devices Lite targets. */
    for (var k in audioCache) {
      if (k !== url && Object.prototype.hasOwnProperty.call(audioCache, k)) delete audioCache[k];
    }
    joinOrStart(audioCache, url, function (ok, bad, prog, dec) {
      /* decodeAudioUrl only hands back a buffer; adopting it into the live audio
       * state is the caller's job (prefetch must not touch it). */
      audio.decodeAudioUrl(url, ok, bad, prog, dec);
    }, onDone, onFail, onProgress, onDecode);
  }

  /* Beatmaps manifest state */
  var manifestItems = []; /* top-level items: albums + songs */
  var currentAlbumId = null; /* null = root, string = album id (mirrors the stack) */
  /* Chain of albums from the root list down to the currently-open one.
   * Manifests can NEST albums (an album's `songs` may itself contain albums —
   * see public/beatmaps.json: from_arcaea > fanmade), so a single id cannot
   * identify the current list: the id alone is ambiguous and a top-level lookup
   * would return an empty list. The stack is the source of truth. */
  var albumStack = [];
  var currentSongItem = null; /* currently selected song item (from manifest) */
  /* --- Online asset caches -------------------------------------------------
   * Charts and audio are downloaded through these, keyed by cache key / URL.
   * There is deliberately NO prefetch: for Lite's audience bandwidth is the
   * scarce resource, so nothing is fetched until START is actually pressed. The
   * caches still avoid re-downloading what has already been fetched — replaying
   * a chart (retry / pause → restart) reuses the JSON, and re-playing the same
   * song reuses the decoded buffer.
   * Entry shape: { state, value, done:[], fail:[], prog:[] } */
  var chartCache = {}; /* cacheKey → chart JSON */
  var audioCache = {}; /* resolved url → AudioBuffer */

  /* Abort a download after this long with NO bytes received. Reset on every
   * progress event, so a slow-but-moving download is never killed — only a
   * genuinely stalled one is. */
  var LOAD_IDLE_MS = 15000;

  /* XHR helper (IE11-compatible, no fetch/Promise needed).
   *
   * Hardened for slow / stalled networks. Previously there was NO timeout, so a
   * dead or crawling connection left the caller waiting forever with no feedback
   * at all (the reported "很容易卡加载，而且没有任何提示"). Now:
   *  - a stalled request is aborted and reported as errTimeout;
   *  - the idle timer resets on every `progress` event, so a genuinely slow
   *    download keeps its full patience;
   *  - onProgress(loaded,total) is XHR2-only (IE10+); without it the request
   *    still works, just without a percentage and with the timer behaving as a
   *    plain total timeout — the only option IE9 has. */
  function loadJson(url, onSuccess, onError, onProgress, timeoutMs) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    var timer = 0;
    var limit = timeoutMs || LOAD_IDLE_MS;

    function finish(err, data) {
      if (finished) return;
      finished = true;
      if (timer) { window.clearTimeout(timer); timer = 0; }
      if (err) { if (onError) onError(err); }
      else { if (onSuccess) onSuccess(data); }
    }
    function armTimer() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        /* Report BEFORE aborting: abort() fires readystatechange synchronously
         * with status 0, which would otherwise win the race with errTimeout. */
        finish(new Error(L('errTimeout')));
        try { xhr.abort(); } catch (e) {}
      }, limit);
    }

    try {
      xhr.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), true);
    } catch (e) { finish(e); return; }

    if (onProgress) {
      xhr.onprogress = function (e) {
        armTimer(); /* bytes are still arriving → not stalled */
        onProgress(e ? e.loaded : 0, (e && e.lengthComputable) ? e.total : 0);
      };
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { finish(e); return; }
        finish(null, data);
      } else {
        finish(new Error(xhr.status ? 'HTTP ' + xhr.status : L('errNet')));
      }
    };
    xhr.onerror = function () { finish(new Error(L('errNet'))); };

    armTimer();
    xhr.send();
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
      resetAlbumNav();
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
      resetAlbumNav();
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
      resetAlbumNav();
      callback && callback(null, list);
    });
  }

  /* Get current list of items to display (depends on the album stack). */
  function getCurrentListItems() {
    if (!albumStack.length) return manifestItems;
    return albumStack[albumStack.length - 1].songs || [];
  }

  /* Reset album navigation when the whole manifest is replaced. */
  function resetAlbumNav() {
    albumStack = [];
    currentAlbumId = null;
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

    /* Built-in chart: use DEMO_CHARTS directly (nothing to download) */
    if (DEMO_CHARTS[selectedKey]) {
      startGameWithChart(DEMO_CHARTS[selectedKey]);
      return;
    }

    /* Online chart: chart JSON first, then its audio (see startGameWithChart) */
    if (!currentSongItem) return;
    var song = currentSongItem;
    var diff = song.difficulties && song.difficulties[selectedDiffIdx];
    if (!diff || !diff.chartFile) {
      setStartLoading(null);
      setStatus(L('chartNoFile'));
      return;
    }

    /* Immediate feedback: the very button the user pressed becomes the progress
     * readout. Previously a slow chart download showed NOTHING AT ALL — this is
     * the reported "卡加载且没有任何提示". */
    clearStatus();
    setStartLoading(L('loading'));
    loadChartCached(song.id + '_' + selectedDiffIdx, resolveServerUrl(diff.chartFile),
      function (chart) {
        startGameWithChart(chart, song);
      },
      function (err) {
        setStartLoading(null);
        setStatus(L('loadFailHint', { err: (err && err.message) || err }));
      },
      function (loaded, total) {
        setStartLoading(loadProgressText('loadPhaseChart', loaded, total, 'loading'));
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
      /* Single choke point that guarantees the busy button is always handed back:
       * not every path here downloads audio (a chart without an `audio` field
       * goes straight to playing), and without this the pressed card would keep
       * showing "加载中…" after returning to the menu. */
      setStartLoading(null);
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
     * If user uploaded an audio file in the editor, use that directly.
     *
     * The download goes through audioCache, so a buffer already warmed by the
     * prefetch (or by a previous attempt) is adopted and playback starts with
     * no further network traffic. */
    var useSynth = function (err) {
      console.warn('[Lite] Audio load failed, using synth:', err);
      setStartLoading(null);
      setStatus(L('audioFailSynth', { err: (err && err.message) || err }));
      audio.hasUploadedAudio = false;
      audio.forceSynth = true;
      audio.setSynthesizedTrack(chart.metadata.bpm);
      startPlaying();
    };
    var adoptBuffer = function (buffer) {
      audio.bgmBuffer = buffer;
      audio.hasUploadedAudio = true;
      audio.forceSynth = false;
    };

    if (songItem && songItem.audio) {
      var aurl = resolveServerUrl(songItem.audio);
      setStartLoading(L('loading'));
      if (audio.useHtml5) {
        /* IE11 without Web Audio: no buffer to cache, the <audio> element path
         * (which has its own timeout) is used instead. */
        audio.loadAudioUrl(aurl, function () { setStartLoading(null); startPlaying(); }, useSynth);
      } else {
        loadAudioCached(aurl, function (buffer) {
          adoptBuffer(buffer);
          setStartLoading(null);
          startPlaying();
        }, useSynth, function (loaded, total) {
          /* Last byte arrived → the remaining wait is decoding, which has no
           * percentage. Showing a word beats a frozen "音频 100%". */
          if (total > 0 && loaded >= total) { setStartLoading(L('audioDecoding')); return; }
          setStartLoading(loadProgressText('loadPhaseAudio', loaded, total, 'loading'));
        }, function () {
          /* Covers responses served from the HTTP cache, where no progress event
           * fires at all: decode is still ahead, so say so. */
          setStartLoading(L('audioDecoding'));
        });
      }
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

  /* Accent palette for menu cards that declare no accentColor of their own.
   * Lite loads no cover art, so a deterministic per-card accent keeps the
   * carousel lively while staying on the cyan/blue brand palette. */
  var CARD_ACCENTS = ['#06b6d4', '#38bdf8', '#2563eb', '#7c3aed', '#a855f7', '#22d3ee'];

  /* Live references to the rendered cards. Selection is applied by toggling
   * classes on these existing elements (see syncSelection) instead of rebuilding
   * the carousel: rebuilding replaces every element mid-frame, which both
   * flickers the row and prevents any CSS transition from running. */
  var cardRefs = [];

  /* Album navigation. Manifests may nest albums, so "back" pops one level
   * (parent album) while "home" jumps straight to the root list. */
  function goToRoot() {
    if (!albumStack.length) return; /* already at the root list */
    resetAlbumNav();
    currentSongItem = null;
    selectedKey = null;
    selectedItem = null;
    buildMenu(-1); /* list transition slides back from the left */
  }

  function goBack() {
    if (!albumStack.length) return;
    albumStack.pop();
    var parent = albumStack.length ? albumStack[albumStack.length - 1] : null;
    currentAlbumId = parent ? parent.id : null;
    currentSongItem = null;
    selectedKey = null;
    selectedItem = null;
    buildMenu(-1);
  }

  /* Replay the carousel slide-in so entering / leaving an album reads as a list
   * transition. `dir` is 1 when drilling in, -1 when going back.
   * The class is removed, a reflow is forced (otherwise re-adding it would be
   * ignored as a no-op class change and the animation would not restart), then
   * re-added. Browsers without CSS animations (IE9) just ignore it. */
  function playListTransition(dir) {
    if (!chartListEl) return;
    chartListEl.className = 'chart-carousel';
    void chartListEl.offsetWidth;
    chartListEl.className = 'chart-carousel ' + (dir < 0 ? 'chart-carousel--back' : 'chart-carousel--fwd');
  }

  /* Show/hide the top-left album nav and label it with the current album name. */
  function updateMenuNav(inAlbum) {
    if (menuTopEl) menuTopEl.className = 'menu-top' + (inAlbum ? ' menu-top--album' : '');
    if (!menuNavTitleEl) return;
    var name = '';
    if (inAlbum) {
      name = albumStack[albumStack.length - 1].title || '';
    }
    menuNavTitleEl.textContent = name;
  }

  function isSelected(item) {
    return !!selectedItem && selectedItem.id === item.id && selectedItem.type === item.type;
  }

  /* Selecting a card only re-applies selection state — the card elements stay
   * put, so the lift and the action-button reveal animate via CSS transition.
   * For songs this also arms the play state (currentSongItem / difficulty). */
  function selectItem(item) {
    selectedItem = item;
    if (item.type === 'song') {
      currentSongItem = item;
      selectedDiffIdx = 0;
      selectedKey = item.id;
      var scheme = (DEMO_CHARTS[item.id] && DEMO_CHARTS[item.id].metadata && DEMO_CHARTS[item.id].metadata.bgScheme) || item.bgScheme || null;
      if (scheme) Theme.apply(scheme);
    }
    syncSelection();
    clearStatus();
  }

  /* Clear the highlighted card (re-clicking a selected card deselects it). */
  function deselect() {
    selectedItem = null;
    currentSongItem = null;
    selectedKey = null;
    selectedDiffIdx = 0;
    syncSelection();
  }

  function enterAlbum(item) {
    albumStack.push(item);
    currentAlbumId = item.id;
    currentSongItem = null;
    selectedKey = null;
    selectedItem = null;
    buildMenu(1); /* different list — a real rebuild is required here */
  }

  /* Selecting a card widens it (120px → 208px, animated), so one picked near the
   * right edge of the row would otherwise stay half-clipped. Nudge the row once
   * the width transition has settled — measuring any earlier still reports the
   * old width. getBoundingClientRect + scrollLeft both work in IE9+. */
  function ensureCardVisible(el) {
    window.setTimeout(function () {
      /* Clicking on to another card within the delay would otherwise scroll the
       * row towards a card that is no longer expanded. */
      if (el.className.indexOf('selected') < 0) return;
      var max = chartListEl.scrollWidth - chartListEl.clientWidth;
      if (max <= 0) return;
      var c = el.getBoundingClientRect();
      var v = chartListEl.getBoundingClientRect();
      var pad = 12;
      var delta = 0;
      if (c.left < v.left + pad) delta = c.left - (v.left + pad);
      else if (c.right > v.right - pad) delta = c.right - (v.right - pad);
      if (!delta) return;
      var next = chartListEl.scrollLeft + delta;
      if (next < 0) next = 0;
      else if (next > max) next = max;
      chartListEl.scrollLeft = next;
    }, 300);
  }

  /* Apply the current selection to the already-rendered cards. */
  function syncSelection() {
    activeStartBtn = null;
    var selEl = null;
    for (var i = 0; i < cardRefs.length; i++) {
      var el = cardRefs[i].el;
      var item = cardRefs[i].item;
      var isAlbum = item.type === 'album';
      var sel = isSelected(item);

      el.className = 'chart-card' + (isAlbum ? ' chart-card--album' : '') + (sel ? ' selected' : '');

      /* Difficulty chips live only on the selected card and are (re)built here,
       * so a freshly-selected card plays their insert animation. */
      var box = el.querySelector('.card-diffs');
      if (box && !isAlbum) {
        box.innerHTML = '';
        if (sel && item.difficulties && item.difficulties.length > 0) {
          for (var di = 0; di < item.difficulties.length; di++) {
            var diff = item.difficulties[di];
            var lvl = (typeof diff.level === 'number' && diff.level > 0) ? ' Lv.' + diff.level : '';
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'diff-btn' + (di === selectedDiffIdx ? ' active' : '');
            b.setAttribute('data-role', 'diff');
            b.setAttribute('data-idx', String(di));
            b.textContent = (diff.name || (L('diff') + (di + 1))) + lvl;
            box.appendChild(b);
          }
        }
      }
      if (sel) {
        selEl = el;
        if (!isAlbum) activeStartBtn = el.querySelector('.card-start');
      }
    }
    if (selEl) ensureCardVisible(selEl);
  }

  /* `dir` selects the list-transition direction (1 = drilled in, -1 = back). */
  function buildMenu(dir) {
    chartListEl.innerHTML = '';
    cardRefs = [];
    activeStartBtn = null;
    clearStatus(); /* a previous load failure no longer applies to this list */

    var items = getCurrentListItems();
    updateMenuNav(albumStack.length > 0);

    for (var i = 0; i < items.length; i++) {
      (function (item, idx) {
        var isAlbum = item.type === 'album';
        var accent = item.accentColor || CARD_ACCENTS[idx % CARD_ACCENTS.length];
        var title = item.title || 'Unknown';

        var card = document.createElement('div');
        card.className = 'chart-card' + (isAlbum ? ' chart-card--album' : '');
        card.setAttribute('data-role', isAlbum ? 'album' : 'card');

        var kindLabel, meta;
        if (isAlbum) {
          kindLabel = L('albumKw');
          meta = (item.artist || 'Various Artists') + ' · ' + (item.songs ? item.songs.length : 0) + L('songsSuffix');
        } else {
          var n = idx + 1;
          kindLabel = L('trackKw') + ' ' + (n < 10 ? '0' + n : '' + n);
          meta = item.artist || 'Unknown';
        }

        /* No cover art: an accent radial glow + a bottom readability veil
         * approximate the full version's look without any image request. */
        card.innerHTML =
          '<div class="card-glow" style="background:radial-gradient(circle at 32% 26%,' +
            withAlpha(accent, 0.34) + ',transparent 68%);"></div>' +
          '<div class="card-veil"></div>' +
          /* Collapsed spine title: rotated top-to-bottom while the card is
           * narrow, cross-fading with .card-body once the card is selected.
           * Lives in the DOM from the start so selection never rebuilds DOM. */
          '<div class="card-title-v">' + title + '</div>' +
          /* Collapsed-only badge: with the narrow spine the horizontal body is
           * hidden, so albums would look exactly like songs. Mirrors the full
           * version's small 专辑 pill on its collapsed album cards. */
          '<div class="card-kind-v">' + kindLabel + '</div>' +
          '<div class="card-body">' +
            '<div class="card-kind">' + kindLabel + '</div>' +
            '<div class="chart-title">' + title + '</div>' +
            '<div class="chart-meta">' + meta + '</div>' +
            (item.bpm ? '<div class="chart-bpm">BPM ' + item.bpm + '</div>' : '') +
            '<div class="card-diffs"></div>' +
          '</div>' +
          '<button type="button" class="btn-start card-start" data-role="start">' +
            (isAlbum ? L('enterAlbum') : L('startGame')) +
          '</button>';

        card.onclick = function (e) {
          var ev = e || window.event;
          var target = ev.target || ev.srcElement;

          /* Difficulty chip: switch difficulty without touching selection. */
          var diffEl = closestRole(target, 'diff');
          if (diffEl) {
            var di = parseInt(diffEl.getAttribute('data-idx'), 10);
            if (!isNaN(di)) {
              selectedDiffIdx = di;
              syncSelection();
              clearStatus();
            }
            return;
          }
          var wasSelected = isSelected(item);
          /* In-card action: songs start the game (selecting first if needed),
           * albums drill in. The button only appears once the card is selected,
           * but this same path also covers IE9. */
          if (closestRole(target, 'start')) {
            if (isAlbum) { enterAlbum(item); return; }
            if (!wasSelected) selectItem(item);
            startGame();
            return;
          }
          /* Plain card click: select, or deselect when it is already selected. */
          if (wasSelected) deselect();
          else selectItem(item);
        };

        chartListEl.appendChild(card);
        cardRefs.push({ el: card, item: item });
      })(items[i], i);
    }

    syncSelection();
    playListTransition(dir);
  }

  /* --- Settings modal --- */
  function openSettings() {
    /* Sync slider values from settings */
    var map = [
      ['set-speed', settings.speedMul, 'val-speed', function (v) { return v.toFixed(1) + 'x'; }],
      ['set-size', settings.sizeScale, 'val-size', function (v) { return v.toFixed(1) + 'x'; }],
      ['set-render', settings.renderDist, 'val-render', function (v) { return String(v); }],
      ['set-maxfps', settings.maxFps, 'val-maxfps', function (v) { return v > 0 ? v + ' fps' : '∞'; }],
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
      /* No apply function needed — the render loop reads settings.maxFps each
       * frame (see frameGateAllows in 09-engine.js). */
      ['set-maxfps', 'val-maxfps', 'maxFps', function (v) { return v > 0 ? v + ' fps' : '∞'; }, function (v) {}],
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

  /* --- Card carousel: mouse wheel → horizontal scroll ---
   * The scrollbar is hidden (see .chart-carousel) and a natively scrollable
   * container only reacts to horizontal wheels / trackpad pans, so without this
   * a plain vertical wheel would leave mouse users unable to reach the cards
   * past the first screen. Non-passive so the wheel never scrolls the page
   * instead. IE9 uses `mousewheel` and never scrolls the row (cards are
   * stacked), so this listener is inert there. */
  (function () {
    if (!chartListEl || !chartListEl.addEventListener) return;
    chartListEl.addEventListener('wheel', function (e) {
      /* e.deltaX present → the device already pans horizontally (trackpad). */
      if (e.deltaX) return;
      var d = (typeof e.deltaY === 'number') ? e.deltaY : -e.wheelDelta;
      if (!d) return;
      var max = chartListEl.scrollWidth - chartListEl.clientWidth;
      if (max <= 0) return;
      var next = chartListEl.scrollLeft + d;
      if (next < 0) next = 0;
      else if (next > max) next = max;
      chartListEl.scrollLeft = next;
      if (e.preventDefault) e.preventDefault();
    }, { passive: false });
  })();

  /* --- Button wiring ---
   * There is no global START button anymore: each card owns its own
   * `.card-start` and the click is handled in buildMenu (via data-role). */
  /* Album nav (top-left): back pops one nesting level, home returns to root. */
  document.getElementById('btn-nav-back').onclick = goBack;
  document.getElementById('btn-nav-home').onclick = goToRoot;
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
      /* Cards are built by JS, so [data-i18n] alone can't re-localize them. */
      buildMenu();
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
