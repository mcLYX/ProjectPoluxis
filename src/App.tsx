import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
// 重度/非首屏组件按需懒加载，降低菜单首屏 JS 体积（three 等仅在使用时下载）。
const GameCanvas = lazy(() => import('./components/GameCanvas').then(m => ({ default: m.GameCanvas })));
const Editor2DCanvas = lazy(() => import('./components/Editor2DCanvas').then(m => ({ default: m.Editor2DCanvas })));
const VisualChartEditor = lazy(() => import('./components/VisualChartEditor').then(m => ({ default: m.VisualChartEditor })));
const UnitTestModal = lazy(() => import('./components/UnitTestModal').then(m => ({ default: m.UnitTestModal })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
import type { EditorTool, BatchSelection, QuickCreateDelta, MarqueeMode } from './components/VisualChartEditor';
import { SongSelect, SongSelectNavState, ResultInfo } from './components/SongSelect';
import { TimingBar, TimingMarker } from './components/TimingBar';
import { DEMO_CHARTS } from './data/demoCharts';
import { storeFile, getFile, generateId } from './data/idb';
import { getAlbumById, createAlbum, addSong, findSongById, findAlbumTitleForSong, addDifficultyToSong, updateDifficultyOfSong, updateSongById } from './data/libraryStore';
import { resolveBeatmapUrl, parseDifficultyMeta } from './data/beatmapLoader';
import type { QualityMode, SkinTextureSet } from './types/game';
import { ChartData, GameStats, JudgementFeedback, NoteData } from './types/game';
import { getSkin, loadSkinTextures } from './data/skinStore';
import type { EditorLaunchInfo, SongItem } from './types/beatmap';
import { calculateNoteScore, calculateRank } from './utils/scoring';
import { clampInt } from './utils/math';
import { safeStorage } from './utils/storage';
import { getChartDuration, beatToSecondsMultiBpm, secondsToBeatMultiBpm, countPlayableNotes, getFirstNoteTime, getBpmAtBeat } from './utils/beatTime';
import { parseAndValidateChart, exportChartJson } from './utils/chartParser';
import { submitScore, clearHighScore, getScoreKey, calcBadgeFromStats } from './utils/scoreStore';
import { globalAudio } from './audio/AudioManager';
import { useI18n } from './i18n';
import { applyDslToNote, loadEditorDsl, saveEditorDsl } from './utils/editorRules';
import {
  Play,
  Pause,
  RotateCcw,
  ArrowLeft,
} from 'lucide-react';

const MARKER_LIFETIME_MS = 1150;

// =============== HUD color helpers (driven by per-chart bgScheme) ===============
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function withAlpha(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function adjustBrightness(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${clampInt(r * factor, 0, 255)}, ${clampInt(g * factor, 0, 255)}, ${clampInt(b * factor, 0, 255)})`;
}

// Fallback palette (matches the previous cyan look) used when a chart doesn't
// define its own bgScheme.
const FALLBACK_BG = { accentColor: '#06b6d4', gradientStart: '#0a1124', gradientEnd: '#050816' };

const DEFAULT_SETTINGS = {
  speedMultiplier: 1.0,
  audioOffsetMs: 0,
  projectionLeadMs: 500,
  noteRenderDistance: 70,
  noteSizeScale: 1.0,
  qualityMode: 'standard' as QualityMode,
  // 自定义档位下的各项画面特效开关与渲染倍率。
  customAntialias: true,
  customBloom: true,
  customParticles: true,
  customDynamicLighting: true,
  customHitEffects: true,
  customRenderScale: 1.0,
  musicVolume: 0.8,
  effectVolume: 0.9,
  // 当前选中的皮肤 id；null 表示使用默认纯色外观。
  selectedSkinId: null as string | null,
  // 默认皮肤（未选皮肤包时）的自定义项。
  // 默认皮肤音符边框 = 内框(跟随音符色,1px) + 外框(软边纹理,可自定义)。判定框颜色恒等于音符色。
  defaultSkinInnerEnabled: true,   // 内框开关，默认开
  defaultSkinOuterEnabled: false,  // 外框开关，默认关（关闭时外框不渲染）
  defaultSkinOuterWidth: 0.05,     // 外框粗细（仅开关启用时生效）
  defaultSkinOuterColor: '#22d3ee',
  defaultSkinOuterAlpha: 1,
  defaultSkinJudgeWidth: 0.01, // 判定框（投影引导）粗细，颜色恒等于音符色
};

function loadSettings(): typeof DEFAULT_SETTINGS {
  try {
    const saved = safeStorage.getItem('poluxis-settings');
    if (!saved) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(saved);
    const result: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };
    // Migrate legacy `lowQualityMode: boolean` → `qualityMode: 'low'|'standard'`.
    if (parsed && typeof parsed.lowQualityMode === 'boolean' && parsed.qualityMode === undefined) {
      result.qualityMode = parsed.lowQualityMode ? 'low' : 'standard';
      delete (parsed as any).lowQualityMode;
    }
    // Migrate legacy `defaultSkinInnerWidth/OuterWidth` (number) → enabled booleans.
    if (parsed && typeof parsed.defaultSkinInnerWidth === 'number') {
      result.defaultSkinInnerEnabled = parsed.defaultSkinInnerWidth > 0;
      delete (parsed as any).defaultSkinInnerWidth;
    }
    if (parsed && typeof parsed.defaultSkinOuterWidth === 'number') {
      result.defaultSkinOuterEnabled = parsed.defaultSkinOuterWidth > 0;
      if (parsed.defaultSkinOuterWidth > 0) result.defaultSkinOuterWidth = parsed.defaultSkinOuterWidth;
      delete (parsed as any).defaultSkinOuterWidth;
    }
    for (const k of Object.keys(result) as Array<keyof typeof DEFAULT_SETTINGS>) {
      const val = parsed[k];
      if (typeof val === 'undefined') continue;
      const def = (result as any)[k];
      // A setting whose default is `null` (e.g. selectedSkinId) has type
      // 'object', while the saved value is a string — the naive
      // `typeof val === typeof def` check would reject it and silently reset
      // the selection to default on every refresh. Accept any loaded value
      // for null-typed settings instead.
      if (def === null) {
        (result as any)[k] = val;
      } else if (typeof val === typeof def) {
        (result as any)[k] = val;
      }
    }
    return result;
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: typeof DEFAULT_SETTINGS) {
  try {
    safeStorage.setItem('poluxis-settings', JSON.stringify(settings));
  } catch (e) { /* ignore quota / private mode errors */ }
}

export function App() {
  const { t } = useI18n();
  const initialSettings = loadSettings();
  // 当前正在进行的谱面加载请求（用于防快速切歌覆盖 / 卸载取消，P2-9）。
  const loadChartAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => loadChartAbortRef.current?.abort(), []);

  const [currentChart, setCurrentChart] = useState<ChartData>(DEMO_CHARTS['neon-cyberspace']);
  /** 由卡片发起谱面编辑/新建时的上下文；为 null 表示自由编辑器（保存至 Editor 专辑）。 */
  const [editorTarget, setEditorTarget] = useState<EditorLaunchInfo | null>(null);
  const [appToast, setAppToast] = useState<string | null>(null);
  const showAppToast = useCallback((msg: string) => {
    setAppToast(msg);
    window.setTimeout(() => setAppToast(null), 2600);
  }, []);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'paused' | 'editor'>('menu');
  const [gameTime, setGameTime] = useState(0);
  const [speedMultiplier, setSpeedMultiplier] = useState(initialSettings.speedMultiplier);
  const [autoPlay, setAutoPlay] = useState(false);
  const [audioOffsetMs, setAudioOffsetMs] = useState(initialSettings.audioOffsetMs);
  const [projectionLeadMs, setProjectionLeadMs] = useState(initialSettings.projectionLeadMs);
  const [noteRenderDistance, setNoteRenderDistance] = useState(initialSettings.noteRenderDistance);
  const [noteSizeScale, setNoteSizeScale] = useState(initialSettings.noteSizeScale);
  const [qualityMode, setQualityMode] = useState<QualityMode>(initialSettings.qualityMode);
  const [customAntialias, setCustomAntialias] = useState(initialSettings.customAntialias);
  const [customBloom, setCustomBloom] = useState(initialSettings.customBloom);
  const [customParticles, setCustomParticles] = useState(initialSettings.customParticles);
  const [customDynamicLighting, setCustomDynamicLighting] = useState(initialSettings.customDynamicLighting);
  const [customHitEffects, setCustomHitEffects] = useState(initialSettings.customHitEffects);
  const [customRenderScale, setCustomRenderScale] = useState(initialSettings.customRenderScale);
  const [musicVolume, setMusicVolume] = useState(initialSettings.musicVolume);
  const [effectVolume, setEffectVolume] = useState(initialSettings.effectVolume);
  // 皮肤：选中 id → 预加载后的贴图集合（传给 GameCanvas）。
  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(initialSettings.selectedSkinId);
  const [skinTextures, setSkinTextures] = useState<SkinTextureSet | null>(null);
  // 默认皮肤（未选皮肤包时）自定义项。
  const [defaultSkinInnerEnabled, setDefaultSkinInnerEnabled] = useState(initialSettings.defaultSkinInnerEnabled);
  const [defaultSkinOuterEnabled, setDefaultSkinOuterEnabled] = useState(initialSettings.defaultSkinOuterEnabled);
  const [defaultSkinOuterWidth, setDefaultSkinOuterWidth] = useState(initialSettings.defaultSkinOuterWidth);
  const [defaultSkinOuterColor, setDefaultSkinOuterColor] = useState(initialSettings.defaultSkinOuterColor);
  const [defaultSkinOuterAlpha, setDefaultSkinOuterAlpha] = useState(initialSettings.defaultSkinOuterAlpha);
  const [defaultSkinJudgeWidth, setDefaultSkinJudgeWidth] = useState(initialSettings.defaultSkinJudgeWidth);
  const [playSession, setPlaySession] = useState(0);
  const [hasCustomAudio, setHasCustomAudio] = useState(false);
  const [songSelectState, setSongSelectState] = useState<SongSelectNavState | null>(null);
  // Stable identity so SongSelect's state-sync useEffect doesn't loop on every
  // render (an inline arrow here would change every render → infinite updates).
  const handleSongSelectStateChange = useCallback((state: SongSelectNavState) => {
    setSongSelectState(state);
  }, []);
  const [transitionPhase, setTransitionPhase] = useState<'idle' | 'fade-out' | 'fade-in'>('idle');
  const transitionTimerRef = useRef<number | null>(null);

  // Countdown State for Resuming Gameplay
  const [countdownVal, setCountdownVal] = useState<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  // Editor State
  const [editorTool, setEditorTool] = useState<EditorTool>('select');
  // ref 镜像当前工具：R 键等事件闭包中读取最新值。
  const editorToolRef = useRef<EditorTool>('select');
  useEffect(() => { editorToolRef.current = editorTool; }, [editorTool]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [batchSelection, setBatchSelection] = useState<BatchSelection>({ startBeat: null, endBeat: null });
  // 多选模式：双击“选择/移动”工具、双击 R 键、或按住 Ctrl 临时进入。
  const [isMultiSelect, setIsMultiSelect] = useState(false);
  // 多选集合（note base id，不含 # 子节点后缀）。与单选 selectedNoteId 并存：
  // 多选模式下的单击/框选改写此集合；批量编辑弹窗据此显示。
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  // ref 镜像，供事件回调读取最新集合，避免闭包过期。
  const selectedNoteIdsRef = useRef<string[]>(selectedNoteIds);
  useEffect(() => { selectedNoteIdsRef.current = selectedNoteIds; }, [selectedNoteIds]);
  // 2D 框选合并方式（仅多选 + 2D 生效）。
  const [marqueeMode, setMarqueeMode] = useState<MarqueeMode>('normal');
  // Ctrl 临时切换：按住时生效，松开恢复。用 state 而非 ref，以在按住/松开时
  // 触发 re-render，让子组件及时感知多选状态。
  const [ctrlHeld, setCtrlHeld] = useState(false);
  /** 当前是否处于多选模式（含 Ctrl 临时切换）。供子组件判断交互分支。
   *  规则：Ctrl 按住时对持久多选状态取反——
   *    - 非多选（含其他工具）下按 Ctrl → 临时多选；
   *    - 多选模式下按 Ctrl → 临时变回单选；
   *  松开 Ctrl 恢复持久状态（isMultiSelect）。 */
  const effectiveMultiSelect = ctrlHeld ? !isMultiSelect : isMultiSelect;

  /** 实际生效的工具：任何工具下按 Ctrl → 临时变为多选工具（select）。
   *  多选模式下按 Ctrl（effectiveMultiSelect=false）时工具仍为 select，
   *  无需切换；其余情况沿用当前工具。 */
  const effectiveEditorTool: EditorTool =
    ctrlHeld && !isMultiSelect ? 'select' : editorTool;
  const [snapSubdivision, setSnapSubdivision] = useState<number>(0.25);
  const [editorPreviewPlaying, setEditorPreviewPlaying] = useState(false);
  const [editorPlaybackRate, setEditorPlaybackRate] = useState<number>(1);
  const [editorVlineCount, setEditorVlineCount] = useState<number>(13);
  const [editorPxPerBeat, setEditorPxPerBeat] = useState<number>(100);
  const [editorViewMode, setEditorViewMode] = useState<'3d' | '2d'>('3d');
  const [isPlayTestMode, setIsPlayTestMode] = useState(false);
  const playTestStartBeatRef = useRef(0);
  // 试玩起点（秒 / 拍）与“是否从当前位置开始”，用于暂停后重试时回到
  // 记录到的试玩起点，而不是整首曲子从头开始。
  const playTestStartSecRef = useRef(0);
  const playTestFromCurrentRef = useRef(false);

  // 编辑器“高级功能”：放置新音符时套用的规则（仅编辑器本地配置，存 localStorage）。
  const [editorDsl, setEditorDsl] = useState<string>(() => loadEditorDsl());
  const editorDslRef = useRef<string>(editorDsl);
  editorDslRef.current = editorDsl;

  // 编辑器加载/上传的音频引用：上传时写入 idb 得到 idb:// 引用；保存至 Editor 专辑时一并写入。
  // customAudioFileRef 持有上传的二进制（用于保存），currentAudioRefRef 持有最终要保存的引用
  // （可为上传得到的 idb://，或来自内置/在线的 URL，或重编辑时已存在的 idb://）。
  const customAudioFileRef = useRef<File | null>(null);
  const currentAudioRefRef = useRef<string | null>(null);

  // Current song info for high score tracking. scoreKey 已含来源命名空间
  // （local:/online:/ 或不加前缀的 builtin），避免同一在线曲目下载前后的成绩互通。
  const [currentSongInfo, setCurrentSongInfo] = useState<
    { songId: string; scoreKey: string; diffName: string } | null
  >(null);
  // Post-play result shown on the song-select "result card" (null = normal menu)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null);
  const [clearBanner, setClearBanner] = useState<'FC' | 'AP' | 'AP+' | null>(null);

  // Modals
  const [showUnitTest, setShowUnitTest] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [stats, setStats] = useState<GameStats>({
    score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0,
    goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: calculateRank(0),
  });

  const [timingMarkers, setTimingMarkers] = useState<TimingMarker[]>([]);
  const [comboBurst, setComboBurst] = useState<{ key: number; value: number } | null>(null);
  // Ambient background is driven imperatively (ref + direct DOM writes inside
  // the HUD rAF) instead of React state. Pushing it every frame via setState
  // forced a full 60fps App reconciliation that saturated one CPU core on
  // mobile; the rAF now mutates the DOM node directly while keeping the exact
  // same gradient, so visuals are unchanged but React never re-renders.
  const ambientBgRef = useRef<HTMLDivElement | null>(null);
  const bgSchemeRef = useRef<any>(null);
  // Live mirror of the current chart so editor callbacks can read fresh notes
  // without adding `currentChart` to their dependency arrays (which would make
  // the place handler stale between rapid placements).
  const currentChartRef = useRef(currentChart);
  currentChartRef.current = currentChart;
  // Gameplay HUD is driven imperatively (no React re-render during play):
  const progressRef = useRef<HTMLDivElement | null>(null);
  const chartDurationRef = useRef(0);
  const gameTimerRef = useRef<number | null>(null);
  // Set to true the instant the song finishes (handleSongEnd fires). This
  // prevents any subsequent ESC / pause-button presses from triggering the
  // paused overlay while the clear-banner / audio fade-out is running (which
  // would otherwise leave the state stuck in "paused" right before flipping
  // to the menu/result screen).
  const songEndedRef = useRef(false);
  const [isSongEnded, setIsSongEnded] = useState(false);

  useEffect(() => {
    globalAudio.setMusicVolume(musicVolume);
  }, [musicVolume]);

  useEffect(() => {
    globalAudio.setEffectVolume(effectVolume);
  }, [effectVolume]);

  // ====== Result-screen music volume ducking ====================================
  // When the result card is shown, duck the BGM to 50% of the user-set volume.
  // This makes the post-play music feel less intrusive while the player reads
  // their score / badge. When the result card is closed, restore the full volume.
  useEffect(() => {
    if (resultInfo) {
      // Entering result screen — duck to 50%
      globalAudio.setMusicVolume(musicVolume * 0.5);
    } else {
      // Exiting result screen (or initial mount) — restore full volume
      globalAudio.setMusicVolume(musicVolume);
    }
    // Cleanup on unmount: restore volume in case the component is torn down
    // while still in result mode (e.g. user navigates away).
    return () => {
      globalAudio.setMusicVolume(musicVolume);
    };
  }, [resultInfo, musicVolume]);

  // ====== Global UI click sound ==================================================
  // Capture-phase `click` listener on document. Click is deliberately used
  // instead of pointerdown so that drag gestures (card carousel, scroll
  // dragging, window resizing, etc.) never fire a UI plink — the browser
  // only dispatches `click` after a press-release pair with no significant
  // pointer movement. We also use a POSITIVE selector to match ONLY actual
  // interactive elements, so clicking empty background / modal backdrops /
  // HUD dead zones stays silent.
  useEffect(() => {
    // Elements that count as a "UI click" target / ancestor:
    //   - Semantic HTML controls (button, a[href], select, details/summary,
    //     label wrapping an input, etc.)
    //   - ARIA roles that imply clickability
    //   - Explicit opt-in via `data-ui-click="1"` attribute (for cards /
    //     custom widgets whose clickability is not obvious from the tag).
    const INTERACTIVE_SELECTOR = [
      'button',
      'a[href]',
      'summary',
      'select',
      'option',
      'label',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="link"]',
      '[role="option"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[data-ui-click]',
    ].join(',');
    // Input subtypes that are "click activated" rather than typed/dragged.
    // Anything not on this list (text / password / range / date / number /
    // file etc.) is skipped so typing and scrubbing don't spam the plink.
    const CLICKY_INPUT_TYPES = new Set([
      'button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color',
    ]);

    const handler = (e: MouseEvent) => {
      if (typeof e.button === 'number' && e.button !== 0) return;
      const target = e.target as Node | null;
      if (!target || target.nodeType !== 1) return;
      const tEl = target as HTMLElement;

      // Exclude the 3D game viewport entirely. Even if someone drops a
      // <button> inside it in the future, game-area events should never
      // trigger the DOM UI plink (we have note-type sfx for that).
      if (tEl.closest?.('[data-viewport="3d"]')) return;

      // Fast path: is the target itself, or any ancestor, one of the
      // whitelisted interactive selectors? If yes → proceed; otherwise this
      // is background / whitespace → skip.
      const interactive = tEl.closest?.(INTERACTIVE_SELECTOR);
      if (!interactive) return;

      // INPUT handling: only whitelisted click-subtypes produce a plink.
      if (tEl.tagName === 'INPUT') {
        const typeAttr = (tEl as HTMLInputElement).type?.toLowerCase() || '';
        if (!CLICKY_INPUT_TYPES.has(typeAttr)) return;
      }
      // TEXTAREA and non-click SELECT subtypes (e.g. when expanding a
      // dropdown the "click on the dropdown body" case) are already filtered
      // out by INTERACTIVE_SELECTOR — but let's be explicit for textarea.
      if (tEl.tagName === 'TEXTAREA') return;

      try {
        globalAudio.playUiSound();
      } catch { /* swallow */ }
    };
    document.addEventListener('click', handler, { capture: true, passive: true });
    return () => {
      document.removeEventListener('click', handler, { capture: true } as unknown as EventListenerOptions);
    };
  }, []);

  const isFirstSettingsRender = useRef(true);
  useEffect(() => {
    if (isFirstSettingsRender.current) {
      isFirstSettingsRender.current = false;
      return;
    }
    saveSettings({
      speedMultiplier, audioOffsetMs, projectionLeadMs, noteRenderDistance,
      noteSizeScale, qualityMode, customAntialias, customBloom,
      customParticles, customDynamicLighting, customHitEffects, customRenderScale, musicVolume, effectVolume,
      selectedSkinId, defaultSkinInnerEnabled, defaultSkinOuterEnabled, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth
    });
  }, [speedMultiplier, audioOffsetMs, projectionLeadMs, noteRenderDistance, noteSizeScale, qualityMode, customAntialias, customBloom, customParticles, customDynamicLighting, customHitEffects, customRenderScale, musicVolume, effectVolume, selectedSkinId, defaultSkinInnerEnabled, defaultSkinOuterEnabled, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth]);

  // 选中皮肤变化时，预加载贴图（灰度图→THREE.Texture）。失败/无皮肤则回退纯色。
  // 菜单态不预加载：避免把 three 拉进首屏；进入游戏/编辑器（GameCanvas 挂载）前才按需下载贴图。
  useEffect(() => {
    if (gameState === 'menu') return;
    let cancelled = false;
    (async () => {
      if (!selectedSkinId) {
        setSkinTextures(null);
        return;
      }
      const meta = await getSkin(selectedSkinId);
      const tex = await loadSkinTextures(meta);
      if (!cancelled) setSkinTextures(tex);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSkinId, gameState]);

  // Calculate current beat from gameTime. Uses the shared inverse so charts
  // with a bpmlist stay accurate (a plain bpm*t/60 would drift after the first
  // tempo change).
  const currentBeat = secondsToBeatMultiBpm(
    gameTime,
    currentChart.metadata.bpm,
    currentChart.metadata.offset || 0,
    currentChart.metadata.bpmlist
  );
  // Mirror currentBeat into a ref so editor handlers can read it without
  // depending on currentBeat (which changes every frame → would break
  // useCallback memoization and cause GameCanvas to re-render every
  // frame via unstable callback identities).
  const currentBeatRef = useRef(currentBeat);
  currentBeatRef.current = currentBeat;

  const handleStartGame = useCallback((chartData: ChartData = currentChart, useCustomAudio = hasCustomAudio, songId?: string, scoreKey?: string, diffName?: string) => {
    // Reset the end-of-song lock BEFORE the fade-out timer starts, so the
    // player can pause during the lead-in of the *next* song if they want.
    songEndedRef.current = false;
    setIsSongEnded(false);
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setCountdownVal(null);
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!useCustomAudio) {
        globalAudio.setSynthesizedTrack(chartData.metadata.bpm);
      }

      // Lead-in is a pure wall-clock delay before the song starts; the audio
      // offset is not part of it (AudioManager applies the offset internally).
      const firstNoteTime = getFirstNoteTime(chartData);
      const leadIn = Math.max(0, 2 - firstNoteTime);
      globalAudio.play(0, leadIn);

      setCurrentChart(chartData);
      setHasCustomAudio(useCustomAudio);
      setStats({
        score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0,
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(chartData), accuracy: 100, rank: calculateRank(0),
      });
      setTimingMarkers([]);
      setComboBurst(null);
      setResultInfo(null);
      if (songId && scoreKey && diffName) {
        setCurrentSongInfo({ songId, scoreKey, diffName });
      } else {
        setCurrentSongInfo(null);
      }
      setGameTime(0);
      setPlaySession((s) => s + 1);
      setGameState('playing');
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, [currentChart, hasCustomAudio, audioOffsetMs]);

  /**
   * Start play-test mode from the editor.
   * @param fromCurrentBeat - if true, start at the current editor playhead position;
   *                         if false, start from the beginning (beat 0).
   * @param restartFromRecorded - if true, ignore `fromCurrentBeat` and restart from
   *                         the position where the CURRENT play-test began (recorded
   *                         in playTestStart*Ref). Used by the pause→retry button so
   *                         retrying a "play from current position" test returns to
   *                         that recorded point rather than the song's very beginning.
   */
  const handleStartPlayTest = useCallback((fromCurrentBeat: boolean, restartFromRecorded = false) => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    // Reset the end-of-song lock so the pause button isn't stuck disabled
    // from a previous play-test that ended.
    songEndedRef.current = false;
    setIsSongEnded(false);
    setCountdownVal(null);
    setEditorPreviewPlaying(false);
    // Restore 1x playback for actual playtest/gameplay.
    setEditorPlaybackRate(1);
    globalAudio.setPlaybackRate(1);

    // Resolve the start position. On a recorded restart this is the point where
    // the current play-test started; otherwise it's the live editor playhead (or 0).
    const startBeat = restartFromRecorded
      ? playTestStartBeatRef.current
      : (fromCurrentBeat ? currentBeatRef.current : 0);
    const startSec = restartFromRecorded
      ? playTestStartSecRef.current
      : (fromCurrentBeat ? gameTime : 0);
    playTestStartBeatRef.current = startBeat;
    playTestStartSecRef.current = startSec;
    playTestFromCurrentRef.current = restartFromRecorded ? playTestFromCurrentRef.current : fromCurrentBeat;

    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!hasCustomAudio) {
        globalAudio.setSynthesizedTrack(currentChart.metadata.bpm);
      }

      const startTimeSec = startSec;

      setStats({
        score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0,
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: calculateRank(0),
      });
      setTimingMarkers([]);
      setComboBurst(null);
      setGameTime(startTimeSec);
      setPlaySession((s) => s + 1);
      setIsPlayTestMode(true);
      setGameState('playing');

      // 重头试玩：给首音之前的 lead-in；从当前位置 / 记录起点重试：无 lead-in。
      const noLeadIn = restartFromRecorded ? playTestFromCurrentRef.current : fromCurrentBeat;
      const leadIn = noLeadIn ? 0 : Math.max(0, 2 - getFirstNoteTime(currentChart));
      globalAudio.play(startTimeSec, leadIn);

      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, [currentChart, hasCustomAudio, audioOffsetMs, gameTime]);

  /**
   * Exit play-test mode and return to the editor.
   */
  const handleExitPlayTest = useCallback(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      setIsPlayTestMode(false);
      setGameState('editor');
      // Clear the end-of-song lock (set when the play-test finished) so the
      // pause button is re-enabled for the next play-test.
      songEndedRef.current = false;
      setIsSongEnded(false);
      setEditorPreviewPlaying(false);
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, []);

  const handleReturnToMenu = useCallback(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setEditorPreviewPlaying(false);
    // Reset editor playback speed so it never leaks into gameplay.
    setEditorPlaybackRate(1);
    globalAudio.setPlaybackRate(1);
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      setGameState('menu');
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, []);

  // Open Visual Chart Editor directly in Gameplay
  const handleOpenVisualEditor = useCallback(() => {
    globalAudio.stop();
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setGameTime(0);
    setPlaySession((s) => s + 1);
    setSelectedNoteId(null);
    setEditorPreviewPlaying(false);
    setEditorTarget(null);
    customAudioFileRef.current = null;
    currentAudioRefRef.current = null;
    setGameState('editor');
  }, []);

  // 依据谱面引用（idb:// 或 URL 路径）加载 ChartData；失败返回 null。
  const loadChartFromRef = async (chartFile: string, signal?: AbortSignal): Promise<ChartData | null> => {
    let text: string | null = null;
    if (chartFile.startsWith('idb://')) {
      const blob = await getFile(chartFile.slice('idb://'.length));
      if (blob) text = await blob.text();
    } else {
      const url = resolveBeatmapUrl(chartFile);
      if (url) {
        const res = await fetch(url, signal ? { signal } : undefined);
        if (res.ok) text = await res.text();
      }
    }
    if (!text) return null;
    const r = parseAndValidateChart(text);
    return r.valid && r.chart ? r.chart : null;
  };

  // 加载编辑器对应的音乐：本地（idb://）读取 blob 生成临时 URL，其余按 URL 加载。
  const loadEditorAudio = async (audio?: string) => {
    if (!audio) return;
    try {
      if (audio.startsWith('idb://')) {
        const blob = await getFile(audio.slice('idb://'.length));
        if (blob) {
          const url = URL.createObjectURL(blob);
          await globalAudio.loadAudioURL(url);
          return;
        }
      }
      const url = resolveBeatmapUrl(audio);
      if (url) await globalAudio.loadAudioURL(url);
    } catch (e) {
      console.error('加载编辑器音频失败', e);
    }
  };

  // 由卡片发起谱面编辑/新建：加载或生成谱面并进入编辑器。
  const handleLaunchChartEditor = useCallback(async (info: EditorLaunchInfo) => {
    globalAudio.stop();
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setGameTime(0);
    setPlaySession((s) => s + 1);
    setSelectedNoteId(null);
    setEditorPreviewPlaying(false);

    // 取消上一次可能仍在飞行的谱面加载，避免快速重入时旧请求后到覆盖新谱面（P2-9）。
    loadChartAbortRef.current?.abort();
    const chartLoadCtrl = new AbortController();
    loadChartAbortRef.current = chartLoadCtrl;

    let chart: ChartData | null = null;
    if (info.mode === 'edit' && info.chartFile) {
      try {
        chart = await loadChartFromRef(info.chartFile, chartLoadCtrl.signal);
      } catch (e) {
        // 被更新的加载或卸载取消：放弃本次后续状态写入，保留既有状态。
        if (chartLoadCtrl.signal.aborted) return;
        chart = null;
      }
      if (!chart) chart = buildLaunchChart(info, false);
    } else {
      // 新建谱面：空白谱面（不再使用模板）。
      chart = buildLaunchChart(info, false);
    }

    // 加载对应音乐，使编辑器可预览/播放（内置/在线走 URL，本地走 idb://）。
    await loadEditorAudio(info.audio);

    // 记录当前音频引用（URL 或 idb://），保存至 Editor 专辑时若用户未重新上传则沿用。
    currentAudioRefRef.current = info.audio ?? null;
    customAudioFileRef.current = null;
    // 切换谱面时重置“自定义音频”标记，避免上一首曲目的音频（hasCustomAudio 仍为真）
    // 遗留到当前合成器曲目，导致误播旧音频。
    setHasCustomAudio(false);

    setEditorTarget(info);
    setCurrentChart(chart);
    setGameState('editor');
  }, []);

  // 依据上下文构建谱面（无可用谱面文件时作为兜底，生成空白谱面）。
  const buildLaunchChart = (info: EditorLaunchInfo, copyTemplate: boolean): ChartData => {
    if (copyTemplate) {
      const tpl = structuredClone(DEMO_CHARTS['neon-cyberspace']);
      tpl.metadata = {
        ...tpl.metadata,
        title: info.songTitle,
        artist: info.songArtist,
        difficulty: 'New',
        bpm: info.bpm,
      };
      return tpl;
    }
    return {
      metadata: {
        title: info.songTitle,
        artist: info.songArtist,
        difficulty: '',
        bpm: info.bpm,
        offset: 0,
        bgScheme: { gradientStart: '#050c1e', gradientEnd: '#1a0d2e', accentColor: info.accentColor || '#00f0ff' },
        noteColor: info.accentColor || '#00f0ff',
        effectToggles: { bloom: true, particles: true, projection: true, gridLines: true },
      },
      notes: [],
    };
  };

  // 编辑器“保存到本地”：本地谱面回写原位；否则存入 Editor 专辑。
  const handleSaveChartToLocal = useCallback(async () => {
    if (!currentChart) return;
    const json = exportChartJson(currentChart);
    const file = new File([json], `${currentChart.metadata.difficulty || 'chart'}.json`, { type: 'application/json' });
    const ref = await storeFile(file);
    const noteCount = countPlayableNotes(currentChart);
    // 难度名若为 “xxx Lv.xx” 形式，自动拆出名称与等级。
    const dmeta = parseDifficultyMeta(currentChart.metadata.difficulty || 'Custom');
    const name = dmeta.name || 'Custom';
    const level = dmeta.level;
    const target = editorTarget;
    // 仅当目标是“本地曲目（含库根独立曲目，其 albumId 可能为 null）”时回写原位，
    // 否则（内置/在线/自由编辑器）存入本地 Editor 专辑。
    const isLocalSong = !!(target && target.source === 'local' && target.songId);
    const savedAudioRef = isLocalSong ? (currentAudioRefRef.current || '') : '';

    try {
      if (isLocalSong && target) {
        const sid = target.songId!; // 已确认存在（isLocalSong 已校验）
        if (target.mode === 'edit' && target.diffName) {
          // 覆盖原难度：在整树（含库根）按 id 找到歌曲后按难度名定位；
          // 找不到该难度名则退化为新增（兼容难度名被改动的情况）。
          const song = await findSongById(sid);
          const di = song ? song.difficulties.findIndex((d) => d.name === target.diffName) : -1;
          if (song && di >= 0) {
            await updateDifficultyOfSong(sid, target.diffName, { chartFile: ref, name, level, noteCount });
          } else {
            await addDifficultyToSong(sid, { name, level, chartFile: ref, noteCount });
          }
        } else {
          // 向本地歌曲新增一个难度（新建谱面 / 无难度时现场新建）。
          await addDifficultyToSong(sid, { name, level, chartFile: ref, noteCount });
        }
        // 回写封面与音频引用（库根/专辑内本地曲目通用）：
        // currentAudioRefRef 在打开编辑器时已初始化为原音频引用，用户上传后会更新；
        // 若未改动则等于原值，写回是幂等的。封面取自谱面 jacket（若有）。
        const songPatch: Partial<SongItem> = { audio: currentAudioRefRef.current || '' };
        if (currentChart.metadata.jacket) songPatch.cover = currentChart.metadata.jacket;
        await updateSongById(sid, songPatch);
        // 难度名可能已在编辑中被改动；保存后以最新 name 刷新上下文，使下次保存
        // 仍能定位到同一难度条目（而不是退化为新增难度）。mode 置为 'edit' 让
        // 新建场景（mode:'new'）首次保存后也走覆盖分支。
        setEditorTarget({ ...target, mode: 'edit', diffName: name });
      } else {
        // 非本地（内置/在线/自由编辑器）→ 创建并保存至本地 Editor 专辑。
        const EDITOR_ALBUM_ID = 'editor';
        const existing = await getAlbumById(EDITOR_ALBUM_ID);
        if (!existing) {
          await createAlbum({
            id: EDITOR_ALBUM_ID,
            title: 'Editor',
            accentColor: '#a855f7',
            songs: [],
          });
        }
        const song: SongItem = {
          type: 'song',
          id: generateId('song'),
          title: currentChart.metadata.title || 'Untitled',
          artist: currentChart.metadata.artist || 'Unknown',
          audio: savedAudioRef,
          cover: '',
          bpm: currentChart.metadata.bpm || 120,
          accentColor: target?.accentColor || currentChart.metadata.noteColor || '#a855f7',
          basePath: '',
          difficulties: [{ name, level, chartFile: ref, noteCount }],
          source: 'local',
        };
        await addSong(EDITOR_ALBUM_ID, song);
        // 记住刚创建的本地歌曲：此后再次“保存到本地”将回写该歌曲的难度原位，
        // 而不是每次都新建一首 Editor 曲目。diffName 记录首次创建的难度名，
        // 便于下次保存按名定位并覆盖同一难度。
        setEditorTarget({
          mode: 'edit',
          songId: song.id,
          songTitle: song.title,
          songArtist: song.artist,
          bpm: song.bpm,
          accentColor: song.accentColor,
          source: 'local',
          selectedDiffIndex: 0,
          difficultiesCount: 1,
          diffName: name,
        });
      }
      // 谱面已修改并保存：清掉该谱面（本地命名空间）的历史成绩，避免旧成绩误导。
      // 下载自在线的谱面 source 为 'local'，只会清掉本地副本成绩，不影响在线原曲。
      if (target && target.source === 'local' && target.songId) {
        clearHighScore(getScoreKey(target.songId, 'local'), target.diffName);
      }
      // 提示保存位置：本地曲目 → 其所在专辑；否则（自由编辑器/内置/在线）→ Editor 专辑。
      // 库根独立曲目不属于任何专辑 → 回退到通用“已保存”。
      let savedPath: string | null = null;
      if (isLocalSong && target) {
        const albumTitle = await findAlbumTitleForSong(target.songId!);
        if (albumTitle) savedPath = `/${albumTitle}`;
      } else {
        savedPath = '/Editor';
      }
      showAppToast(savedPath ? t('fab.savedTo', { path: savedPath }) : t('fab.saved'));
    } catch (err) {
      console.error(err);
      showAppToast(t('editor.saveFailed'));
    }
  }, [currentChart, editorTarget, t, showAppToast]);

  const handleSongEnd = useCallback(() => {
    if (gameState !== 'editor') {
      // Lock pause IMMEDIATELY — no pause-overlay insertion while we are
      // running the clear-banner / fade-out sequence (otherwise the state
      // machine enters paused on top of the menu transition and breaks).
      songEndedRef.current = true;
      setIsSongEnded(true);
      // Fade out audio first
      globalAudio.fadeOutAndStop(1.0);

      if (isPlayTestMode) {
        // In play-test mode, return to editor instead of showing results
        setIsPlayTestMode(false);
        setGameState('editor');
      } else {
        // Calculate badge for THIS play (shown on result card, including auto mode)
        const badge = calcBadgeFromStats(stats);

        // Save high score + best badge only if NOT auto play
        let isNewScore = false;
        let isNewB = false;
        if (currentSongInfo && !autoPlay) {
          const result = submitScore(currentSongInfo.scoreKey, currentSongInfo.diffName, stats);
          isNewScore = result?.isNewScore ?? false;
          isNewB = result?.isNewBadge ?? false;
        }

        const info: ResultInfo = {
          stats,
          badge,
          isNewHighScore: isNewScore,
          isNewBadge: isNewB,
          songId: currentSongInfo?.songId ?? null,
          diffName: currentSongInfo?.diffName ?? null,
          meta: {
            title: currentChart.metadata.title,
            artist: currentChart.metadata.artist,
            difficulty: currentChart.metadata.difficulty,
            bpm: currentChart.metadata.bpm,
          },
        };

        // Back to song select in "result card" mode (bars hidden, enlarged card)
        const showResult = () => {
          setResultInfo(info);
          setGameState('menu');
          setTransitionPhase('fade-in');
          transitionTimerRef.current = window.setTimeout(() => {
            setTransitionPhase('idle');
            transitionTimerRef.current = null;
          }, 300);
        };

        // Show clear banner (FC / AP / AP+) first if earned
        if (badge) {
          setClearBanner(badge);
          window.setTimeout(() => {
            setClearBanner(null);
            showResult();
          }, 1800);
        } else {
          // No badge — wait for audio fade-out (1s) then show result
          window.setTimeout(showResult, 1000);
        }
      }
    }
  }, [gameState, isPlayTestMode, currentSongInfo, stats, autoPlay, currentChart]);

  const handleJudgementStable = useCallback((fb: JudgementFeedback) => {
    setStats((prev) => {
      const isHit = fb.type !== 'Miss';
      const newCombo = isHit ? prev.combo + 1 : 0;
      const newMaxCombo = Math.max(prev.maxCombo, newCombo);
      const sCount = prev.sPerfectCount + (fb.type === 'S-Perfect' ? 1 : 0);
      const pCount = prev.perfectCount + (fb.type === 'Perfect' ? 1 : 0);
      const gCount = prev.goodCount + (fb.type === 'Good' ? 1 : 0);
      const mCount = prev.missCount + (fb.type === 'Miss' ? 1 : 0);
      const newScore = prev.score + fb.scoreGained;
      const judgedTotal = sCount + pCount + gCount + mCount;
      const newAcc = judgedTotal > 0 ? ((sCount + pCount + gCount * 0.5) / judgedTotal) * 100 : 100;

      if (newCombo > 0 && newCombo % 10 === 0) {
        setComboBurst({ key: Date.now(), value: newCombo });
      }

      return {
        ...prev, score: newScore, combo: newCombo, maxCombo: newMaxCombo,
        sPerfectCount: sCount, perfectCount: pCount, goodCount: gCount, missCount: mCount,
        accuracy: newAcc, rank: calculateRank(newScore),
      };
    });

    const marker: TimingMarker = { id: `${fb.id}-${fb.createdAt}`, dt: fb.deltaT, type: fb.type };
    setTimingMarkers((prev) => [...prev.slice(-24), marker]);
    window.setTimeout(() => {
      setTimingMarkers((prev) => prev.filter((m) => m.id !== marker.id));
    }, MARKER_LIFETIME_MS);
  }, []);

  // Pause / Resume with 3s countdown
  const handleTogglePause = () => {
    // Never allow pausing after the song has ended — the game is already in
    // the fade-out / clear-banner phase and about to transition to menu.
    if (songEndedRef.current) return;
    // If playing, pause instantly and cancel any existing countdowns
    if (gameState === 'playing') {
      globalAudio.pause();
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setCountdownVal(null);
      // Capture live position so resume (globalAudio.play(gameTime)) is exact.
      // Gameplay no longer updates gameTime every frame, so snapshot it here.
      const liveT = globalAudio.getCurrentTime();
      setGameTime(liveT);
      if (progressRef.current) {
        progressRef.current.style.width = `${Math.min(100, (liveT / (chartDurationRef.current || 1)) * 100)}%`;
      }
      setGameState('paused');
    }
    // If paused, we can toggle countdown resume
    else if (gameState === 'paused') {
      if (countdownVal !== null) {
        // Cancel countdown and stay paused
        if (countdownTimerRef.current) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
        setCountdownVal(null);
      } else {
        // Start 3-second countdown
        setCountdownVal(3);
        let currentSec = 3;
        countdownTimerRef.current = window.setInterval(() => {
          currentSec--;
          if (currentSec <= 0) {
            if (countdownTimerRef.current) {
              window.clearInterval(countdownTimerRef.current);
              countdownTimerRef.current = null;
            }
            setCountdownVal(null);
            /* gameTime came from getCurrentTime(), and play() takes the same
             * chart-time coordinate — so it round-trips as-is. */
            globalAudio.play(gameTime);
            setGameState('playing');
          } else {
            setCountdownVal(currentSec);
          }
        }, 1000);
      }
    }
  };

  const handleEditorTogglePlay = () => {
    if (editorPreviewPlaying) {
      globalAudio.pause();
      // Snapshot the live position so resume (globalAudio.play(gameTime)) is
      // exact — the editor rAF loop stops driving gameTime the moment preview
      // playback halts, so without this a mid-song pause would resume from 0.
      setGameTime(globalAudio.getCurrentTime());
      setEditorPreviewPlaying(false);
    } else {
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!hasCustomAudio) {
        globalAudio.setSynthesizedTrack(currentChart.metadata.bpm);
      }
      // Play from the current position (gameTime). The chart clock starts exactly
      // here (beat 0.00 stays at 0.00) and the audio plays from its corresponding
      // position (audioTime = chartTime - userAudioOffset), not from the song's
      // beginning. Unlike gameplay we apply no lead-in — a negative offset must NOT
      // shove the chart back to a negative position to restart the audio from 0.
      globalAudio.play(gameTime);
      setEditorPreviewPlaying(true);
    }
  };

  const handleSeekBeat = (beat: number) => {
    const snappedBeat = Math.round(beat / snapSubdivision) * snapSubdivision;
    // No lower clamp: the editor must be able to represent and display beats
    // before 0 (e.g. negative-offset lead-in or notes placed before beat 0), so
    // the various beat read-outs correctly show negative values.
    const targetSec = beatToSecondsMultiBpm(
      snappedBeat,
      currentChart.metadata.bpm,
      currentChart.metadata.offset || 0,
      currentChart.metadata.bpmlist
    );
    setGameTime(targetSec);
    if (gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)) {
      // In-place seek: no stop/play cycle, no lead-in, no audible gap.
      globalAudio.seek(targetSec);
    }
  };

  /** Mouse-wheel / trackpad scrubbing of the editor timeline (global, both 2D & 3D).
   *  One notch = exactly one snap subdivision. Scroll down = forward. */
  const handleEditorWheel = useCallback((e: React.WheelEvent) => {
    if (gameState !== 'editor') return;
    const { bpm, offset, bpmlist } = currentChart.metadata;
    const dir = e.deltaY > 0 ? 1 : -1;
    const deltaBeats = dir * (snapSubdivision || 0.25);
    const curBeat = secondsToBeatMultiBpm(gameTime, bpm, offset || 0, bpmlist);
    handleSeekBeat(curBeat + deltaBeats);
  }, [gameState, gameTime, currentChart, snapSubdivision, handleSeekBeat]);

  // 编辑器放置工具快捷键：q=tap, w=touch, e=slide, r=select(移动)
  useEffect(() => {
    if (gameState !== 'editor') return;
    let lastRTime = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Ctrl 临时多选：按住 Control 时进入多选，松开恢复。
      // 无条件 set 以规避 effect 闭包中 ctrlHeld 的过期值（React 对相同值会跳过重渲染）。
      if (e.key === 'Control') {
        setCtrlHeld(true);
        return;
      }

      let next: EditorTool | null = null;
      switch (e.key.toLowerCase()) {
        case 'q': next = 'place-tap'; break;
        case 'w': next = 'place-touch'; break;
        case 'e': next = 'place-slide'; break;
        case 'r': {
          // 双击 R 切换多选 / 单选模式。单击 R 仍切到 select 工具。
          const now = performance.now();
          if (now - lastRTime < 300) {
            // 双击：切换多选模式。
            lastRTime = 0;
            setIsMultiSelect((v) => !v);
            setEditorTool('select');
            e.preventDefault();
            return;
          }
          lastRTime = now;
          // 单击 R 从放置工具切回 select → 退出多选（双击 R 才保留多选）。
          if (editorToolRef.current !== 'select') setIsMultiSelect(false);
          next = 'select';
          break;
        }
        default: return;
      }
      e.preventDefault();
      setEditorTool(next);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        setCtrlHeld(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gameState]);

  // 不满足批量编辑条件时，框选方式重置为“正常”（默认）。
  // 批量编辑条件：多选模式下选中 ≥1；或非多选模式下选中 ≥2（回到单选不清除已选）。
  useEffect(() => {
    const batchActive = effectiveMultiSelect
      ? selectedNoteIds.length >= 1
      : selectedNoteIds.length >= 2;
    if (!batchActive) setMarqueeMode('normal');
  }, [effectiveMultiSelect, selectedNoteIds]);

  useEffect(() => {
    if (gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)) {
      // Throttle HUD state updates to ~20fps (frame % 3). The 3D canvas
      // (GameCanvas) reads audio time DIRECTLY from globalAudio in its
      // own 60fps rAF, so it is completely independent of this throttle.
      // Only the React-rendered HUD (combo, score, progress bar, ambient bg)
      // is driven by this state — 20fps is plenty for those non-motion UI
      // elements and avoids burning 1/3 of the frame budget on React
      // reconciliation every frame.
      // Time-based throttling replaces the old frame%3 counter. On a 144Hz
      // display the rAF fires ~144x/sec, so a frame-count throttle silently
      // became ~48fps of React reconciliation — the main mobile CPU hog.
      //   glow/BPM pulse → ~60fps (keeps the 12ms attack visible)
      //   progress bar   → ~30fps (imperative DOM write, no React re-render)
      // During pure gameplay we never call setGameTime, so App never reconciles
      // while playing. Editor preview still needs reactive time for its timeline.
      let lastGlow = 0;
      let lastHud = 0;
      const tick = () => {
        const nowMs = performance.now();
        const doGlow = nowMs - lastGlow >= 16;
        const doHud = nowMs - lastHud >= 33;
        if (doGlow) lastGlow = nowMs;
        if (doHud) lastHud = nowMs;

        const inEditorPreview = gameState === 'editor';

        if (qualityMode !== 'low') {
          // Pump current BPM into the audio clock (~60fps) so the pulse stays
          // tempo-synced across BPM shifts. Derived from the LIVE audio time
          // (not React state) to avoid stale-beat drift.
          if (doGlow) {
            const curT = globalAudio.getCurrentTime();
            const beat = secondsToBeatMultiBpm(
              curT,
              currentChart.metadata.bpm,
              currentChart.metadata.offset || 0,
              currentChart.metadata.bpmlist
            );
            globalAudio.setCurrentBpm(getBpmAtBeat(beat, currentChart.metadata.bpm, currentChart.metadata.bpmlist));
            const f = globalAudio.getAudioFrequencyData();
            const bg = bgSchemeRef.current;
            if (bg && ambientBgRef.current) {
              const glowExtent = 18 + f.loudness * 18 + f.beatPulse * 22;
              ambientBgRef.current.style.background =
                `radial-gradient(circle at 50% 50%, ${bg.gradientEnd} ${glowExtent}%, ${bg.gradientStart} 90%)`;
            }
          }
        }

        if (doHud) {
          const t = globalAudio.getCurrentTime();
          if (inEditorPreview) setGameTime(t);
          if (progressRef.current) {
            progressRef.current.style.width = `${Math.min(100, (t / (chartDurationRef.current || 1)) * 100)}%`;
          }
        }

        gameTimerRef.current = requestAnimationFrame(tick);
      };
      gameTimerRef.current = requestAnimationFrame(tick);
    } else {
      if (gameTimerRef.current) cancelAnimationFrame(gameTimerRef.current);
    }
    return () => {
      if (gameTimerRef.current) cancelAnimationFrame(gameTimerRef.current);
    };
  }, [gameState, editorPreviewPlaying, qualityMode]);

  // Visual Editor Callbacks
  const handlePlaceEditorNote = useCallback((x: number, y: number, beat?: number): { id: string; x: number; y: number; beat: number } | null => {
    const exactBeat = Math.round((beat ?? currentBeatRef.current) * 1000) / 1000;

    const noteType: NoteData['type'] =
      editorTool === 'place-slide' ? 'slide' : editorTool === 'place-touch' ? 'touch' : 'tap';

    const base = selectedNoteId ? selectedNoteId.split('#')[0] : null;
    const sel = base ? currentChartRef.current.notes.find((n) => n.id === base) : undefined;

    // Only the slide tool auto-chains: placing while a node of an existing slide
    // chain is selected appends a child node (selection stays on the head).
    // Tap/Touch (and any non-chainable case) place a standalone note and select it.
    if (editorTool === 'place-slide' && sel && sel.type === noteType) {
      const lastBeat = sel.nodes && sel.nodes.length > 0 ? sel.nodes[sel.nodes.length - 1].beat : sel.beat;
      const step = Math.max(snapSubdivision, 0.05);
      const newBeat = exactBeat > lastBeat + 0.001
        ? exactBeat
        : Math.round((lastBeat + step) * 1000) / 1000;
      const childIndex = (sel.nodes ?? []).length;
      setCurrentChart((prev) => {
        const updatedNotes = prev.notes.map((n) =>
          n.id === sel.id ? { ...n, nodes: [...(n.nodes ?? []), { beat: newBeat, x, y }] } : n
        );
        return { ...prev, notes: updatedNotes };
      });
      // 保持选中在链头上：多选集合同步为头节点，避免 Ctrl 切到多选后集合为空。
      setSelectedNoteId(sel.id);
      setSelectedNoteIds([sel.id]);
      // 返回新子节点的 id 与 x/y/beat（slide 子节点不受 DSL 影响，即传入值）。
      return { id: `${sel.id}#${childIndex + 1}`, x, y, beat: newBeat };
    }

    // Short, collision-resistant id: a 7-char base36 random (~78e9 combos).
    const newNoteId = `ed-${Math.random().toString(36).slice(2, 9)}`;
    const newNote: NoteData = applyDslToNote(
      { id: newNoteId, beat: exactBeat, x, y, type: noteType, nodes: [] },
      editorDslRef.current
    );
    // 统一选中数据源：单选焦点与多选集合都指向新音符，避免 Ctrl 切到多选后
    // 该音符不被视为已选中（多选集合为空）。
    setSelectedNoteId(newNoteId);
    setSelectedNoteIds([newNoteId]);
    setCurrentChart((prev) => ({ ...prev, notes: [...prev.notes, newNote].sort((a, b) => a.beat - b.beat) }));
    // 返回新音符 id 与 DSL 处理后的实际 x/y/beat，供 2D 放置后仅调整 y、
    // x/beat 使用规则结果（不再拉回拖动前的原值）。
    return { id: newNoteId, x: newNote.x, y: newNote.y, beat: newNote.beat };
  }, [editorTool, selectedNoteId, snapSubdivision]);

  const handleMoveEditorNote = useCallback((id: string, x: number, y: number, beat?: number) => {
    const hashIdx = id.indexOf('#');
    if (hashIdx >= 0) {
      const base = id.slice(0, hashIdx);
      const childIdx = parseInt(id.slice(hashIdx + 1)) - 1;
      setCurrentChart((prev) => {
        const updatedNotes = prev.notes.map((n) => {
          if (n.id !== base || !n.nodes || childIdx < 0 || childIdx >= n.nodes.length) return n;
          const nodes = n.nodes.map((sn, i) => (i === childIdx ? { ...sn, x, y, ...(beat != null ? { beat } : {}) } : sn));
          return { ...n, nodes };
        });
        return { ...prev, notes: updatedNotes };
      });
      return;
    }
    setCurrentChart((prev) => {
      const updatedNotes = prev.notes.map((n) => (n.id === id ? { ...n, x, y, ...(beat != null ? { beat } : {}) } : n));
      return { ...prev, notes: updatedNotes };
    });
  }, []);

  const handleSelectEditorNote = useCallback((id: string | null) => {
    // 统一选中逻辑：selectedNoteIds 为唯一数据源（含子节点 id#i），
    // selectedNoteId 仅在集合长度为 1 时作为单选焦点（与集合同步）。
    if (id === null) {
      // 取消单选焦点。多选模式保留集合（批量弹窗不消失）；
      // 单选模式（含切换工具后）清空集合，使音符视觉上取消选中。
      setSelectedNoteId(null);
      if (!effectiveMultiSelect) setSelectedNoteIds([]);
      return;
    }
    if (effectiveMultiSelect) {
      // 多选模式：切换精确 id（头节点或子节点独立选中，子节点不带动整条链）。
      const wasSelected = selectedNoteIdsRef.current.includes(id);
      setSelectedNoteIds((prev) =>
        wasSelected ? prev.filter((x) => x !== id) : [...prev, id]
      );
      if (wasSelected) {
        // 取消选中：若该 note 恰是单选焦点，同步清除焦点，避免残留选中高亮。
        setSelectedNoteId((cur) => (cur === id ? null : cur));
      } else {
        setSelectedNoteId(id);
      }
    } else {
      // 单选模式：精确 id 作为集合唯一成员（子节点可独立选中，缺省参数继承头节点）。
      setSelectedNoteId(id);
      setSelectedNoteIds([id]);
    }
  }, [effectiveMultiSelect]);

  /** 切换多选模式（双击 select 工具 / 双击 R 触发）。 */
  const handleToggleMultiSelect = useCallback(() => {
    setIsMultiSelect((v) => !v);
  }, []);

  /** 工具切换统一入口：从其他工具（放置工具）单击切回 select 时退出多选，
   *  保证双击工具图标 / 双击 R 切回时才是多选工具；在 select 上单击不退出。 */
  const handleSetEditorTool = useCallback((tool: EditorTool) => {
    const prev = editorToolRef.current;
    setEditorTool(tool);
    // 切换到 select 且之前不是 select（发生了工具切换）→ 退出多选。
    if (tool === 'select' && prev !== 'select') {
      setIsMultiSelect(false);
    }
  }, []);

  /** 覆盖式设置多选集合（null = 清空）。同时清空单选焦点以避免两者不一致，
   *  也避免关闭批量弹窗后残留单音符面板。 */
  const handleSelectNotes = useCallback((ids: string[] | null) => {
    setSelectedNoteIds(ids ?? []);
    setSelectedNoteId(null);
  }, []);

  /** 按 marqueeMode 合并框选命中的 note id 到多选集合。 */
  const handleMarqueeSelect = useCallback((hitIds: string[], mode: MarqueeMode) => {
    setSelectedNoteIds((prev) => {
      const set = new Set(prev);
      if (mode === 'normal') {
        return hitIds;
      }
      if (mode === 'add') {
        for (const id of hitIds) set.add(id);
        return Array.from(set);
      }
      if (mode === 'subtract') {
        for (const id of hitIds) set.delete(id);
        return Array.from(set);
      }
      // intersect: 框中已选中→取消，未选中→加入
      for (const id of hitIds) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      return Array.from(set);
    });
    setSelectedNoteId(null);
  }, []);

  /** 批量移动：接收一组绝对位置（头节点与子节点 id 均可），一次性写入。
   *  x 钳制 ±2.4、y 钳制 ±1.5；beat 不做下限钳制（2D 允许负拍）。
   *  传入绝对位置而非位移，避免节流多次提交造成位移累积。 */
  const handleMoveEditorNotes = useCallback((positions: Array<{ id: string; x: number; y: number; beat: number }>) => {
    if (positions.length === 0) return;
    const headMap = new Map<string, { x: number; y: number; beat: number }>();
    const childMap = new Map<string, { x: number; y: number; beat: number }>();
    for (const p of positions) {
      if (p.id.includes('#')) childMap.set(p.id, p);
      else headMap.set(p.id, p);
    }
    setCurrentChart((prev) => {
      const updatedNotes = prev.notes.map((n) => {
        const hp = headMap.get(n.id);
        let next = n;
        let changed = false;
        if (hp) {
          const nx = Math.max(-2.4, Math.min(2.4, hp.x));
          const ny = Math.max(-1.5, Math.min(1.5, hp.y));
          next = { ...n, x: nx, y: ny, beat: hp.beat };
          changed = true;
        }
        // 整条链一起移动：子节点也按绝对位置写入。
        if (n.nodes && n.nodes.length > 0) {
          const nodes = n.nodes.map((sn, i) => {
            const cp = childMap.get(`${n.id}#${i + 1}`);
            if (!cp) return sn;
            changed = true;
            return { ...sn, x: cp.x, y: cp.y, beat: cp.beat };
          });
          if (changed) next = { ...next, nodes };
        }
        return changed ? next : n;
      }).sort((a, b) => a.beat - b.beat);
      return { ...prev, notes: updatedNotes };
    });
  }, []);


  /** Batch-note insertion used by the "quick-create" gesture system. */
  type QcSlideEntry = NonNullable<QuickCreateDelta['slides']>[number];
  const handleApplyQuickCreateDelta = useCallback((delta: QuickCreateDelta) => {
    const newTaps: NoteData[] = (delta.taps ?? []).map((t) =>
      applyDslToNote(
        {
          id: `qc-${Math.random().toString(36).slice(2, 9)}`,
          beat: t.beat,
          x: t.x,
          y: t.y,
          type: 'tap',
        },
        editorDslRef.current
      )
    );
    const newTouches: NoteData[] = (delta.touches ?? []).map((t) =>
      applyDslToNote(
        {
          id: `qc-${Math.random().toString(36).slice(2, 9)}`,
          beat: t.beat,
          x: t.x,
          y: t.y,
          type: 'touch',
        },
        editorDslRef.current
      )
    );

    // Slide handling is dedup-aware: for an incoming slide {headBeat, headX,
    // headY, nodes[]}, we try to find an EXISTING slide note in the chart
    // whose head (beat, x, y) matches within tolerance — if found, the nodes
    // are MERGED into the existing note's nodes[] (deduplicated by beat) so
    // repeated in-place slide dispatches from qcOnMove don't pile up
    // duplicate slide notes.
    const slidePatches: Array<{ matchId: string | null; head: QcSlideEntry }> =
      (delta.slides ?? []).map((s: QcSlideEntry) => ({ matchId: null, head: s }));

    setCurrentChart((prev) => {
      const slidesUpdate = [...prev.notes];
      for (const patch of slidePatches) {
        const h = patch.head;
        const existingIdx = slidesUpdate.findIndex((n) =>
          n.type === 'slide'
          && Math.abs(n.beat - h.headBeat) < 1e-3
          && Math.abs(n.x - h.headX) < 1e-2
          && Math.abs(n.y - h.headY) < 1e-2
        );
        if (existingIdx >= 0) {
          patch.matchId = slidesUpdate[existingIdx].id;
          const existing = slidesUpdate[existingIdx];
          const curNodes = existing.nodes ? [...existing.nodes] : [];
          for (const newNode of h.nodes) {
            const dupIdx = curNodes.findIndex((n) => Math.abs(n.beat - newNode.beat) < 1e-3);
            if (dupIdx >= 0) {
              curNodes[dupIdx] = { ...curNodes[dupIdx], ...newNode };
            } else {
              curNodes.push(newNode);
            }
          }
          curNodes.sort((a, b) => a.beat - b.beat);
          slidesUpdate[existingIdx] = { ...existing, nodes: curNodes };
        }
      }

      // Create any slides that did NOT match an existing head.
      const newSlides: NoteData[] = slidePatches
        .filter((p) => p.matchId === null)
        .map((p) =>
          applyDslToNote(
            {
              id: `qc-${Math.random().toString(36).slice(2, 9)}`,
              beat: p.head.headBeat,
              x: p.head.headX,
              y: p.head.headY,
              type: 'slide',
              nodes: [...p.head.nodes],
            },
            editorDslRef.current
          )
        );

      const updatedNotes = [...slidesUpdate, ...newTaps, ...newTouches, ...newSlides]
        .sort((a, b) => a.beat - b.beat);

      return { ...prev, notes: updatedNotes };
    });

    // Per spec: suppressSelection → never auto-select notes or show panel.
    // In quick-create we always suppress, so just clear any stale selection.
    setSelectedNoteId(null);
    setSelectedNoteIds([]);
  }, []);

  const chartDuration = getChartDuration(currentChart);
  chartDurationRef.current = chartDuration;
  const judgedCount = stats.sPerfectCount + stats.perfectCount + stats.goodCount + stats.missCount;
  const remainingNotes = Math.max(0, stats.totalNotes - judgedCount);
  const potentialRank = calculateRank(
    stats.score + remainingNotes * calculateNoteScore('S-Perfect', Math.max(1, stats.totalNotes))
  );

  // =========================================================================
  // Per-chart HUD color palette (driven by currentChart.metadata.bgScheme).
  // We compute a handful of derivatives (lightened/darkened/alpha variants)
  // and expose them as CSS variables on the HUD root node. Tailwind classes
  // then reference those vars via arbitrary-value syntax, so hover /
  // transition modifiers keep working.
  // =========================================================================
  const rawBgScheme = (currentChart.metadata as any)?.bgScheme;
  const bgScheme = rawBgScheme && typeof rawBgScheme === 'object'
    ? { ...FALLBACK_BG, ...rawBgScheme }
    : FALLBACK_BG;
  const accent = bgScheme.accentColor;
  const hudCssVars: React.CSSProperties = {
    // solid variants
    '--hud-accent': accent,
    '--hud-accent-20': withAlpha(accent, 0.2),
    '--hud-accent-30': withAlpha(accent, 0.3),
    '--hud-accent-40': withAlpha(accent, 0.4),
    '--hud-accent-50': withAlpha(accent, 0.5),
    '--hud-accent-60': withAlpha(accent, 0.6),
    '--hud-accent-80': withAlpha(accent, 0.8),
    '--hud-accent-light': adjustBrightness(accent, 1.35),   // "cyan-300"-ish text
    '--hud-accent-bright': adjustBrightness(accent, 1.6),  // "cyan-200"-ish text
    '--hud-accent-dark': adjustBrightness(accent, 0.55),   // gradient end (like blue-600)
    '--hud-accent-deep': adjustBrightness(accent, 0.32),   // cyan-950
    '--hud-accent-900': adjustBrightness(accent, 0.22),    // cyan-900 for buttons
    // panel background: mix gradientStart (chart's ambient dark) with near-black
    '--hud-panel-bg': withAlpha(
      // Convert gradientStart mix with #000 first, then re-parse to add alpha.
      // We keep it simple: take gradientStart and just give it opacity.
      (bgScheme.gradientStart.startsWith('rgb') || bgScheme.gradientStart.startsWith('hsl'))
        ? '#0a1124'
        : bgScheme.gradientStart,
      0.9,
    ),
    // glow drop-shadow for countdown (we'll use inline style for precision)
  } as any;
  // Computed inline glow variants for combo-burst / countdown drop-shadows
  // (drop-shadow doesn't take CSS var colors in all browsers, so pass directly)
  const comboBurstStroke = withAlpha(accent, 0.6);
  const countdownGlow = `drop-shadow(0 0 40px ${withAlpha(accent, 0.6)})`;
  const hudAccentLight = adjustBrightness(accent, 1.35);
  const hudAccentBright = adjustBrightness(accent, 1.6);
  const hudAccentDark = adjustBrightness(accent, 0.55);
  const hudAccent40 = withAlpha(accent, 0.4);
  const hudAccent60 = withAlpha(accent, 0.6);
  const hudAccent20 = withAlpha(accent, 0.2);
  const hudAccent10 = withAlpha(accent, 0.1);
  // Panel border tint (accent) — used on the glass pause card edge
  const panelBorder = withAlpha(accent, 0.4);
  // Primary button: gradient-from accent -> accent-dark
  const primaryGradient = `linear-gradient(135deg, ${accent} 0%, ${hudAccentDark} 100%)`;
  const primaryGradientHover = `linear-gradient(135deg, ${hudAccentLight} 0%, ${accent} 100%)`;
  const primaryShadow = `0 10px 25px -5px ${withAlpha(accent, 0.45)}`;
  // Progress bar
  const progressGradient = `linear-gradient(90deg, ${hudAccentLight} 0%, ${hudAccentDark} 100%)`;

  // Cache the live chart's bg scheme so the HUD rAF can build the ambient
  // gradient every frame without going through React state.
  bgSchemeRef.current = currentChart.metadata.bgScheme;

  // Paint an initial ambient background for the current chart so it's correct
  // before the first HUD frame (and while paused / not yet playing). The HUD
  // rAF overwrites it each frame during play; because the element has no
  // `style` prop, React never resets it on re-renders.
  useEffect(() => {
    const bg = currentChart.metadata.bgScheme;
    if (ambientBgRef.current) {
      ambientBgRef.current.style.background =
        `radial-gradient(circle at 50% 50%, ${bg.gradientEnd} 21.6%, ${bg.gradientStart} 90%)`;
    }
  }, [currentChart]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#0a0d12] select-none text-white font-rajdhani">
      {/* Dynamic Ambient BG — fully static dark color in Low Quality Mode to save massive shader resources */}
      {qualityMode === 'low' ? (
        <div className="absolute inset-0 bg-[#0e1218] pointer-events-none z-0" />
      ) : (
        <div
          ref={ambientBgRef}
          className="absolute inset-0 pointer-events-none opacity-75"
        />
      )}

      {/* 3D Viewport — always mounted. In 2D editor mode the viewport stays
          mounted but GameCanvas pauses its rAF render loop via `viewportActive`
          (zero background cost: no render, no window update, no per-frame work),
          so switching back to 3D resumes instantly without rebuilding the WebGL
          scene / re-creating every note mesh (that rebuild was a [Violation]
          multi-hundred-ms hitch). The paused loop therefore no longer starves
          the 2D canvas of frame budget either. */}
      <div
        className="absolute inset-0 z-0"
        data-viewport="3d"
        onWheel={handleEditorWheel}
      >
        <Suspense fallback={null}>
        <GameCanvas
          chart={currentChart}
          viewportActive={!(gameState === 'editor' && editorViewMode === '2d')}
          isPlaying={gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)}
          isPaused={gameState === 'paused'}
          gameTime={gameTime}
          speedMultiplier={speedMultiplier}
          projectionLeadMs={projectionLeadMs}
          noteRenderDistance={noteRenderDistance}
          noteSizeScale={noteSizeScale}
          qualityMode={qualityMode}
          antialias={qualityMode === 'custom' ? customAntialias : qualityMode !== 'low'}
          allowBloom={qualityMode === 'custom' ? customBloom : (qualityMode === 'high' || qualityMode === 'ultra')}
          allowParticles={qualityMode === 'custom' ? customParticles : (qualityMode === 'high' || qualityMode === 'ultra')}
          allowDynamicLighting={qualityMode === 'custom' ? customDynamicLighting : qualityMode === 'ultra'}
          allowHitEffects={qualityMode === 'custom' ? customHitEffects : qualityMode === 'ultra'}
          renderScale={qualityMode === 'custom' ? customRenderScale : (qualityMode === 'low' ? 0.75 : 1.0)}
          autoPlay={autoPlay}
          playSession={playSession}
          isEditorMode={gameState === 'editor'}
          activeEditorTool={effectiveEditorTool}
          selectedNoteId={selectedNoteId}
          selectedNoteIds={selectedNoteIds}
          isMultiSelect={effectiveMultiSelect}
          snapSubdivision={snapSubdivision}
          onJudgement={handleJudgementStable}
          onSongEnd={handleSongEnd}
          onSelectEditorNote={handleSelectEditorNote}
          onMoveEditorNote={handleMoveEditorNote}
          onPlaceEditorNote={handlePlaceEditorNote}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
          skinTextures={skinTextures}
          defaultSkinInnerEnabled={defaultSkinInnerEnabled}
          defaultSkinOuterEnabled={defaultSkinOuterEnabled}
          defaultSkinOuterWidth={defaultSkinOuterWidth}
          defaultSkinOuterColor={defaultSkinOuterColor}
          defaultSkinOuterAlpha={defaultSkinOuterAlpha}
          defaultSkinJudgeWidth={defaultSkinJudgeWidth}
        />
        </Suspense>
      </div>

      {/* 2D top-down editor viewport (replaces 3D when in 2D mode) */}
      {gameState === 'editor' && editorViewMode === '2d' && (
        <div className="absolute inset-0 z-0" data-viewport="2d">
          <Suspense fallback={null}>
          <Editor2DCanvas
            chart={currentChart}
            gameTime={gameTime}
            isPlaying={editorPreviewPlaying}
            snapSubdivision={snapSubdivision}
            activeTool={effectiveEditorTool}
            selectedNoteId={selectedNoteId}
            isMultiSelect={effectiveMultiSelect}
            selectedNoteIds={selectedNoteIds}
            marqueeMode={marqueeMode}
            vlineCount={editorVlineCount}
            pxPerBeat={editorPxPerBeat}
            onPlaceNote={(x, y, beat) => handlePlaceEditorNote(x, y, beat)}
            onMoveNote={(id, x, y, beat) => handleMoveEditorNote(id, x, y, beat)}
            onSelectNote={handleSelectEditorNote}
            onSeekBeat={handleSeekBeat}
            onSelectNotes={handleSelectNotes}
            onMarqueeSelect={handleMarqueeSelect}
            onMoveNotes={handleMoveEditorNotes}
          />
          </Suspense>
        </div>
      )}

      {/* ── UI 层：游戏内 / 编辑器 UI 全屏铺满，仅靠 safe-area 避开刘海/灵动岛；不再有 2:1 强行限制 ── */}
      <div
        className="absolute inset-0 z-10 pointer-events-none"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
        }}
      >

      {/* Visual Chart Editor Overlay when in Editor Mode */}
      {gameState === 'editor' && (
        <Suspense fallback={null}>
        <VisualChartEditor
          chart={currentChart}
          currentBeat={currentBeat}
          currentTimeSec={gameTime}
          isPlaying={editorPreviewPlaying}
          activeTool={effectiveEditorTool}
          selectedNoteId={selectedNoteId}
          batchSelection={batchSelection}
          isMultiSelect={effectiveMultiSelect}
          selectedNoteIds={selectedNoteIds}
          marqueeMode={marqueeMode}
          snapSubdivision={snapSubdivision}
          viewMode={editorViewMode}
          onSetViewMode={(mode) => {
            setEditorViewMode(mode);
            if (mode === '2d' && editorTool === 'quick-create') {
              // Quick-create is unavailable in 2D mode.
              setEditorTool('select');
              setSelectedNoteId(null);
              setBatchSelection({ startBeat: null, endBeat: null });
            }
          }}
          onUpdateChart={(updated) => setCurrentChart((prev) => ({ ...prev, ...updated }))}
          onSeekBeat={handleSeekBeat}
          onTogglePlay={handleEditorTogglePlay}
          onSetActiveTool={(tool) => {
            handleSetEditorTool(tool);
            if (tool === 'quick-create') {
              // Quick-create mode must not show the floating edit panel, even
              // for a note that a prior "select" tool left highlighted.
              setSelectedNoteId(null);
              setBatchSelection({ startBeat: null, endBeat: null });
            }
          }}
          onSelectNote={handleSelectEditorNote}
          onSetBatchSelection={(sel) => setBatchSelection(sel)}
          onToggleMultiSelect={handleToggleMultiSelect}
          onSelectNotes={handleSelectNotes}
          onMarqueeSelect={handleMarqueeSelect}
          onSetMarqueeMode={(m) => setMarqueeMode(m)}
          onMoveEditorNotes={handleMoveEditorNotes}
          onSetSnapSubdivision={(snap) => setSnapSubdivision(snap)}
          vlineCount={editorVlineCount}
          onSetVlineCount={(n) => setEditorVlineCount(n)}
          pxPerBeat={editorPxPerBeat}
          onSetPxPerBeat={(n) => setEditorPxPerBeat(n)}
          playbackRate={editorPlaybackRate}
          onSetPlaybackRate={(rate) => {
            setEditorPlaybackRate(rate);
            globalAudio.setPlaybackRate(rate);
          }}
          onUploadAudioFile={async (file) => {
            await globalAudio.loadAudioFile(file);
            setHasCustomAudio(true);
            customAudioFileRef.current = file;
            try {
              currentAudioRefRef.current = await storeFile(file);
            } catch (err) {
              console.error('保存音频失败', err);
            }
          }}
          onExitEditor={handleReturnToMenu}
          onSaveToLocal={handleSaveChartToLocal}
          onStartPlayTest={handleStartPlayTest}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
          editorDsl={editorDsl}
          onEditorDslChange={(dsl: string) => { setEditorDsl(dsl); saveEditorDsl(dsl); }}
        />
        </Suspense>
      )}

      {/* Normal Gameplay In-Game HUD */}
      {(gameState === 'playing' || gameState === 'paused') && (
        <div
          className={`absolute inset-0 z-10 pointer-events-none transition-opacity duration-300 ${
            transitionPhase === 'fade-out' ? 'opacity-0' : 'opacity-100'
          }`}
          style={hudCssVars}
        >
          {/* Background-layer Combo (large, semi-transparent, behind notes) */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {stats.combo > 0 && (
              <div className="flex flex-col items-center select-none">
                <div
                  className="text-[12rem] leading-none font-black font-orbitron text-white/[0.07] tracking-tighter"
                  style={{ textShadow: 'none' }}
                >
                  {stats.combo}
                </div>
                <div className="text-sm font-bold uppercase tracking-[0.4em] text-white/[0.12] -mt-6">
                  COMBO
                </div>
              </div>
            )}
            {comboBurst && (
              <div
                key={comboBurst.key}
                className="absolute flex items-center justify-center pointer-events-none"
                style={{ animation: 'comboBurstAnim 600ms ease-out forwards' }}
              >
                <div
                  className="text-[10rem] font-black font-orbitron text-transparent tracking-tighter"
                  style={{ WebkitTextStroke: `2px ${comboBurstStroke}` }}
                >
                  {comboBurst.value}
                </div>
              </div>
            )}
          </div>

          {/* Top HUD overlay */}
          <div className="absolute inset-x-0 top-0 z-10 pointer-events-none bg-gradient-to-b from-black/55 via-black/15 to-transparent">
            <TimingBar markers={timingMarkers} accentColor={accent} />

            <div className="flex items-start justify-between px-4 pt-2">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold uppercase border backdrop-blur-md"
                    style={{
                      background: hudAccent20,
                      color: hudAccentLight,
                      borderColor: hudAccent40,
                      boxShadow: `0 0 12px ${hudAccent20}, inset 0 1px 0 rgba(255,255,255,0.15)`,
                    }}
                  >
                    {currentChart.metadata.difficulty}
                  </span>
                  <span className="text-xs text-white/55 font-mono">
                    BPM {currentChart.metadata.bpm}
                  </span>
                </div>
                <h2 className="text-lg font-bold font-orbitron tracking-wider text-white drop-shadow-md">
                  {currentChart.metadata.title}
                </h2>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/50">Score</div>
                <div className="text-3xl font-black font-orbitron tracking-tight text-transparent bg-clip-text" style={{ backgroundImage: `linear-gradient(90deg, #ffffff 0%, ${hudAccentBright} 55%, #fcd34d 100%)` }}>
                  {Math.round(stats.score).toLocaleString().padStart(8, '0')}
                </div>
                <div style={{ color: hudAccentLight }} className="text-xs font-mono">
                  ACC: {stats.accuracy.toFixed(2)}% | RANK: {potentialRank}
                </div>
              </div>
            </div>
          </div>

          {/* 3-Second Resume Countdown overlay */}
          {countdownVal !== null && (
            <div
              className={`absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40 pointer-events-none transition-all duration-500 ${
                countdownVal === 3
                  ? 'backdrop-blur-[8px]'
                  : countdownVal === 2
                  ? 'backdrop-blur-[4px]'
                  : 'backdrop-blur-none'
              }`}
            >
              <div className="text-center">
                <div
                  className="text-8xl sm:text-[10rem] font-black font-orbitron tracking-tighter scale-110 animate-pulse"
                  style={{ color: hudAccentLight, filter: countdownGlow }}
                >
                  {countdownVal}
                </div>
                <div className="text-xs font-bold uppercase tracking-[0.3em] text-white/55 mt-4">
                  {t('hud.getReady')}
                </div>
              </div>
            </div>
          )}

          {/* Dark Pause Overlay with Action Cards */}
          {gameState === 'paused' && countdownVal === null && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/65 backdrop-blur-md pointer-events-auto">
              <div
                className="glass-panel-strong text-center max-w-sm w-full p-6 rounded-3xl animate-in zoom-in-95 duration-200"
                style={{ borderColor: panelBorder }}
              >
                <div
                  className="font-bold tracking-widest uppercase text-xs font-orbitron mb-1"
                  style={{ color: hudAccentLight }}
                >
                  {isPlayTestMode ? t('hud.playTestPaused') : t('hud.paused')}
                </div>
                <h2 className="text-xl font-bold font-orbitron text-white tracking-wider mb-6">
                  {currentChart.metadata.title}
                </h2>

                {/* 3 Cybernetic Circle Buttons (返回, 重试, 继续) */}
                <div className="flex items-center justify-center gap-6 mb-4">
                  {/* Exit/Return button (neutral glass — not themed) */}
                  <button
                    onClick={isPlayTestMode ? handleExitPlayTest : handleReturnToMenu}
                    className="glass-btn w-14 h-14 rounded-full text-white/85 hover:text-white flex items-center justify-center cursor-pointer group"
                    title={isPlayTestMode ? t('hud.backToEditor') : t('hud.backToMenu')}
                  >
                    <ArrowLeft size={22} className="group-hover:-translate-x-0.5 transition" />
                  </button>

                  {/* Continue/Resume button (primary accent themed) */}
                  <button
                    onClick={handleTogglePause}
                    className="w-18 h-18 rounded-full border text-white flex items-center justify-center transition cursor-pointer transform hover:scale-105 active:scale-95"
                    title={t('hud.continue')}
                    style={{
                      borderColor: hudAccentLight,
                      background: primaryGradient,
                      boxShadow: primaryShadow,
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = primaryGradientHover; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = primaryGradient; }}
                  >
                    <Play size={26} className="fill-white translate-x-0.5" />
                  </button>

                  {/* Restart/Retry button (subtle accent-tinted glass) */}
                  <button
                    onClick={() => isPlayTestMode ? handleStartPlayTest(false, true) : handleStartGame(currentChart, hasCustomAudio, currentSongInfo?.songId, currentSongInfo?.scoreKey, currentSongInfo?.diffName)}
                    className="w-14 h-14 rounded-full border flex items-center justify-center transition cursor-pointer group"
                    title={t('hud.retry')}
                    style={{
                      borderColor: hudAccent40,
                      background: withAlpha(accent, 0.1),
                      color: hudAccentLight,
                      boxShadow: `0 0 16px ${hudAccent10}, inset 0 1px 0 rgba(255,255,255,0.12)`,
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = withAlpha(accent, 0.2);
                      el.style.color = hudAccentBright;
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = withAlpha(accent, 0.1);
                      el.style.color = hudAccentLight;
                    }}
                  >
                    <RotateCcw size={20} className="group-hover:rotate-45 transition" />
                  </button>
                </div>

                <div className="text-[10px] text-white/45 uppercase tracking-wider">
                  {isPlayTestMode ? t('hud.backEditorStates') : t('hud.backMenuStates')}
                </div>
              </div>
            </div>
          )}

          {/* Bottom HUD: Progress Bar is pinned to the absolute bottom */}
          <div className="absolute inset-x-0 bottom-0 z-10 pointer-events-auto px-4 pb-1.5 bg-gradient-to-t from-black/75 via-black/25 to-transparent pt-6">
            <div
              className="w-full h-1 rounded-full overflow-hidden border backdrop-blur-sm"
              style={{
                background: 'rgba(255,255,255,0.06)',
                borderColor: 'rgba(255,255,255,0.12)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
              }}
            >
              <div
                ref={progressRef}
                className="h-full transition-all duration-100 rounded-full"
                style={{
                  background: progressGradient,
                  boxShadow: `0 0 12px ${hudAccent60}`,
                }}
              />
            </div>
          </div>

          {/* Pause Button sits strictly above the timeline */}
          <div className="absolute left-4 bottom-4 z-20 pointer-events-auto">
            <button
              onClick={handleTogglePause}
              disabled={isSongEnded}
              className={`p-1.5 rounded-lg border backdrop-blur-md transition ${isSongEnded ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              title={isSongEnded ? t('hud.songEnded') : t('hud.pause')}
              style={{
                background: withAlpha(accent, 0.12),
                borderColor: withAlpha(accent, 0.4),
                color: hudAccentLight,
                boxShadow: `0 0 14px ${hudAccent10}, inset 0 1px 0 rgba(255,255,255,0.14)`,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = withAlpha(accent, 0.24); }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = withAlpha(accent, 0.12); }}
            >
              <Pause size={16} />
            </button>
          </div>

          {/* Speed & AutoPlay display sits on bottom right above timeline */}
          <div className="absolute right-4 bottom-4 z-20 pointer-events-none font-mono text-[11px] text-white/55 flex items-center gap-3">
            <span>×{speedMultiplier.toFixed(1)}</span>
            {autoPlay && <span className="text-amber-400 font-bold">[AUTO]</span>}
          </div>
        </div>
      )}

      </div>{/* /UI 框 */}

      {/* Main Menu Screen — Vertical Card Carousel (封面背景全屏；卡片 UI 全屏铺满，靠 safe-area 避让刘海，无 2:1 限制) */}
      {gameState === 'menu' && (
        <div className={`absolute inset-0 z-20 transition-opacity duration-300 ${
          transitionPhase === 'fade-out' ? 'opacity-0' : 'opacity-100'
        } ${transitionPhase === 'fade-in' ? 'animate-fade-in' : ''}`}>
          <SongSelect
            autoPlay={autoPlay}
            initialState={songSelectState ?? undefined}
            result={resultInfo}
            onClearResult={() => setResultInfo(null)}
            onRetryCustom={() => handleStartGame(currentChart, hasCustomAudio)}
            onToggleAutoPlay={() => setAutoPlay((v) => !v)}
            onOpenSettings={() => setShowSettings(true)}
            onOpenEditor={handleOpenVisualEditor}
            onLaunchChartEditor={handleLaunchChartEditor}
            onSwitchLite={() => { window.location.href = 'lite/index.html'; }}
            onStartGame={(chart, hasAudio, songId, scoreKey, diffName) => handleStartGame(chart, hasAudio, songId, scoreKey, diffName)}
            onStateChange={handleSongSelectStateChange}
          />
        </div>
      )}

      <Suspense fallback={null}>
      <UnitTestModal isOpen={showUnitTest} onClose={() => setShowUnitTest(false)} />
      </Suspense>
      <Suspense fallback={null}>
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        speedMultiplier={speedMultiplier}
        setSpeedMultiplier={setSpeedMultiplier}
        audioOffsetMs={audioOffsetMs}
        setAudioOffsetMs={setAudioOffsetMs}
        projectionLeadMs={projectionLeadMs}
        setProjectionLeadMs={setProjectionLeadMs}
        noteRenderDistance={noteRenderDistance}
        setNoteRenderDistance={setNoteRenderDistance}
        noteSizeScale={noteSizeScale}
        setNoteSizeScale={setNoteSizeScale}
        qualityMode={qualityMode}
        setQualityMode={setQualityMode}
        customAntialias={customAntialias}
        setCustomAntialias={setCustomAntialias}
        customBloom={customBloom}
        setCustomBloom={setCustomBloom}
        customParticles={customParticles}
        setCustomParticles={setCustomParticles}
        customDynamicLighting={customDynamicLighting}
        setCustomDynamicLighting={setCustomDynamicLighting}
        customHitEffects={customHitEffects}
        setCustomHitEffects={setCustomHitEffects}
        customRenderScale={customRenderScale}
        setCustomRenderScale={setCustomRenderScale}
        musicVolume={musicVolume}
        setMusicVolume={setMusicVolume}
        effectVolume={effectVolume}
        setEffectVolume={setEffectVolume}
        selectedSkinId={selectedSkinId}
        setSelectedSkinId={setSelectedSkinId}
        defaultSkinInnerEnabled={defaultSkinInnerEnabled}
        setDefaultSkinInnerEnabled={setDefaultSkinInnerEnabled}
        defaultSkinOuterEnabled={defaultSkinOuterEnabled}
        setDefaultSkinOuterEnabled={setDefaultSkinOuterEnabled}
        defaultSkinOuterWidth={defaultSkinOuterWidth}
        setDefaultSkinOuterWidth={setDefaultSkinOuterWidth}
        defaultSkinOuterColor={defaultSkinOuterColor}
        setDefaultSkinOuterColor={setDefaultSkinOuterColor}
        defaultSkinOuterAlpha={defaultSkinOuterAlpha}
        setDefaultSkinOuterAlpha={setDefaultSkinOuterAlpha}
        defaultSkinJudgeWidth={defaultSkinJudgeWidth}
        setDefaultSkinJudgeWidth={setDefaultSkinJudgeWidth}
      />
      </Suspense>
      {/* Clear Banner (FC / AP / AP+) */}
      {clearBanner && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div
            className={`px-12 py-4 sm:px-16 sm:py-5 rounded-2xl font-black font-orbitron text-4xl sm:text-5xl tracking-[0.2em] uppercase ${
              clearBanner === 'FC'
                ? 'bg-sky-500/20 border-4 border-sky-400 text-sky-300 shadow-[0_0_60px_rgba(56,189,248,0.6)]'
                : clearBanner === 'AP'
                ? 'bg-amber-500/20 border-4 border-amber-400 text-amber-300 shadow-[0_0_60px_rgba(251,191,36,0.6)]'
                : 'bg-amber-500/20 border-4 border-amber-400 text-amber-300 shadow-[0_0_80px_rgba(251,146,60,0.8),0_0_40px_rgba(251,191,36,0.6)]'
            }`}
            style={{
              animation: 'clearBannerEnter 600ms cubic-bezier(0.18, 0.9, 0.22, 1.2) forwards, clearBannerExit 500ms 1.3s ease-in forwards',
            }}
          >
            {clearBanner === 'FC' ? 'FULL COMBO' : clearBanner === 'AP' ? 'ALL PERFECT' : 'ALL PERFECT+'}
          </div>
        </div>
      )}

      {/* 轻量 Toast（谱面保存反馈等） */}
      {appToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-xl glass-panel-strong text-sm font-bold text-white/90 shadow-2xl border border-white/15">
          {appToast}
        </div>
      )}

    </div>
  );
}

export default App;
