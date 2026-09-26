import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BeatmapsManifest, BeatmapItem, AlbumItem, SongItem, DifficultyEntry, EditorLaunchInfo } from '../types/beatmap';
import { SongCard } from './SongCard';
import FloatingActionBar, { ClipboardItem } from './FloatingActionBar';
import { AccountMenu } from './AccountMenu';
import { ChartData, GameStats } from '../types/game';
import type { ClearBadge } from '../utils/scoreStore';
import { getScoreKey } from '../utils/scoreStore';
import {
  assembleManifest,
  assembleLocalManifest,
  assembleOnlineManifest,
  hasOnlineManifestCache,
  invalidateManifestCache,
  loadChartForDifficulty,
  getFallbackChart,
  isFallbackSong,
  resolveBeatmapUrl,
  findAlbumById
} from '../data/beatmapLoader';
import { getCurrentServer } from '../data/onlineServers';
import {
  onLibraryChanged,
  createAlbum,
  addSong,
  addSongToRoot,
  updateAlbum,
  updateSong,
  updateSongById,
  deleteAlbum,
  deleteSong,
  deleteSongById,
  addDifficultyToSong,
  moveSong,
  moveAlbum,
  downloadSongToLibrary,
  getSongParentAlbumId,
} from '../data/libraryStore';
import { storeFile, generateId } from '../data/idb';
import { importZip, importLooseFiles, parseChartMeta, resolveDifficulty } from '../data/zipImport';
import { onServersChanged } from '../data/onlineServers';
import { globalAudio } from '../audio/AudioManager';
import { useI18n } from '../i18n';
import { ArrowLeft, Home, ClipboardPaste, Loader2, Tv } from 'lucide-react';

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

/* ============================ 开始加载状态模型 ============================
 * 开始一首谱面需要两份资源：音频（按曲共享、跨难度不变）与谱面（按难度）。
 * 展开卡片即后台预载（音频 → 谱面顺序）；点击开始若预载未完则等待并展示真实进度。
 * 所有加载方（预览预载与开始补载）都把事件写入同一份 loadStateRef"地面真相"，
 * 按钮文案由 loadStageLabel 纯函数推导 —— 状态只有一份，展示不会各说各话。
 * 关键点：音频"就绪"必须可验证（AudioManager.getActiveURL() === 本曲 URL），
 * 缓存命中时 loadAudioURL 不发任何进度事件，所以不能依赖事件流推断就绪。 */
type StagePhase = 'idle' | 'download' | 'decode' | 'ready';
interface StageState {
  phase: StagePhase;
  /** 已接收 / 总字节（仅 download 阶段有意义；total 0 = 服务器未返回 Content-Length）。 */
  loaded: number;
  total: number;
}
interface LoadState {
  songId: string;
  audio: StageState;
  chart: StageState;
}
const idleStage = (): StageState => ({ phase: 'idle', loaded: 0, total: 0 });

/** 由加载状态推导按钮文案；全部就绪返回 null（无需任何加载展示）。
 *  展示优先级 = 加载管线顺序：音频下载 → 解码 → 谱面下载 → 全部就绪。 */
function loadStageLabel(st: LoadState, t: (key: string) => string): string | null {
  const pctOf = (s: StageState): string =>
    s.total > 0 ? `${Math.min(100, Math.round((s.loaded / s.total) * 100))}%` : '';
  if (st.audio.phase === 'download') {
    const pct = pctOf(st.audio);
    return pct ? `${t('songcard.loadingAudio')} ${pct}` : t('songcard.loadingAudio');
  }
  if (st.audio.phase === 'decode') return t('songcard.decoding');
  if (st.audio.phase === 'ready') {
    if (st.chart.phase === 'download') {
      const pct = pctOf(st.chart);
      return pct ? `${t('songcard.loadingChart')} ${pct}` : t('songcard.loadingChart');
    }
    if (st.chart.phase === 'ready') return null;
    // 音频已就绪、谱面尚未开跑（预览仍在音频阶段，或谱面将由开始流程现场加载）。
    return `${t('songcard.loadingAudio')} 100%`;
  }
  // 音频 idle：合成器曲目（无音频文件），展示由谱面驱动。
  if (st.chart.phase === 'download') {
    const pct = pctOf(st.chart);
    return pct ? `${t('songcard.loadingChart')} ${pct}` : t('songcard.loadingChart');
  }
  if (st.chart.phase === 'ready') return null;
  return t('songcard.loading');
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
  onOpenSettings: () => void;
  onOpenEditor: () => void;
  /** 由卡片发起“编辑谱面/新建谱面”，携带上下文信息。 */
  onLaunchChartEditor: (info: EditorLaunchInfo) => void;
  onSwitchLite: () => void;
  onStartGame: (chart: ChartData, hasAudio: boolean, songId: string, scoreKey: string, diffName: string) => void;
  onStateChange?: (state: SongSelectNavState) => void;
}

type ViewDepth = 'root' | 'album';

export interface SongSelectNavState {
  viewDepth: ViewDepth;
  currentAlbumId: string | null;
  /** 专辑导航栈（从根到当前），用于支持嵌套专辑与“上一级 / 回根目录”。 */
  albumStack?: string[];
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
  onOpenSettings,
  onOpenEditor,
  onLaunchChartEditor,
  onSwitchLite,
  onStartGame,
  onStateChange,
}) => {
  const { t } = useI18n();
  const [manifest, setManifest] = useState<BeatmapsManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 在线谱面异步同步中（非阻塞，仅显示小 spinner 提示）。
  const [syncingOnline, setSyncingOnline] = useState(false);
  // In result mode, force-expand the played song's card (custom charts → none).
  const [expandedId, setExpandedId] = useState<string | null>(
    result ? result.songId : (initialState?.expandedId ?? null)
  );
  const [albumStack, setAlbumStack] = useState<string[]>(
    initialState?.albumStack && initialState.albumStack.length > 0
      ? initialState.albumStack
      : initialState?.currentAlbumId
        ? [initialState.currentAlbumId]
        : [],
  );
  const currentAlbumId = albumStack.length ? albumStack[albumStack.length - 1] : null;
  const viewDepth: ViewDepth = albumStack.length ? 'album' : 'root';
  const [selectedDifficulties, setSelectedDifficulties] = useState<Record<string, number>>(initialState?.selectedDifficulties ?? {});
  // Inline edit state (card-as-file-manager): the card currently being edited.
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    title: string;
    artist: string;
    bpm: number;
    accentColor: string;
    difficulties: DifficultyEntry[];
  } | null>(null);
  // In-memory clipboard for the "move" action (one item at a time).
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  // Lightweight transient toast.
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }, []);
  const [loadingSongId, setLoadingSongId] = useState<string | null>(null);
  // 加载阶段文案（「谱面 42%」/「音频 87%」/「解码中」）。与 loadingSongId 同生命周期。
  const [startPhase, setStartPhase] = useState<string | null>(null);
  /* 开局会话令牌：每次点击开始自增。异步加载期间玩家又点了别的歌时，旧会话在各
   * await 之后检查令牌并静默退出（不回调 onStartGame、不复位闸门），保证
   * "最后点击的那首"才是真正进入的谱面。 */
  const startSessionRef = useRef(0);
  const isStartingGameRef = useRef(false);
  /* 当前正在"开始"的那首曲目。isStartingGameRef 成功开局后不会复位（它还要阻止
   * 预览的清理逻辑停掉游戏音频），所以仅凭它做闸门的话，玩过一局之后再浏览卡片，
   * 后台预载的进度回调会持续写状态、引起无谓重渲染。加上这个 id 精确限定。 */
  const startingSongIdRef = useRef<string | null>(null);
  /* 统一的加载阶段上报：不论下载是"展开卡片时的预览预载"发起的，还是"点击开始"
   * 发起的，都走这里 —— 玩家按下开始后若预载仍在进行，就能立刻看到真实阶段与
   * 百分比，而不是干等一个笼统的「加载中」。
   * 只在"这一首正在开始"时写入状态。百分比只在整数变化时更新（字节回调上百次）。 */
  /* 开始加载的"地面真相"（模型见文件顶部 LoadState）：预览预载与开始补载都写这里，
   * 且无论是否处于"开始"闸门 —— 只有这样，点击开始时才能立刻把按钮对齐到真实阶段
   * （缓存命中不发事件、解码是单次事件不再重发，这些坑都靠"状态常驻"绕开）。 */
  const loadStateRef = useRef<LoadState>({ songId: '', audio: idleStage(), chart: idleStage() });
  /* 唯一的 UI 写入口：把地面真相推导成文案并同步到按钮。仅在"这一首正在开始"时生效。 */
  const syncStartPhase = useCallback((): void => {
    if (!isStartingGameRef.current) return;
    const startingId = startingSongIdRef.current;
    if (!startingId || startingId !== loadStateRef.current.songId) return;
    setStartPhase(loadStageLabel(loadStateRef.current, t));
  }, [t]);
  /* 各加载方的统一上报口。非当前歌曲的迟到事件直接忽略（如切卡后旧下载的进度回调）。 */
  const reportPhase = useCallback(
    (
      songId: string,
      kind: 'audio' | 'chart',
      phase: StagePhase,
      loaded?: number,
      total?: number,
    ): void => {
      const st = loadStateRef.current;
      if (st.songId !== songId) return;
      st[kind] = {
        phase,
        loaded: phase === 'download' ? loaded ?? 0 : 0,
        total: phase === 'download' ? total ?? 0 : 0,
      };
      syncStartPhase();
    },
    [syncStartPhase],
  );
  // In-flight preview preload (audio + chart) per expanded song. The Start
  // button stays enabled during preload; if the player hits Start before it
  // finishes, handleStartGame awaits this promise (showing the loading state)
  // to avoid racing the audio buffer swap.
  const previewLoadRef = useRef<{ songId: string; promise: Promise<void> } | null>(null);
  /* 预览预载已完成的谱面（含所属难度）。点击开始时若难度未变则直接复用，避免
   * 重复 fetch 同一份谱面文件（原先在 await 预览后还会无条件再 loadChartForDifficulty 一次）。 */
  const previewChartRef = useRef<{ songId: string; diffIdx: number; chart: ChartData } | null>(null);
  // Album transition animation state
  const [albumAnimPhase, setAlbumAnimPhase] = useState<'idle' | 'exit' | 'enter-start' | 'enter'>('idle');
  const [albumAnimDir, setAlbumAnimDir] = useState<'in' | 'out'>('in'); // 'in' = going into album, 'out' = going back
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* PC 鼠标滚轮横向滚动卡片轮播：原生 `overflow-x-auto` 只响应横向滚轮/横向拖拽，
   * 竖向滚轮默认不会滚动它；且 React 的 onWheel 是 passive 监听，无法 preventDefault。
   * 故挂原生非 passive 监听：把竖向滚轮映射为横向滚动；若指针落在可纵向滚动的子元素
   * （如展开卡片内部的信息区）内则让位给它。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return; // 触控板缩放手势，不拦截
      if (el.scrollWidth <= el.clientWidth + 1) return; // 没有横向可滚动内容
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        const style = getComputedStyle(node);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 1
        ) {
          return; // 该子元素自己能纵向滚动 → 交给它
        }
        node = node.parentElement;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      // 临时关掉 scroll-smooth，避免每个滚轮事件都触发一次平滑动画（手感发黏）。
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollLeft += delta;
      el.style.scrollBehavior = prevBehavior;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
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
      albumStack,
      expandedId,
      selectedDifficulties,
    });
  }, [viewDepth, currentAlbumId, albumStack, expandedId, selectedDifficulties, onStateChange]);

  useEffect(() => {
    notifyStateChange();
  }, [notifyStateChange]);

  // Load manifest on mount — two phases, never blocking game entry:
  // 1) local (builtin + library) renders immediately;
  // 2) online chart list syncs in the background (bounded by its own timeout)
  //    and is merged in when it arrives. A dead/unreachable chart server no
  //    longer shows a full-screen "LOADING BEATMAPS" until the network timeout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await assembleLocalManifest();
        if (cancelled) return;
        setManifest(base);
        const cur = getCurrentServer();
        if (cur) {
          // 会话内已同步过（缓存命中）则不重新 fetch、不显示“同步中”；仅
          // 首次/切换服务器（缓存 key 变化）时才真正同步。
          const cached = hasOnlineManifestCache(cur.id);
          setSyncingOnline(!cached);
          const online = await assembleOnlineManifest(cur);
          if (!cancelled) {
            // 在线谱面插入内置与本地之间（展示顺序：内置 → 在线 → 本地）。
            setManifest((prev) => {
              if (!prev) return prev;
              const builtin = prev.items.filter((it) => it.source === 'builtin');
              const local = prev.items.filter((it) => it.source !== 'builtin');
              return { ...prev, items: [...builtin, ...online, ...local] };
            });
            setSyncingOnline(false);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error('加载谱面清单失败', e);
          setLoadError(String(e));
          setSyncingOnline(false);
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
    // 一局真正结束：复位"开始"闸门，使下一首歌的加载流程与首首一致
    // （否则 isStartingGameRef 会残留为 true，跨歌曲持久化造成状态错乱）。
    isStartingGameRef.current = false;
    startingSongIdRef.current = null;
    setJustExitedResult(true);
    window.setTimeout(() => setJustExitedResult(false), 600);
    onClearResult?.();
  }, [onClearResult]);

  const handleExpand = useCallback((id: string) => {
    // Expanding any card exits result mode and cancels any inline edit.
    if (result) exitResultMode();
    if (editId) {
      setEditId(null);
      setEditDraft(null);
    }
    setExpandedId(id);
  }, [result, exitResultMode, editId]);

  const handleCollapse = useCallback(() => {
    if (result) {
      // In result mode, "collapse" just returns to the normal expanded card.
      exitResultMode();
      return;
    }
    setExpandedId(null);
  }, [result, exitResultMode]);

  // 带切换动画的导航：dir='in' 进入更深层级，dir='out' 返回上一级/根目录。
  const runAlbumTransition = useCallback(
    (dir: 'in' | 'out', applyStack: () => string[]) => {
      if (albumAnimPhase !== 'idle') return;
      setAlbumAnimDir(dir);
      setAlbumAnimPhase('exit');
      setExpandedId(null);
      // After exit animation, switch data, instantly position new list off-screen, then slide in
      window.setTimeout(() => {
        setAlbumStack(applyStack());
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
    },
    [albumAnimPhase],
  );

  const handleEnterAlbum = useCallback(
    (album: AlbumItem) => {
      runAlbumTransition('in', () => [...albumStack, album.id]);
    },
    [albumStack, runAlbumTransition],
  );

  // 返回上一级（再上一级是父专辑，最上层则回到根目录）。
  const handleBack = useCallback(() => {
    runAlbumTransition('out', () => albumStack.slice(0, -1));
  }, [albumStack, runAlbumTransition]);

  // 直接回到根目录。
  const handleHome = useCallback(() => {
    runAlbumTransition('out', () => []);
  }, [runAlbumTransition]);

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
    // 切走卡片（expandedId 变化）时中止本曲仍在途的下载，不浪费带宽/CPU。
    const abort = new AbortController();
    // NOTE: do NOT set loadingSongId here — the Start button should be
    // immediately usable. handleStartGame awaits previewLoadRef if needed.
    // 新的一首：重置地面真相，本曲的所有加载事件都归到它名下（旧歌的迟到回调
    // 会因 songId 不符被 reportPhase 丢弃）。
    loadStateRef.current = { songId: song.id, audio: idleStage(), chart: idleStage() };

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
            await globalAudio.loadAudioURL(resolveBeatmapUrl(song.audio), true, (p) => {
              if (p.phase === 'decode') reportPhase(song.id, 'audio', 'decode');
              else reportPhase(song.id, 'audio', 'download', p.loaded, p.total);
            }, abort.signal);
            if (!cancelled) reportPhase(song.id, 'audio', 'ready');
          } catch (e) {
            if (!cancelled) console.warn('Failed to load preview audio:', e);
          }
        } else {
          // No audio for this song — switch to synth so we don't play
          // the previous song's audio buffer by mistake.
          globalAudio.setSynthesizedTrack(song.bpm || 140);
        }

        // Preload chart for current difficulty。同曲同难度已预载过（反复切卡回来）
        // 则直接复用，不重复下载。
        const diffIdx = selectedDifficultiesRef.current[song.id] ?? 0;
        const cachedChart = previewChartRef.current;
        if (cachedChart && cachedChart.songId === song.id && cachedChart.diffIdx === diffIdx) {
          if (!cancelled) reportPhase(song.id, 'chart', 'ready');
        } else {
          const chart = await loadChartForDifficulty(
            song,
            diffIdx,
            (loaded, total) => reportPhase(song.id, 'chart', 'download', loaded, total),
            abort.signal,
          );
          // 已切走：不覆盖新歌的预载结果，也不写状态。
          if (!cancelled) {
            reportPhase(song.id, 'chart', 'ready');
            previewChartRef.current = { songId: song.id, diffIdx, chart };
          }
        }

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
      abort.abort();
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

    const session = ++startSessionRef.current;
    const stale = (): boolean => session !== startSessionRef.current;

    /* ===== 就绪判定（全部可验证，不靠猜测）=====
     * - 音频：AudioManager 记录了活动缓冲的归属 URL（getActiveURL），等于本曲
     *   音频 URL 才算就绪 —— 杜绝"上一首残留缓冲被误认成本曲已就绪"；
     *   缓存命中时 loadAudioURL 不发进度事件，所以不能靠事件流推断就绪。
     * - 谱面：预览预载完成且难度一致才复用；否则开始流程现场加载（带进度）。
     * - 预览预载在途则等待，避免与音频缓冲切换竞争。 */
    const audioUrl = song.audio ? resolveBeatmapUrl(song.audio) : '';
    const audioReady = !song.audio || globalAudio.getActiveURL?.() === audioUrl;
    const previewChart = previewChartRef.current;
    const chartReady =
      !!previewChart && previewChart.songId === song.id && previewChart.diffIdx === diffIdx;
    const previewPending = previewLoadRef.current?.songId === song.id;

    isStartingGameRef.current = true;
    startingSongIdRef.current = song.id;
    /* 认领地面真相：正常时预览 effect 已把状态归到本曲名下；若预览因故未跑
     * （如无难度曲目），在这里认领，保证本曲的进度上报不被 songId 守卫丢弃。 */
    if (loadStateRef.current.songId !== song.id) {
      loadStateRef.current = { songId: song.id, audio: idleStage(), chart: idleStage() };
    }

    /* 一切就绪且无在途预载 → 直接开局，不闪加载展示。 */
    if (audioReady && chartReady && !previewPending) {
      globalAudio.stop();
      startingSongIdRef.current = null;
      onStartGame(previewChart!.chart, !!song.audio, song.id, getScoreKey(song.id, song.source), diff.name);
      return;
    }

    /* 需要加载：进入加载展示。文案立刻按地面真相推导（「音频 100%」/「音频 37%」/
     * 「解码中」/「谱面 64%」/「加载中」），后续事件持续刷新。 */
    setLoadingSongId(song.id);
    syncStartPhase();
    try {
      if (previewPending) {
        await previewLoadRef.current!.promise;
      }
      // 等待期间玩家又点了别的歌：本会话已过期，静默退出（新会话已接管闸门与 UI）。
      if (stale()) return;

      // 谱面：预览已备好则复用，否则现场加载（带下载进度）。
      let chart: ChartData;
      if (isFallbackSong(song.id)) {
        chart = getFallbackChart(song.id);
      } else if (chartReady) {
        chart = previewChart!.chart;
      } else {
        chart = await loadChartForDifficulty(song, diffIdx, (loaded, total) =>
          reportPhase(song.id, 'chart', 'download', loaded, total),
        );
        if (stale()) return;
        reportPhase(song.id, 'chart', 'ready');
        previewChartRef.current = { songId: song.id, diffIdx, chart };
      }

      // Stop preview
      globalAudio.stop();

      // 音频：确认活动缓冲确为本曲；不是（预览失败 / 从未预载）则现场加载。
      const hasAudio = !!song.audio;
      if (hasAudio && globalAudio.getActiveURL?.() !== audioUrl) {
        await globalAudio.loadAudioURL(audioUrl, true, (p) => {
          if (p.phase === 'decode') reportPhase(song.id, 'audio', 'decode');
          else reportPhase(song.id, 'audio', 'download', p.loaded, p.total);
        });
        if (stale()) return;
        reportPhase(song.id, 'audio', 'ready');
      }

      // scoreKey 按来源加命名空间，避免同一在线曲目下载前后的成绩互通。
      setStartPhase(null);
      // 关卡已交出去：关闭阶段闸门，避免之后的预览预载继续写状态。
      startingSongIdRef.current = null;
      onStartGame(chart, hasAudio, song.id, getScoreKey(song.id, song.source), diff.name);
    } catch (e) {
      if (stale()) return; // 过期会话不得复位新会话的闸门/状态
      console.error('Failed to start game:', e);
      setLoadingSongId(null);
      setStartPhase(null);
      isStartingGameRef.current = false;
      startingSongIdRef.current = null;
    }
    // syncStartPhase / reportPhase 均以 t 为依赖（useCallback 链），切换语言时
    // 身份会更新，放入依赖是安全的。
  }, [onStartGame, syncStartPhase, reportPhase]);

  // Click outside to collapse (in result mode: exit result, keep card expanded)
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.scrollContainer) {
      if (result) {
        exitResultMode();
      } else if (editId) {
        // Clicking empty space while editing cancels the inline edit (keeps the card expanded).
        setEditId(null);
        setEditDraft(null);
      } else if (expandedId) {
        handleCollapse();
      }
    }
  }, [expandedId, editId, handleCollapse, result, exitResultMode]);

  const items = getCurrentItems();
  const currentAlbum = viewDepth === 'album' && currentAlbumId
    ? (findAlbumById(manifest?.items ?? [], currentAlbumId) ?? undefined)
    : null;

  // ---- Card-as-file-manager helpers ----
  const findItemById = (id: string | null): BeatmapItem | null => {
    if (!id) return null;
    // 优先匹配当前视图的直接子节点：展开项一定对应当前页面里被点击的那张卡片，
    // 可避免不同来源（在线/本地）或同名 id 在深层遍历时抢先命中导致的错配。
    const direct = items.find((it) => it.id === id);
    if (direct) return direct;
    // 兜底：整树递归查找（应对极少数非当前视图层级的 id）。
    const stack: BeatmapItem[] = [...items];
    while (stack.length) {
      const it = stack.pop()!;
      if (it.id === id) return it;
      if (it.type === 'album') stack.push(...it.songs);
    }
    return null;
  };
  const expandedItem: BeatmapItem | null = findItemById(expandedId);

  const handlePickFiles = async (files: File[], kind: 'import' | 'chart' | 'audio' | 'cover') => {
    try {
      if (kind === 'import') {
        const hasZip = files.some((f) => f.name.toLowerCase().endsWith('.zip'));
        const res = hasZip
          ? await importZip(files.find((f) => f.name.toLowerCase().endsWith('.zip'))!, {
              targetAlbumId: currentAlbumId,
              t,
            })
          : await importLooseFiles(files, { targetAlbumId: currentAlbumId, t });
        if (currentAlbumId) {
          for (const s of res.songs ?? []) await addSong(currentAlbumId, s);
        } else {
          await createAlbum(res.album);
        }
        const warns = res.warnings?.length ? ' ' + t('fab.importWarnings', { detail: res.warnings.join('；') }) : '';
        showToast(t('fab.imported', { count: String(res.songCount) }) + warns);
      } else if (expandedItem) {
        const it = expandedItem;
        const file = files[0];
        if (kind === 'audio' && it.type === 'song') {
          // 按 id 整树定位（含库根独立曲目，其无父专辑 id）。
          const ref = await storeFile(file);
          await updateSongById(it.id, { audio: ref });
        } else if (kind === 'cover') {
          const ref = await storeFile(file);
          if (it.type === 'song') {
            // 按 id 整树定位（含库根独立曲目）。
            await updateSongById(it.id, { cover: ref });
          } else {
            await updateAlbum(it.id, { cover: ref });
          }
        } else if (kind === 'chart' && it.type === 'song') {
          const text = await file.text();
          const meta = parseChartMeta(text);
          const ref = await storeFile(file);
          const d = resolveDifficulty(meta?.difficulty);
          // 按 id 整树定位（含库根独立曲目），不再依赖父专辑 id。
          await addDifficultyToSong(it.id, { name: d.name, level: d.level, chartFile: ref, noteCount: meta?.noteCount });
        }
        showToast(t('fab.saved'));
      }
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : t('fab.importError');
      showToast(`${t('fab.importError')}：${msg}`);
    }
  };

  const handleNewAlbum = async (name: string) => {
    try {
      const created = await createAlbum({
        title: name, artist: '', cover: '', accentColor: DEFAULT_ACCENT, basePath: '', songs: [],
      });
      if (currentAlbumId) await moveAlbum(null, currentAlbumId, created.id);
      showToast(t('fab.created'));
    } catch (err) { console.error(err); }
  };

  const handleNewSong = async (name: string) => {
    try {
      const song: SongItem = {
        type: 'song', id: generateId('song'), title: name, artist: '', bpm: 120,
        cover: '', accentColor: DEFAULT_ACCENT, audio: '', basePath: '', difficulties: [],
      };
      if (currentAlbumId) {
        await addSong(currentAlbumId, song);
      } else {
        // 根目录直接创建为独立曲目，而不是用同名专辑包裹曲目
        await addSongToRoot(song);
      }
      showToast(t('fab.created'));
    } catch (err) { console.error(err); }
  };

  const handleEdit = () => {
    if (!expandedItem) return;
    const it = expandedItem;
    setEditDraft({
      title: it.title,
      artist: it.artist ?? '',
      bpm: it.type === 'song' ? it.bpm : 120,
      accentColor: it.accentColor ?? '',
      difficulties: it.type === 'song' ? it.difficulties.map((d) => ({ ...d })) : [],
    });
    setEditId(it.id);
  };

  const handleEditFieldChange = (
    field: 'title' | 'artist' | 'bpm' | 'accentColor',
    value: string | number,
  ) => {
    setEditDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const handleDeleteDifficulty = (index: number) => {
    setEditDraft((prev) => {
      if (!prev) return prev;
      // 允许删光所有难度（在当前选中难度被删后，卡片会自动收敛到剩余难度）。
      return { ...prev, difficulties: prev.difficulties.filter((_, i) => i !== index) };
    });
  };

  // 编辑谱面：加载当前选中难度进入编辑器；若歌曲无难度则现场新建一个再进入。
  const handleEditChart = () => {
    const it = expandedItem;
    if (!it || it.type !== 'song') return;
    const idx =
      it.difficulties.length > 0
        ? Math.min(getDiffIdx(it.id, it.difficulties.length), it.difficulties.length - 1)
        : -1;
    onLaunchChartEditor({
      mode: 'edit',
      albumId: currentAlbumId,
      songId: it.id,
      songTitle: it.title,
      songArtist: it.artist ?? '',
      bpm: it.bpm,
      accentColor: it.accentColor,
      source: it.source ?? 'local',
      audio: it.audio,
      chartFile: idx >= 0 ? it.difficulties[idx].chartFile : undefined,
      diffName: idx >= 0 ? it.difficulties[idx].name : undefined,
      selectedDiffIndex: idx,
      difficultiesCount: it.difficulties.length,
    });
  };

  // 新建谱面：重用卡片信息，并以内置 Neon Cyberspace 的 note 序列作为模板。
  const handleNewChart = () => {
    const it = expandedItem;
    if (!it || it.type !== 'song') return;
    onLaunchChartEditor({
      mode: 'new',
      albumId: currentAlbumId,
      songId: it.id,
      songTitle: it.title,
      songArtist: it.artist ?? '',
      bpm: it.bpm,
      accentColor: it.accentColor,
      source: it.source ?? 'local',
      audio: it.audio,
      selectedDiffIndex: -1,
      difficultiesCount: it.difficulties.length,
    });
  };

  const handleSave = async () => {
    if (!expandedItem || !editDraft) return;
    const it = expandedItem;
    try {
      if (it.type === 'album') {
        await updateAlbum(it.id, {
          title: editDraft.title,
          artist: editDraft.artist,
          accentColor: editDraft.accentColor || undefined,
        });
      } else {
        // 同一首歌可能同时存在于多个专辑（共用 id）。当前展开的歌曲一定位于
        // 当前视图专辑内，优先以 currentAlbumId 定位父专辑，避免改错副本。
        const albumId = currentAlbumId ?? (await getSongParentAlbumId(it.id));
        if (albumId)
          await updateSong(albumId, it.id, {
            title: editDraft.title,
            artist: editDraft.artist,
            bpm: Number(editDraft.bpm) || 120,
            accentColor: editDraft.accentColor || undefined,
            difficulties: editDraft.difficulties,
          });
        else
          await updateSongById(it.id, {
            title: editDraft.title,
            artist: editDraft.artist,
            bpm: Number(editDraft.bpm) || 120,
            accentColor: editDraft.accentColor || undefined,
            difficulties: editDraft.difficulties,
          });
      }
      showToast(t('fab.saved'));
    } catch (err) { console.error(err); }
    setEditId(null);
    setEditDraft(null);
  };

  const handleCancelEdit = () => { setEditId(null); setEditDraft(null); };

  const handleMove = () => {
    if (!expandedItem) return;
    setClipboard({ id: expandedItem.id, kind: expandedItem.type, fromAlbumId: currentAlbumId });
    setEditId(null);
    setEditDraft(null);
    // 收起卡片，使底栏出现“粘贴”（粘贴仅在卡片收起时可进行）。
    setExpandedId(null);
  };

  const handleDelete = async () => {
    if (!expandedItem) return;
    const it = expandedItem;
    try {
      if (it.type === 'album') await deleteAlbum(it.id);
      else {
        // 同理：优先以当前视图专辑定位父专辑，避免删除/改错同名副本。
        const albumId = currentAlbumId ?? (await getSongParentAlbumId(it.id));
        if (albumId) await deleteSong(albumId, it.id);
        else await deleteSongById(it.id); // 库根独立曲目（无父专辑）按 id 删除
      }
      setClipboard((c) => (c && c.id === it.id ? null : c));
      showToast(t('fab.deleted'));
    } catch (err) { console.error(err); }
    setEditId(null);
    setEditDraft(null);
    setExpandedId(null);
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    // Pasting back into the same album cancels the move.
    if (clipboard.fromAlbumId === currentAlbumId) {
      setClipboard(null);
      return;
    }
    try {
      if (clipboard.kind === 'album') await moveAlbum(clipboard.fromAlbumId, currentAlbumId, clipboard.id);
      else await moveSong(clipboard.fromAlbumId, currentAlbumId, clipboard.id);
      showToast(t('fab.pasted'));
    } catch (err) { console.error(err); }
    setClipboard(null);
  };

  const handleDownload = async (item?: BeatmapItem) => {
    const it = item ?? expandedItem;
    if (!it) return;
    try {
      if (it.type === 'album') {
        for (const s of it.songs) if (s.type === 'song') await downloadSongToLibrary(s);
      } else {
        await downloadSongToLibrary(it);
      }
      showToast(t('fab.downloaded'));
    } catch (err) { console.error(err); }
  };

  // 仅本地上下文（根目录或本地专辑）才允许新增/编辑；内置与在线内容受限。
  const currentAllowsEdit = !currentAlbum || currentAlbum.source === 'local';
  let fabMode: 'add' | 'edit' | 'download' | 'none' = 'none';
  if (expandedItem) {
    // 在根目录展开“内置/在线”专辑时，仍可新建内容（创建到根目录），
    // 而不是被折叠成"无操作"。
    const isRootAlbum = expandedItem.type === 'album' && viewDepth === 'root';
    if (isRootAlbum && expandedItem.source !== 'local') {
      fabMode = currentAllowsEdit ? 'add' : 'none';
    } else if (expandedItem.source === 'online' && expandedItem.type === 'album') {
      // 在线专辑不可直接下载（仅允许单曲下载）。
      fabMode = 'none';
    } else if (expandedItem.source === 'online') {
      fabMode = 'download';
    } else if (expandedItem.source === 'local') {
      fabMode = 'edit';
    } else {
      // 内置专辑/曲目不可编辑。
      fabMode = 'none';
    }
  } else if (currentAllowsEdit) {
    fabMode = 'add';
  }
  const fabVisible = fabMode !== 'none' && !result;

  // 剪贴板内容标题，用于在左侧“粘贴”按钮上显示是什么（跨整个 manifest 查找，不受当前视图限制）。
  const clipboardItem: BeatmapItem | null = (() => {
    if (!clipboard || !manifest?.items) return null;
    const stack: BeatmapItem[] = [...manifest.items];
    while (stack.length) {
      const it = stack.pop()!;
      if (it.id === clipboard.id) return it;
      if (it.type === 'album') stack.push(...it.songs);
    }
    return null;
  })();
  const clipboardLabel = clipboardItem
    ? `${clipboard!.kind === 'album' ? t('songcard.album') : t('songcard.track')}：${clipboardItem.title}`
    : '';
  const pasteVisible = !!clipboard && fabVisible && fabMode !== 'download';

  return (
    <div
      ref={containerRef}
      onClick={handleContainerClick}
      className="absolute inset-0 z-20"
    >
      {/* 压暗 + 背景模糊层：单独提成一层，不再挂在容器自身上。
          带 backdrop-filter 的元素会成为其后代的 backdrop root —— 容器自己带
          模糊时，左下头像、右下管理菜单以及所有玻璃面板只能采到本层内部的内容，
          采不到容器之外的页面背景，表现就是"模糊没渲染出来、几乎透明"（安卓
          WebView 上尤其明显）。改为兄弟层之后，面板的 backdrop 才是真正的页面
          背景，磨砂玻璃才成立。 */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 bg-black/45 backdrop-blur-md pointer-events-none"
      />
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
            <>
              <button
                onClick={handleBack}
                title={t('songselect.backToParent')}
                className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shrink-0"
              >
                <ArrowLeft size={14} />
              </button>
              <button
                onClick={handleHome}
                title={t('songselect.home')}
                className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shrink-0"
              >
                <Home size={14} />
              </button>
            </>
          )}
          {currentAlbum && (
            <div className="text-white font-orbitron font-bold tracking-wider truncate">
              {currentAlbum.title}
            </div>
          )}
          {viewDepth === 'root' && (
            <h1 className="flex items-baseline leading-none">
              <span className="text-2xl sm:text-3xl font-black font-orbitron tracking-wider gradient-text bg-gradient-to-r from-cyan-300 via-sky-200 to-amber-300">
                Poluxis
              </span>
              <span className="text-[10px] font-bold font-orbitron uppercase tracking-[0.35em] text-white/40 mr-2 mt-1 self-start">
                Project
              </span>
            </h1>
          )}
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
          const customDiff = result && !result.songId ? resolveDifficulty(result.meta.difficulty) : null;
          const customResultOnly =
            customDiff
              ? [{
                  type: 'song' as const,
                  id: '__custom_result__',
                  title: result!.meta.title,
                  artist: result!.meta.artist,
                  bpm: result!.meta.bpm,
                  difficulties: [{ name: customDiff.name || 'Custom', level: customDiff.level, chartFile: '' }],
                } as SongItem]
              : null;

          const renderList: BeatmapItem[] = customResultOnly ?? items;

          if (renderList.length === 0 && !result) {
            // Entering an empty album: show the "敬请期待" placeholder instead of the generic empty message.
            if (viewDepth === 'album' && currentAlbum && currentAlbum.songs.length === 0) {
              return (
                <div className="w-full flex flex-col items-center justify-center gap-3 text-white/40">
                  <div className="text-3xl font-orbitron tracking-[0.3em]">{t('songselect.soon')}</div>
                  <div className="text-sm">{t('songselect.albumEmpty')}</div>
                </div>
              );
            }
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
                key={`${item.id}-${i}`}
                item={item}
                isExpanded={isExpanded}
                isLoading={isLoading}
                loadingLabel={isLoading ? startPhase : null}
                currentDifficultyIdx={diffIdx}
                onExpand={() => handleExpand(item.id)}
                onCollapse={handleCollapse}
                onEnterAlbum={item.type === 'album' ? handleEnterAlbum : undefined}
                onStartGame={item.type === 'song' && isCustomResultCard ? () => onRetryCustom?.() : (item.type === 'song' ? handleStartGame : undefined)}
                onChangeDifficulty={item.type === 'song' ? handleChangeDifficulty : undefined}
                highScoreKey={isCustomResultCard ? undefined : getScoreKey(item.id, item.source)}
                resultData={hasResultPayload ? result : null}
                onExitResult={hasResultPayload ? exitResultMode : undefined}
                className={siblingSlideIn ? 'slide-in-card' : ''}
                centerWhenExpanded={shouldCenterOnExpanded}
                editMode={editId === item.id}
                editValues={editId === item.id && editDraft ? editDraft : undefined}
                onEditFieldChange={handleEditFieldChange}
                onDeleteDifficulty={handleDeleteDifficulty}
                onSave={handleSave}
              />
            );
            if (showDivider) {
              return (
                <React.Fragment key={`frag-${item.id}-${i}`}>
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
        <div className="flex items-center gap-4 text-xs text-white/70 pointer-events-auto">
          {/* 左下角账号入口（Auto-Play 左侧）：点击向上展开「设置 / 编辑器 / Lite 版」下拉列表 */}
          <AccountMenu
            placement="bottom-left"
            onOpenSettings={onOpenSettings}
            onOpenEditor={onOpenEditor}
            onSwitchLite={onSwitchLite}
          />
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
          {syncingOnline && (
            <span className="flex items-center gap-1.5 text-white/60 text-xs font-medium">
              <Loader2 size={13} className="animate-spin text-cyan-300" />
              {t('songselect.syncingOnline')}
            </span>
          )}
        </div>

        <div className="pointer-events-auto flex items-end gap-3">
          {pasteVisible && (
            <button
              onClick={handlePaste}
              className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold text-cyan-200"
            >
              <ClipboardPaste size={14} />
              <span>{clipboardLabel}</span>
            </button>
          )}
          <FloatingActionBar
            visible={fabVisible}
            mode={fabMode}
            expandedItem={expandedItem}
            inEditMode={editId !== null}
            onPickFiles={handlePickFiles}
            onNewAlbum={handleNewAlbum}
            onNewSong={handleNewSong}
            onEdit={handleEdit}
            onEditChart={handleEditChart}
            onNewChart={handleNewChart}
            onMove={handleMove}
            onDelete={handleDelete}
            onSave={handleSave}
            onCancelEdit={handleCancelEdit}
            onDownload={() => handleDownload()}
          />
        </div>
      </div>
      )}

      {toastMsg && (
        <div
          className="fixed left-1/2 top-6 z-[60] -translate-x-1/2 glass-panel-strong rounded-xl px-4 py-2 text-sm font-semibold text-white/90 animate-fade-in"
          style={{ pointerEvents: 'none' }}
        >
          {toastMsg}
        </div>
      )}
      </div>{/* /UI 框 */}
    </div>
  );
};
