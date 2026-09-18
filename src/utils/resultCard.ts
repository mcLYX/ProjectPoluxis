/**
 * 结算分享图合成器。
 *
 * 游戏画面由 WebGL canvas 渲染，且结算后画面已清空，直接 toDataURL 得到的只是
 * 空场景 —— 因此分享图不以游戏画面为底，而是：
 *   · 有专辑图(jacket) → 以其 cover 裁切铺满作底图；
 *   · 无专辑图 → 退回歌曲「强调色渐变」背景。
 * 再在上层用 2D API 绘制与游戏内结算卡片一致的结算信息面板。
 */
import type { GameStats } from '../types/game';
import type { ClearBadge } from './scoreStore';

export interface ResultCardData {
  stats: GameStats;
  badge: ClearBadge | null;
  isNewHighScore: boolean;
  meta: { title: string; artist: string; difficulty: string; bpm: number };
  /** 专辑图地址（可能为远程 http(s) / blob / data URL）。 */
  jacket?: string | null;
  /** 歌曲强调色（无专辑图时作为渐变底色）。 */
  accentColor?: string;
  /** 是否 Auto-Play 通关（需标注）。 */
  isAutoplay: boolean;
}

const CARD_W = 1080;
const CARD_H = 1620;

const FONT_DISPLAY = "'Orbitron', 'Segoe UI', system-ui, sans-serif";
const FONT_MONO = "ui-monospace, 'Cascadia Mono', 'Consolas', monospace";

/** 判定等级（评级字母）主题色，与游戏内一致：EX/EX+ 琥珀、S 青、A 翡翠。 */
function rankColor(rank: GameStats['rank']): string {
  switch (rank) {
    case 'EX+':
    case 'EX':
      return '#fbbf24'; // amber-400
    case 'S':
      return '#67e8f9'; // cyan-300
    case 'A':
      return '#34d399'; // emerald-400
    default:
      return 'rgba(255,255,255,0.5)';
  }
}

/** 把 hex 颜色按 alpha 转 rgba 字符串。 */
function withAlpha(hex: string, alpha: number): string {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 远程图需匿名跨域，否则后续 toDataURL 会因画布被污染而抛 SecurityError。
    // 加载失败时 reject，由调用方退回渐变背景。
    if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clampText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** 绘制整张卡片（背景 + 底部信息面板）。jacketImg 为 null 时退化为强调色渐变。 */
function renderCard(ctx: CanvasRenderingContext2D, data: ResultCardData, jacketImg: HTMLImageElement | null): void {
  // 先铺不透明底色，杜绝专辑图带透明通道 / 渐变半透明导致的卡片透明。
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // --- 背景 ---
  if (jacketImg) {
    const scale = Math.max(CARD_W / jacketImg.width, CARD_H / jacketImg.height);
    const dw = jacketImg.width * scale;
    const dh = jacketImg.height * scale;
    ctx.drawImage(jacketImg, (CARD_W - dw) / 2, (CARD_H - dh) / 2, dw, dh);
  } else {
    // 无专辑图：不透明暗底之上叠一层强调色渐变（半透明叠染，整体仍不透明）。
    const accent = data.accentColor || '#0ea5e9';
    const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    g.addColorStop(0, 'rgba(5,8,15,0)');
    g.addColorStop(1, withAlpha(accent, 0.45));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }

  // 底部信息面板渐变（保证文字可读）
  const overlay = ctx.createLinearGradient(0, CARD_H * 0.32, 0, CARD_H);
  overlay.addColorStop(0, 'rgba(2,6,23,0)');
  overlay.addColorStop(0.45, 'rgba(2,6,23,0.82)');
  overlay.addColorStop(1, 'rgba(2,6,23,0.96)');
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const { stats, badge, isNewHighScore, meta, isAutoplay } = data;

  // --- Auto-Play 标注 ---
  if (isAutoplay) {
    ctx.font = `900 30px ${FONT_DISPLAY}`;
    const label = 'AUTO-PLAY';
    const w = ctx.measureText(label).width + 48;
    ctx.fillStyle = 'rgba(251,191,36,0.18)';
    roundRect(ctx, 72, 56, w, 52, 12);
    ctx.fill();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    roundRect(ctx, 72, 56, w, 52, 12);
    ctx.stroke();
    ctx.fillStyle = '#fcd34d';
    ctx.textAlign = 'left';
    ctx.fillText(label, 72 + 24, 56 + 36);
  }

  // --- 歌曲信息 ---
  ctx.textAlign = 'left';
  ctx.fillStyle = '#67e8f9';
  ctx.font = `700 26px ${FONT_MONO}`;
  ctx.fillText(`DIFFICULTY · ${meta.difficulty}`, 72, CARD_H * 0.475);

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 54px ${FONT_DISPLAY}`;
  ctx.fillText(clampText(ctx, meta.title, CARD_W - 144), 72, CARD_H * 0.475 + 66);

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `400 30px ${FONT_DISPLAY}`;
  ctx.fillText(clampText(ctx, meta.artist, CARD_W - 144), 72, CARD_H * 0.475 + 116);

  // --- 评级 + 徽章 ---
  ctx.textAlign = 'left';
  ctx.fillStyle = rankColor(stats.rank);
  ctx.font = `900 170px ${FONT_DISPLAY}`;
  ctx.fillText(stats.rank, 72, CARD_H * 0.64);

  if (badge) {
    const bx = 72 + ctx.measureText(stats.rank).width + 28;
    const by = CARD_H * 0.64 - 96;
    const isAp = badge !== 'FC';
    ctx.fillStyle = isAp ? 'rgba(245,158,11,0.2)' : 'rgba(14,165,233,0.2)';
    roundRect(ctx, bx, by, 150, 66, 14);
    ctx.fill();
    ctx.strokeStyle = isAp ? '#fbbf24' : '#38bdf8';
    ctx.lineWidth = 4;
    roundRect(ctx, bx, by, 150, 66, 14);
    ctx.stroke();
    ctx.fillStyle = isAp ? '#fcd34d' : '#7dd3fc';
    ctx.font = `900 34px ${FONT_DISPLAY}`;
    ctx.fillText(badge, bx + 26, by + 47);
  }

  if (isNewHighScore) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbbf24';
    ctx.font = `900 34px ${FONT_DISPLAY}`;
    ctx.fillText('NEW RECORD', CARD_W - 72, CARD_H * 0.64 - 40);
  }

  // --- 分数 ---
  ctx.textAlign = 'left';
  const scoreText = Math.round(stats.score).toLocaleString();
  ctx.font = `900 96px ${FONT_DISPLAY}`;
  const gradient = ctx.createLinearGradient(72, 0, 72 + ctx.measureText(scoreText).width, 0);
  gradient.addColorStop(0, '#67e8f9');
  gradient.addColorStop(0.5, '#ffffff');
  gradient.addColorStop(1, '#fcd34d');
  ctx.fillStyle = gradient;
  ctx.fillText(scoreText, 72, CARD_H * 0.76);

  // --- 判定统计（PERFECT 黄 / GOOD 青 / MISS 红；S-Perfect 数量橙色）---
  const boxes: Array<{ label: string; count: number; sPerfect: number; color: string }> = [
    { label: 'PERFECT', count: stats.perfectCount + stats.sPerfectCount, sPerfect: stats.sPerfectCount, color: '#fcd34d' },
    { label: 'GOOD', count: stats.goodCount, sPerfect: 0, color: '#38bdf8' },
    { label: 'MISS', count: stats.missCount, sPerfect: 0, color: '#f87171' },
  ];
  const boxW = (CARD_W - 144 - 48) / 3;
  const boxY = CARD_H * 0.81;
  boxes.forEach((b, i) => {
    const bx = 72 + i * (boxW + 24);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, bx, boxY, boxW, 118, 16);
    ctx.fill();
    ctx.strokeStyle = `${b.color}66`;
    ctx.lineWidth = 2;
    roundRect(ctx, bx, boxY, boxW, 118, 16);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = b.color;
    ctx.font = `700 24px ${FONT_DISPLAY}`;
    ctx.fillText(b.label, bx + boxW / 2, boxY + 42);

    ctx.font = `700 40px ${FONT_MONO}`;
    const mainStr = `${b.count}`;
    const suffixStr = b.sPerfect > 0 ? `(+${b.sPerfect})` : '';
    const totalW = ctx.measureText(mainStr).width + ctx.measureText(suffixStr).width;
    const vx = bx + boxW / 2 - totalW / 2;
    const valueY = boxY + 92;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(mainStr, vx, valueY);
    if (suffixStr) {
      ctx.fillStyle = '#fb923c'; // 橙：S-Perfect 数量
      ctx.fillText(suffixStr, vx + ctx.measureText(mainStr).width, valueY);
    }
  });

  // --- 连击 / 准度 ---
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `400 30px ${FONT_MONO}`;
  ctx.fillText(`MAX COMBO ${stats.maxCombo}x · ACC ${stats.accuracy.toFixed(2)}%`, 72, CARD_H * 0.925);

  // --- 水印（项目名 Poluxis）---
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = `700 26px ${FONT_DISPLAY}`;
  ctx.fillText('Poluxis', CARD_W - 72, CARD_H * 0.925 + 4);
}

/**
 * 合成成绩分享图。优先用专辑图作底，加载失败或跨域污染时退回强调色渐变。
 */
export async function composeResultCard(data: ResultCardData): Promise<string | null> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 等字体就绪，保证 Orbitron 生效（已加载过则立即 resolve）。
  try {
    await document.fonts?.ready;
  } catch {
    /* 忽略字体加载失败 */
  }

  const jacketImg = data.jacket ? await loadImage(data.jacket).catch(() => null) : null;

  // 首次渲染（含专辑图）
  renderCard(ctx, data, jacketImg);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    // 画布被跨域专辑图污染 → 以强调色渐变重新渲染一次
  }
  renderCard(ctx, data, null);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
