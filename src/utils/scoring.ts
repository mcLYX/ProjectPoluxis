import { JudgementType } from '../types/game';
import {
  JUDGE_THRESH,
  JUDGE_COLORS,
  JUDGE_SCALE,
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

/* 判定档位 / 单音符得分 / 评级的**纯规则**实现已下沉到 `shared/gameplaySpec.ts`
 * （三端单一真相：完整版 3D、完整版 2D、Lite 单文件共用同一份，Lite 原先手抄的
 * 副本已删除）。本模块只保留完整版独有的**呈现细节** —— `JUDGEMENT_COLORS` 的
 * `name` / `glowClass` —— 并原样重新导出下沉的函数，使既有消费方无需改动。 */
export { calculateNoteScore, calculateRank, evaluateJudgement } from '../shared/gameplaySpec';
