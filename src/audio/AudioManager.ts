import { NoteType } from '../types/game';
import { clamp } from '../utils/math';
import { readBodyWithProgress } from '../utils/bodyProgress';

/** 加载阶段上报：下载中（含已下/总长）或解码中。供 UI 显示
 *  「音频 42%」/「解码中」，避免网络慢时只有一个笼统的「加载中」。 */
export type AudioLoadPhase =
  | { phase: 'download'; loaded: number; total: number }
  | { phase: 'decode' };

export class AudioManager {
  private ctx: AudioContext | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmBuffer: AudioBuffer | null = null;
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
  // ====== 兼容模式（音频跟随谱面）=====
  // 背景：HarmonyOS ArkWeb 上 AudioContext.currentTime 可能停滞（音频输出停摆）
  // 但 rAF/渲染仍走。原架构谱面时钟完全绑定 ctx.currentTime，音频一停谱面跟着停。
  // 兼容模式把谱面时钟切到 performance.now() 锚定的墙钟，音频 buffer 仍由音频
  // 时钟驱动；App 周期检测偏差，超阈值时仅重建 buffer（nudgeAudio）让音频追谱面。
  // chartWallMs = 墙钟上 audio time 0 的时刻（play/seek/setPlaybackRate 重锚）。
  private compatMode: boolean = false;
  private chartWallMs: number = 0;
  /** 开启/关闭兼容模式（外部设置项驱动）。 */
  public setCompatMode(enabled: boolean): void {
    this.compatMode = enabled;
  }
  public isCompatMode(): boolean {
    return this.compatMode;
  }
  private synthInterval: number | null = null;
  /** Handle for the one-shot `setTimeout` that defers the first synth tick when
   *  playback starts before the song's true beginning (audio time < 0, i.e. a
   *  negative offset or a seek into negative beats). MUST be cleared whenever
   *  the synth loop is (re)started or stopped — otherwise repeated seeks leave
   *  multiple pending timers, each of which later spawns its own `setInterval`,
   *  and the stacked loops play on top of each other ("叠加播放"). */
  private synthStartTimer: number | null = null;
  // ====== Lookahead 合成调度（替代 setInterval 驱动）=====
  // 原 setInterval 驱动在主线程上逐 tick 创建 Oscillator：主线程一旦被触摸等
  // 重活阻塞，音符就停 + 累积，且 setInterval 的墙钟步进与 AudioContext 时钟
  // 脱钩（停顿后音频位置与谱面错位）。Lookahead 调度用 osc.start(ctxTime)
  // 把未来 ~0.25s 的音符预先排布到 AudioContext 硬件时钟上——已调度的音符由
  // 音频线程按时触发，主线程短暂阻塞不再中断音频，也不会产生位置错位。
  /** 下一个待排步的 step 序号（与音符模式 beat16/bar 对应）。 */
  private synthNextStep: number = 0;
  /** 下一个待排步在 AudioContext 时钟上的触发时间。 */
  private synthNextTime: number = 0;
  /** 相邻 step 在 AudioContext 时钟上的间隔（秒），= beatInterval/4。 */
  private synthStepInterval: number = 0;
  /** 已调度、尚未播完的 Oscillator 节点（stop/seek 时取消）。 */
  private synthPending: AudioScheduledSourceNode[] = [];
  /** Lookahead 定时器（递归 setTimeout，~100ms 检查一次）。 */
  private synthLookaheadTimer: number | null = null;
  /** 提前调度窗口（秒）。主线程阻塞短于该值时不中断音频（覆盖常见触摸/GC 停顿）。 */
  private static readonly SYNTH_LOOKAHEAD_SEC = 0.5;
  /** Lookahead 检查周期（毫秒）。 */
  private static readonly SYNTH_LOOKAHEAD_MS = 100;
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
  /** 单调递增的加载令牌，用于丢弃过期的音频加载结果（避免切到合成器后旧缓冲仍被应用） */
  private loadToken: number = 0;
  /** 已解码 AudioBuffer 的 URL 缓存（P1-3）。解码结果体积大，复用避免同一谱面往返重复解码；
   *  仅按 URL 作键，文件上传走一次性路径不进缓存。上限防止长会话/多谱面累积。
   *  注意：AudioBuffer 无 close() 方法，淘汰时只需从 Map 移除引用交由 GC 回收。 */
  private bufferCache = new Map<string, AudioBuffer>();
  private static readonly BUFFER_CACHE_MAX = 4;
  /** 当前活动 BGM 缓冲（bgmBuffer）对应的音频 URL。null = 合成器曲目 / 上传文件 /
   *  尚未加载。调用方（如选歌界面）用它判断"活动缓冲是否就是目标曲目"，
   *  避免上一首残留的缓冲被误认为已就绪。 */
  private activeUrl: string | null = null;

  /** Hit sound buffers keyed by note type — tap/touch/slide.ogg are loaded
   *  from /sounds/ (build-packaged) in loadBuiltinSounds() during init().
   *  If a file fails to load, preRenderHitSounds() synthesises a reasonable
   *  procedural equivalent so we never fall silent. */
  private hitSoundBuffers: Partial<Record<NoteType, AudioBuffer>> = {};
  /** ui.ogg for DOM button/card clicks. Same load / fallback strategy. */
  private uiSoundBuffer: AudioBuffer | null = null;

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

  /** 当前活动 BGM 缓冲对应的 URL；null = 合成器 / 上传文件 / 未加载。 */
  public getActiveURL(): string | null {
    return this.activeUrl;
  }

  /** True when playback uses a real decoded audio file rather than the built-in
   *  procedural synthesizer — i.e. exactly the case in which there IS sample
   *  data to draw (the editor's waveform overlay keys off this). Mirrors the
   *  `useBuffer` test used by play()/seek() so the two can never disagree. */
  public isUsingRealAudio(): boolean {
    return !!(this.hasUploadedAudio && !this.forceSynth && this.bgmBuffer);
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
   *                chartTime = audioTime + userAudioOffset * playbackRate.
   *
   *  The offset is scaled by playbackRate because it compensates for OUTPUT
   *  LATENCY (Bluetooth etc.), a REAL-TIME delay L. Since the chart clock runs
   *  at `playbackRate` relative to wall time, a real delay L is L*rate chart
   *  seconds. Without this scaling the compensation is only correct at rate 1
   *  and audio drifts vs. the chart at other speeds. See toAudioTime below.
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
   *  userAudioOffset * playbackRate) so the two coordinates never desync.
   *
   *  The user offset compensates OUTPUT LATENCY (a real-time delay). Because the
   *  chart clock runs at `playbackRate`, that real delay must be expressed as
   *  `userAudioOffset * playbackRate` chart seconds — otherwise the compensation
   *  is only correct at rate 1 and audio drifts vs. the chart at other speeds. */
  private toAudioTime(chartSec: number): number {
    return chartSec - this.userAudioOffset * this.playbackRate;
  }

  /** audio time -> chart time. Mirrors toAudioTime (offset scaled by rate). */
  private toChartTime(audioSec: number): number {
    return audioSec + this.userAudioOffset * this.playbackRate;
  }

  /** 兼容模式下的墙钟秒数（audio-time 坐标）：不依赖 ctx.currentTime，不受
   *  AudioContext 时钟停滞影响。`chartWallMs` 为 audio time 0 对应的墙钟时刻。 */
  private wallClockSec(): number {
    return ((performance.now() - this.chartWallMs) / 1000) * this.playbackRate;
  }

  /** Live audio-buffer position derived from the AudioContext clock.
   *  `startTime` is the ctx timestamp at which the buffer position was 0.
   *  兼容模式下改用墙钟（谱面不被音频时钟拖累），非兼容模式保持原逻辑。 */
  private getAudioTime(): number {
    if (this.compatMode) return this.wallClockSec();
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
  public async loadAudioFile(file: File): Promise<void> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext failed to initialize');
    const token = ++this.loadToken;
    const arrayBuffer = await file.arrayBuffer();
    // 若期间已切换到其它音频或合成器曲目，丢弃本次结果，避免旧缓冲覆盖新曲目
    if (token !== this.loadToken) return;
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
      throw new Error('无法解码音频文件「' + file.name + '」' + hint);
    }
    if (token !== this.loadToken) return;
    this.bgmBuffer = audioBuffer;
    this.hasUploadedAudio = true;
    this.forceSynth = false;
    this.activeUrl = null; // 上传文件不走 URL 缓存，活动缓冲不再是任何 URL 的产物
  }

  /** Load audio from a URL (e.g. /beatmaps/...mp3). Sets it as the active BGM
   *  buffer if `setActive` is true. `onPhase` reports download progress and the
   *  start of decoding so the caller can show a stage label. */
  public async loadAudioURL(
    url: string,
    setActive = true,
    onPhase?: (p: AudioLoadPhase) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext failed to initialize');
    // 命中 URL 缓存：直接复用已解码缓冲，避免重复 fetch + decodeAudioData。
    const cached = this.bufferCache.get(url);
    if (cached) {
      if (setActive) {
        this.bgmBuffer = cached;
        this.hasUploadedAudio = true;
        this.forceSynth = false;
        this.activeUrl = url;
      }
      return;
    }
    const token = ++this.loadToken;
    const res = await fetch(url, { signal });
    if (token !== this.loadToken) return;
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    const arrayBuffer = await readBodyWithProgress(
      res,
      onPhase && ((loaded, total) => onPhase({ phase: 'download', loaded, total })),
    );
    if (token !== this.loadToken) return;
    if (signal?.aborted) {
      // 字节虽已到齐，但调用方已不关心本曲：省掉解码的 CPU 开销。
      throw new DOMException('Audio load aborted', 'AbortError');
    }
    let audioBuffer: AudioBuffer;
    try {
      /* 字节已到齐，剩下的是 CPU 侧解码：它自身没有进度可报，但几 MB 的文件
       * 在弱设备上可能明显耗时，所以单独告知一声，避免 UI 停在「音频 100%」。 */
      onPhase?.({ phase: 'decode' });
      audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      const isOgg = /\.ogg(\?|$)/i.test(url);
      const hint = isOgg
        ? ' (Safari 不支持 OGG 格式，请改用 MP3 / M4A)'
        : ' (格式可能不被当前浏览器支持)';
      throw new Error(`无法解码音频: ${url}${hint}`);
    }
    if (token !== this.loadToken) return;
    // 解码成功后入缓存（即便 setActive=false 也值得缓存，供后续 setActive 复用）。
    this.bufferCache.set(url, audioBuffer);
    this.evictBuffers();
    if (setActive) {
      this.bgmBuffer = audioBuffer;
      this.hasUploadedAudio = true;
      this.forceSynth = false;
      this.activeUrl = url;
    }
  }

  /** 淘汰最旧的 URL 缓存项（仅移除引用，AudioBuffer 由 GC 回收，无 close()）。 */
  private evictBuffers(): void {
    while (this.bufferCache.size > AudioManager.BUFFER_CACHE_MAX) {
      const oldest = this.bufferCache.keys().next().value;
      if (oldest === undefined) break;
      this.bufferCache.delete(oldest);
    }
  }

  /** 主动丢弃最旧的已解码缓冲，供内存压力场景（如长会话、移动端）调用。 */
  public pruneBuffers(): void {
    this.evictBuffers();
  }

  /** 进程级 / HMR 卸载时销毁：关闭 AudioContext、清空缓存与活动缓冲。
   *  注意：本类为全局单例，组件卸载不得调用（会误伤仍依赖它的 UI 音效）；
   *  仅可由 import.meta.hot.dispose 或页面卸载等真正进程级卸载点调用（P1-3）。 */
  public dispose(): void {
    try {
      this.stop();
    } catch {
      /* ignore */
    }
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    this.bgmBuffer = null;
    this.activeUrl = null;
    this.bufferCache.clear();
    this.loadToken++;
  }


  /** Mark this session as using the procedural synth (demo tracks). */
  public setSynthesizedTrack(bpm: number) {
    this.init();
    // 取消任何进行中的音频加载，并清掉可能过期的旧缓冲，
    // 避免切到合成器曲目后仍播放上一首曲目的音频。
    this.loadToken++;
    this.hasUploadedAudio = false;
    this.bgmBuffer = null;
    this.activeUrl = null;
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
    // 兼容模式：同步锚定墙钟，使 play() 后 getAudioTime() 与原实现一致，即
    // `audioStartSec - leadInSec*rate`（lead-in 期间谱面从负值走起，音频延迟
    // leadInSec 后开始）。公式推导：wallClockSec() = (now - chartWallMs)/1000 * rate，
    // 令其等于 audioStartSec - leadInSec*rate → chartWallMs = now - audioStartSec*1000/rate
    // + leadInSec*1000。此处 + leadInSec*1000 对应原 startTime 的 + leadInSec。
    this.chartWallMs = performance.now() - (audioStartSec * 1000) / this.playbackRate + leadInSec * 1000;
    this.isPlaying = true;

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
    if (this.synthInterval || this.synthStartTimer || this.synthLookaheadTimer) {
      window.setTimeout(() => {
        this.clearSynth();
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
    this.clearSynth();
  }

  /** 把谱面时钟归零（未播放态下 getCurrentTime 的回退值）。开局流程在挂载画布、
   *  等待首帧期间调用：画布此刻应以 t=0 渲染场景，而不是上一局残留的 pauseTime
   *  （stop() 故意不清它，暂停-恢复依赖原值）。 */
  public resetClock(): void {
    this.pauseTime = 0;
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
    // 兼容模式：同步锚定墙钟，seek 后 getCurrentTime() 立即读到 targetChartSec。
    this.chartWallMs = performance.now() - (audioTarget * 1000) / this.playbackRate;

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
      // Synthesised: restart the lookahead scheduler from the matching step.
      // The scheduler anchors the first step to the AudioContext clock (silent
      // until audio time reaches 0 if the target precedes the song start);
      // startSynthesizedMusic 开头会 clearSynth 清理上一轮调度。
      this.startSynthesizedMusic(audioTarget, 0);
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

  /** 真实音频位置（chart-time 坐标）：始终由 AudioContext 时钟驱动，不随兼容模式
   *  墙钟分叉。App 校准循环用它对比谱面墙钟，判断音频是否落后。 */
  public getRawAudioTime(): number {
    if (!this.isPlaying || !this.ctx) return this.pauseTime;
    return this.toChartTime((this.ctx.currentTime - this.startTime) * this.playbackRate);
  }

  /** 兼容模式校准动作：把音频 buffer 跳到 `targetChartSec`，但**不重锚谱面墙钟**。
   *  谱面/判定/粒子/HUD 的位置完全不受影响——音频跟随谱面，允许音频跳变。
   *  仅 buffer 音频有效（合成路径无独立音轨可校准，直接忽略）。 */
  public nudgeAudio(targetChartSec: number): void {
    if (!this.compatMode) return;
    if (!this.isPlaying || !this.ctx) return;
    if (!(this.hasUploadedAudio && !this.forceSynth && this.bgmBuffer)) return;
    if (!this.bgmGain) return;
    const audioTarget = this.toAudioTime(targetChartSec);
    // 复用 seek 的 buffer 重建（stop 旧源 + 新源从 offset 播），但不改 chartWallMs。
    if (this.bgmSource) {
      try { this.bgmSource.stop(); this.bgmSource.disconnect(); } catch { /* 已停止/已断开 */ }
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
  }

  /** Set the editor playback rate (0.25 / 0.5 / 1 / 2). The rate is applied
   *  directly to the running AudioBufferSource (so the pitch shifts with speed),
   *  and the game clock is re-anchored so the current gameTime stays continuous
   *  across the speed change. When not playing, the rate is just stored and
   *  applied on the next play(). */
  public setPlaybackRate(rate: number): void {
    const clamped = clamp(rate, 0.05, 4);
    if (!this.isPlaying || !this.ctx) {
      this.playbackRate = clamped;
      return;
    }
    // Preserve the current CHART position across the rate switch. Because the
    // offset is now scaled by playbackRate (toAudioTime/toChartTime), the
    // `chartTime = audioTime + offset*rate` term changes with the rate, so we
    // must shift the audio anchor by that delta to keep the current chartTime
    // continuous (otherwise the chart would jump by offset*(rate_new-rate_old)
    // the instant you change speed).
    const audioTime = this.getAudioTime();
    const prevOffsetRate = this.userAudioOffset * this.playbackRate;
    const nextOffsetRate = this.userAudioOffset * clamped;
    this.playbackRate = clamped;
    const anchoredAudioTime = audioTime + (prevOffsetRate - nextOffsetRate);
    this.startTime = this.ctx.currentTime - anchoredAudioTime / this.playbackRate;
    // 兼容模式：同步重锚墙钟，使 getCurrentTime() 在变速后保持连续。
    this.chartWallMs = performance.now() - (anchoredAudioTime * 1000) / this.playbackRate;
    // Update the running source's rate in place (pitch shifts with speed).
    if (this.bgmSource) {
      this.bgmSource.playbackRate.value = clamped;
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
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
    // 清理上一轮调度（防御，stop/seek 也会走 clearSynth）。
    this.clearSynth();
    const rate = this.playbackRate;
    const beatInterval = 60 / this.synthBpm;
    this.synthStepInterval = beatInterval / 4;
    // Clamp the starting step at 0 so a negative offset (song hasn't begun) just
    // starts from the beginning rather than ticking at a negative step.
    this.synthNextStep = Math.max(0, Math.floor(startOffset / (beatInterval / 4)));
    // The ctx time at which the audio time reaches 0 (chart time == offset).
    // Defer the first step until then so the synth stays silent during lead-in
    // when appropriate (positive offset) or begins mid-song only once audio
    // time is non-negative (negative offset) — exactly like the buffer path.
    this.synthNextTime = this.ctx.currentTime + leadInSec - startOffset / rate;
    this.scheduleSynthLookahead();
  }

  /** 取消合成调度：停 lookahead 定时器，并静默/断开已调度但尚未播完的音符。 */
  private clearSynth(): void {
    if (this.synthLookaheadTimer) {
      window.clearTimeout(this.synthLookaheadTimer);
      this.synthLookaheadTimer = null;
    }
    if (this.synthInterval) {
      window.clearInterval(this.synthInterval);
      this.synthInterval = null;
    }
    if (this.synthStartTimer) {
      window.clearTimeout(this.synthStartTimer);
      this.synthStartTimer = null;
    }
    // 已 start(when)（可能 when 在未来）的音符无法撤销 start，只能提前 stop
    // 使其静音并断开，避免 seek/stop 后残留发声。
    for (const src of this.synthPending) {
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* already disconnected */ }
    }
    this.synthPending = [];
  }

  /** 在 AudioContext 时钟 `when` 排布一个 step 的全部音符（与旧 setInterval
   *  tick 逐字等价，仅把触发时刻 `now` 换成排布时刻 `when`）。 */
  private scheduleSynthStep(step: number, when: number): void {
    // 局部收窄：闭包内使用局部变量，避免非空断言（lint 基线约束）。
    const ctx = this.ctx;
    const bgmGain = this.bgmGain;
    if (!ctx || !bgmGain) return;
    const chords = this.synthChords;
    const beat16 = step % 16;
    const bar = Math.floor(step / 16) % chords.length;
    const chord = chords[bar];
    // rampTo 为 null 时表示固定频率（无频率滑音），对应原 tick 里仅
    // setValueAtTime 而不用 exponentialRamp 的音符（3000Hz tick）。
    const spawn = (type: OscillatorType, freq: number, rampTo: number | null, vol: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, when);
      if (rampTo !== null) o.frequency.exponentialRampToValueAtTime(rampTo, when + dur);
      g.gain.setValueAtTime(vol, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur);
      o.connect(g); g.connect(bgmGain);
      o.start(when); o.stop(when + dur);
      // onended 移除引用以便 GC；stop/seek 时 clearSynth 对仍挂着的 stop+disconnect。
      o.onended = () => {
        const i = this.synthPending.indexOf(o);
        if (i >= 0) this.synthPending.splice(i, 1);
      };
      this.synthPending.push(o);
    };
    if (beat16 % 4 === 0) spawn('sine', 140, 35, 0.8, 0.12);
    if (beat16 === 4 || beat16 === 12) spawn('triangle', 240, 80, 0.5, 0.1);
    if (beat16 % 2 === 1) spawn('triangle', 3000, null, 0.15, 0.04);
    // 琶音音符：sawtooth 强拍 / sine 其余；时长 = beatInterval*0.35。
    const arpNote = chord[beat16 % chord.length];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = (beat16 % 4 === 0) ? 'sawtooth' : 'sine';
    o.frequency.setValueAtTime(arpNote, when);
    g.gain.setValueAtTime(0.25, when);
    const arpDur = (60 / this.synthBpm) * 0.35;
    g.gain.exponentialRampToValueAtTime(0.001, when + arpDur);
    o.connect(g); g.connect(bgmGain);
    o.start(when); o.stop(when + arpDur);
    o.onended = () => {
      const i = this.synthPending.indexOf(o);
      if (i >= 0) this.synthPending.splice(i, 1);
    };
    this.synthPending.push(o);
  }

  /** Lookahead 主循环：若下一个待排步已落入"当前 + 提前量"窗口内，则批量排布，
   *  并把指针推进到窗口之外。已排布的音符在 AudioContext 时钟上精确触发，不受
   *  主线程后续阻塞影响。 */
  private scheduleSynthLookahead(): void {
    if (this.synthLookaheadTimer) return; // 已有循环在跑
    const lookaheadTick = (): void => {
      this.synthLookaheadTimer = null;
      if (!this.isPlaying || !this.ctx || !this.bgmGain) return;
      // 防爆音：若主线程阻塞使排布指针落后于当前音频时钟（超过小余量），
      // 跳过已错过的 step 而非补播——否则恢复瞬间多个 osc.start(过去时间)
      // 会同时响起。错过即跳过，与旧 setInterval 丢弃堆积回调的语义一致。
      const now = this.ctx.currentTime;
      const behind = now - this.synthNextTime;
      if (behind > 0.05) {
        const skipSteps = Math.ceil(behind / this.synthStepInterval);
        this.synthNextStep += skipSteps;
        this.synthNextTime += skipSteps * this.synthStepInterval;
      }
      const horizon = now + AudioManager.SYNTH_LOOKAHEAD_SEC;
      while (this.synthNextTime < horizon) {
        this.scheduleSynthStep(this.synthNextStep, this.synthNextTime);
        this.synthNextStep++;
        this.synthNextTime += this.synthStepInterval;
      }
      this.synthLookaheadTimer = window.setTimeout(lookaheadTick, AudioManager.SYNTH_LOOKAHEAD_MS);
    };
    lookaheadTick();
  }

  /** 合成音符的和弦库（每 4 小节循环）。 */
  private synthChords = [
    [220, 277.18, 329.63, 440],
    [174.61, 220, 261.63, 349.23],
    [261.63, 329.63, 392, 523.25],
    [196, 246.94, 293.66, 392],
  ];
}

export const globalAudio = new AudioManager();

// HMR 进程级卸载：销毁单例持有的 AudioContext，避免模块重挂时旧 ctx 累积（P1-3 / R2-2）。
// 仅模块被热替换时触发；生产构建中 import.meta.hot 为 undefined，此分支不执行。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    globalAudio.dispose();
  });
}
