import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BeatmapsManifest, BeatmapItem, AlbumItem, SongItem } from '../types/beatmap';
import { SongCard } from './SongCard';
import { ChartData, GameStats } from '../types/game';
import type { ClearBadge } from '../utils/scoreStore';
import {
  assembleManifest,
  invalidateManifestCache,
  loadChartForDifficulty,
  getFallbackChart,
  isFallbackSong,
  resolveBeatmapUrl,
  findAlbumById
} from '../data/beatmapLoader';
import { onLibraryChanged } from '../data/libraryStore';
import { onServersChanged } from '../data/onlineServers';
import { globalAudio } from '../audio/AudioManager';
import { useI18n } from '../i18n';
import { ArrowLeft, Loader2, BookOpen, Sliders, FileCode, Upload, Smartphone, Tv } from 'lucide-react';

/** Default accent color used when a beatmap item defines none. */
const DEFAULT_ACCENT = '#0ea5e9';

/** Dimmed accent-color gradient used as the backdrop when a card has no cover. */
function dimAccentGradient(hex: string): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `linear-gradient(160deg, rgba(${r}, ${g}, ${b}, 0.45) 0%, rgba(10, 13, 18, 0.92) 100%)`;
}

/** Glowing dot used to separate the 内置 · 在线 · 本地 source segments. */
function SegmentDivider() {
  return (
    <div className="flex-shrink-0 w-8 flex items-center justify-center self-center" aria-hidden>
      <div className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-cyan-300 to-amber-300 shadow-[0_0_16px_rgba(34,211,238,0.85)]" />
    </div>
  );
}

/** Post-play result shown on the enlarged song card ("结算卡片"). */
export interface ResultInfo {
  stats: GameStats;
  badge: ClearBadge | null;
  isNewHighScore: boolean;
  isNewBadge: boolean;
  /** null → played a custom chart (file manager / not in manifest) */
  songId: string | null;
  diffName: string | null;
  meta: { title: string; artist: string; difficulty: string; bpm: number };
}

interface SongSelectProps {
  autoPlay: boolean;
  initialState?: SongSelectNavState;
  /** When set, render in result mode: bars hidden, played song's card enlarged with stats. */
  result?: ResultInfo | null;
  onClearResult?: () => void;
  /** Retry for custom (non-manifest) charts. */
  onRetryCustom?: () => void;
  onToggleAutoPlay: () => void;
  onOpenDocs: () => void;
  onOpenSettings: () => void;
  onOpenEditor: () => void;
  onOpenFileManager: () => void;
  onSwitchLite: () => void;
  onStartGame: (chart: ChartData, hasAudio: boolean, songId: string, diffName: string) => void;
  onStateChange?: (state: SongSelectNavState) => void;
}

type ViewDepth = 'root' | 'album';

export interface SongSelectNavState {
  viewDepth: ViewDepth;
  currentAlbumId: string | null;
  expandedId: string | null;
  selectedDifficulties: Record<string, number>;
}

export const SongSelect: React.FC<SongSelectProps> = ({
  autoPlay,
  initialState,
  result = null,
  onClearResult,
  onRetryCustom,
  onToggleAutoPlay,
  onOpenDocs,
  onOpenSettings,
  onOpenEditor,
  onOpenFileManager,
  onSwitchLite,
  onStartGame,
  onStateChange,
}) => {
  const { t } = useI18n();
  const [manifest, setManifest] = useState<BeatmapsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // In result mode, force-expand the played song's card (custom charts → none).
  const [expandedId, setExpandedId] = useState<string | null>(
    result ? result.songId : (initialState?.expandedId ?? null)
  );
  const [viewDepth, setViewDepth] = useState<ViewDepth>(initialState?.viewDepth ?? 'root');
  const [currentAlbumId, setCurrentAlbumId] = useState<string | null>(initialState?.currentAlbumId ?? null);
  const [selectedDifficulties, setSelectedDifficulties] = useState<Record<string, number>>(initialState?.selectedDifficulties ?? {});
  const [loadingSongId, setLoadingSongId] = useState<string | null>(null);
  const isStartingGameRef = useRef(false);
  // In-flight preview preload (audio + chart) per expanded song. The Start
  // button stays enabled during preload; if the player hits Start before it
  // finishes, handleStartGame awaits this promise (showing the loading state)
  // to avoid racing the audio buffer swap.
  const previewLoadRef = useRef<{ songId: string; promise: Promise<void> } | null>(null);
  // Album transition animation state
  const [albumAnimPhase, setAlbumAnimPhase] = useState<'idle' | 'exit' | 'enter-start' | 'enter'>('idle');
  const [albumAnimDir, setAlbumAnimDir] = useState<'in' | 'out'>('in'); // 'in' = going into album, 'out' = going back
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioInitializedRef = useRef(false);
  // When set (briefly) after leaving result mode, sibling cards animate in.
  const [justExitedResult, setJustExitedResult] = useState(false);
  // Blurred cover background shown behind the carousel while a card is expanded.
  // Two crossfading layers so switching cards cross-dissolves the backdrop
  // (instead of snapping to the new image). activeBgLayerRef tracks the live
  // layer without making it an effect dependency (avoiding re-run loops).
  const [bgLayers, setBgLayers] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const [activeBgLayer, setActiveBgLayer] = useState<'a' | 'b'>('a');
  const activeBgLayerRef = useRef<'a' | 'b'>('a');

  const notifyStateChange = useCallback(() => {
    onStateChange?.({
      viewDepth,
      currentAlbumId,
      expandedId,
      selectedDifficulties,
    });
  }, [viewDepth, currentAlbumId, expandedId, selectedDifficulties, onStateChange]);

  useEffect(() => {
    notifyStateChange();
  }, [notifyStateChange]);

  // Load manifest on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await assembleManifest();
        if (!cancelled) {
          setManifest(m);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh the manifest whenever the local library or the active online
  // server changes (FileManager edits, downloads, server switch, ...).
  useEffect(() => {
    const reload = async () => {
      invalidateManifestCache();
      try {
        const m = await assembleManifest();
        setManifest(m);
      } catch (e) {
        console.error('刷新谱面清单失败', e);
      }
    };
    const unsubLib = onLibraryChanged(reload);
    const unsubSrv = onServersChanged(reload);
    return () => {
      unsubLib();
      unsubSrv();
    };
  }, []);

  const getCurrentItems = useCallback((): BeatmapItem[] => {
    if (!manifest) return [];
    if (viewDepth === 'album' && currentAlbumId) {
      const album = findAlbumById(manifest.items, currentAlbumId);
      return album ? album.songs : manifest.items;
    }
    return manifest.items;
  }, [manifest, viewDepth, currentAlbumId]);

  // Exit result mode: clear the result, then briefly flag the siblings so they
  // slide/fade back into view on the song-select carousel.
  const exitResultMode = useCallback(() => {
    setJustExitedResult(true);
    window.setTimeout(() => setJustExitedResult(false), 600);
    onClearResult?.();
  }, [onClearResult]);

  const handleExpand = useCallback((id: string) => {
    // Expanding any card exits result mode.
    if (result) exitResultMode();
    setExpandedId(id);
  }, [result, exitResultMode]);

  const handleCollapse = useCallback(() => {
    if (result) {
      // In result mode, "collapse" just returns to the normal expanded card.
      exitResultMode();
      return;
    }
    setExpandedId(null);
  }, [result, exitResultMode]);

  const handleEnterAlbum = useCallback((album: AlbumItem) => {
    if (albumAnimPhase !== 'idle') return;
    setAlbumAnimDir('in');
    setAlbumAnimPhase('exit');
    setExpandedId(null);
    // After exit animation, switch data, instantly position new list off-screen, then slide in
    window.setTimeout(() => {
      setViewDepth('album');
      setCurrentAlbumId(album.id);
      setAlbumAnimPhase('enter-start'); // instant jump to start position
      // Reset scroll to start for new list — do this before the next frame
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollLeft = 0;
        }
        // Next frame: trigger slide-in animation
        requestAnimationFrame(() => {
          setAlbumAnimPhase('enter');
          window.setTimeout(() => {
            setAlbumAnimPhase('idle');
          }, 350);
        });
      });
    }, 250);
  }, [albumAnimPhase]);

  const handleBackToRoot = useCallback(() => {
    if (albumAnimPhase !== 'idle') return;
    setAlbumAnimDir('out');
    setAlbumAnimPhase('exit');
    setExpandedId(null);
    window.setTimeout(() => {
      setViewDepth('root');
      setCurrentAlbumId(null);
      setAlbumAnimPhase('enter-start');
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollLeft = 0;
        }
        requestAnimationFrame(() => {
          setAlbumAnimPhase('enter');
          window.setTimeout(() => {
            setAlbumAnimPhase('idle');
          }, 350);
        });
      });
    }, 250);
  }, [albumAnimPhase]);

  const handleChangeDifficulty = useCallback((song: SongItem, idx: number) => {
    setSelectedDifficulties((prev) => ({ ...prev, [song.id]: idx }));
  }, []);

  // Use refs for values that are needed inside async effects but shouldn't
  // trigger re-runs of the effect when they change.
  const selectedDifficultiesRef = useRef(selectedDifficulties);
  useEffect(() => { selectedDifficultiesRef.current = selectedDifficulties; }, [selectedDifficulties]);

  const getDiffIdx = useCallback((songId: string, total: number): number => {
    const stored = selectedDifficulties[songId];
    return stored !== undefined && stored < total ? stored : 0;
  }, [selectedDifficulties]);

  // Load audio when a song card is first expanded.
  // Does NOT re-run on difficulty changes — audio stays the same across difficulties.
  useEffect(() => {
    if (!expandedId || !manifest) return;
    const items = getCurrentItems();
    const song = items.find((i) => i.type === 'song' && i.id === expandedId) as SongItem | undefined;
    if (!song) return;
    if (song.difficulties.length === 0) return;

    let cancelled = false;
    // NOTE: do NOT set loadingSongId here — the Start button should be
    // immediately usable. handleStartGame awaits previewLoadRef if needed.

    const loadPromise = (async () => {
      try {
        // Initialize audio context on first interaction (browsers require user gesture)
        if (!audioInitializedRef.current) {
          await globalAudio.resume();
          audioInitializedRef.current = true;
        }

        // Load audio (only once per song — same audio across all difficulties)
        if (song.audio) {
          try {
            await globalAudio.loadAudioURL(resolveBeatmapUrl(song.audio), true);
          } catch (e) {
            console.warn('Failed to load preview audio:', e);
          }
        } else {
          // No audio for this song — switch to synth so we don't play
          // the previous song's audio buffer by mistake.
          globalAudio.setSynthesizedTrack(song.bpm || 140);
        }

        // Preload chart for current difficulty
        const diffIdx = selectedDifficultiesRef.current[song.id] ?? 0;
        await loadChartForDifficulty(song, diffIdx);

        if (!cancelled && !isStartingGameRef.current) {
          // Preview play at low volume from ~10% in
          const buffer = globalAudio.getActiveBuffer?.();
          if (song.audio && buffer && buffer.duration > 0) {
            const previewStart = Math.min(5, buffer.duration * 0.1);
            const prevVol = globalAudio.getMusicVolume();
            globalAudio.setMusicVolume(prevVol * 0.5);
            globalAudio.play(previewStart);
            setTimeout(() => {
              globalAudio.setMusicVolume(prevVol);
            }, 300);
          }
        }
      } catch (e) {
        console.error('Error loading song:', e);
      }
    })();

    previewLoadRef.current = { songId: song.id, promise: loadPromise };

    return () => {
      cancelled = true;
      if (previewLoadRef.current?.songId === song.id) {
        previewLoadRef.current = null;
      }
      if (!isStartingGameRef.current) {
        globalAudio.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, manifest]);

  // Dim, blurred cover background. Fades in when a card is expanded (any album
  // or song) and cross-dissolves when switching cards. When a card has no cover
  // we fall back to its (dimmed) accent color. All transitions are delayed 0.5s
  // via CSS transition-delay on the layers below.
  const activeBgCoverItemId = result ? result.songId : expandedId;
  const targetBg = (() => {
    if (!activeBgCoverItemId) return '';
    const item = getCurrentItems().find((i) => i.id === activeBgCoverItemId);
    if (!item) return '';
    if (item.cover) return `url("${resolveBeatmapUrl(item.cover)}")`;
    return dimAccentGradient(item.accentColor || DEFAULT_ACCENT);
  })();

  useEffect(() => {
    if (!targetBg) return; // collapsed: keep last layer so it can fade out
    const next: 'a' | 'b' = activeBgLayerRef.current === 'a' ? 'b' : 'a';
    setBgLayers((prev) => ({ ...prev, [next]: targetBg }));
    activeBgLayerRef.current = next;
    setActiveBgLayer(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBg]);

  const handleStartGame = useCallback(async (song: SongItem, diffIdx: number) => {
    const diff = song.difficulties[diffIdx];
    if (!diff) return;

    setLoadingSongId(song.id);
    isStartingGameRef.current = true;
    try {
      // If the preview preload (audio + chart) for this song is still in
      // flight, wait for it first — the button shows "加载中" only from
      // this point on, not during background preloading.
      if (previewLoadRef.current?.songId === song.id) {
        await previewLoadRef.current.promise;
      }

      // Load chart
      let chart: ChartData | null = null;
      if (isFallbackSong(song.id)) {
        chart = getFallbackChart(song.id);
      } else {
        chart = await loadChartForDifficulty(song, diffIdx);
      }
      if (!chart) {
        setLoadingSongId(null);
        isStartingGameRef.current = false;
        return;
      }

      // Stop preview
      globalAudio.stop();

      // Start game
      const hasAudio = !!song.audio;
      if (hasAudio) {
        // Audio already loaded in preview; if not, load now
        if (!globalAudio.getActiveBuffer?.()) {
          await globalAudio.loadAudioURL(resolveBeatmapUrl(song.audio), true);
        }
      }
      onStartGame(chart, hasAudio, song.id, diff.name);
    } catch (e) {
      console.error('Failed to start game:', e);
      setLoadingSongId(null);
      isStartingGameRef.current = false;
    }
  }, [onStartGame]);

  // Click outside to collapse (in result mode: exit result, keep card expanded)
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.scrollContainer) {
      if (result) {
        exitResultMode();
      } else if (expandedId) {
        handleCollapse();
      }
    }
  }, [expandedId, handleCollapse, result, exitResultMode]);

  if (loading) {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-md">
        <div className="flex flex-col items-center gap-3 text-cyan-300">
          <Loader2 size={32} className="animate-spin" />
          <span className="text-sm font-bold font-orbitron tracking-wider">LOADING BEATMAPS...</span>
        </div>
      </div>
    );
  }

  const items = getCurrentItems();
  const currentAlbum = viewDepth === 'album' && currentAlbumId
    ? (findAlbumById(manifest?.items ?? [], currentAlbumId) ?? undefined)
    : null;

  return (
    <div
      ref={containerRef}
      onClick={handleContainerClick}
      className="absolute inset-0 z-20 bg-black/45 backdrop-blur-md"
    >
      {/* Dim + blurred cover background — fades in when a card is expanded, and
          cross-dissolves when switching cards. All transitions delayed 0.5s. */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 overflow-hidden pointer-events-none"
        style={{ opacity: activeBgCoverItemId ? 1 : 0, transition: 'opacity 600ms ease 0.5s' }}
      >
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: bgLayers.a,
            opacity: activeBgLayer === 'a' ? 1 : 0,
            filter: 'blur(48px)',
            transform: 'scale(1.25)',
            transition: 'opacity 600ms ease 0.5s',
          }}
        />
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: bgLayers.b,
            opacity: activeBgLayer === 'b' ? 1 : 0,
            filter: 'blur(48px)',
            transform: 'scale(1.25)',
            transition: 'opacity 600ms ease 0.5s',
          }}
        />
        <div className="absolute inset-0 bg-black/70" />
      </div>

      {/* 全屏层：卡片轮播横向铺满整屏（滚动连续），上下栏另行固定在 2:1 安全区 */}
      <div className="absolute inset-0 flex flex-col">

      {/* Top Bar (hidden in result mode) */}
      {!result && (
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between py-4 min-h-[60px] pointer-events-none" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))', paddingLeft: 'max(1.5rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1.5rem, env(safe-area-inset-right, 0px))' }}>
        <div className="flex items-center gap-3 min-w-0 pointer-events-auto">
          {viewDepth === 'album' && (
            <button
              onClick={handleBackToRoot}
              className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shrink-0"
            >
              <ArrowLeft size={14} /> 返回
            </button>
          )}
          {currentAlbum && (
            <div className="text-white font-orbitron font-bold tracking-wider truncate">
              {currentAlbum.title}
            </div>
          )}
          {viewDepth === 'root' && (
            <h1 className="flex items-baseline leading-none">
              <span className="text-2xl sm:text-3xl font-black font-orbitron tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-sky-200 to-amber-300">
                Poluxis
              </span>
              <span className="text-[10px] font-bold font-orbitron uppercase tracking-[0.35em] text-white/40 mr-2 mt-1 self-start">
                Project
              </span>
            </h1>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap pointer-events-auto">
          <button
            onClick={onOpenDocs}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
          >
            <BookOpen size={15} /> {t('songselect.doc')}
          </button>
          <button
            onClick={onOpenFileManager}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
          >
            <Upload size={15} /> {t('songselect.upload')}
          </button>
          <button
            onClick={onOpenEditor}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
          >
            <FileCode size={15} /> {t('songselect.edit')}
          </button>
          <button
            onClick={onSwitchLite}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
          >
            <Smartphone size={14} /> {t('songselect.lite')}
          </button>
        </div>
      </div>
      )}

      {/* Card Carousel */}
      {/*
        IMPORTANT: We always render the card list in the SAME flex container,
        even in result mode. This keeps each card's DOM position, parent node
        and scroll-slot stable across the result ↔ normal transition — so the
        size transition (w-[94vw] ↔ w-[85vw]) can smoothly interpolate without
        the card "teleporting" from a wrapper to the carousel, which was the
        root cause of the iPhone-SE landscape jitter (three stacked easings on
        a freshly-mounted card).

        In result mode we simply hide sibling cards and give the played card
        its resultData payload (which makes it grow to the large, result-card
        size via its own CSS transition). Hiding siblings (display:none) also
        collapses their flex gaps, so the single visible card ends up sitting
        inside a flex container that we now justify-center, giving us the same
        visual centering the old wrapper did — but without moving the card in
        the DOM tree.
      */}
      <div
        ref={scrollRef}
        data-scroll-container
        onClick={handleContainerClick}
        className={`
          song-carousel
          relative z-10 flex-1 flex items-center overflow-x-auto overflow-y-hidden
          ${result ? 'justify-center' : 'justify-start'}
          gap-6
          py-8
          scroll-smooth
        `}
        style={{
          paddingLeft: 'max(2.5rem, env(safe-area-inset-left, 0px))',
          paddingRight: 'max(2.5rem, env(safe-area-inset-right, 0px))',
          opacity: albumAnimPhase === 'exit' || albumAnimPhase === 'enter-start' ? 0 : 1,
          transform: albumAnimPhase === 'exit'
            ? `translateX(${albumAnimDir === 'in' ? '-60px' : '60px'})`
            : albumAnimPhase === 'enter-start'
              ? `translateX(${albumAnimDir === 'in' ? '60px' : '-60px'})`
              : 'translateX(0)',
          transition: albumAnimPhase === 'enter-start' ? 'none' : 'opacity 250ms ease, transform 250ms ease',
        }}
      >
        {(() => {
          // Figure out what cards to show. Custom/non-manifest result charts
          // don't have a matching item in the manifest, so we synthesize a
          // single-item list for them (the carousel stays stable because it
          // always renders a flex-list — just a different length list).
          const customResultOnly =
            result && !result.songId
              ? [{
                  type: 'song' as const,
                  id: '__custom_result__',
                  title: result.meta.title,
                  artist: result.meta.artist,
                  bpm: result.meta.bpm,
                  difficulties: [{ name: result.meta.difficulty || 'Custom', level: 0, chartFile: '' }],
                } as SongItem]
              : null;

          const renderList: BeatmapItem[] = customResultOnly ?? items;

          if (renderList.length === 0 && !result) {
            return (
              <div className="w-full flex justify-center text-white/55 text-sm">
                {loadError ? t('songselect.loadError', { err: loadError }) : t('songselect.empty')}
              </div>
            );
          }

          const showDividers = !result;
          return renderList.map((item, i) => {
            const prevItem = i > 0 ? renderList[i - 1] : null;
            const showDivider = showDividers && !!prevItem && (item.source ?? 'builtin') !== (prevItem.source ?? 'builtin');
            // In manifest-result mode, figure out which card is the played one.
            const isPlayedResult = !!result && !!result.songId && item.id === result.songId;
            // In custom-result mode there's only one synthetic card — it's always the played one.
            const isCustomResultCard = !!customResultOnly;
            const hasResultPayload = isPlayedResult || isCustomResultCard;

            // Normal expanded state, but in any result mode we force-expand
            // the played card (it should never look collapsed while showing
            // result stats).
            const isExpanded = hasResultPayload
              ? true
              : expandedId === item.id;

            const diffIdx = item.type === 'song'
              ? getDiffIdx(item.id, item.difficulties.length)
              : 0;
            const isLoading = item.type === 'song' && loadingSongId === item.id;

            // In manifest-result mode: hide every card except the played one
            // (display:none collapses the flex gap so the played card sits
            // flush in the justify-center container, visually identical to
            // the old wrapper layout).
            const hideInResult = !!result && !!result.songId && !isPlayedResult;
            if (hideInResult) return null;

            // Sibling fade-in when leaving result mode: all cards EXCEPT the
            // expanded/played one get the slide-in animation (see below).
            const siblingSlideIn = justExitedResult && !isExpanded;
            // When leaving result mode the played card transitions back from
            // the large result dimensions to the normal expanded dimensions —
            // that CSS transition is plenty of animation on its own; stacking
            // an extra translateY+scale cardFadeIn on top would duplicate the
            // easing curve and cause the old iPhone-SE "overshoot out of
            // viewport" bug.
            const shouldCenterOnExpanded = justExitedResult && isExpanded;

            const card = (
              <SongCard
                key={item.id}
                item={item}
                isExpanded={isExpanded}
                isLoading={isLoading}
                currentDifficultyIdx={diffIdx}
                onExpand={() => handleExpand(item.id)}
                onCollapse={handleCollapse}
                onEnterAlbum={item.type === 'album' ? handleEnterAlbum : undefined}
                onStartGame={item.type === 'song' && isCustomResultCard ? () => onRetryCustom?.() : (item.type === 'song' ? handleStartGame : undefined)}
                onChangeDifficulty={item.type === 'song' ? handleChangeDifficulty : undefined}
                highScoreKey={isCustomResultCard ? undefined : item.id}
                resultData={hasResultPayload ? result : null}
                onExitResult={hasResultPayload ? exitResultMode : undefined}
                className={siblingSlideIn ? 'slide-in-card' : ''}
                centerWhenExpanded={shouldCenterOnExpanded}
              />
            );
            if (showDivider) {
              return (
                <React.Fragment key={`frag-${item.id}`}>
                  <SegmentDivider />
                  {card}
                </React.Fragment>
              );
            }
            return card;
          });
        })()}
      </div>

      {/* Bottom Bar (hidden in result mode) */}
      {!result && (
      <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-wrap items-center justify-between gap-4 py-4 pointer-events-none" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))', paddingLeft: 'max(1.5rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1.5rem, env(safe-area-inset-right, 0px))' }}>
        <div className="flex items-center gap-6 text-xs text-white/70 pointer-events-auto">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={onToggleAutoPlay}
              className="accent-cyan-400"
            />
            <span className="flex items-center gap-1">
              <Tv size={14} className="text-amber-400" /> Auto-Play
            </span>
          </label>
          <button
            onClick={onOpenSettings}
            className="glass-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold"
          >
            <Sliders size={14} /> {t('songselect.settings')}
          </button>
        </div>

        {expandedId && (
          <div className="text-white/45 text-xs font-bold font-orbitron tracking-wider">
            {t('songselect.collapseHint')}
          </div>
        )}
      </div>
      )}
      </div>{/* /UI 框 */}
    </div>
  );
};
