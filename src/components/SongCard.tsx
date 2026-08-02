import React, { useState, useRef, useEffect } from 'react';
import { BeatmapItem, SongItem, AlbumItem } from '../types/beatmap';
import { resolveBeatmapUrl, isFallbackSong } from '../data/beatmapLoader';
import { Play, ChevronRight, Loader2, Music, Award, ArrowLeft } from 'lucide-react';
import { getHighScore, HighScoreEntry, ClearBadge } from '../utils/scoreStore';
import { GameStats } from '../types/game';

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
    return item.songs.length > 0;
  }
  // Built-in (fallback) songs are always available — they use synth audio
  // and have their chart data bundled in the app.
  if (isFallbackSong(item.id)) {
    return item.difficulties.length > 0;
  }
  return item.difficulties.length > 0 && !!item.audio;
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
}) => {
  const [coverError, setCoverError] = useState(false);
  const [showDiffMenu, setShowDiffMenu] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

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

  const currentDiff = item.type === 'song' ? item.difficulties[currentDifficultyIdx] : null;

  // 获取当前难度的最高分（每次渲染读取最新值，确保游戏结束后立即刷新）
  const highScore: HighScoreEntry | null =
    item.type === 'song' && currentDiff && highScoreKey
      ? getHighScore(highScoreKey, currentDiff.name)
      : null;

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action]')) return;
    if (inResult) return; // result card: interact via 返回 / Start buttons only
    if (isExpanded) {
      onCollapse();
    } else {
      onExpand();
    }
  };

  const handleEnterAlbum = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.type === 'album' && onEnterAlbum && available) {
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
    if (item.type === 'song' && item.difficulties.length > 1) {
      setShowDiffMenu((v) => !v);
    }
  };

  const handleSelectDiff = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    setShowDiffMenu(false);
    if (item.type === 'song' && onChangeDifficulty) {
      onChangeDifficulty(item, idx);
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
      style={{
        background: showCover
          ? undefined
          : `linear-gradient(160deg, ${rgba(accent, 0.16)} 0%, rgba(10, 13, 18, 0.86) 100%)`,
        borderColor: rgba(accent, 0.38),
        boxShadow: isExpanded
          ? inResult
            ? `0 0 80px ${rgba(accent, 0.42)}, inset 0 1px 0 rgba(255,255,255,0.14)`
            : `0 0 60px ${rgba(accent, 0.32)}, inset 0 1px 0 rgba(255,255,255,0.14)`
          : 'inset 0 1px 0 rgba(255,255,255,0.08)',
        ['--song-card-hover-glow' as any]: `0 0 30px ${rgba(accent, 0.28)}, inset 0 1px 0 rgba(255,255,255,0.12)`,
      }}
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

      {/* Expanded state: horizontal title (top left) */}
      <div
        className={`
          absolute top-5 left-5 right-5
          transition-all duration-400
          ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'}
        `}
      >
        <div className="text-white font-bold font-orbitron text-2xl tracking-wide drop-shadow-lg">
          {item.title}
        </div>
        <div className="text-white/70 text-sm mt-1 font-rajdhani drop-shadow">
          {item.type === 'album' ? (item.artist || 'Various Artists') : item.artist}
        </div>
        {item.type === 'song' && (
          <div className="text-white/50 text-xs mt-1 font-mono">
            BPM {item.bpm}
          </div>
        )}
      </div>

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
                Track Cleared
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
                  ? '★ NEW RECORD & NEW BADGE ★'
                  : resultData.isNewHighScore
                  ? '★ NEW RECORD ★'
                  : '★ NEW BADGE ★'}
              </div>
            )}

            <div className="text-3xl short:text-2xl font-black font-orbitron tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-white to-amber-300 mb-2 short:mb-1">
              {Math.round(resultData.stats.score).toLocaleString()}
            </div>

            {/* Perfect merges S-Perfect: "15(+7)" */}
            <div className="grid grid-cols-3 gap-1.5 mb-1.5 short:mb-1">
              <div className="rounded-lg bg-white/5 border border-yellow-500/40 py-1.5 short:py-1">
                <div className="text-yellow-300 text-[10px] font-bold tracking-wider">PERFECT</div>
                <div className="font-mono font-bold text-white text-sm">
                  {resultData.stats.perfectCount + resultData.stats.sPerfectCount}
                  {resultData.stats.sPerfectCount > 0 && (
                    <span className="text-orange-400">(+{resultData.stats.sPerfectCount})</span>
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-white/5 border border-sky-500/40 py-1.5 short:py-1">
                <div className="text-sky-400 text-[10px] font-bold tracking-wider">GOOD</div>
                <div className="font-mono font-bold text-white text-sm">{resultData.stats.goodCount}</div>
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
            <span className="text-sm font-bold">加载中</span>
          </div>
        ) : !available ? (
          <div className="px-5 py-2.5 rounded-xl bg-white/[0.05] backdrop-blur-md border border-white/10 text-white/40 text-sm font-bold cursor-not-allowed">
            To be continued...
          </div>
        ) : item.type === 'album' ? (
          <button
            data-action="enter"
            onClick={handleEnterAlbum}
            className="px-5 py-2.5 rounded-xl glass-btn-primary font-bold text-sm hover:scale-105 active:scale-95 transition flex items-center gap-1.5"
            style={{ ['--hud-accent' as any]: '#10b981' }}
          >
            Enter
            <ChevronRight size={16} />
          </button>
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
                返回
              </button>
            )}
            <button
              data-action="start"
              onClick={handleStart}
              className="px-5 py-2.5 rounded-xl glass-btn-primary font-bold text-sm hover:scale-105 active:scale-95 transition flex items-center gap-1.5"
            >
              <Play size={14} className="fill-white" />
              {inResult ? '重试' : 'Start'}
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
                <span className="ml-1 text-white/60">Lv.{currentDiff.level}</span>
              </div>
            ) : (
              <button
                data-action="diff"
                onClick={handleDiffClick}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-orbitron tracking-wider border transition ${
                  item.difficulties.length > 1
                    ? 'bg-white/10 backdrop-blur-sm border-white/30 text-white hover:bg-white/20 cursor-pointer'
                    : 'bg-black/30 border-white/20 text-white/80 cursor-default'
                }`}
              >
                {currentDiff.name}
                <span className="ml-1 text-white/60">Lv.{currentDiff.level}</span>
                {item.difficulties.length > 1 && (
                  <span className="ml-1 text-white/40">▾</span>
                )}
              </button>
            )
          )}

          {/* Difficulty dropdown (hidden in result mode) */}
          {!inResult && showDiffMenu && currentDiff && item.difficulties.length > 1 && (
            <div className="absolute bottom-full left-0 mb-2 bg-black/90 backdrop-blur-md border border-white/20 rounded-xl overflow-hidden min-w-[140px] shadow-2xl z-50">
              {item.difficulties.map((d, i) => (
                <button
                  key={d.name}
                  onClick={(e) => handleSelectDiff(e, i)}
                  className={`w-full px-4 py-2 text-left text-xs font-bold transition ${
                    i === currentDifficultyIdx
                      ? 'bg-cyan-500/30 text-cyan-200'
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="font-orbitron">{d.name}</span>
                  <span className="float-right text-white/50 font-mono">Lv.{d.level}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Album-type badge (collapsed: small tag at top) */}
      {item.type === 'album' && !isExpanded && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 text-[9px] font-bold text-white/70 font-orbitron tracking-wider">
          ALBUM
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
            {item.songs.length} {item.songs.length === 1 ? 'TRACK' : 'TRACKS'}
          </div>
        </div>
      )}
    </div>
  );
};
