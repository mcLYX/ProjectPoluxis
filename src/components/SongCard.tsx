import React, { useState, useRef, useEffect } from 'react';
import { cssVars } from '../utils/style';
import { BeatmapItem, SongItem, AlbumItem, DifficultyEntry } from '../types/beatmap';

// 编辑态输入框：压暗背景并模糊底层专辑图，提升在彩色封面上的可读性。
const EDIT_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
};
import { resolveBeatmapUrl, isFallbackSong, countLeafSongs, albumHasPlayableSong } from '../data/beatmapLoader';
import { Play, ChevronRight, Loader2, Music, Award, ArrowLeft, Save, Trash2 } from 'lucide-react';
import { getHighScore, HighScoreEntry, ClearBadge } from '../utils/scoreStore';
import { GameStats } from '../types/game';
import { useI18n } from '../i18n';

/** Play-result payload shown on the enlarged "result" variant of the card. */
export interface SongCardResultData {
  stats: GameStats;
  badge: ClearBadge | null;
  isNewHighScore: boolean;
  isNewBadge: boolean;
}

interface SongCardProps {
  item: BeatmapItem;
  isExpanded: boolean;
  isLoading?: boolean;
  currentDifficultyIdx?: number;
  onExpand: () => void;
  onCollapse: () => void;
  onEnterAlbum?: (album: AlbumItem) => void;
  onStartGame?: (song: SongItem, diffIdx: number) => void;
  onChangeDifficulty?: (song: SongItem, diffIdx: number) => void;
  highScoreKey?: string;
  /** When set (and expanded), the card renders as the post-play result card. */
  resultData?: SongCardResultData | null;
  /** "返回" on the result card: exit result mode back to normal expanded state. */
  onExitResult?: () => void;
  /** Extra classes applied to the outer card (e.g. entrance animation). */
  className?: string;
  /** When true and this card is expanded, scroll it into view (used right
      after leaving result mode so the played card stays centered). */
  centerWhenExpanded?: boolean;
  /** Edit mode: card fields become inline-editable and the action button becomes Save. */
  editMode?: boolean;
  /** Current draft values for the inline edit fields. */
  editValues?: {
    title: string;
    artist: string;
    bpm: number;
    accentColor: string;
    difficulties: DifficultyEntry[];
  };
  /** Called when an inline edit field changes (title/artist/bpm/accentColor). */
  onEditFieldChange?: (field: 'title' | 'artist' | 'bpm' | 'accentColor', value: string | number) => void;
  /** Called to delete a single difficulty chart by index (song cards only). */
  onDeleteDifficulty?: (index: number) => void;
  /** Called to save the current edit. */
  onSave?: () => void;
}

function rankColor(rank: GameStats['rank']): string {
  switch (rank) {
    case 'EX+':
    case 'EX':
      return 'text-amber-400';
    case 'S':
      return 'text-cyan-300';
    case 'A':
      return 'text-emerald-400';
    default:
      return 'text-white/50';
  }
}

function badgeClass(badge: ClearBadge): string {
  return badge === 'FC'
    ? 'bg-sky-500/20 border-sky-400 text-sky-300 shadow-[0_0_20px_rgba(56,189,248,0.5)]'
    : badge === 'AP'
    ? 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.5)]'
    : 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_28px_rgba(251,146,60,0.7)]';
}

const DEFAULT_ACCENT = '#0ea5e9';

function getAccent(item: BeatmapItem): string {
  return item.accentColor || DEFAULT_ACCENT;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function isAvailable(item: BeatmapItem): boolean {
  if (item.type === 'album') {
    // 递归检查任意后代是否含可玩歌曲（支持嵌套专辑/空专辑）
    return albumHasPlayableSong(item);
  }
  // Built-in (fallback) songs are always available — they use synth audio
  // and have their chart data bundled in the app.
  if (isFallbackSong(item.id)) {
    return item.difficulties.length > 0;
  }
  // Local / online songs: a difficulty is enough to play (synth audio when no
  // audio file is present).
  return item.difficulties.length > 0;
}

export const SongCard: React.FC<SongCardProps> = ({
  item,
  isExpanded,
  isLoading = false,
  currentDifficultyIdx = 0,
  onExpand,
  onCollapse,
  onEnterAlbum,
  onStartGame,
  onChangeDifficulty,
  highScoreKey,
  resultData = null,
  onExitResult,
  className = '',
  centerWhenExpanded = false,
  editMode,
  editValues,
  onEditFieldChange,
  onDeleteDifficulty,
  onSave,
}) => {
  const { t } = useI18n();
  const [coverError, setCoverError] = useState(false);
  const [showDiffMenu, setShowDiffMenu] = useState(false);
  const [editDiffIdx, setEditDiffIdx] = useState(0);
  // 结算卡片：点击 PERFECT/GOOD 在「数量」与「early/late 拆分」间切换。
  const [split, setSplit] = useState<'perfect' | 'good' | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // 每次结算结果变化时重置拆分视图，避免切歌后残留旧状态。
  useEffect(() => { setSplit(null); }, [resultData]);

  const accent = getAccent(item);
  const inResult = isExpanded && !!resultData;
  // The result card represents a chart that was just played — always startable.
  const available = !!resultData || isAvailable(item);
  const coverUrl = item.cover ? resolveBeatmapUrl(item.cover) : '';
  const showCover = !!coverUrl && !coverError;

  // Center this card in the carousel when entering result mode, or (in normal
  // mode) right after leaving it so the played song stays in view.
  //
  // NOTE: After the SongSelect refactor, the card never changes DOM parent
  // between result and normal mode (it always lives in the same carousel flex
  // container). This means we can safely use smooth scrolling without it
  // fighting a freshly-mounted element's position jump. We still defer the
  // center-by-scroll call one frame for the centerWhenExpanded path so the
  // CSS size transition (large result-card → smaller expanded-card) has laid
  // out its starting frame before we animate the scroll position — otherwise
  // the browser measures against the old dimensions and scrolls to the wrong
  // spot mid-transition.
  useEffect(() => {
    if (inResult) {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    } else if (centerWhenExpanded && isExpanded) {
      const raf = requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [inResult, centerWhenExpanded, isExpanded]);

  // 进入编辑态时，难度显示/选中改为以草稿(draft)为准，使删除等操作即时反映。
  useEffect(() => {
    if (editMode && item.type === 'song' && editValues) {
      setEditDiffIdx(Math.min(currentDifficultyIdx, Math.max(0, editValues.difficulties.length - 1)));
    }
    // 仅在进入/退出编辑态时重置选中难度
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode]);

  // 编辑模式下，难度显示/选中以草稿(draft)为准，删除后界面即时更新。
  const draftActive = editMode && item.type === 'song' && !!editValues;
  const workDiffs = draftActive ? editValues!.difficulties : item.type === 'song' ? item.difficulties : [];
  const workIdx = draftActive
    ? Math.min(editDiffIdx, Math.max(0, workDiffs.length - 1))
    : currentDifficultyIdx;
  const currentDiff = item.type === 'song' ? workDiffs[workIdx] ?? null : null;

  // 获取当前难度的最高分（每次渲染读取最新值，确保游戏结束后立即刷新）
  const highScore: HighScoreEntry | null =
    item.type === 'song' && currentDiff && highScoreKey
      ? getHighScore(highScoreKey, currentDiff.name)
      : null;

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action]')) return;
    if (inResult) return; // result card: interact via 返回 / Start buttons only
    if (editMode && isExpanded) return; // editing: don't collapse on body click
    if (isExpanded) {
      onCollapse();
    } else {
      onExpand();
    }
  };

  const handleEnterAlbum = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.type === 'album' && onEnterAlbum) {
      onEnterAlbum(item);
    }
  };

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.type === 'song' && onStartGame && available) {
      onStartGame(item, currentDifficultyIdx);
    }
  };

  const handleDiffClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.type === 'song' && workDiffs.length > 1) {
      setShowDiffMenu((v) => !v);
    }
  };

  return (
    <div
      ref={cardRef}
      data-ui-click="1"
      onClick={handleCardClick}
      className={`
        relative rounded-2xl ${inResult ? 'cursor-default' : 'cursor-pointer'} overflow-hidden
        ${className}
        transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]
        ${isExpanded
          ? inResult
            ? 'w-[94vw] max-w-[600px] h-[86vh] max-h-[720px] scale-100 z-30 song-card__expanded-result'
            : 'w-[85vw] max-w-[420px] h-[70vh] max-h-[560px] scale-100 z-30 song-card__expanded'
          : 'w-[28vw] max-w-[120px] h-[60vh] max-h-[360px] hover:scale-[1.04] z-10 song-card__collapsed'
        }
        flex-shrink-0
        border backdrop-blur-md
      `}
      style={cssVars({
        background: showCover
          ? undefined
          : `linear-gradient(160deg, ${rgba(accent, 0.16)} 0%, rgba(10, 13, 18, 0.86) 100%)`,
        borderColor: rgba(accent, 0.38),
        boxShadow: isExpanded
          ? inResult
            ? `0 0 80px ${rgba(accent, 0.42)}, inset 0 1px 0 rgba(255,255,255,0.14)`
            : `0 0 60px ${rgba(accent, 0.32)}, inset 0 1px 0 rgba(255,255,255,0.14)`
          : 'inset 0 1px 0 rgba(255,255,255,0.08)',
        '--song-card-hover-glow': `0 0 30px ${rgba(accent, 0.28)}, inset 0 1px 0 rgba(255,255,255,0.12)`,
      })}
    >
      {/* Cover Image */}
      {showCover && (
        <img
          src={coverUrl}
          alt={item.title}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setCoverError(true)}
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      )}
      {!showCover && (
        <div
          className="absolute inset-0 flex items-center justify-center opacity-20"
          style={{ background: `radial-gradient(circle at 30% 30%, ${accent}, transparent 70%)` }}
        >
          <Music size={48} />
        </div>
      )}

      {/* Dark gradient overlay for readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/20 pointer-events-none" />

      {/* Collapsed state: vertical text (left bottom) */}
      <div
        className={`
          absolute left-3 bottom-4 right-3
          transition-opacity duration-300
          ${isExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'}
        `}
      >
        <div
          className="text-white font-bold font-orbitron text-sm tracking-wider"
          style={{
            writingMode: 'vertical-lr',
            textOrientation: 'mixed',
            textShadow: '0 2px 8px rgba(0,0,0,0.8)',
          }}
        >
          {item.title}
        </div>
      </div>

      {/* Expanded state: horizontal title (top left) — inline-editable in edit mode */}
      {editMode && isExpanded ? (
        <div className="absolute top-5 left-5 right-5 flex flex-col gap-2 transition-all duration-400 max-h-[60%] overflow-y-auto pr-1">
          <input
            data-action="edit-field"
            value={editValues?.title ?? item.title}
            onChange={(e) => onEditFieldChange?.('title', e.target.value)}
            placeholder={t('fab.nameSong')}
            className="glass-input rounded-lg px-2 py-1 font-bold font-orbitron text-xl text-white outline-none w-full"
            style={EDIT_INPUT_STYLE}
          />
          <input
            data-action="edit-field"
            value={editValues?.artist ?? item.artist ?? ''}
            onChange={(e) => onEditFieldChange?.('artist', e.target.value)}
            placeholder={t('songcard.artist')}
            className="glass-input rounded-lg px-2 py-1 text-sm font-rajdhani text-white/80 outline-none w-full"
            style={EDIT_INPUT_STYLE}
          />
          {item.type === 'song' && (
            <input
              data-action="edit-field"
              type="number"
              value={editValues?.bpm ?? item.bpm}
              onChange={(e) => onEditFieldChange?.('bpm', Number(e.target.value))}
              placeholder="BPM"
              className="glass-input rounded-lg px-2 py-1 text-xs font-mono text-white/70 outline-none w-24"
              style={EDIT_INPUT_STYLE}
            />
          )}

          {/* 强调色编辑 */}
          <div className="flex items-center gap-2 mt-1">
            <span
              className="text-[10px] font-bold font-orbitron tracking-wider text-white/60"
              style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
            >
              {t('songcard.accent')}
            </span>
            <input
              data-action="edit-field"
              type="color"
              value={editValues?.accentColor || '#0ea5e9'}
              onChange={(e) => onEditFieldChange?.('accentColor', e.target.value)}
              className="h-7 w-9 rounded cursor-pointer bg-transparent border border-white/30"
            />
            <div className="flex items-center gap-1">
              {['#0ea5e9', '#22d3ee', '#34d399', '#f59e0b', '#f43f5e', '#a855f7', '#e879f9', '#64748b'].map(
                (c) => (
                  <button
                    key={c}
                    type="button"
                    data-action="edit-field"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditFieldChange?.('accentColor', c);
                    }}
                    className="h-5 w-5 rounded-full border border-white/40 transition hover:scale-110"
                    style={{
                      background: c,
                      outline: editValues?.accentColor?.toLowerCase() === c.toLowerCase() ? '2px solid #fff' : 'none',
                    }}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`
            absolute top-5 left-5 right-5
            transition-all duration-400
            ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'}
          `}
        >
          <div
            className="text-white font-bold font-orbitron text-2xl tracking-wide"
            style={{ textShadow: '0 2px 14px rgba(0,0,0,0.95)' }}
          >
            {item.title}
          </div>
          <div
            className="text-white/80 text-sm mt-1 font-rajdhani"
            style={{ textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}
          >
            {item.type === 'album' ? (item.artist || 'Various Artists') : item.artist}
          </div>
          {item.type === 'song' && (
            <div className="text-white/60 text-xs mt-1 font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              BPM {item.bpm}
            </div>
          )}
        </div>
      )}

      {/* Source badge (top-right, expanded only) */}
      {isExpanded && item.source && item.source !== 'builtin' && (
        <div
          className="absolute top-5 right-5 z-10 px-2.5 py-1 rounded-full text-[10px] font-bold font-orbitron tracking-wider border backdrop-blur-sm"
          style={{
            color: item.source === 'online' ? '#22d3ee' : '#fbbf24',
            borderColor: item.source === 'online' ? 'rgba(34,211,238,0.5)' : 'rgba(251,191,36,0.5)',
            background: item.source === 'online' ? 'rgba(34,211,238,0.12)' : 'rgba(251,191,36,0.12)',
          }}
        >
          {item.source === 'online' ? t('filemgr.online') : t('filemgr.local')}
        </div>
      )}

      {/* Result overlay: judgement breakdown panel (result mode only) */}
      {item.type === 'song' && resultData && (
        <div
          className={`
            absolute left-4 right-4 top-[5.75rem] bottom-[4.75rem] short:top-[4.5rem] short:bottom-[4.25rem]
            flex items-center justify-center
            transition-opacity duration-400
            ${isExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'}
          `}
        >
          <div className="w-full max-h-full overflow-y-auto rounded-2xl bg-white/[0.06] backdrop-blur-xl border border-white/20 px-4 py-3 short:py-2 text-center" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)' }}>
            <div className="flex items-center justify-center gap-1.5 text-white mb-1 short:mb-0.5">
              <Award size={13} />
              <span className="text-[10px] font-bold font-orbitron tracking-[0.3em] uppercase">
                {t('songcard.trackCleared')}
              </span>
            </div>

            <div className="flex items-center justify-center gap-3 mb-1 short:mb-0.5">
              <span
                className={`font-orbitron font-black text-4xl short:text-2xl tracking-widest drop-shadow-lg ${rankColor(
                  resultData.stats.rank
                )}`}
              >
                {resultData.stats.rank}
              </span>
              {resultData.badge && (
                <span
                  className={`px-2.5 py-1 rounded-lg font-black font-orbitron text-sm short:text-xs tracking-widest border-2 ${badgeClass(
                    resultData.badge
                  )}`}
                >
                  {resultData.badge}
                </span>
              )}
            </div>

            {(resultData.isNewHighScore || resultData.isNewBadge) && (
              <div className="text-amber-300 text-[10px] font-bold font-orbitron tracking-widest animate-pulse mb-0.5">
                {resultData.isNewHighScore && resultData.isNewBadge
                  ? t('songcard.newRecordAndBadge')
                  : resultData.isNewHighScore
                  ? t('songcard.newRecord')
                  : t('songcard.newBadge')}
              </div>
            )}

            <div className="text-3xl short:text-2xl font-black font-orbitron tracking-tight gradient-text bg-gradient-to-r from-cyan-300 via-white to-amber-300 mb-2 short:mb-1">
              {Math.round(resultData.stats.score).toLocaleString()}
            </div>

            {/* Perfect merges S-Perfect: "15(+7)"；点击切换为 early/late 拆分 E/L */}
            <div className="grid grid-cols-3 gap-1.5 mb-1.5 short:mb-1">
              <div
                onClick={() => setSplit((s) => (s === 'perfect' ? null : 'perfect'))}
                className="rounded-lg bg-white/5 border border-yellow-500/40 py-1.5 short:py-1 cursor-pointer hover:bg-white/10 active:scale-95 transition select-none"
              >
                <div className="text-yellow-300 text-[10px] font-bold tracking-wider">PERFECT</div>
                <div className="font-mono font-bold text-white text-sm">
                  {split === 'perfect' ? (
                    <span>
                      <span className="text-cyan-300">E{resultData.stats.perfectEarly}</span>{' '}
                      <span className="text-red-300">L{resultData.stats.perfectLate}</span>
                    </span>
                  ) : (
                    <>
                      {resultData.stats.perfectCount + resultData.stats.sPerfectCount}
                      {resultData.stats.sPerfectCount > 0 && (
                        <span className="text-orange-400">(+{resultData.stats.sPerfectCount})</span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div
                onClick={() => setSplit((s) => (s === 'good' ? null : 'good'))}
                className="rounded-lg bg-white/5 border border-sky-500/40 py-1.5 short:py-1 cursor-pointer hover:bg-white/10 active:scale-95 transition select-none"
              >
                <div className="text-sky-400 text-[10px] font-bold tracking-wider">GOOD</div>
                <div className="font-mono font-bold text-white text-sm">
                  {split === 'good' ? (
                    <span>
                      <span className="text-cyan-300">E{resultData.stats.goodEarly}</span>{' '}
                      <span className="text-red-300">L{resultData.stats.goodLate}</span>
                    </span>
                  ) : (
                    resultData.stats.goodCount
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-white/5 border border-red-500/40 py-1.5 short:py-1">
                <div className="text-red-400 text-[10px] font-bold tracking-wider">MISS</div>
                <div className="font-mono font-bold text-white text-sm">{resultData.stats.missCount}</div>
              </div>
            </div>

            <div className="text-[11px] text-white/70 font-mono">
              MAX COMBO {resultData.stats.maxCombo}x · ACC {resultData.stats.accuracy.toFixed(2)}%
            </div>
          </div>
        </div>
      )}

      {/* Bottom-right action button (Enter / Start / To Be Continued) */}
      <div
        className={`
          absolute bottom-5 right-5
          transition-all duration-400
          ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}
        `}
      >
        {isLoading ? (
          <div className="px-5 py-2.5 rounded-xl bg-black/40 backdrop-blur-sm border border-white/20 flex items-center gap-2 text-white/60">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm font-bold">{t('songcard.loading')}</span>
          </div>
        ) : editMode ? (
          <button
            data-action="save"
            onClick={(e) => {
              e.stopPropagation();
              onSave?.();
            }}
            className="px-5 py-2.5 rounded-xl glass-btn-primary font-bold text-sm hover:scale-105 active:scale-95 transition flex items-center gap-1.5"
            style={cssVars({ '--hud-accent': '#22d3ee' })}
          >
            <Save size={14} />
            {t('fab.save')}
          </button>
        ) : item.type === 'album' ? (
          <button
            data-action="enter"
            onClick={handleEnterAlbum}
            className="px-5 py-2.5 rounded-xl glass-btn-primary font-bold text-sm hover:scale-105 active:scale-95 transition flex items-center gap-1.5"
            style={cssVars({ '--hud-accent': '#10b981' })}
          >
            {t('songcard.enter')}
            <ChevronRight size={16} />
          </button>
        ) : !available ? (
          <div className="px-5 py-2.5 rounded-xl bg-white/[0.05] backdrop-blur-md border border-white/10 text-white/40 text-sm font-bold cursor-not-allowed">
            {t('songcard.toBeContinued')}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {inResult && (
              <button
                data-action="exit-result"
                onClick={(e) => {
                  e.stopPropagation();
                  onExitResult?.();
                }}
                className="px-4 py-2.5 rounded-xl bg-black/40 backdrop-blur-sm border border-white/25 text-white/85 hover:bg-white/10 hover:scale-105 active:scale-95 font-bold text-sm transition flex items-center gap-1.5"
              >
                <ArrowLeft size={14} />
                {t('songcard.back')}
              </button>
            )}
            <button
              data-action="start"
              onClick={handleStart}
              className="px-5 py-2.5 rounded-xl glass-btn-primary font-bold text-sm hover:scale-105 active:scale-95 transition flex items-center gap-1.5"
            >
              <Play size={14} className="fill-white" />
              {inResult ? t('songcard.retry') : t('songcard.start')}
            </button>
          </div>
        )}
      </div>

      {/* Bottom-left: high score + difficulty (song only, expanded) */}
      {item.type === 'song' && (
        <div
          className={`
            absolute bottom-5 left-5
            transition-all duration-400
            ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}
          `}
        >
          {highScore && (
            <div className="mb-2">
              <div className="flex items-end gap-2">
                <div className="text-amber-300 text-lg font-black font-orbitron tracking-tight drop-shadow-lg">
                  {Math.round(highScore.score).toLocaleString()}
                </div>
                <div className="text-white/50 text-xs font-mono pb-1">
                  {highScore.rank}
                </div>
                {highScore.bestBadge && (
                  <div
                    className={`px-1.5 py-0.5 rounded text-[10px] font-black font-orbitron tracking-wider border ${
                      highScore.bestBadge === 'FC'
                        ? 'bg-sky-500/30 border-sky-400/60 text-sky-200'
                        : highScore.bestBadge === 'AP'
                        ? 'bg-amber-500/30 border-amber-400/60 text-amber-200'
                        : 'bg-amber-500/30 border-orange-400/70 text-amber-200 shadow-[0_0_10px_rgba(251,146,60,0.5)]'
                    }`}
                  >
                    {highScore.bestBadge}
                  </div>
                )}
              </div>
            </div>
          )}
          {currentDiff && (
            inResult ? (
              // Result card: show difficulty as a static tag (no switching allowed
              // mid-result), always visible so the player knows which level they
              // just cleared (it got accidentally hidden by the previous
              // !inResult guard).
              <div
                className="px-3 py-1.5 rounded-lg text-xs font-bold font-orbitron tracking-wider border bg-black/30 border-white/20 text-white/80 cursor-default select-none"
              >
                {currentDiff.name}
                {currentDiff.level != null && currentDiff.level > 0 && (
                  <span className="ml-1 text-white/60">Lv.{currentDiff.level}</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  data-action="diff"
                  onClick={handleDiffClick}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-orbitron tracking-wider border transition ${
                    workDiffs.length > 1
                      ? 'bg-white/10 backdrop-blur-sm border-white/30 text-white hover:bg-white/20 cursor-pointer'
                      : 'bg-black/30 border-white/20 text-white/80 cursor-default'
                  }`}
                >
                  {currentDiff.name}
                  {currentDiff.level != null && currentDiff.level > 0 && (
                    <span className="ml-1 text-white/60">Lv.{currentDiff.level}</span>
                  )}
                  {workDiffs.length > 1 && (
                    <span className="ml-1 text-white/40">▾</span>
                  )}
                </button>
                {editMode && (
                  <button
                    type="button"
                    data-action="edit-field"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteDifficulty?.(workIdx);
                    }}
                    className="h-7 w-7 rounded-md bg-rose-500/20 border border-rose-400/50 text-rose-200 hover:bg-rose-500/40 hover:scale-105 active:scale-95 transition flex items-center justify-center"
                    title={t('songcard.deleteDifficulty')}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            )
          )}

          {/* Difficulty dropdown (hidden in result mode) */}
          {!inResult && showDiffMenu && currentDiff && workDiffs.length > 1 && (
            <div className="absolute bottom-full left-0 mb-2 bg-black/90 backdrop-blur-md border border-white/20 rounded-xl overflow-hidden min-w-[140px] shadow-2xl z-50">
              {workDiffs.map((d, i) => (
                <button
                  key={`${d.name}-${i}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDiffMenu(false);
                    if (draftActive) setEditDiffIdx(i);
                    else if (onChangeDifficulty) onChangeDifficulty(item, i);
                  }}
                  className={`w-full px-4 py-2 text-left text-xs font-bold transition ${
                    i === workIdx
                      ? 'bg-cyan-500/30 text-cyan-200'
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="font-orbitron">{d.name}</span>
                  {d.level != null && d.level > 0 && (
                    <span className="float-right text-white/50 font-mono">Lv.{d.level}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Album-type badge (collapsed: small tag at top) */}
      {item.type === 'album' && !isExpanded && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 text-[9px] font-bold text-white/70 font-orbitron tracking-wider">
          {t('songcard.album')}
        </div>
      )}

      {/* Album song count (expanded, bottom-left area) */}
      {item.type === 'album' && isExpanded && (
        <div
          className={`
            absolute bottom-5 left-5
            transition-all duration-400
            ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}
          `}
        >
          <div className="text-white/60 text-xs font-bold font-orbitron tracking-wider">
            {countLeafSongs(item)} {countLeafSongs(item) === 1 ? t('songcard.track') : t('songcard.tracks')}
          </div>
        </div>
      )}
    </div>
  );
};
