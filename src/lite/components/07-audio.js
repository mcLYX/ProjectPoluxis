/* === 4. LiteAudio — ported from src/audio/AudioManager.ts ===
   * Primary path: Web Audio API (modern browsers).
   * Fallback path: HTML5 <audio> element (IE11, which lacks Web Audio API
   *   entirely). In fallback mode: imported audio plays via blob URL, but
   *   synth BGM and hit sounds are unavailable (no way to generate audio
   *   without Web Audio API). The game remains playable, just silent for
   *   demo tracks. */
  function LiteAudio() {
    this.ctx = null; this.masterGain = null; this.bgmGain = null; this.sfxGain = null;
    this.bgmSource = null; this.synthInterval = null; this.synthBpm = 140;
    this.startTime = 0; this.pauseTime = 0; this.isPlaying = false;
    this.userOffset = 0; this.leadInTime = 0; this.musicVolume = 0.8; this.effectVolume = 0.9;
    /* 兼容模式：谱面时钟改用 performance.now() 锚定的墙钟（而非 ctx.currentTime），
     * 使低帧率 / 音频卡顿时谱面仍平滑推进，不随音频定格。音频照常播放，但不再锁住谱面。 */
    this.compatMode = false; this.chartWallMs = 0;
    this.hasUploadedAudio = false; this.forceSynth = false; this.bgmBuffer = null;
    this.hitSoundBuffers = {}; this.useOscFallback = false; this.disabled = false;
    /* HTML5 fallback (IE11): when true, BGM plays via <audio> element. */
    this.useHtml5 = false; this.htmlAudioEl = null;
  }
  LiteAudio.prototype.init = function () {
    if (this.useHtml5) return; /* already initialized as HTML5 fallback */
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      /* IE11: no Web Audio API at all. Fall back to HTML5 <audio> for BGM.
       * Synth BGM and hit sounds are unavailable — the game runs silent
       * unless the user imports an audio file. */
      this.useHtml5 = true;
      return;
    }
    try {
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain(); this.masterGain.gain.value = 0.9;
      this.masterGain.connect(this.ctx.destination);
      this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = this.musicVolume;
      this.bgmGain.connect(this.masterGain);
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = this.effectVolume;
      this.sfxGain.connect(this.masterGain);
      this.loadBuiltinSounds();
    } catch (e) { this.disabled = true; }
  };
  /* Pre-render per-note-type hit sounds (tap/touch/slide) offline. These are the
   * procedural fallback; loadBuiltinSounds() may upgrade them with packaged OGG. */
  LiteAudio.prototype.preRenderHitSounds = function () {
    var sr = this.ctx ? this.ctx.sampleRate : 44100;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) { this.useOscFallback = true; return; }
    var self = this;
    var render = function (key, durSec, build) {
      try {
        var off = new OAC(1, Math.ceil(sr * durSec), sr);
        var out = off.createGain(); out.connect(off.destination);
        build(off, out);
        var result = off.startRendering();
        var store = function (b) { if (b) self.hitSoundBuffers[key] = b; };
        if (result && typeof result.then === 'function') result.then(store, function () {});
        else if (result) store(result);
      } catch (e) { /* fall back to oscillator path per-call */ }
    };
    /* tap: triangle 880→1760 + sine 1320→2640, 0.18s */
    render('tap', 0.22, function (ctx, out) {
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o1.type = 'triangle'; o1.frequency.setValueAtTime(880, 0);
      o1.frequency.exponentialRampToValueAtTime(1760, 0.08);
      o2.type = 'sine'; o2.frequency.setValueAtTime(1320, 0);
      o2.frequency.exponentialRampToValueAtTime(2640, 0.12);
      g.gain.setValueAtTime(0.7, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.18);
      o1.connect(g); o2.connect(g); g.connect(out);
      o1.start(0); o2.start(0); o1.stop(0.18); o2.stop(0.18);
    });
    /* touch: sine 740→1480, 0.14s */
    render('touch', 0.18, function (ctx, out) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(740, 0);
      o.frequency.exponentialRampToValueAtTime(1480, 0.1);
      g.gain.setValueAtTime(0.6, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.14);
      o.connect(g); g.connect(out); o.start(0); o.stop(0.14);
    });
    /* slide: sawtooth 480→880 through lowpass 2200→800, 0.16s */
    render('slide', 0.2, function (ctx, out) {
      var o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(2200, 0); f.frequency.linearRampToValueAtTime(800, 0.16);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(480, 0);
      o.frequency.exponentialRampToValueAtTime(880, 0.16);
      g.gain.setValueAtTime(0.32, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.16);
      o.connect(f); f.connect(g); g.connect(out); o.start(0); o.stop(0.16);
    });
    /* ui: crisp 2-note plink (sine 1240 + 1860 Hz, 60ms) — same recipe as the
     * full version, used for DOM button/card clicks when ui.ogg is absent. */
    render('ui', 0.08, function (ctx, out) {
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o1.type = 'sine'; o1.frequency.value = 1240;
      o2.type = 'sine'; o2.frequency.value = 1860;
      g.gain.setValueAtTime(0.35, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.06);
      o1.connect(g); o2.connect(g); g.connect(out);
      o1.start(0); o2.start(0); o1.stop(0.06); o2.stop(0.06);
    });
  };
  /* Load packaged OGG sounds (tap/touch/slide/ui) when available, upgrading the
   * synthesized fallback. Any file that is missing (e.g. ui.ogg not shipped yet)
   * simply keeps its synthesized version — a 404 never breaks the others.
   * Skipped on IE11 (no fetch/decodeAudioData): synthesized sounds are the
   * degrade path there, per requirement. */
  LiteAudio.prototype.loadBuiltinSounds = function () {
    if (this.useHtml5 || !this.ctx) return;
    this.preRenderHitSounds(); /* guarantee a fallback is ready immediately */
    if (!window.fetch || !this.ctx.decodeAudioData) return;
    var self = this;
    var files = [
      { type: 'tap', url: '../sounds/tap.ogg' },
      { type: 'touch', url: '../sounds/touch.ogg' },
      { type: 'slide', url: '../sounds/slide.ogg' },
      { type: 'ui', url: '../sounds/ui.ogg' }
    ];
    files.forEach(function (item) {
      try {
        fetch(item.url).then(function (res) {
          if (!res || !res.ok) return null;
          return res.arrayBuffer();
        }).then(function (ab) {
          if (!ab) return;
          var ok = function (buf) { if (buf) self.hitSoundBuffers[item.type] = buf; };
          var fail = function () { /* keep synthesized fallback */ };
          var p = self.ctx.decodeAudioData(ab, ok, fail);
          if (p && typeof p.then === 'function') p.then(ok, fail);
        }).catch(function () { /* keep synthesized fallback */ });
      } catch (e) { /* keep synthesized fallback */ }
    });
  };
  LiteAudio.prototype.playHitSound = function (type) {
    if (this.useHtml5) return; /* no hit sounds in HTML5 mode (no Web Audio API) */
    if (!this.ctx || !this.sfxGain || this.disabled) return;
    var cleanup = function (node) { try { if (node) node.disconnect(); } catch (e) {} };
    var buf = this.hitSoundBuffers[type];
    if (buf) {
      /* IMPORTANT: AudioBufferSourceNode is one-shot. Without an onended
       * disconnect the node stays referenced by sfxGain and is never GC'd on
       * IE11/EdgeHTML → nodes accumulate with every hit (multi-touch makes it
       * worse) and the tab eventually chokes. Release it once it finishes. */
      var src = this.ctx.createBufferSource(); src.buffer = buf;
      src.connect(this.sfxGain);
      src.onended = function () { cleanup(src); };
      src.start();
      return;
    }
    /* Oscillator fallback (pre-render not ready / failed). Per note type. */
    var t = this.ctx.currentTime, o, g, f;
    var stopCleanup = function (nodes) {
      for (var ni = 0; ni < nodes.length; ni++) {
        try { if (nodes[ni]) nodes[ni].disconnect(); } catch (e) {}
      }
    };
    if (type === 'touch') {
      o = this.ctx.createOscillator(); g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(740, t); o.frequency.exponentialRampToValueAtTime(1480, t + 0.1);
      g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g); g.connect(this.sfxGain); o.start(t); o.stop(t + 0.14);
      o.onended = function () { stopCleanup([o, g]); };
    } else if (type === 'slide') {
      o = this.ctx.createOscillator(); g = this.ctx.createGain(); f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(2200, t); f.frequency.linearRampToValueAtTime(800, t + 0.16);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(480, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.16);
      g.gain.setValueAtTime(0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(f); f.connect(g); g.connect(this.sfxGain); o.start(t); o.stop(t + 0.16);
      o.onended = function () { stopCleanup([o, f, g]); };
    } else { /* tap (default) */
      o = this.ctx.createOscillator(); var o2 = this.ctx.createOscillator(); g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1760, t + 0.08);
      o2.type = 'sine'; o2.frequency.setValueAtTime(1320, t); o2.frequency.exponentialRampToValueAtTime(2640, t + 0.12);
      g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g); o2.connect(g); g.connect(this.sfxGain);
      o.start(t); o2.start(t); o.stop(t + 0.18); o2.stop(t + 0.18);
      o.onended = function () { stopCleanup([o, o2, g]); };
    }
  };
  /* Play the UI click sound (ui.ogg when shipped, synthesized plink otherwise).
   * init() runs here because callers are always inside a click handler, which is
   * the only place AudioContext creation/resume is allowed by autoplay policy. */
  LiteAudio.prototype.playUiSound = function () {
    this.init();
    if (this.useHtml5) return; /* IE11: no Web Audio API → silent, but no error */
    if (!this.ctx || !this.sfxGain || this.disabled) return;
    var buf = this.hitSoundBuffers['ui'];
    if (buf) {
      var src = this.ctx.createBufferSource(); src.buffer = buf;
      src.connect(this.sfxGain);
      src.onended = function () { try { src.disconnect(); } catch (e) {} };
      src.start(); return;
    }
    var t = this.ctx.currentTime;
    var o1 = this.ctx.createOscillator(), o2 = this.ctx.createOscillator(), g = this.ctx.createGain();
    o1.type = 'sine'; o1.frequency.value = 1240;
    o2.type = 'sine'; o2.frequency.value = 1860;
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o1.connect(g); o2.connect(g); g.connect(this.sfxGain);
    o1.start(t); o2.start(t); o1.stop(t + 0.06); o2.stop(t + 0.06);
    o1.onended = function () { try { o1.disconnect(); o2.disconnect(); g.disconnect(); } catch (e) {} };
  };
  LiteAudio.prototype.setOffset = function (sec) { this.userOffset = sec; };
  LiteAudio.prototype.setCompatMode = function (enabled) { this.compatMode = !!enabled; };
  /* Load an uploaded audio file (mp3/wav/ogg). Mirrors AudioManager.loadAudioFile.
   * Three code paths for maximum browser compatibility:
   *   1. HTML5 fallback (IE11, no Web Audio API): blob URL → <audio> element.
   *      No decodeAudioData needed — the browser decodes on playback.
   *   2. Modern browsers with FileReader.readAsArrayBuffer: File → ArrayBuffer
   *      → decodeAudioData (Promise or callback style).
   *   3. Old browsers with Web Audio but no readAsArrayBuffer (old Safari):
   *      XHR + blob URL → ArrayBuffer → decodeAudioData. */
  LiteAudio.prototype.loadAudioFile = function (file, onLoad, onError) {
    this.init();
    var self = this;
    /* Path 1: HTML5 <audio> fallback (IE11) */
    if (this.useHtml5) {
      var createURL = (window.URL && window.URL.createObjectURL)
        || (window.webkitURL && window.webkitURL.createObjectURL);
      if (!createURL) { if (onError) onError(new Error(L('errImport'))); return; }
      var url = createURL(file);
      var audioEl = document.createElement('audio');
      audioEl.src = url;
      audioEl.volume = this.musicVolume;
      /* IE11 supports loadedmetadata; 'canplay' fires when enough data to
       * start. Use both for cross-browser reliability. */
      var done = false;
      var onReady = function () {
        if (done) return; done = true;
        self.htmlAudioEl = audioEl;
        self.hasUploadedAudio = true; self.forceSynth = false;
        if (onLoad) onLoad({ duration: audioEl.duration || 0 });
      };
      audioEl.addEventListener('loadedmetadata', onReady);
      audioEl.addEventListener('canplay', onReady);
      audioEl.addEventListener('error', function () {
        if (done) return; done = true;
        if (onError) onError(new Error(L('errAudioDecode')));
      });
      return;
    }
    if (!this.ctx) { if (onError) onError(new Error('AudioContext unavailable')); return; }
    /* Shared decode function — works for both FileReader and XHR paths. */
    var decodeBuffer = function (arrayBuffer) {
      if (!arrayBuffer) { if (onError) onError(new Error(L('errRead'))); return; }
      var success = function (buffer) {
        self.bgmBuffer = buffer; self.hasUploadedAudio = true; self.forceSynth = false;
        if (onLoad) onLoad(buffer);
      };
      var failure = function (err) { if (onError) onError(err || new Error(L('errDecode'))); };
      try {
        /* IE11-style callback signature: decodeAudioData(buf, successCb, failCb).
         * Modern signature returns a Promise — handle both. */
        var r = self.ctx.decodeAudioData(arrayBuffer, success, failure);
        if (r && typeof r.then === 'function') r.then(success, failure);
      } catch (e) { if (onError) onError(e); }
    };
    /* Path 2: FileReader.readAsArrayBuffer (modern browsers) */
    var reader = new FileReader();
    if (typeof reader.readAsArrayBuffer === 'function') {
      reader.onload = function () { decodeBuffer(reader.result); };
      reader.onerror = function () { if (onError) onError(new Error(L('errRead'))); };
      reader.readAsArrayBuffer(file);
    } else {
      /* Path 3: XHR + blob URL fallback (old Safari without readAsArrayBuffer) */
      var createURL2 = (window.URL && window.URL.createObjectURL)
        || (window.webkitURL && window.webkitURL.createObjectURL);
      if (!createURL2) { if (onError) onError(new Error(L('errImport'))); return; }
      var url2 = createURL2(file);
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url2, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () { decodeBuffer(xhr.response); };
      xhr.onerror = function () { if (onError) onError(new Error(L('errRead'))); };
      xhr.send();
    }
  };

  /* Abort a download after this long with NO bytes received. Reset on every
   * progress event, so a slow-but-moving download is never killed — only a
   * genuinely stalled one is. */
  var AUDIO_IDLE_MS = 25000;

  /* Fetch + decode an audio URL. The decoded AudioBuffer is handed to `onLoad`
   * WITHOUT touching this instance's state, so the menu can prefetch into its
   * own cache and adopt the buffer only when it actually starts playing — a
   * prefetched buffer must never leak into a chart that has no audio of its own.
   *
   * Slow / stalled networks: previously this had no timeout at all, so a dead
   * connection left the UI hanging with no feedback forever. Now a stalled
   * download is aborted and reported. `onProgress(loaded,total)` is XHR2-only
   * (IE10+); without it the request still works, just without a percentage and
   * with the timer acting as a plain total timeout.
   * HTML5 mode (IE11 without Web Audio) cannot decode to a buffer, so callers
   * there must use loadAudioUrl, which handles the <audio> element path.
   *
   * `onDecode()` fires once the bytes are all in and CPU-side decoding begins.
   * That phase has no progress of its own and can take a noticeable while for a
   * multi-MB file on a weak device, so the UI uses it to switch to a
   * "decoding" label instead of freezing on the last percentage. */
  LiteAudio.prototype.decodeAudioUrl = function (url, onLoad, onError, onProgress, onDecode) {
    this.init();
    var self = this;
    if (this.useHtml5 || !this.ctx) {
      if (onError) onError(new Error('decodeAudioUrl unavailable'));
      return;
    }
    var xhr = new XMLHttpRequest();
    var finished = false;
    var timer = 0;
    function finish(err, buffer) {
      if (finished) return;
      finished = true;
      if (timer) { window.clearTimeout(timer); timer = 0; }
      if (err) { if (onError) onError(err); }
      else { if (onLoad) onLoad(buffer); }
    }
    function armTimer() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        /* Report BEFORE aborting: abort() fires readystatechange synchronously
         * with status 0, which would otherwise win the race with a vaguer error. */
        finish(new Error(L('errTimeout')));
        try { xhr.abort(); } catch (e) {}
      }, AUDIO_IDLE_MS);
    }
    try {
      xhr.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), true);
    } catch (e) { finish(e); return; }
    xhr.responseType = 'arraybuffer';
    if (onProgress) {
      xhr.onprogress = function (e) {
        armTimer();
        onProgress(e ? e.loaded : 0, (e && e.lengthComputable) ? e.total : 0);
      };
    }
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) { finish(new Error('HTTP ' + xhr.status)); return; }
      /* Download done — from here on it is CPU-side decode with no progress of
       * its own (this also covers a response served straight from the HTTP
       * cache, where no progress event fires at all). */
      if (onDecode) onDecode();
      var success = function (buffer) { finish(null, buffer); };
      var failure = function (err) { finish(err || new Error(L('errDecode'))); };
      try {
        /* IE11-style callback signature; modern engines return a Promise. */
        var r = self.ctx.decodeAudioData(xhr.response, success, failure);
        if (r && typeof r.then === 'function') r.then(success, failure);
      } catch (e) { finish(e); }
    };
    xhr.onerror = function () { finish(new Error(L('errNet'))); };
    armTimer();
    xhr.send();
  };

  /* Load audio from a URL and adopt it as this instance's BGM buffer.
   * `onDecode` is ignored on the HTML5 path (there is no decode step). */
  LiteAudio.prototype.loadAudioUrl = function (url, onLoad, onError, onProgress, onDecode) {
    this.init();
    var self = this;
    /* HTML5 fallback (IE11 / no Web Audio): an <audio> element, no decode.
     * No byte progress is available here, so the guard is a plain timeout. */
    if (this.useHtml5) {
      var audioEl = document.createElement('audio');
      audioEl.src = url;
      audioEl.volume = this.musicVolume;
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return; done = true;
        if (onError) onError(new Error(L('errTimeout')));
      }, AUDIO_IDLE_MS);
      var onReady = function () {
        if (done) return; done = true;
        window.clearTimeout(timer);
        self.htmlAudioEl = audioEl;
        self.hasUploadedAudio = true; self.forceSynth = false;
        if (onLoad) onLoad({ duration: audioEl.duration || 0 });
      };
      audioEl.addEventListener('loadedmetadata', onReady);
      audioEl.addEventListener('canplay', onReady);
      audioEl.addEventListener('error', function () {
        if (done) return; done = true;
        window.clearTimeout(timer);
        if (onError) onError(new Error(L('errAudioLoad')));
      });
      return;
    }
    this.decodeAudioUrl(url, function (buffer) {
      self.bgmBuffer = buffer; self.hasUploadedAudio = true; self.forceSynth = false;
      if (onLoad) onLoad(buffer);
    }, onError, onProgress, onDecode);
  };

  LiteAudio.prototype.setMusicVolume = function (v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.useHtml5) { if (this.htmlAudioEl) this.htmlAudioEl.volume = this.musicVolume; return; }
    if (this.bgmGain && this.ctx) {
      var gain = this.bgmGain.gain;
      var t = this.ctx.currentTime;
      if (gain.setTargetAtTime) {
        gain.setTargetAtTime(this.musicVolume, t, 0.015);
      } else {
        gain.value = this.musicVolume;
      }
    }
  };
  LiteAudio.prototype.setEffectVolume = function (v) {
    this.effectVolume = Math.max(0, Math.min(1, v));
    if (this.useHtml5) return; /* no effect volume in HTML5 mode */
    if (this.sfxGain && this.ctx) {
      var gain = this.sfxGain.gain;
      var t = this.ctx.currentTime;
      if (gain.setTargetAtTime) {
        gain.setTargetAtTime(this.effectVolume, t, 0.015);
      } else {
        gain.value = this.effectVolume;
      }
    }
  };
  LiteAudio.prototype.setSynthesizedTrack = function (bpm) {
    this.init();
    /* IE11 (HTML5 mode): can't synthesize audio. Mark forceSynth so play()
     * knows to run the game clock without audio when no file is uploaded. */
    this.forceSynth = true; this.synthBpm = bpm;
  };
  /* Time-coordinate contract (mirrors the full build's AudioManager):
   * every public method speaks CHART TIME, i.e. the same coordinate
   * getCurrentTime() returns. The userOffset conversion happens inside this
   * class and nowhere else — callers must never add or subtract it.
   *   chartTime = audioTime + userOffset
   * @param startChartSec chart-time position to start from. */
  LiteAudio.prototype.play = function (startChartSec, leadInSec) {
    this.init();
    leadInSec = leadInSec || 0;
    this.leadInTime = leadInSec;
    /* The single chart -> audio conversion point (mirrors AudioManager.play).
     * NOT clamped: audioStartSec may be negative (positive offset — the song
     * hasn't begun yet, stays silent) OR positive (negative offset — the song
     * is ALREADY partway when the chart starts, so audio must begin DURING the
     * lead-in rather than wait until beat 0 and then jump to a middle offset). */
    var audioStartSec = (startChartSec || 0) - this.userOffset;
    /* 兼容模式：锚定墙钟，使 getCurrentTime() 在 compat 下读到
     * startChartSec - leadInSec（(audioStartSec - leadInSec) + userOffset 化简后
     * 抵消 userOffset）。必须在 audioStartSec 求定之后——否则 undefined → NaN 定格。 */
    if (this.compatMode) this.chartWallMs = now() - (audioStartSec - leadInSec) * 1000;
    var self = this;
    /* 负延迟时歌曲已进行到 audioStartSec，lead-in 需按该值缩短（甚至无需等待）。 */
    var effLeadIn = Math.max(0, leadInSec - audioStartSec);
    if (this.useHtml5) {
      this.stop();
      this.isPlaying = true;
      /* Shift start time forward so that getCurrentTime() returns
       * startChartSec - leadInSec immediately, matching the Web Audio path. */
      this.startTime = now() - (audioStartSec - leadInSec) * 1000;
      if (this.htmlAudioEl) {
        try { this.htmlAudioEl.currentTime = Math.max(0, audioStartSec); } catch (e) {}
        this.htmlAudioEl.volume = this.musicVolume;
        /* Negative offset: the song is already partway, so start as soon as the
         * (possibly zero) shortened lead-in elapses instead of the full leadIn. */
        if (effLeadIn > 0) {
          window.setTimeout(function () {
            if (!self.isPlaying) return;
            var p = self.htmlAudioEl.play();
            if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay blocked */ });
          }, effLeadIn * 1000);
        } else {
          var p = this.htmlAudioEl.play();
          if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay blocked */ });
        }
      }
      return;
    }
    if (!this.ctx) return; this.stop();
    /* startTime is anchored so getCurrentTime() returns startChartSec - leadInSec
     * right after play() and counts up normally. Real audio begins when the
     * chart clock reaches the offset (baseStart), from the song's beginning
     * (offset 0); for negative offset that is DURING the lead-in. For a mid-song
     * resume (baseStart in the past) we start now from the current audio position. */
    this.startTime = this.ctx.currentTime - audioStartSec + leadInSec;
    this.isPlaying = true;
    var useBuffer = this.hasUploadedAudio && !this.forceSynth && this.bgmBuffer;
    var baseStart = this.ctx.currentTime + leadInSec - audioStartSec;
    if (useBuffer && this.bgmBuffer && this.bgmGain) {
      this.bgmSource = this.ctx.createBufferSource(); this.bgmSource.buffer = this.bgmBuffer;
      this.bgmSource.connect(this.bgmGain);
      if (baseStart >= this.ctx.currentTime) {
        this.bgmSource.start(baseStart, 0);
      } else {
        this.bgmSource.start(this.ctx.currentTime, audioStartSec);
      }
    } else {
      this.startSynthesizedMusic(Math.max(0, audioStartSec), effLeadIn);
    }
  };
  LiteAudio.prototype.pause = function () { if (!this.isPlaying) return; this.pauseTime = this.getCurrentTime(); this.stop(); };
  LiteAudio.prototype.stop = function () {
    this.isPlaying = false;
    if (this.useHtml5) {
      if (this.htmlAudioEl) { try { this.htmlAudioEl.pause(); } catch (e) {} }
      return;
    }
    if (this.bgmSource) { try { this.bgmSource.stop(); this.bgmSource.disconnect(); } catch (e) {} this.bgmSource = null; }
    if (this.synthInterval) { window.clearInterval(this.synthInterval); this.synthInterval = null; }
  };
  LiteAudio.prototype.getCurrentTime = function () {
    if (!this.isPlaying) return this.pauseTime;
    /* 兼容模式：谱面时钟走 performance.now() 墙钟，与音频解耦，避免音频
     * 卡顿/低帧率时谱面跟着定格。userOffset 已在 chartWallMs 锚定中体现。 */
    if (this.compatMode) return (now() - this.chartWallMs) / 1000 + this.userOffset;
    if (this.useHtml5) {
      /* Prefer audioEl.currentTime (actual playback position) over wall clock
       * for accuracy. Fall back to wall clock if no audio element (silent mode).
       *
       * Note: during the lead-in period, the audio element hasn't started
       * playing yet, so currentTime stays at offsetSec. We use the wall
       * clock (startTime-based) instead, which advances smoothly through
       * the lead-in period. Once audio starts, currentTime will be correct. */
      if (this.htmlAudioEl && isFinite(this.htmlAudioEl.currentTime) &&
          now() - this.startTime >= this.leadInTime * 1000) {
        return this.htmlAudioEl.currentTime + this.userOffset;
      }
      return (now() - this.startTime) / 1000 + this.userOffset;
    }
    if (!this.ctx) return this.pauseTime;
    return (this.ctx.currentTime - this.startTime) + this.userOffset;
  };
  /* Synth BGM — ported from AudioManager.ts L293-336 (4-chord arp + kick + hat) */
  LiteAudio.prototype.startSynthesizedMusic = function (startOffset, leadInSec) {
    if (!this.ctx || !this.bgmGain) return;
    var beatInterval = 60 / this.synthBpm;
    var step = Math.floor(startOffset / (beatInterval / 4));
    var chords = [[220,277.18,329.63,440],[174.61,220,261.63,349.23],[261.63,329.63,392,523.25],[196,246.94,293.66,392]];
    var self = this;
    var tick = function () {
      if (!self.isPlaying || !self.ctx || !self.bgmGain) return;
      var t = self.ctx.currentTime;
      var beat16 = step % 16, bar = Math.floor(step / 16) % chords.length, chord = chords[bar];
      if (beat16 % 4 === 0) {
        var o = self.ctx.createOscillator(), g = self.ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.08);
        g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g); g.connect(self.bgmGain); o.start(t); o.stop(t + 0.12);
      }
      if (beat16 === 4 || beat16 === 12) {
        var h = self.ctx.createOscillator(), hg = self.ctx.createGain();
        h.type = 'triangle'; h.frequency.setValueAtTime(240, t); h.frequency.exponentialRampToValueAtTime(80, t + 0.09);
        hg.gain.setValueAtTime(0.5, t); hg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        h.connect(hg); hg.connect(self.bgmGain); h.start(t); h.stop(t + 0.1);
      }
      if (beat16 % 2 === 1) {
        var hs = self.ctx.createOscillator(), hsg = self.ctx.createGain();
        hs.type = 'triangle'; hs.frequency.setValueAtTime(3000, t);
        hsg.gain.setValueAtTime(0.15, t); hsg.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        hs.connect(hsg); hsg.connect(self.bgmGain); hs.start(t); hs.stop(t + 0.04);
      }
      var arp = chord[beat16 % chord.length];
      var ao = self.ctx.createOscillator(), ag = self.ctx.createGain();
      ao.type = (beat16 % 4 === 0) ? 'sawtooth' : 'sine'; ao.frequency.setValueAtTime(arp, t);
      ag.gain.setValueAtTime(0.25, t); ag.gain.exponentialRampToValueAtTime(0.001, t + beatInterval * 0.35);
      ao.connect(ag); ag.connect(self.bgmGain); ao.start(t); ao.stop(t + beatInterval * 0.35);
      step++;
    };
    var intervalMs = (beatInterval / 4) * 1000;
    if (leadInSec > 0) {
      /* Defer the first tick by leadInSec so the synth starts exactly when the
       * game clock reaches zero — same lockstep as buffer audio. */
      window.setTimeout(function () {
        if (!self.isPlaying) return;
        tick();
        self.synthInterval = window.setInterval(tick, intervalMs);
      }, leadInSec * 1000);
    } else {
      tick();
      this.synthInterval = window.setInterval(tick, intervalMs);
    }
  };
  var audio = new LiteAudio();
