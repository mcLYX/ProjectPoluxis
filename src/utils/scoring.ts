import { JudgementType, GameStats } from '../types/game';

export const JUDGEMENT_THRESHOLDS = {
  S_PERFECT_MAX_MS: 40,
  PERFECT_MAX_MS: 80,
  GOOD_MAX_MS: 160,
};

export const JUDGEMENT_COLORS: Record<JudgementType, { hex: string; name: string; glowClass: string; scale: number }> = {
  'S-Perfect': { hex: '#ff8c00', name: '橙色', glowClass: 'glow-s-perfect text-orange-400', scale: 1.2 },
  'Perfect': { hex: '#ffd700', name: '黄色', glowClass: 'glow-perfect text-yellow-300', scale: 1.1 },
  'Good': { hex: '#38bdf8', name: '天蓝色', glowClass: 'glow-good text-sky-400', scale: 1.05 },
  'Miss': { hex: '#ef4444', name: '暗红灰', glowClass: 'text-red-500', scale: 1.0 },
};

/**
 * Determine judgement based on absolute time difference Δt (in milliseconds)
 */
export function evaluateJudgement(deltaTMs: number): JudgementType | null {
  const absDelta = Math.abs(deltaTMs);
  if (absDelta < JUDGEMENT_THRESHOLDS.S_PERFECT_MAX_MS) {
    return 'S-Perfect';
  } else if (absDelta < JUDGEMENT_THRESHOLDS.PERFECT_MAX_MS) {
    return 'Perfect';
  } else if (absDelta < JUDGEMENT_THRESHOLDS.GOOD_MAX_MS) {
    return 'Good';
  }
  return null; // outside valid hit window (too early / too late)
}

/**
 * Calculate single note score strictly adhering to specifications:
 * - S-Perfect: (10,000,000 / totalNotes) + 1
 * - Perfect: 10,000,000 / totalNotes
 * - Good: (10,000,000 / totalNotes) * 0.5
 * - Miss: 0
 */
export function calculateNoteScore(judgement: JudgementType, totalNotes: number): number {
  if (totalNotes <= 0) return 0;
  const baseUnit = 10000000 / totalNotes;
  switch (judgement) {
    case 'S-Perfect':
      return baseUnit + 1;
    case 'Perfect':
      return baseUnit;
    case 'Good':
      return baseUnit * 0.5;
    case 'Miss':
    default:
      return 0;
  }
}

/**
 * Calculate Rank based on current score
 */
export function calculateRank(score: number): GameStats['rank'] {
  if (score >= 9900000) return 'EX+';
  if (score >= 9500000) return 'EX';
  if (score >= 9000000) return 'S';
  if (score >= 8000000) return 'A';
  if (score >= 7000000) return 'B';
  if (score >= 6000000) return 'C';
  return 'F';
}
