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

function makeKey(scoreKey: string, difficultyName: string): string {
  return `${scoreKey}__${difficultyName}`;
}

/**
 * 生成成绩存储的命名空间键。
 * 同一在线曲目下载到本地后会得到一个 source 为 'local' 的副本，
 * 它与 source 为 'online' 的原曲共享 songId，若只用 songId 作键会导致
 * 在线 / 下载两份成绩互通。这里按 source 加前缀命名空间：
 *  - builtin  → 不加前缀（兼容历史成绩）
 *  - local    → 'local:<id>'（下载的谱面、本地自建谱面、编辑器保存的谱面）
 *  - online   → 'online:<id>'（在线原曲）
 * 这样编辑「在线下载的谱面」只需清掉 'local:<id>' 的成绩，在线原曲成绩不受影响。
 */
export function getScoreKey(songId: string, source?: string): string {
  if (!source || source === 'builtin') return songId;
  return `${source}:${songId}`;
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
export function getHighScore(scoreKey: string, difficultyName: string): HighScoreEntry | null {
  const all = loadFromStorage();
  const key = makeKey(scoreKey, difficultyName);
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
  scoreKey: string,
  difficultyName: string,
  stats: GameStats,
): SubmitResult | null {
  const all = loadFromStorage();
  const key = makeKey(scoreKey, difficultyName);
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

/**
 * 清除某谱面的成绩。
 *  - 不传 difficultyName：清除该谱面全部难度的成绩（如整首谱面被删除）。
 *  - 传 difficultyName：只清除被修改保存的那一个难度的成绩，其余难度成绩保留。
 */
export function clearHighScore(scoreKey: string, difficultyName?: string) {
  const all = loadFromStorage();
  let changed = false;
  if (difficultyName !== undefined) {
    const key = `${scoreKey}__${difficultyName}`;
    if (key in all) {
      delete all[key];
      changed = true;
    }
  } else {
    const prefix = `${scoreKey}__`;
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) {
        delete all[k];
        changed = true;
      }
    }
  }
  if (changed) saveToStorage(all);
}
