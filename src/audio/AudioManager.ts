import { NoteType } from '../types/game';

/** Frequency response of the A-weighting curve (ANSI S1.4), expressed as a
 *  dB gain relative to 1 kHz. Input: frequency in Hz, Output: amplitude gain
 *  in [0,1] range. We do NOT exponentiate to linear in dB (as the failure
 *  experience from a piano pitch task warns against); we convert the dB gain
 *  to linear using 10^(A_dB/20), then apply it to the linear bin magnitude.
 */
function aWeightingLinearGain(fHz: number): number {
  // Boundaries & invalid input guard. Values outside 20 Hz..20 kHz get 0.
  if (fHz < 20 || fHz > 20000) return 0;
  const f2 = fHz * fHz;
  const f4 = f2 * f2;
  // A-weighting (RA_f) formula in dB (IEC 61672-1)
  const RA = (12200 * 12200) * f4 / (
    (f2 + 20.6 * 20.6)
    * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
    * (f2 + 12200 * 12200)
  );
  const A_dB = 20 * Math.log10(Math.max(1e-12, RA)) + 2.0;
  return Math.pow(10, A_dB / 20);
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmBuffer: AudioBuffer | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicVolume: number = 0.8;
  private effectVolume: number = 0.9;

  private startTime: number = 0;
  private pauseTime: number = 0;
  private isPlaying: boolean = false;
  private userAudioOffset: number = 0;
  private leadInTime: number = 0;
  private synthInterval: number | null = null;
  /** Handle for the one-shot `setTimeout` that defers the first synth tick when
   *  playback starts before the song's true beginning (audio time < 0, i.e. a
   *  negative offset or a seek into negative beats). MUST be cleared whenever
   *  the synth loop is (re)started or stopped — otherwise repeated seeks leave
   *  multiple pending timers, each of which later spawns its own `setInterval`,
   *  and the stacked loops play on top of each other ("叠加播放"). */
  private synthStartTimer: number | null = null;
  private synthBpm: number = 140;
  /** Editor-only playback rate multiplier (0.25x / 0.5x / 1x / 2x). 1 = normal.
   *  Applied directly to the AudioBufferSource (so the pitch shifts with speed —
   *  acceptable for a chart-making aid). The game clock (getCurrentTime) is also
   *  scaled by the same rate so notes scroll in lockstep with the audio. Reset to
   *  1 whenever a real game / play-test / editor-exit starts. */
  private playbackRate: number = 1;

  /** True = use uploaded audio buffer; false = procedural synth */
  private hasUploadedAudio: boolean = false;
  /** True = explicitly told to use synth (demo tracks) */
  private forceSynth: boolean = false;

  /** Hit sound buffers keyed by note type — tap/touch/slide.ogg are loaded
   *  from /sounds/ (build-packaged) in loadBuiltinSounds() during init().
   *  If a file fails to load, preRenderHitSounds() synthesises a reasonable
   *  procedural equivalent so we never fall silent. */
  private hitSoundBuffers: Partial<Record<NoteType, AudioBuffer>> = {};
  /** ui.ogg for DOM button/card clicks. Same load / fallback strategy. */
  private uiSoundBuffer: AudioBuffer | null = null;
  /** Cached FFT output buffer — reused across frames to avoid per-tick allocation. */
  private freqDataBuffer: Uint8Array<ArrayBuffer> | null = null;
  /** Precomputed A-weighting linear gain for each FFT bin. Recomputed only
   *  when the sample rate changes (i.e. at init / on the first analysis). */
  private aWeightLut: Float32Array | null = null;
  /** Frequency-bin count at the last LUT build (used to invalidate the cache). */
  private lastBinCount: number = -1;
  /** Sample rate used for the last LUT build. */
  private lastSampleRate: number = -1;

  // ====== BPM-driven rhythm-pulse state ======================================
  /** Current BPM as supplied by the game loop each frame. Falls back to
   *  synthBpm or 140 if nobody updates it; we never use 0 to avoid divide-by-0. */
  private lastBpm: number = 140;
  /** AudioContext-relative time of the last known beat tick. Infinity means
   *  "not yet synced". We advance this by 60/lastBpm every time a new beat
   *  window fires — it's a soft beat clock, derived purely from the BPM
   *  number the game gives us (no onset detection). */
  private lastBeatTime: number = Infinity;
  /** A-weighted RMS loudness averaged over the *preceding* beat window.
   *  This is the amplitude that drives the current beat's pulse. */
  private lastBeatLoudness: number = 0.1;
  /** Running A-weighted RMS inside the CURRENT beat window (accumulating). */
  private windowSumSq: number = 0;
  /** Sample count for the current beat window. */
  private windowCount: number = 0;
  /** Output beatPulse state — the "节奏扩散" envelope: 0 -> 1 (attack) -> 0 (decay). */
  private beatPulseState: number = 0;
  /** When did the current beat pulse attack start (AudioContext time)? */
  private beatPulseAttackAt: number = -Infinity;

  public init() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.9;
      this.masterGain.connect(this.ctx.destination);

      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = this.musicVolume;
      this.bgmGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.effectVolume;
      this.sfxGain.connect(this.masterGain);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;
      this.bgmGain.connect(this.analyser);
      // Allocate the FFT byte buffer exactly once (matches frequencyBinCount).
      // Wrap in an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>,
      // which is what getByteFrequencyData expects on TS 5.7+.
      this.freqDataBuffer = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

      // Try to load the packaged hit sounds (tap/touch/slide/ui.ogg). If
      // fetch/decode fails (file:// mode, old browser, CORS, etc.), fall back
      // to procedural pre-rendered equivalents so that gameplay never goes
      // silent. Fetch is async; in the rare race where a note lands before
      // the buffers are ready, playHitSound plays the procedural fallback.
      this.loadBuiltinSounds().catch(() => {
        this.preRenderHitSounds();
      });
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** Resume the AudioContext (call after a user gesture on mobile). */
  public async resume(): Promise<void> {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public getActiveBuffer(): AudioBuffer | null {
    return this.bgmBuffer;
  }

  public getMusicVolume(): number {
    return this.musicVolume;
  }

  /** Try to load the 4 packaged hit/ui sounds from /sounds/. Safari/WebKit
   *  cannot decode OGG Vorbis at all, so we try multiple extensions per sound
   *  (ogg → mp3 → m4a) and use whichever the browser can actually decode.
   *  Any sound that still fails to load falls back to preRenderHitSounds(). */
  private async loadBuiltinSounds(): Promise<void> {
    if (!this.ctx) return;
    const base: Array<{ key: NoteType | 'ui'; name: string }> = [
      { key: 'tap',   name: 'tap'   },
      { key: 'touch', name: 'touch' },
      { key: 'slide', name: 'slide' },
      { key: 'ui',    name: 'ui'    },
    ];
    const extensions = ['ogg', 'mp3', 'm4a'];
    await Promise.all(
      base.map(async ({ key, name }) => {
        for (const ext of extensions) {
          const url = `sounds/${name}.${ext}`;
          try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const ab = await res.arrayBuffer();
            const buffer = await this.ctx!.decodeAudioData(ab.slice(0));
            if (key === 'ui') {
              this.uiSoundBuffer = buffer;
            } else {
              this.hitSoundBuffers[key as NoteType] = buffer;
            }
            return; // success for this sound
          } catch {
            // try next extension
          }
        }
      })
    );
    // Fill any slots that failed to load (e.g. running on file:// URLs, or
    // the build didn't copy the folder). Pre-render is synchronous so the
    // slot is usable immediately.
    this.preRenderHitSounds();
  }

  /**
   * Procedural fallback. Renders short hit buffers for any note-type slot
   * that's still empty (tap / touch / slide) plus ui. The character of each
   * sound is tuned to the mechanical identity of the note:
   *   tap   = short hard click (triangle + noise burst, 70ms)
   *   touch = softer sine ping (95ms)
   *   slide = a gentle chirp (sine 480→880 over 140ms)
   *   ui    = a crisp 2-note plink (sine 1240 + 1860 Hz, 65ms)
   * Uses the same OfflineAudioContext optimisation as the old judgement-
   * based implementation — no on-click node building.
   */
  private preRenderHitSounds() {
    const sampleRate = this.ctx?.sampleRate ?? 44100;
    const OAC = window.OfflineAudioContext
      || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OAC) return;

    const render = (
      durationSec: number,
      build: (ctx: OfflineAudioContext, out: GainNode) => void
    ): AudioBuffer | null => {
      try {
        const off = new OAC(1, Math.ceil(sampleRate * durationSec), sampleRate);
        const out = off.createGain();
        out.connect(off.destination);
        build(off, out);
        const buffer = off.startRendering();
        // Synchronous path on prefixed impls — grab it now. If it's a
        // Promise we still return null so the caller uses the live oscillator
        // fallback on the first click; it resolves quickly enough (<50ms)
        // that subsequent clicks will hit the buffer path.
        if (buffer instanceof AudioBuffer) return buffer;
        (buffer as Promise<AudioBuffer>).then(() => {});
        return null;
      } catch {
        return null;
      }
    };

    if (!this.hitSoundBuffers.tap) {
      const b = render(0.09, (ctx, out) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        const n = ctx.createBufferSource();
        o.type = 'triangle';
        o.frequency.setValueAtTime(980, 0);
        o.frequency.exponentialRampToValueAtTime(520, 0.045);
        g.gain.setValueAtTime(0.55, 0);
        g.gain.exponentialRampToValueAtTime(0.001, 0.07);
        const noise = ctx.createBuffer(1, Math.ceil(sampleRate * 0.02), sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        n.buffer = noise;
        const ng = ctx.createGain();
        ng.gain.value = 0.2;
        o.connect(g); n.connect(ng); g.connect(out); ng.connect(out);
        o.start(0); n.start(0); o.stop(0.07); n.stop(0.02);
      });
      if (b) this.hitSoundBuffers.tap = b;
    }
    if (!this.hitSoundBuffers.touch) {
      const b = render(0.11, (ctx, out) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(820, 0);
        o.frequency.exponentialRampToValueAtTime(1100, 0.04);
        g.gain.setValueAtTime(0.45, 0);
        g.gain.exponentialRampToValueAtTime(0.001, 0.09);
        o.connect(g); g.connect(out);
        o.start(0); o.stop(0.09);
      });
      if (b) this.hitSoundBuffers.touch = b;
    }
    if (!this.hitSoundBuffers.slide) {
      const b = render(0.16, (ctx, out) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sawtooth';
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2200, 0);
        filter.frequency.linearRampToValueAtTime(800, 0.12);
        o.frequency.setValueAtTime(480, 0);
        o.frequency.exponentialRampToValueAtTime(880, 0.12);
        g.gain.setValueAtTime(0.3, 0);
        g.gain.exponentialRampToValueAtTime(0.001, 0.14);
        o.connect(filter); filter.connect(g); g.connect(out);
        o.start(0); o.stop(0.14);
      });
      if (b) this.hitSoundBuffers.slide = b;
    }
    if (!this.uiSoundBuffer) {
      const b = render(0.08, (ctx, out) => {
        const o1 = ctx.createOscillator(); const o2 = ctx.createOscillator();
        const g = ctx.createGain();
        o1.type = 'sine'; o1.frequency.value = 1240;
        o2.type = 'sine'; o2.frequency.value = 1860;
        g.gain.setValueAtTime(0.35, 0);
        g.gain.exponentialRampToValueAtTime(0.001, 0.06);
        o1.connect(g); o2.connect(g); g.connect(out);
        o1.start(0); o2.start(0); o1.stop(0.06); o2.stop(0.06);
      });
      if (b) this.uiSoundBuffer = b;
    }
  }

  public setOffset(seconds: number) {
    this.userAudioOffset = seconds;
  }

  /* ===== Time-coordinate contract ===========================================
   * There are exactly TWO time coordinates in this codebase:
   *
   *   audio time — the playback position inside the audio buffer (or synth
   *                loop). Starts at 0 at the first sample. NEVER leaves this
   *                class.
   *   chart time — the clock the chart / notes / editor / HUD live in.
   *                chartTime = audioTime + userAudioOffset.
   *
   * EVERY public method of AudioManager speaks CHART TIME (play, seek,
   * getCurrentTime, pause position). Callers must never add or subtract the
   * offset themselves — the conversion happens here and only here.
   * ------------------------------------------------------------------------ */

  /** chart time -> audio time. NOTE: NOT clamped. The audio time may go
   *  negative (before the buffer's first sample), which just means "the song
   *  hasn't started yet — stay silent". The chart clock (getCurrentTime) must
   *  stay exact and keep reading the real chart time even when it is below the
   *  offset (including negative values during lead-in). The buffer is started
   *  later (at the ctx time when audio time reaches 0, i.e. chart time ==
   *  userAudioOffset) so the two coordinates never desync. */
  private toAudioTime(chartSec: number): number {
    return chartSec - this.userAudioOffset;
  }

  /** audio time -> chart time. */
  private toChartTime(audioSec: number): number {
    return audioSec + this.userAudioOffset;
  }

  /** Live audio-buffer position derived from the AudioContext clock.
   *  `startTime` is the ctx timestamp at which the buffer position was 0. */
  private getAudioTime(): number {
    if (!this.ctx) return 0;
    return (this.ctx.currentTime - this.startTime) * this.playbackRate;
  }

  public getLeadInTime(): number {
    return this.leadInTime;
  }

  public setMusicVolume(value: number) {
    this.musicVolume = Math.max(0, Math.min(1, value));
    if (this.bgmGain && this.ctx) {
      this.bgmGain.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.015);
    }
  }

  public setEffectVolume(value: number) {
    this.effectVolume = Math.max(0, Math.min(1, value));
    if (this.sfxGain && this.ctx) {
      this.sfxGain.gain.setTargetAtTime(this.effectVolume, this.ctx.currentTime, 0.015);
    }
  }

  /** Load an uploaded audio file. Clears forceSynth flag so play() uses the buffer. */
  public async loadAudioFile(file: File): Promise<AudioBuffer> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext failed to initialize');
    const arrayBuffer = await file.arrayBuffer();
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      // Safari/WebKit cannot decode OGG Vorbis at all — surface a clear,
      // actionable error instead of a cryptic decode failure.
      const isOgg = /\.ogg$/i.test(file.name);
      const hint = isOgg
        ? ' (Safari 不支持 OGG 格式，请改用 MP3 / M4A)'
        : ' (格式可能不被当前浏览器支持)';
      throw new Error(`无法解码音频文件「${file.name}」${hint}`);
    }
    this.bgmBuffer = audioBuffer;
    this.hasUploadedAudio = true;
    this.forceSynth = false;
    return audioBuffer;
  }

  /** Load audio from a URL (e.g. /beatmaps/...mp3). Returns the decoded buffer.
   *  Sets it as the active BGM buffer if `setActive` is true. */
  public async loadAudioURL(url: string, setActive = true): Promise<AudioBuffer> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext failed to initialize');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    const arrayBuffer = await res.arrayBuffer();
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      const isOgg = /\.ogg(\?|$)/i.test(url);
      const hint = isOgg
        ? ' (Safari 不支持 OGG 格式，请改用 MP3 / M4A)'
        : ' (格式可能不被当前浏览器支持)';
      throw new Error(`无法解码音频: ${url}${hint}`);
    }
    if (setActive) {
      this.bgmBuffer = audioBuffer;
      this.hasUploadedAudio = true;
      this.forceSynth = false;
    }
    return audioBuffer;
  }

  /** Mark this session as using the procedural synth (demo tracks). */
  public setSynthesizedTrack(bpm: number) {
    this.init();
    this.forceSynth = true;
    this.synthBpm = bpm;
  }

  /** Decide what to play: uploaded audio takes priority unless forceSynth is set.
   *  @param startChartSec - CHART-TIME position to start at (seconds). The
   *                     offset conversion is done internally; callers pass the
   *                     same coordinate getCurrentTime() returns.
   *  @param leadInSec - extra lead-in time before the start position. When > 0,
   *                     the audio is delayed by leadInSec so that the first note
   *                     arrives at least leadInSec seconds after play() is called.
   *                     Game time advances normally from the start (going negative
   *                     during the lead-in period) so note motion is smooth.
   *                     Only affects this play() call.
   */
  public play(startChartSec = 0, leadInSec = 0) {
    this.init();
    if (!this.ctx) return;
    this.stop();

    this.leadInTime = leadInSec;
    /* Convert once, here. `audioStartSec` is the buffer position that
     * corresponds to `startChartSec` (may be negative — the song hasn't begun
     * yet). `startTime` anchors the chart clock so getCurrentTime() reads the
     * exact chart time, even below the offset (negative during lead-in).
     * The buffer itself is started separately, at the ctx time when audio time
     * reaches 0 (chart time == userAudioOffset), with offset 0. */
    const audioStartSec = this.toAudioTime(startChartSec);
    this.startTime = this.ctx.currentTime - audioStartSec / this.playbackRate + leadInSec;
    this.isPlaying = true;

    // Reset the beat-driven rhythm state. A new play call means a new chart
    // (or at least a new lead-in), so any cached beat window from the
    // previous session would be stale (and cause the pulse to jump wildly
    // on the first frame of playback). lastBeatTime == Infinity triggers
    // the first-tick anchor inside getAudioFrequencyData.
    this.lastBeatTime = Infinity;
    this.lastBeatLoudness = 0.1;
    this.windowSumSq = 0;
    this.windowCount = 0;
    this.beatPulseState = 0;
    this.beatPulseAttackAt = -Infinity;

    const useBuffer = this.hasUploadedAudio && !this.forceSynth && this.bgmBuffer;
    // The ctx time at which audio time reaches 0 (chart time == offset). The
    // buffer begins its true start there (offset 0); before that the chart
    // clock keeps advancing but no audio plays.
    const baseStart = this.ctx.currentTime + leadInSec - audioStartSec / this.playbackRate;

    if (useBuffer && this.bgmBuffer && this.bgmGain) {
      /* Plain rate change: apply playbackRate directly to the source. The pitch
       * shifts with speed (acceptable for an editor chart-making aid). The game
       * clock is scaled by the same rate so notes scroll in lockstep with audio.
       * If the song hasn't started yet (baseStart still in the future) we begin
       * it at offset 0 when the chart clock reaches the offset; otherwise we're
       * seeking into the middle and start now at the correct offset. */
      this.bgmSource = this.ctx.createBufferSource();
      this.bgmSource.buffer = this.bgmBuffer;
      this.bgmSource.playbackRate.value = this.playbackRate;
      this.bgmSource.connect(this.bgmGain);
      if (baseStart >= this.ctx.currentTime) {
        this.bgmSource.start(baseStart, 0);
      } else {
        this.bgmSource.start(this.ctx.currentTime, audioStartSec);
      }
    } else {
      /* The synthesizer is a setInterval-based loop. We delay its first tick
       * until the chart clock reaches the offset (audio time 0), so synth audio
       * begins in lockstep with the buffer path — including during lead-in when
       * the offset is negative (song starts partway) or positive (silence until
       * the offset). */
      this.startSynthesizedMusic(audioStartSec, leadInSec);
    }
  }

  public pause() {
    if (!this.isPlaying) return;
    this.pauseTime = this.getCurrentTime();
    this.stop();
  }

  /** Fade out audio over `duration` seconds, then stop.
   *  Respects the user's music volume setting — fades from current volume to 0. */
  public fadeOutAndStop(duration = 1.0) {
    if (!this.isPlaying) return;
    if (!this.ctx || !this.bgmGain) {
      this.stop();
      return;
    }
    const now = this.ctx.currentTime;
    // Fade to 0 over duration seconds
    this.bgmGain.gain.cancelScheduledValues(now);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, now);
    this.bgmGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    // Stop the source after fade completes
    const stopTime = now + duration + 0.05;
    if (this.bgmSource) {
      try {
        this.bgmSource.stop(stopTime);
      } catch {}
    }
    if (this.synthInterval || this.synthStartTimer) {
      window.setTimeout(() => {
        if (this.synthInterval) {
          window.clearInterval(this.synthInterval);
          this.synthInterval = null;
        }
        if (this.synthStartTimer) {
          window.clearTimeout(this.synthStartTimer);
          this.synthStartTimer = null;
        }
      }, duration * 1000);
    }
    // NOTE: intentionally do NOT set this.isPlaying = false here. Doing so would
    // make getCurrentTime() fall back to the stale pauseTime, freezing the game
    // clock (and thus the canvas particles) for the whole post-song-end window.
    // Playback truly ends when bgmSource.stop() fires; isPlaying is reset by the
    // stop() call in the song-end sequence (App.handleSongEnd).

    // Restore music volume setting (but not the gain — it'll be re-applied on next play)
    window.setTimeout(() => {
      if (this.bgmGain && this.ctx) {
        this.bgmGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.bgmGain.gain.value = this.musicVolume;
      }
    }, duration * 1000 + 100);
  }

  public stop() {
    this.isPlaying = false;
    if (this.bgmSource) {
      try { this.bgmSource.stop(); this.bgmSource.disconnect(); } catch {}
      this.bgmSource = null;
    }
    if (this.synthInterval) {
      window.clearInterval(this.synthInterval);
      this.synthInterval = null;
    }
    if (this.synthStartTimer) {
      window.clearTimeout(this.synthStartTimer);
      this.synthStartTimer = null;
    }
  }

  /** In-place position jump while staying in the playing state — no stop/play
   *  cycle, no lead-in delay, no audible gap on buffer audio. Designed for
   *  editor scrubbing and timeline seeks. The game clock is adjusted so
   *  getCurrentTime() reads `targetChartSec` immediately after the call.
   *
   *  @param targetChartSec CHART-TIME target (same coordinate as
   *         getCurrentTime()); the offset conversion happens internally.
   *
   *  - Buffer audio: stop the current source and start a new one from the
   *    matching audio position, reusing the existing gain node so there's no
   *    volume jump.
   *  - Synthesised audio: clear the interval, recalculate the step, and restart
   *    the tick loop. */
  public seek(targetChartSec: number) {
    if (!this.isPlaying || !this.ctx) return;
    const useBuffer = this.hasUploadedAudio && !this.forceSynth && this.bgmBuffer;

    // Single conversion point: chart time in, audio time used everywhere below.
    // The audio time may be negative (the song hasn't begun yet); the chart
    // clock is anchored so getCurrentTime() reads the exact target immediately.
    const audioTarget = this.toAudioTime(targetChartSec);
    this.startTime = this.ctx.currentTime - audioTarget / this.playbackRate;

    if (useBuffer && this.bgmBuffer && this.bgmGain) {
      // Stop old source, start new one. If the target is before the song's true
      // start (audioTarget < 0) the buffer begins silently at offset 0 when the
      // audio time reaches 0 (a future ctx time); otherwise start now at the
      // exact offset.
      if (this.bgmSource) {
        try { this.bgmSource.stop(); this.bgmSource.disconnect(); } catch {}
        this.bgmSource = null;
      }
      const when = audioTarget >= 0
        ? this.ctx.currentTime
        : this.ctx.currentTime + (-audioTarget) / this.playbackRate;
      const offset = Math.max(0, audioTarget);
      this.bgmSource = this.ctx.createBufferSource();
      this.bgmSource.buffer = this.bgmBuffer;
      this.bgmSource.playbackRate.value = this.playbackRate;
      this.bgmSource.connect(this.bgmGain);
      this.bgmSource.start(when, offset);
    } else {
      // Synthesised: restart the interval loop from the matching step, but
      // defer the first tick (silent) until the audio time reaches 0 if the
      // target is before the song's true beginning.
      if (this.synthInterval) {
        window.clearInterval(this.synthInterval);
        this.synthInterval = null;
      }
      if (this.synthStartTimer) {
        window.clearTimeout(this.synthStartTimer);
        this.synthStartTimer = null;
      }
      const beatInterval = 60 / this.synthBpm;
      let step = Math.max(0, Math.floor(audioTarget / (beatInterval / 4)));
      const delayMs = audioTarget < 0 ? (-audioTarget) / this.playbackRate * 1000 : 0;
      const chords = [
        [220, 277.18, 329.63, 440],
        [174.61, 220, 261.63, 349.23],
        [261.63, 329.63, 392, 523.25],
        [196, 246.94, 293.66, 392],
      ];
      const tick = () => {
        if (!this.isPlaying || !this.ctx || !this.bgmGain) return;
        const now = this.ctx.currentTime;
        const beat16 = step % 16;
        const bar = Math.floor(step / 16) % chords.length;
        const chord = chords[bar];
        if (beat16 % 4 === 0) {
          const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
          o.type = 'sine'; o.frequency.setValueAtTime(140, now); o.frequency.exponentialRampToValueAtTime(35, now + 0.08);
          g.gain.setValueAtTime(0.8, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.12);
        }
        if (beat16 === 4 || beat16 === 12) {
          const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
          o.type = 'triangle'; o.frequency.setValueAtTime(240, now); o.frequency.exponentialRampToValueAtTime(80, now + 0.09);
          g.gain.setValueAtTime(0.5, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
          o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.1);
        }
        if (beat16 % 2 === 1) {
          const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
          o.type = 'triangle'; o.frequency.setValueAtTime(3000, now);
          g.gain.setValueAtTime(0.15, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
          o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.04);
        }
        const arpNote = chord[beat16 % chord.length];
        const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
        o.type = (beat16 % 4 === 0) ? 'sawtooth' : 'sine';
        o.frequency.setValueAtTime(arpNote, now);
        g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now + beatInterval * 0.35);
        o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + beatInterval * 0.35);
        step++;
      };
      if (delayMs > 0) {
        this.synthStartTimer = window.setTimeout(() => {
          this.synthStartTimer = null;
          if (!this.isPlaying) return;
          tick();
          this.synthInterval = window.setInterval(tick, (beatInterval / 4) * 1000);
        }, delayMs);
      } else {
        tick();
        this.synthInterval = window.setInterval(tick, (beatInterval / 4) * 1000);
      }
    }
  }

  /** The chart clock — the single time source for notes, HUD and the editor.
   *  Scaled by the editor playback rate R so that when the music is slowed to
   *  0.5x the chart scrolls at half speed too, in lockstep with the
   *  (pitch-shifted) audio. `pauseTime` is stored in the same coordinate, so a
   *  paused clock can be fed straight back into play()/seek(). */
  public getCurrentTime(): number {
    if (!this.isPlaying || !this.ctx) return this.pauseTime;
    return this.toChartTime(this.getAudioTime());
  }

  /** Set the editor playback rate (0.25 / 0.5 / 1 / 2). The rate is applied
   *  directly to the running AudioBufferSource (so the pitch shifts with speed),
   *  and the game clock is re-anchored so the current gameTime stays continuous
   *  across the speed change. When not playing, the rate is just stored and
   *  applied on the next play(). */
  public setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.05, Math.min(4, rate));
    if (!this.isPlaying || !this.ctx) {
      this.playbackRate = clamped;
      return;
    }
    // Preserve the current position across the rate switch by re-anchoring
    // startTime. The offset plays no part here: it is a constant shift between
    // the two coordinates, so preserving audio time preserves chart time too.
    const audioTime = this.getAudioTime();
    this.playbackRate = clamped;
    this.startTime = this.ctx.currentTime - audioTime / this.playbackRate;
    // Update the running source's rate in place (pitch shifts with speed).
    if (this.bgmSource) {
      this.bgmSource.playbackRate.value = clamped;
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  // ====== New beat-driven visual light system =================================

  /** Feed the currently active BPM to the audio rhythm clock. Call this on
   *  every frame from the game loop BEFORE getAudioFrequencyData(). The
   *  BPM-driven pulse ignores onset detection and instead ticks a soft beat
   *  clock using `60/bpm` seconds per beat. This is far more stable on
   *  complex orchestral scores (noisy bass, no clear kick) than the old
   *  naive bass-magnitude average.
   *
   *  `bpmAtBeat` comes from the chart's bpmlist (use `getBpmAtBeat` helper in
   *  beatTime.ts), so BPM shifts (e.g. a 60bpm slow-down bridge) are tracked
   *  by the pulse window as well.
   */
  public setCurrentBpm(bpmAtBeat: number): void {
    // Clamp to sane audio values so beat period is never 0 / Inf.
    const safe = Math.max(30, Math.min(400, Number.isFinite(bpmAtBeat) ? bpmAtBeat : 140));
    this.lastBpm = safe;
  }

  /** (Re)build the A-weighting lookup table keyed by bin index. Only runs
   *  when the bin count or sample rate changes (≈once per app lifetime). */
  private rebuildAWeightLut() {
    if (!this.ctx || !this.analyser) return;
    const sr = this.ctx.sampleRate;
    const binCount = this.analyser.frequencyBinCount;
    if (this.aWeightLut && binCount === this.lastBinCount && sr === this.lastSampleRate) return;
    this.aWeightLut = new Float32Array(binCount);
    const binHz = sr / (this.analyser.fftSize || 64);
    for (let i = 0; i < binCount; i++) {
      this.aWeightLut[i] = aWeightingLinearGain(i * binHz);
    }
    this.lastBinCount = binCount;
    this.lastSampleRate = sr;
  }

  /** Single-frame A-weighted RMS loudness from the AnalyserNode byte data.
   *  getByteFrequencyData gives 0..255 → linear magnitude. Divide by 255 to
   *  [0,1], A-weight, then RMS. This value represents ~23ms of audio (the
   *  AnalyserNode fftSize=64 window) and will feed the per-beat rolling mean
   *  inside getAudioFrequencyData. */
  private computeAWeightedRmsInstant(): number {
    if (!this.analyser || !this.freqDataBuffer) return 0;
    this.rebuildAWeightLut();
    if (!this.aWeightLut) return 0;
    this.analyser.getByteFrequencyData(this.freqDataBuffer);
    const data = this.freqDataBuffer;
    const len = data.length;
    const lut = this.aWeightLut;
    let sumSq = 0;
    let wSum = 0;
    for (let i = 0; i < len; i++) {
      const w = lut[i];
      if (w <= 0) continue;
      const lin = data[i] / 255;
      // A-weight in amplitude domain → squared magnitude scales by w^2
      const v = lin * w;
      sumSq += v * v;
      wSum += w * w;
    }
    if (wSum < 1e-9) return 0;
    return Math.sqrt(sumSq / wSum);
  }

  /** Output signature. `beatPulse` is the tempo-aligned visual envelope
   *  (0→1→0, attack=12ms, decay across the remaining 0.75*beat) that replaces
   *  the old bass-only glow. `loudness` is the A-weighted RMS averaged over
   *  the PREVIOUS beat window (it drives how bright the pulse looks). The
   *  `bass`/`mid`/`treble`/`overall` fields are preserved for backwards
   *  compatibility but are recomputed from the A-weighted RMS so that any
   *  remaining consumers behave consistently.
   */
  public getAudioFrequencyData(): {
    bass: number;
    mid: number;
    treble: number;
    overall: number;
    loudness: number;
    beatPulse: number;
  } {
    const fallback = { bass: 0.1, mid: 0.1, treble: 0.1, overall: 0.1, loudness: 0.1, beatPulse: 0 };
    if (!this.analyser || !this.freqDataBuffer || !this.ctx) return fallback;

    const now = this.ctx.currentTime;

    // ---- 1. Per-frame A-weighted RMS --------------------------------------------------------
    const rmsInstant = this.computeAWeightedRmsInstant();

    // ---- 2. Tick the soft beat clock. -------------------------------------------------------
    const beatPeriodSec = 60 / Math.max(30, this.lastBpm || 140);
    if (!isFinite(this.lastBeatTime) || this.lastBeatTime === Infinity) {
      // First tick — anchor to now; next beat starts immediately.
      this.lastBeatTime = now;
      this.windowSumSq = 0;
      this.windowCount = 0;
    }

    // Fire one or more beat windows if we've crossed beat boundaries.
    // Usually it's exactly 1, but if the caller paused then resumed we can
    // jump multiple; this avoids the pulse stalling when it resumes late.
    while (now - this.lastBeatTime >= beatPeriodSec) {
      // Compute per-beat mean RMS from the window.
      if (this.windowCount > 0) {
        const meanRms = Math.sqrt(this.windowSumSq / this.windowCount);
        // LPF so a single quiet/loud beat doesn't cause a jumpy pulse.
        this.lastBeatLoudness = 0.65 * this.lastBeatLoudness + 0.35 * Math.min(1, meanRms * 2.2);
      }
      // Fire the pulse: instant attack → amplitude = lastBeatLoudness.
      this.beatPulseAttackAt = this.lastBeatTime + beatPeriodSec;
      this.beatPulseState = this.lastBeatLoudness;
      // Advance window: rolling 70% carry-over so the new beat inherits
      // some context. Pure reset would read 0 for the entire first 1/60s of
      // a beat (≈first 3 frames) and make the attack look jittery.
      this.windowSumSq = this.windowCount > 0 ? this.windowSumSq * 0.3 : 0;
      this.windowCount = this.windowCount > 0 ? Math.round(this.windowCount * 0.3) : 0;
      this.lastBeatTime += beatPeriodSec;
    }

    // ---- 3. Accumulate into the current beat window ----------------------------------------
    const v = rmsInstant;
    this.windowSumSq += v * v;
    this.windowCount += 1;

    // ---- 4. Compute the tempo-aligned pulse envelope ---------------------------------------
    // Attack phase = fast ramp (0 → 1 over 12ms)
    // Decay phase  = exponential drop toward 0 over the beat remainder,
    //                tuned so it settles at ~5% amplitude by the NEXT beat
    //                (≈ 0.75 * beatPeriodSec).
    const ATTACK_MS = 0.012;
    const tSinceAttack = Math.max(0, now - this.beatPulseAttackAt);
    let pulse = 0;
    if (tSinceAttack < ATTACK_MS) {
      pulse = this.beatPulseState * (tSinceAttack / ATTACK_MS);
    } else {
      // Decay coefficient chosen such that exp(-DECAY * beatPeriodSec) ≈ 0.05.
      // ⇒ DECAY ≈ ln(20) / beatPeriodSec ≈ 3 / beatPeriodSec.
      const decayPerSec = 3 / beatPeriodSec;
      const tDecay = tSinceAttack - ATTACK_MS;
      pulse = this.beatPulseState * Math.exp(-decayPerSec * tDecay);
    }
    // Hard-clamp (exponential numerics could drift tiny negatives).
    const beatPulse = Math.max(0, Math.min(1, pulse));
    // Loudness for the current visual frame: blend last beat's value with a
    // hint of the instant RMS so build-up crescendos show up slightly
    // before the next beat fires.
    const loudness = Math.min(1, this.lastBeatLoudness * 0.8 + Math.min(1, rmsInstant * 2.2) * 0.2);

    // ---- 5. Backwards-compat: synthesize bass/mid/treble from RMS --------------------------------
    // Old bass/mid/treble bins are no longer the signal, but some legacy
    // consumers still read them. Use A-weight bands: bass weight biased low
    // (~bins 0-4 even though A-weight suppresses them), mid on actual speech
    // region, treble on the rest. Scaled to the same output range as the old
    // function (≈bass×1.4, mid×1.3, treble×1.2) so HUDs don't change character.
    if (!this.aWeightLut) {
      return { bass: 0.1, mid: 0.1, treble: 0.1, overall: loudness, loudness, beatPulse };
    }
    const data = this.freqDataBuffer;
    const len = data.length;
    const lut = this.aWeightLut;
    let b = 0, bW = 0, m = 0, mW = 0, t = 0, tW = 0;
    const splitMid = Math.min(len, Math.max(4, Math.ceil(len * 0.5)));
    for (let i = 0; i < len; i++) {
      const w = lut[i];
      if (w <= 0) continue;
      const lin = (data[i] / 255) * w;
      if (i < 4) { b += lin * lin; bW += w; }
      else if (i < splitMid) { m += lin * lin; mW += w; }
      else { t += lin * lin; tW += w; }
    }
    const bassOut = Math.min(1, Math.sqrt(b / Math.max(1e-9, bW)) * 1.4);
    const midOut = Math.min(1, Math.sqrt(m / Math.max(1e-9, mW)) * 1.3);
    const trebleOut = Math.min(1, Math.sqrt(t / Math.max(1e-9, tW)) * 1.2);
    const overallOut = Math.min(1, (bassOut * 0.5 + midOut * 0.3 + trebleOut * 0.2));

    return {
      bass: bassOut,
      mid: midOut,
      treble: trebleOut,
      overall: overallOut,
      loudness,
      beatPulse,
    };
  }

  /** Play the note-type-specific hit sound.
   *  type: NoteType ('tap' | 'touch' | 'slide') — maps to tap.ogg / touch.ogg
   *  / slide.ogg respectively. Notes with a Miss judgement are simply NOT
   *  played by the caller (GameCanvas), so this function does not need a
   *  "silent" branch. The sound is keyed by the MECHANICAL identity of the
   *  note, not by the judgement accuracy — this is the requested behaviour.
   */
  public playHitSound(type: NoteType) {
    // Guarantee ctx + SFX graph exist. During the editor or a preview-then-
    // real-play flow the graph might not have been built yet, so this ensures
    // we never silently drop a hit because the lazy init hasn't fired.
    this.init();
    if (!this.ctx || !this.sfxGain) return;
    const buffer = this.hitSoundBuffers[type];
    if (buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.sfxGain);
      src.start();
      return;
    }
    // Last-resort fallback if both URL load and OfflineAudioContext failed.
    // Builds a tiny per-click graph — very rare path.
    const now = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.sfxGain);
    const o = this.ctx.createOscillator();
    if (type === 'tap') {
      o.type = 'triangle';
      o.frequency.setValueAtTime(980, now);
      o.frequency.exponentialRampToValueAtTime(520, now + 0.045);
      g.gain.setValueAtTime(0.55, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    } else if (type === 'touch') {
      o.type = 'sine';
      o.frequency.setValueAtTime(820, now);
      o.frequency.exponentialRampToValueAtTime(1100, now + 0.04);
      g.gain.setValueAtTime(0.45, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    } else { // slide
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(480, now);
      o.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      g.gain.setValueAtTime(0.3, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    }
    o.connect(g);
    o.start(now);
    o.stop(now + 0.16);
  }

  /** Play ui.ogg for DOM button/card interactions. */
  public playUiSound() {
    // Init must run inside a user gesture in order for AudioContext.resume()
    // to succeed (Chrome/FF/Safari autoplay policy). Callers always invoke
    // from a click/pointer handler, so creating the ctx here is safe and
    // fixes the "no UI sound until a song is selected" problem.
    this.init();
    if (!this.ctx || !this.sfxGain) return;
    if (this.uiSoundBuffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.uiSoundBuffer;
      src.connect(this.sfxGain);
      src.start();
      return;
    }
    // Fallback
    const now = this.ctx.currentTime;
    const o1 = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o1.type = 'sine'; o1.frequency.value = 1240;
    o2.type = 'sine'; o2.frequency.value = 1860;
    g.gain.setValueAtTime(0.35, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    o1.connect(g); o2.connect(g); g.connect(this.sfxGain);
    o1.start(now); o2.start(now); o1.stop(now + 0.06); o2.stop(now + 0.06);
  }

  private startSynthesizedMusic(startOffset: number, leadInSec = 0) {
    if (!this.ctx || !this.bgmGain) return;
    // Defensive: cancel any still-pending synth start timer (e.g. from a
    // previous play/seek) so we never end up with two stacked loops. stop()
    // also clears these, but this guards the play()->this path directly.
    if (this.synthInterval) {
      window.clearInterval(this.synthInterval);
      this.synthInterval = null;
    }
    if (this.synthStartTimer) {
      window.clearTimeout(this.synthStartTimer);
      this.synthStartTimer = null;
    }
    const rate = this.playbackRate;
    const beatInterval = 60 / this.synthBpm;
    // Clamp the starting step at 0 so a negative offset (song hasn't begun) just
    // starts from the beginning rather than ticking at a negative step.
    let step = Math.max(0, Math.floor(startOffset / (beatInterval / 4)));
    // The ctx time at which the audio time reaches 0 (chart time == offset).
    // Defer the first tick until then so the synth stays silent during lead-in
    // when appropriate (positive offset) or begins mid-song only once audio
    // time is non-negative (negative offset) — exactly like the buffer path.
    const baseStart = this.ctx.currentTime + leadInSec - startOffset / rate;
    const delayMs = Math.max(0, (baseStart - this.ctx.currentTime) * 1000);
    const intervalMs = (beatInterval / 4) * 1000;
    const chords = [
      [220, 277.18, 329.63, 440],
      [174.61, 220, 261.63, 349.23],
      [261.63, 329.63, 392, 523.25],
      [196, 246.94, 293.66, 392],
    ];
    const tick = () => {
      if (!this.isPlaying || !this.ctx || !this.bgmGain) return;
      const now = this.ctx.currentTime;
      const beat16 = step % 16;
      const bar = Math.floor(step / 16) % chords.length;
      const chord = chords[bar];
      if (beat16 % 4 === 0) {
        const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(140, now); o.frequency.exponentialRampToValueAtTime(35, now + 0.08);
        g.gain.setValueAtTime(0.8, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.12);
      }
      if (beat16 === 4 || beat16 === 12) {
        const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(240, now); o.frequency.exponentialRampToValueAtTime(80, now + 0.09);
        g.gain.setValueAtTime(0.5, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.1);
      }
      if (beat16 % 2 === 1) {
        const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(3000, now);
        g.gain.setValueAtTime(0.15, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + 0.04);
      }
      const arpNote = chord[beat16 % chord.length];
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
      o.type = (beat16 % 4 === 0) ? 'sawtooth' : 'sine';
      o.frequency.setValueAtTime(arpNote, now);
      g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now + beatInterval * 0.35);
      o.connect(g); g.connect(this.bgmGain); o.start(now); o.stop(now + beatInterval * 0.35);
      step++;
    };
    if (delayMs > 0) {
      this.synthStartTimer = window.setTimeout(() => {
        this.synthStartTimer = null;
        if (!this.isPlaying) return;
        tick(); // first note
        this.synthInterval = window.setInterval(tick, intervalMs);
      }, delayMs);
    } else {
      tick();
      this.synthInterval = window.setInterval(tick, intervalMs);
    }
  }
}

export const globalAudio = new AudioManager();
