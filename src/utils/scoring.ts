import { JudgementType, GameStats } from '../types/game';
import {
  JUDGE_THRESH,
  JUDGE_COLORS,
  JUDGE_SCALE,
  SCORE_BASE,
  RANK_THRESHOLDS,
} from '../shared/gameplaySpec';

/** Legacy alias kept so existing importers (judge system, UI) need no change. */
export const JUDGEMENT_THRESHOLDS = JUDGE_THRESH;

/** Colours + UI metadata per judgement. Hex/scale come from the shared spec;
 *  `name`/`glowClass` are full-version-only presentation details. */
export const JUDGEMENT_COLORS: Record<JudgementType, { hex: string; name: string; glowClass: string; scale: number }> = {
  'S-Perfect': { hex: JUDGE_COLORS['S-Perfect'], name: '橙色', glowClass: 'glow-s-perfect text-orange-400', scale: JUDGE_SCALE['S-Perfect'] },
  'Perfect': { hex: JUDGE_COLORS['Perfect'], name: '黄色', glowClass: 'glow-perfect text-yellow-300', scale: JUDGE_SCALE['Perfect'] },
  'Good': { hex: JUDGE_COLORS['Good'], name: '天蓝色', glowClass: 'glow-good text-sky-400', scale: JUDGE_SCALE['Good'] },
  'Miss': { hex: JUDGE_COLORS['Miss'], name: '暗红灰', glowClass: 'text-red-500', scale: JUDGE_SCALE['Miss'] },
};

/**
 * Determine judgement based on absolute time difference Δt (in milliseconds)
 */
export function evaluateJudgement(deltaTMs: number): JudgementType | null {
  const absDelta = Math.abs(deltaTMs);
  if (absDelta < JUDGE_THRESH.S_PERFECT) {
    return 'S-Perfect';
  } else if (absDelta < JUDGE_THRESH.PERFECT) {
    return 'Perfect';
  } else if (absDelta < JUDGE_THRESH.GOOD) {
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
  const baseUnit = SCORE_BASE / totalNotes;
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
  if (score >= RANK_THRESHOLDS.EX_PLUS) return 'EX+';
  if (score >= RANK_THRESHOLDS.EX) return 'EX';
  if (score >= RANK_THRESHOLDS.S) return 'S';
  if (score >= RANK_THRESHOLDS.A) return 'A';
  if (score >= RANK_THRESHOLDS.B) return 'B';
  if (score >= RANK_THRESHOLDS.C) return 'C';
  return 'F';
}
