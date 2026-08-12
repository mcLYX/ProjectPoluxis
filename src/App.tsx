import { useState, useEffect, useRef, useCallback } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { Editor2DCanvas } from './components/Editor2DCanvas';
import { VisualChartEditor, EditorTool, BatchSelection, QuickCreateDelta } from './components/VisualChartEditor';
import { UnitTestModal } from './components/UnitTestModal';
import { FileManagerModal } from './components/FileManagerModal';
import { DocModal } from './components/DocModal';
import { SongSelect, SongSelectNavState, ResultInfo } from './components/SongSelect';
import { TimingBar, TimingMarker } from './components/TimingBar';
import { SettingsModal } from './components/SettingsModal';
import { DEMO_CHARTS } from './data/demoCharts';
import type { QualityMode } from './types/game';
import { ChartData, GameStats, JudgementFeedback, NoteData } from './types/game';
import { calculateNoteScore, calculateRank } from './utils/scoring';
import { getChartDuration, beatToSecondsMultiBpm, secondsToBeatMultiBpm, countPlayableNotes, getFirstNoteTime, getBpmAtBeat } from './utils/beatTime';
import { submitScore, calcBadgeFromStats } from './utils/scoreStore';
import { globalAudio } from './audio/AudioManager';
import { useI18n } from './i18n';
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
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${clamp(r * factor)}, ${clamp(g * factor)}, ${clamp(b * factor)})`;
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
  musicVolume: 0.8,
  effectVolume: 0.9,
};

function loadSettings(): typeof DEFAULT_SETTINGS {
  try {
    const saved = window.localStorage.getItem('poluxis-settings');
    if (!saved) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(saved);
    const result: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };
    // Migrate legacy `lowQualityMode: boolean` → `qualityMode: 'low'|'standard'`.
    if (parsed && typeof parsed.lowQualityMode === 'boolean' && parsed.qualityMode === undefined) {
      result.qualityMode = parsed.lowQualityMode ? 'low' : 'standard';
      delete (parsed as any).lowQualityMode;
    }
    for (const k of Object.keys(result) as Array<keyof typeof DEFAULT_SETTINGS>) {
      if (typeof parsed[k] === typeof result[k]) {
        (result as any)[k] = parsed[k];
      }
    }
    return result;
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: typeof DEFAULT_SETTINGS) {
  try {
    window.localStorage.setItem('poluxis-settings', JSON.stringify(settings));
  } catch (e) { /* ignore quota / private mode errors */ }
}

export function App() {
  const { t } = useI18n();
  const initialSettings = loadSettings();

  const [currentChart, setCurrentChart] = useState<ChartData>(DEMO_CHARTS['neon-cyberspace']);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'paused' | 'editor'>('menu');
  const [gameTime, setGameTime] = useState(0);
  const [speedMultiplier, setSpeedMultiplier] = useState(initialSettings.speedMultiplier);
  const [autoPlay, setAutoPlay] = useState(false);
  const [audioOffsetMs, setAudioOffsetMs] = useState(initialSettings.audioOffsetMs);
  const [projectionLeadMs, setProjectionLeadMs] = useState(initialSettings.projectionLeadMs);
  const [noteRenderDistance, setNoteRenderDistance] = useState(initialSettings.noteRenderDistance);
  const [noteSizeScale, setNoteSizeScale] = useState(initialSettings.noteSizeScale);
  const [qualityMode, setQualityMode] = useState<QualityMode>(initialSettings.qualityMode);
  const [musicVolume, setMusicVolume] = useState(initialSettings.musicVolume);
  const [effectVolume, setEffectVolume] = useState(initialSettings.effectVolume);
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
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [batchSelection, setBatchSelection] = useState<BatchSelection>({ startBeat: null, endBeat: null });
  const [snapSubdivision, setSnapSubdivision] = useState<number>(0.25);
  const [editorPreviewPlaying, setEditorPreviewPlaying] = useState(false);
  const [editorPlaybackRate, setEditorPlaybackRate] = useState<number>(1);
  const [editorVlineCount, setEditorVlineCount] = useState<number>(13);
  const [editorPxPerBeat, setEditorPxPerBeat] = useState<number>(100);
  const [editorViewMode, setEditorViewMode] = useState<'3d' | '2d'>('3d');
  const [isPlayTestMode, setIsPlayTestMode] = useState(false);
  const playTestStartBeatRef = useRef(0);

  // Current song info for high score tracking
  const [currentSongInfo, setCurrentSongInfo] = useState<{ songId: string; diffName: string } | null>(null);
  // Post-play result shown on the song-select "result card" (null = normal menu)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null);
  const [clearBanner, setClearBanner] = useState<'FC' | 'AP' | 'AP+' | null>(null);

  // Modals
  const [showUnitTest, setShowUnitTest] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [stats, setStats] = useState<GameStats>({
    score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0,
    goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: 'EX+',
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
      noteSizeScale, qualityMode, musicVolume, effectVolume
    });
  }, [speedMultiplier, audioOffsetMs, projectionLeadMs, noteRenderDistance, noteSizeScale, qualityMode, musicVolume, effectVolume]);

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

  const handleStartGame = useCallback((chartData: ChartData = currentChart, useCustomAudio = hasCustomAudio, songId?: string, diffName?: string) => {
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
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(chartData), accuracy: 100, rank: 'EX+',
      });
      setTimingMarkers([]);
      setComboBurst(null);
      setResultInfo(null);
      if (songId && diffName) {
        setCurrentSongInfo({ songId, diffName });
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
   */
  const handleStartPlayTest = useCallback((fromCurrentBeat: boolean) => {
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
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!hasCustomAudio) {
        globalAudio.setSynthesizedTrack(currentChart.metadata.bpm);
      }

      const startTimeSec = fromCurrentBeat ? gameTime : 0;
      playTestStartBeatRef.current = fromCurrentBeat ? currentBeatRef.current : 0;

      setStats({
        score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0,
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: 'EX+',
      });
      setTimingMarkers([]);
      setComboBurst(null);
      setGameTime(startTimeSec);
      setPlaySession((s) => s + 1);
      setIsPlayTestMode(true);
      setGameState('playing');

      const leadIn = fromCurrentBeat ? 0 : Math.max(0, 2 - getFirstNoteTime(currentChart));
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
    setGameState('editor');
  }, []);

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
          const result = submitScore(currentSongInfo.songId, currentSongInfo.diffName, stats);
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
      // Give the chart clock a short lead-in that reaches the audio offset when
      // it is negative, so the song's true beginning (audioTime == 0, at
      // chartTime == offset, i.e. during the lead-in with chartTime < 0) plays
      // instead of starting from the middle. For positive offsets no lead-in is
      // needed (audio stays silent until the offset is reached).
      // Only pre-roll from the very top (gameTime <= 0): resuming mid-song must
      // continue from the snapshotted position, otherwise the lead-in would shove
      // the chart clock back to the offset and progress would jump backwards.
      const leadIn = (audioOffsetMs < 0 && gameTime <= 0) ? Math.max(0, -audioOffsetMs / 1000) : 0;
      globalAudio.play(gameTime, leadIn);
      setEditorPreviewPlaying(true);
    }
  };

  const handleSeekBeat = (beat: number) => {
    const snappedBeat = Math.round(beat / snapSubdivision) * snapSubdivision;
    const targetSec = Math.max(
      0,
      beatToSecondsMultiBpm(
        snappedBeat,
        currentChart.metadata.bpm,
        currentChart.metadata.offset || 0,
        currentChart.metadata.bpmlist
      )
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
    handleSeekBeat(Math.max(0, curBeat + deltaBeats));
  }, [gameState, gameTime, currentChart, snapSubdivision, handleSeekBeat]);

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

  const handleSelectCustomSong = async (chart: ChartData, audioFile?: File) => {
    setCurrentChart(chart);
    if (audioFile) {
      try {
        await globalAudio.loadAudioFile(audioFile);
        setHasCustomAudio(true);
        handleStartGame(chart, true);
      } catch (err) {
        // Decode failed (e.g. Safari can't play OGG) — fall back to the
        // procedural synth so the game still starts, and explain in console.
        console.error('[audio] custom audio decode failed, using synth:', err);
        setHasCustomAudio(false);
        handleStartGame(chart, false);
      }
    } else {
      setHasCustomAudio(false);
      handleStartGame(chart, false);
    }
  };

  // Visual Editor Callbacks
  const handlePlaceEditorNote = useCallback((x: number, y: number, beat?: number) => {
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
      setCurrentChart((prev) => {
        const updatedNotes = prev.notes.map((n) =>
          n.id === sel.id ? { ...n, nodes: [...(n.nodes ?? []), { beat: newBeat, x, y }] } : n
        );
        return { ...prev, notes: updatedNotes };
      });
      return;
    }

    // Short, collision-resistant id: a 7-char base36 random (~78e9 combos).
    const newNoteId = `ed-${Math.random().toString(36).slice(2, 9)}`;
    const newNote: NoteData = { id: newNoteId, beat: exactBeat, x, y, type: noteType, nodes: [] };
    setSelectedNoteId(newNoteId);
    setCurrentChart((prev) => ({ ...prev, notes: [...prev.notes, newNote].sort((a, b) => a.beat - b.beat) }));
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
    setSelectedNoteId(id);
  }, []);

  /** Batch-note insertion used by the "quick-create" gesture system. */
  type QcSlideEntry = NonNullable<QuickCreateDelta['slides']>[number];
  const handleApplyQuickCreateDelta = useCallback((delta: QuickCreateDelta) => {
    const newTaps: NoteData[] = (delta.taps ?? []).map((t) => ({
      id: `qc-${Math.random().toString(36).slice(2, 9)}`,
      beat: t.beat,
      x: t.x,
      y: t.y,
      type: 'tap',
    }));
    const newTouches: NoteData[] = (delta.touches ?? []).map((t) => ({
      id: `qc-${Math.random().toString(36).slice(2, 9)}`,
      beat: t.beat,
      x: t.x,
      y: t.y,
      type: 'touch',
    }));

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
        .map((p) => ({
          id: `qc-${Math.random().toString(36).slice(2, 9)}`,
          beat: p.head.headBeat,
          x: p.head.headX,
          y: p.head.headY,
          type: 'slide',
          nodes: [...p.head.nodes],
        }));

      const updatedNotes = [...slidesUpdate, ...newTaps, ...newTouches, ...newSlides]
        .sort((a, b) => a.beat - b.beat);

      return { ...prev, notes: updatedNotes };
    });

    // Per spec: suppressSelection → never auto-select notes or show panel.
    // In quick-create we always suppress, so just clear any stale selection.
    setSelectedNoteId(null);
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

      {/* 3D Viewport — only active during gameplay/editor to save memory on low-end devices */}
      <div
        className="absolute inset-0 z-0"
        data-viewport="3d"
        onWheel={handleEditorWheel}
        style={{ display: gameState === 'editor' && editorViewMode === '2d' ? 'none' : 'block' }}
      >
        <GameCanvas
          chart={currentChart}
          isPlaying={gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)}
          isPaused={gameState === 'paused'}
          gameTime={gameTime}
          speedMultiplier={speedMultiplier}
          projectionLeadMs={projectionLeadMs}
          noteRenderDistance={noteRenderDistance}
          noteSizeScale={noteSizeScale}
          qualityMode={qualityMode}
          autoPlay={autoPlay}
          playSession={playSession}
          isEditorMode={gameState === 'editor'}
          activeEditorTool={editorTool}
          selectedNoteId={selectedNoteId}
          snapSubdivision={snapSubdivision}
          onJudgement={handleJudgementStable}
          onSongEnd={handleSongEnd}
          onSelectEditorNote={handleSelectEditorNote}
          onMoveEditorNote={handleMoveEditorNote}
          onPlaceEditorNote={handlePlaceEditorNote}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
        />
      </div>

      {/* 2D top-down editor viewport (replaces 3D when in 2D mode) */}
      {gameState === 'editor' && editorViewMode === '2d' && (
        <div className="absolute inset-0 z-0" data-viewport="2d">
          <Editor2DCanvas
            chart={currentChart}
            gameTime={gameTime}
            isPlaying={editorPreviewPlaying}
            snapSubdivision={snapSubdivision}
            activeTool={editorTool}
            selectedNoteId={selectedNoteId}
            vlineCount={editorVlineCount}
            pxPerBeat={editorPxPerBeat}
            onPlaceNote={(x, y, beat) => handlePlaceEditorNote(x, y, beat)}
            onMoveNote={(id, x, y, beat) => handleMoveEditorNote(id, x, y, beat)}
            onSelectNote={handleSelectEditorNote}
            onSeekBeat={handleSeekBeat}
          />
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
        <VisualChartEditor
          chart={currentChart}
          currentBeat={currentBeat}
          currentTimeSec={gameTime}
          isPlaying={editorPreviewPlaying}
          activeTool={editorTool}
          selectedNoteId={selectedNoteId}
          batchSelection={batchSelection}
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
            setEditorTool(tool);
            if (tool === 'quick-create') {
              // Quick-create mode must not show the floating edit panel, even
              // for a note that a prior "select" tool left highlighted.
              setSelectedNoteId(null);
              setBatchSelection({ startBeat: null, endBeat: null });
            }
          }}
          onSelectNote={(id) => setSelectedNoteId(id)}
          onSetBatchSelection={(sel) => setBatchSelection(sel)}
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
          }}
          onExitEditor={handleReturnToMenu}
          onStartPlayTest={handleStartPlayTest}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
        />
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
                    onClick={() => isPlayTestMode ? handleStartPlayTest(false) : handleStartGame(currentChart, hasCustomAudio, currentSongInfo?.songId, currentSongInfo?.diffName)}
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
            onOpenDocs={() => setShowDocs(true)}
            onOpenSettings={() => setShowSettings(true)}
            onOpenEditor={handleOpenVisualEditor}
            onOpenFileManager={() => setShowFileManager(true)}
            onSwitchLite={() => { window.location.href = 'lite/index.html'; }}
            onStartGame={(chart, hasAudio, songId, diffName) => handleStartGame(chart, hasAudio, songId, diffName)}
            onStateChange={handleSongSelectStateChange}
          />
        </div>
      )}

      <UnitTestModal isOpen={showUnitTest} onClose={() => setShowUnitTest(false)} />
      <FileManagerModal
        isOpen={showFileManager}
        onClose={() => setShowFileManager(false)}
        onSelectCustomSong={handleSelectCustomSong}
      />
      <DocModal isOpen={showDocs} onClose={() => setShowDocs(false)} />
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
        musicVolume={musicVolume}
        setMusicVolume={setMusicVolume}
        effectVolume={effectVolume}
        setEffectVolume={setEffectVolume}
      />
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

    </div>
  );
}

export default App;
