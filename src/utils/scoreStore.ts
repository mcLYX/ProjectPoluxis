import { GameStats } from '../types/game';

const STORAGE_KEY = 'poluxis_highscores_v1';

export type ClearBadge = 'FC' | 'AP' | 'AP+';

export interface HighScoreEntry {
  score: number;
  maxCombo: number;
  accuracy: number;
  rank: GameStats['rank'];
  sPerfectCount: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  totalNotes: number;
  playedAt: number;
  // 已达成的最高标识（FC < AP < AP+），拿到后不会降级
  bestBadge?: ClearBadge;
}

export interface HighScoreMap {
  [songId_diffName: string]: HighScoreEntry;
}

function loadFromStorage(): HighScoreMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as HighScoreMap;
  } catch (e) {
    console.warn('Failed to load high scores:', e);
    return {};
  }
}

function saveToStorage(data: HighScoreMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save high scores:', e);
  }
}

function makeKey(songId: string, difficultyName: string): string {
  return `${songId}__${difficultyName}`;
}

/** 根据成绩计算当前达成的最高徽章 */
export function calcBadgeFromStats(stats: GameStats): ClearBadge | null {
  const judgedTotal = stats.sPerfectCount + stats.perfectCount + stats.goodCount + stats.missCount;
  if (judgedTotal === 0) return null;
  if (stats.missCount > 0) return null;
  // 全 S-Perfect → AP+
  if (stats.sPerfectCount === judgedTotal) return 'AP+';
  // 没有 Good（全部是 Perfect 或 S-Perfect）→ AP
  if (stats.goodCount === 0) return 'AP';
  // 没有 Miss → FC
  return 'FC';
}

/** 比较两个徽章等级，返回更高的那个 */
function higherBadge(a?: ClearBadge, b?: ClearBadge): ClearBadge | undefined {
  const rank: Record<ClearBadge, number> = { 'FC': 1, 'AP': 2, 'AP+': 3 };
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

/** 获取某首歌某个难度的最高分记录。没有记录返回 null。 */
export function getHighScore(songId: string, difficultyName: string): HighScoreEntry | null {
  const all = loadFromStorage();
  const key = makeKey(songId, difficultyName);
  return all[key] || null;
}

export interface SubmitResult {
  entry: HighScoreEntry;
  isNewScore: boolean;
  isNewBadge: boolean;
}

/**
 * 提交一次游戏成绩：
 * - 分数超过历史最高 → 更新分数
 * - 徽章比历史最高好 → 更新徽章（只升不降）
 * - 两者都没变化 → 返回 null
 */
export function submitScore(
  songId: string,
  difficultyName: string,
  stats: GameStats,
): SubmitResult | null {
  const all = loadFromStorage();
  const key = makeKey(songId, difficultyName);
  const prev = all[key];

  const newBadge = calcBadgeFromStats(stats);
  const bestBadge = higherBadge(prev?.bestBadge, newBadge || undefined);

  const isNewScore = !prev || stats.score > prev.score;
  const isNewBadge = bestBadge !== prev?.bestBadge;

  if (!isNewScore && !isNewBadge) {
    return null;
  }

  const entry: HighScoreEntry = {
    score: isNewScore ? stats.score : prev!.score,
    maxCombo: isNewScore ? stats.maxCombo : prev!.maxCombo,
    accuracy: isNewScore ? stats.accuracy : prev!.accuracy,
    rank: isNewScore ? stats.rank : prev!.rank,
    sPerfectCount: isNewScore ? stats.sPerfectCount : prev!.sPerfectCount,
    perfectCount: isNewScore ? stats.perfectCount : prev!.perfectCount,
    goodCount: isNewScore ? stats.goodCount : prev!.goodCount,
    missCount: isNewScore ? stats.missCount : prev!.missCount,
    totalNotes: stats.totalNotes,
    playedAt: Date.now(),
    bestBadge,
  };

  all[key] = entry;
  saveToStorage(all);
  return { entry, isNewScore, isNewBadge };
}

/** 获取所有最高分记录（用于批量读取、展示等）。 */
export function getAllHighScores(): HighScoreMap {
  return loadFromStorage();
}

/** 清除所有最高分记录（慎用）。 */
export function clearAllHighScores() {
  localStorage.removeItem(STORAGE_KEY);
}
