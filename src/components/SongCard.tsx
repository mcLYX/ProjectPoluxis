import React, { useState, useRef, useEffect } from 'react';
// 卡片专属样式（收起态 hover 光晕 + 结算入场动画的 keyframes）。
// ⚠️ 历史上这个文件没有被任何模块 import，里面两条规则一直是死代码；组件必须显式引入。
import './SongCard.css';
import { cssVars } from '../utils/style';
import { BeatmapItem, SongItem, AlbumItem, DifficultyEntry } from '../types/beatmap';

// 编辑态输入框：压暗背景并模糊底层专辑图，提升在彩色封面上的可读性。
const EDIT_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
};
import { resolveBeatmapUrl, isFallbackSong, countLeafSongs, albumHasPlayableSong } from '../data/beatmapLoader';
import { Play, ChevronRight, Loader2, Music, Award, ArrowLeft, Save, Trash2, RotateCcw } from 'lucide-react';
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
  /** 覆盖加载中的文案（阶段 + 百分比，如「音频 42%」）；缺省为 t('songcard.loading')。 */
  loadingLabel?: string | null;
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

/** 结算文字阴影：可读性主力是它（+局部渐变），而不是把整张曲绘压暗。 */
const RESULT_TEXT_SHADOW = '0 2px 10px rgba(0,0,0,0.92), 0 0 24px rgba(0,0,0,0.5)';
/** 小字号标签用：只做"贴住背景"的最小保证 —— 一层 1px 硬影 + 一层很淡的扩散。
 *  刻意保持轻：多层浓阴影会让每个小块各自"浮"起来，反而暴露出布局的分块边界
 *  （哪块从哪开始、到哪结束一目了然），看着像拼装件而不像一张画面。 */
const RESULT_TEXT_SHADOW_SM = '0 1px 2px rgba(0,0,0,0.88), 0 0 6px rgba(0,0,0,0.55)';

interface RankVisual {
  /** 评级字形的渐变填充（配合 .gradient-text 的 background-clip:text）。 */
  gradient: string;
  /** 外发光色（`filter: drop-shadow()`），与填充同色系。 */
  glow: string;
}

/** 评级配色：EX 系金橙、S 青、A 绿、B/C 冷紫、F 灰。
 *  用渐变+发光而非纯色文字 —— 结算卡没有玻璃底衬托，纯色压在曲绘上容易发灰。 */
function rankVisual(rank: GameStats['rank']): RankVisual {
  switch (rank) {
    case 'EX+':
      return { gradient: 'linear-gradient(165deg,#fff8e1 0%,#ffd166 34%,#fb923c 68%,#f43f5e 100%)', glow: 'rgba(251,146,60,0.78)' };
    case 'EX':
      return { gradient: 'linear-gradient(165deg,#fffbeb 0%,#fcd34d 42%,#f59e0b 100%)', glow: 'rgba(251,191,36,0.66)' };
    case 'S':
      return { gradient: 'linear-gradient(165deg,#ecfeff 0%,#7dd3fc 40%,#22d3ee 100%)', glow: 'rgba(34,211,238,0.62)' };
    case 'A':
      return { gradient: 'linear-gradient(165deg,#ecfdf5 0%,#6ee7b7 42%,#10b981 100%)', glow: 'rgba(52,211,153,0.56)' };
    case 'B':
      return { gradient: 'linear-gradient(165deg,#eef2ff 0%,#a5b4fc 42%,#6366f1 100%)', glow: 'rgba(129,140,248,0.5)' };
    case 'C':
      return { gradient: 'linear-gradient(165deg,#f5f3ff 0%,#c4b5fd 42%,#8b5cf6 100%)', glow: 'rgba(167,139,250,0.46)' };
    default:
      return { gradient: 'linear-gradient(165deg,#f8fafc 0%,#cbd5e1 42%,#94a3b8 100%)', glow: 'rgba(148,163,184,0.42)' };
  }
}

function badgeClass(badge: ClearBadge): string {
  return badge === 'FC'
    ? 'bg-sky-500/20 border-sky-400 text-sky-300 shadow-[0_0_14px_rgba(56,189,248,0.38)]'
    : badge === 'AP'
    ? 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.38)]'
    : 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_18px_rgba(251,146,60,0.5)]';
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

/** 判定小分区：只有一道顶高光 + 底部一条渐隐色条，不画整圈边框 —— 画满边框会把
 *  曲绘切成一格一格的小方块，视觉上"盖"在封面上而不是"长"在封面上。 */
function JudgeStat({
  label, value, color, glow, onClick,
}: {
  label: string;
  value: React.ReactNode;
  color: string;
  glow: string;
  onClick?: () => void;
}) {
  const paint: React.CSSProperties = {
    /* 渐变对比压低 + 顶部内高光减弱：让小块读作"一层光"而不是"一块面板"。
       底色一旦太实、边缘一旦太亮，格子与格子之间就会浮出布局的边界线。 */
    background: 'linear-gradient(180deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.045) 52%, rgba(255,255,255,0.015) 100%)',
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.14), 0 6px 16px -14px ${glow}`,
  };
  const shell = 'relative block overflow-hidden rounded-xl px-2 py-1.5 text-left transition';
  const body = (
    <>
      <span
        className="absolute left-2.5 right-2.5 bottom-0 h-[2px] rounded-full"
        style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
      />
      <span
        className="block text-[9px] font-bold font-orbitron tracking-[0.18em]"
        style={{ color, textShadow: `0 0 12px ${glow}` }}
      >
        {label}
      </span>
      <span
        className="block font-mono font-bold text-white text-[clamp(12px,3.9vw,15px)] leading-tight mt-0.5 tabular-nums"
        style={{ textShadow: RESULT_TEXT_SHADOW }}
      >
        {value}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      data-action="judge-split"
      onClick={onClick}
      className={`${shell} cursor-pointer hover:brightness-125 active:scale-[0.97]`}
      style={paint}
    >
      {body}
    </button>
  ) : (
    <div className={`${shell} cursor-default`} style={paint}>{body}</div>
  );
}

export const SongCard: React.FC<SongCardProps> = ({
  item,
  isExpanded,
  isLoading = false,
  loadingLabel = null,
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
  /** 结算评级配色（渐变填充 + 外发光）。 */
  const rv = rankVisual(resultData ? resultData.stats.rank : 'F');
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

      {/* 可读性底衬。
          常态：整卡自下而上的压暗渐变（卡片小、信息少，代价可忽略）。
          结算态：改为「底部渐隐条 + 左上角题名晕 + 强调色氛围光」—— 只托住文字真正
          占住的那一带，卡片中上部的大片曲绘保持通透，UI 不会把封面横切成两半。 */}
      <div
        className={`absolute inset-0 pointer-events-none ${inResult ? '' : 'bg-gradient-to-t from-black/90 via-black/30 to-black/20'}`}
        style={inResult ? {
          backgroundImage: [
            // 底栏：只托住文字这一带，顶部完全消失（无硬边）。有下面的"聚焦带"分担
            // 对比度需求，这里刻意比上一版轻 —— 压暗不再是小字可读性的唯一手段。
            'linear-gradient(to top, rgba(3,5,9,0.78) 0%, rgba(3,5,9,0.58) 26%, rgba(3,5,9,0.30) 50%, rgba(3,5,9,0.10) 72%, rgba(3,5,9,0) 90%)',
            // 题名角晕：只压左上角一小块，右上角曲绘留白
            'radial-gradient(70% 36% at 6% 4%, rgba(3,5,9,0.70) 0%, rgba(3,5,9,0.28) 50%, rgba(3,5,9,0) 100%)',
            // 强调色氛围光：让成绩区与曲绘同色系，视觉上"长"在封面上
            `radial-gradient(58% 44% at 50% 92%, ${rgba(accent, 0.24)} 0%, ${rgba(accent, 0.07)} 46%, transparent 74%)`,
          ].join(', '),
        } : undefined}
      />

      {/* 聚焦带（仅结算态）：把封面在文字所在的那一带有色地"收一收"——
          轻模糊 + 降饱和 + 微压暗，向上渐隐消失。全卡唯一一处模糊，范围只有下方
          58%，中上部曲绘原样保留；像镜头景深把繁复背景推远，文字自然浮出。
          样式与 mask 的 @supports 兜底都在 SongCard.css。 */}
      {inResult && <div className="result-focus-band" />}

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
        <div className="absolute top-5 left-5 flex flex-col gap-2 transition-all duration-400 max-h-[60%] overflow-y-auto pr-1" style={{ width: 'calc(min(85vw, 420px) - 2.5rem)' }}>
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
            absolute top-5 left-5
            transition-all duration-400
            ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'}
          `}
          /* Viewport-anchored width (== expanded card inner width, which is
           * `min(85vw,420px) - 40px`). The card width animates 120→420 over 500ms;
           * if this box used `right-5` its width would track the card every frame
           * and the title/artist/BPM would re-wrap on every frame (the same jank
           * Lite had). Anchoring keeps the box constant; `overflow-hidden` on the
           * card just clips it while narrow and reveals it as it widens. */
          style={{ width: 'calc(min(85vw, 420px) - 2.5rem)' }}
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

      {/* 结算成绩：直接落在曲绘上，**没有玻璃面板**。
          可读性来自「底部渐隐底衬 + 字形发光 + 小分区渐变」三层，而不是把整张封面压暗。 */}
      {item.type === 'song' && resultData && (
        <div
          className={`
            absolute left-1/2 -translate-x-1/2 top-[84px] bottom-[92px] short:top-[72px] short:bottom-[88px]
            flex flex-col justify-end
            transition-opacity duration-400
            ${isExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'}
          `}
          /* 视口锚定宽度（结算卡内宽 = min(94vw,600px) - 2.5rem）：卡片 420→600 的
             入场过渡期间若用 left/right 锚定，判定数字会每帧重排。用 translateX(-50%)
             居中（走合成器，不触发重排）+ 固定宽度。 */
          style={{ width: 'calc(min(94vw, 600px) - 2.5rem)' }}
        >
          {/* 刻意**不加** overflow / 滚动容器。
              坑：`overflow-y: auto` 会让 `overflow-x` 从 visible 强制变成 auto
              （CSS 规范：两轴中只要有一个不是 visible，另一个就取 auto），于是这个
              盒子横竖都在裁剪 —— 评级 EX+ 的 30px 辉光和分数的 18px 辉光一跨出盒子
              左右边缘就被切断，屏幕上出现两条笔直的"版面边界"切口，比裁之前更难看。
              想靠滚动兜底纵向溢出也不行：裁剪必然带来切口。
              纵向已由 clamp 尺寸 + 横屏单行布局压到最小，正常不会溢出。 */}
          <div>
            {/* ① 眉标：关卡完成 */}
            <div className="result-rise flex items-center gap-2 mb-1.5" style={{ animationDelay: '40ms' }}>
              <span
                className="w-[3px] h-3 rounded-full"
                style={{
                  background: `linear-gradient(180deg, ${accent}, ${rgba(accent, 0.15)})`,
                  boxShadow: `0 0 10px ${rgba(accent, 0.85)}`,
                }}
              />
              <Award size={12} className="text-white/75" />
              <span
                className="text-[10px] font-bold font-orbitron tracking-[0.32em] uppercase text-white/85"
                style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
              >
                {t('songcard.trackCleared')}
              </span>
              {/* 新纪录提示挪到眉标行右端：它和"关卡完成"是同一层级的状态标记，
                  挤在评级旁边会把主视觉挤成一团（横屏尤其明显）。 */}
              {(resultData.isNewHighScore || resultData.isNewBadge) && (
                <span
                  className="result-rise ml-auto px-2 py-[2px] rounded-md text-[10px] font-bold font-orbitron tracking-[0.12em] text-amber-100 whitespace-nowrap"
                  style={{
                    animationDelay: '240ms',
                    /* 描边与外辉都收一档：描边太实 + 光晕太浓时，pill 会变成一个
                       独立贴片，把"这里是一块 UI"写在脸上。 */
                    background: 'linear-gradient(100deg, rgba(251,191,36,0.30), rgba(251,146,60,0.12))',
                    border: '1px solid rgba(253,224,71,0.38)',
                    boxShadow: '0 0 12px rgba(251,191,36,0.32)',
                    textShadow: RESULT_TEXT_SHADOW_SM,
                  }}
                >
                  {resultData.isNewHighScore && resultData.isNewBadge
                    ? t('songcard.newRecordAndBadge')
                    : resultData.isNewHighScore
                    ? t('songcard.newRecord')
                    : t('songcard.newBadge')}
                </span>
              )}
            </div>

            {/* ② 主视觉：评级（渐变 + 发光）+ 徽章 + 分数。
                竖屏两行、分数在评级下方；横屏（short）压成一行、分数右对齐 ——
                宽屏的横向空间本来就空着，纵向高度则寸土寸金。 */}
            <div className="flex flex-col wide:flex-row wide:items-end wide:gap-5">
              <div className="flex items-end gap-2.5">
                <span
                  className="result-rank-in font-orbitron font-black leading-[0.8] tracking-tight gradient-text"
                  style={{
                    fontSize: 'clamp(46px, min(15vw, 12vh), 88px)',
                    backgroundImage: rv.gradient,
                    filter: `drop-shadow(0 3px 10px rgba(0,0,0,0.9)) drop-shadow(0 0 30px ${rv.glow})`,
                    animationDelay: '80ms',
                  }}
                >
                  {resultData.stats.rank}
                </span>
                {resultData.badge && (
                  <span
                    className={`result-rise mb-1.5 wide:mb-2.5 px-2 py-[3px] rounded-md font-black font-orbitron text-[11px] tracking-[0.16em] border-2 ${badgeClass(
                      resultData.badge
                    )}`}
                    style={{ animationDelay: '200ms' }}
                  >
                    {resultData.badge}
                  </span>
                )}
              </div>

              <div
                className="result-rise mt-1 wide:mt-0 wide:ml-auto flex items-baseline gap-2"
                style={{ animationDelay: '150ms' }}
              >
                <span
                  className="text-[9px] font-orbitron tracking-[0.3em] text-white/55"
                  style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
                >
                  SCORE
                </span>
                <span
                  className="font-orbitron font-black leading-none tracking-tight gradient-text"
                  style={{
                    fontSize: 'clamp(24px, min(7.6vw, 6.2vh), 40px)',
                    backgroundImage: 'linear-gradient(96deg, #a5f3fc 0%, #ffffff 46%, #fcd34d 100%)',
                    filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.9)) drop-shadow(0 0 18px rgba(103,232,249,0.35))',
                  }}
                >
                  {Math.round(resultData.stats.score).toLocaleString()}
                </span>
              </div>
            </div>

            {/* ④ 发丝分隔线：两端都是渐隐（连起点也不画出来），刻意压得很淡 ——
                分隔线越"完整"，越像一条把画面切成两块的硬边界。 */}
            <div
              className="result-rise mt-2.5 mb-2 short:mt-1.5 short:mb-1.5 h-px w-full"
              style={{
                animationDelay: '220ms',
                background: `linear-gradient(90deg, transparent 0%, ${rgba(accent, 0.42)} 20%, rgba(255,255,255,0.13) 48%, transparent 100%)`,
              }}
            />

            {/* ⑤ 判定小分区 + ⑥ ACC/COMBO：横屏并到同一行 —— 判定占主位，
                ACC/COMBO 靠右且刻意做小做淡（次要信息不该和判定数字抢视觉）。
                竖屏则上下两行，避免窄屏挤在一起。 */}
            <div
              className="result-rise flex flex-col gap-2.5 wide:flex-row wide:items-end wide:gap-3"
              style={{ animationDelay: '260ms' }}
            >
              <div className="result-judge-grid flex-1">
                <JudgeStat
                  label="PERFECT"
                  color="#fde047"
                  glow="rgba(250,204,21,0.55)"
                  onClick={() => setSplit((s) => (s === 'perfect' ? null : 'perfect'))}
                  value={
                    split === 'perfect' ? (
                      <span className="whitespace-nowrap">
                        <span className="text-cyan-300">E{resultData.stats.perfectEarly}</span>{' '}
                        <span className="text-rose-300">L{resultData.stats.perfectLate}</span>
                      </span>
                    ) : (
                      <span className="whitespace-nowrap">
                        {resultData.stats.perfectCount + resultData.stats.sPerfectCount}
                        {resultData.stats.sPerfectCount > 0 && (
                          /* S-Perfect 附加分：比主数字小一档，宽度吃紧时还能再缩
                             （字号跟视口联动），保证 "1536 (+1462)" 单行不折行 */
                          <span className="text-orange-400 text-[clamp(9px,2.9vw,11px)]"> (+{resultData.stats.sPerfectCount})</span>
                        )}
                      </span>
                    )
                  }
                />
                <JudgeStat
                  label="GOOD"
                  color="#38bdf8"
                  glow="rgba(56,189,248,0.55)"
                  onClick={() => setSplit((s) => (s === 'good' ? null : 'good'))}
                  value={
                    split === 'good' ? (
                      <span>
                        <span className="text-cyan-300">E{resultData.stats.goodEarly}</span>{' '}
                        <span className="text-rose-300">L{resultData.stats.goodLate}</span>
                      </span>
                    ) : (
                      resultData.stats.goodCount
                    )
                  }
                />
                <JudgeStat label="MISS" color="#fb7185" glow="rgba(244,63,94,0.5)" value={resultData.stats.missCount} />
              </div>

              {/* ACC / MAX COMBO：次要信息，字号与不透明度都刻意压低一档。
                  横屏（wide）改成上下两行 —— 单行时这块要占掉 ~190px，判定分区
                  每格只剩 ~100px，"1536 (+1462)" 就会折行把 chip 撑高；改成两行后
                  宽度还回一半，正好和并排的判定分区高度相当。竖屏仍单行（下面独占
                  一整行，横向本来就够）。 */}
              <div className="flex items-center gap-3 wide:flex-col wide:items-start wide:gap-1 wide:pb-1.5 shrink-0">
                <span className="flex items-baseline gap-1.5">
                  <span
                    className="text-[9px] font-orbitron tracking-[0.22em] text-white/55"
                    style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
                  >
                    ACC
                  </span>
                  <span
                    className="font-orbitron font-bold text-[13px] text-white/85 leading-none tabular-nums"
                    style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
                  >
                    {resultData.stats.accuracy.toFixed(2)}
                    <span className="text-[9px] text-white/50 ml-0.5">%</span>
                  </span>
                </span>
                <span
                  className="w-px h-3 wide:hidden"
                  style={{ background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.22), transparent)' }}
                />
                <span className="flex items-baseline gap-1.5">
                  <span
                    className="text-[9px] font-orbitron tracking-[0.22em] text-white/55"
                    style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
                  >
                    COMBO
                  </span>
                  <span
                    className="font-orbitron font-bold text-[13px] text-white/85 leading-none tabular-nums"
                    style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
                  >
                    {resultData.stats.maxCombo}
                    <span className="text-[9px] text-white/50 ml-0.5">x</span>
                  </span>
                </span>
              </div>
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
            <span className="text-sm font-bold">{loadingLabel || t('songcard.loading')}</span>
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
              {inResult ? <RotateCcw size={14} /> : <Play size={14} className="fill-white" />}
              {inResult ? t('songcard.retry') : t('songcard.start')}
            </button>
          </div>
        )}
      </div>

      {/* Bottom-left: high score + difficulty (song only, expanded).
          结算态**照常显示**（难度变静态 tag）：与展开态保持同一套版面语言，
          也正好利用左下角空位 —— 成绩区因此不必为了避让它而往上长。 */}
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
              // 结算态：难度是静态 tag（成绩已定，不允许中途换难度），但仍要显示
              // —— 玩家得知道自己刚打完的是哪一档。
              <div
                className="px-3 py-1.5 rounded-lg text-xs font-bold font-orbitron tracking-wider border bg-black/30 border-white/20 text-white/80 cursor-default select-none"
                style={{ textShadow: RESULT_TEXT_SHADOW_SM }}
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
