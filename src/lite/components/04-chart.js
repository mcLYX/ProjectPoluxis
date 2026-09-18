/* === 3. Chart resolution ===
 * The pure resolution logic (beatToSecondsMultiBpm, resolveChart, resolveEvents,
 * extractSpeedPoints, getScrollDistance, getFirstNoteTime, countPlayableNotes,
 * getMaxBeat, getChartDuration, secondsToBeatMultiBpm) now lives in
 * src/shared/beatTime.ts and is inlined into this build by scripts/build-lite.mjs
 * (single source of truth with the full app). Do NOT redefine those here — edit
 * the shared file instead. Below are only the Lite scoring helpers.
 *
 * `angle` from the inlined resolveChart is in DEGREES (raw JSON unit); the Lite
 * renderer consumes degrees directly, so no conversion is needed. */

  function evaluateJudgement(deltaTMs) {
    var a = Math.abs(deltaTMs);
    if (a < JUDGE_THRESH.S_PERFECT) return 'S-Perfect';
    if (a < JUDGE_THRESH.PERFECT) return 'Perfect';
    if (a < JUDGE_THRESH.GOOD) return 'Good';
    return null;
  }
  /* Per-note score — mirrors calculateNoteScore in src/utils/scoring.ts.
   * baseUnit = 10M / totalNotes. S-Perfect = baseUnit + 1, Perfect = baseUnit,
   * Good = baseUnit * 0.5, Miss = 0. */
  function calculateNoteScore(j, total) {
    if (total <= 0) return 0;
    var base = SCORE_BASE / total;
    if (j === 'S-Perfect') return base + 1;
    if (j === 'Perfect') return base;
    if (j === 'Good') return base * 0.5;
    return 0;
  }
  function calculateRank(score) {
    if (score >= RANK_THRESHOLDS.EX_PLUS) return 'EX+';
    if (score >= RANK_THRESHOLDS.EX) return 'EX';
    if (score >= RANK_THRESHOLDS.S) return 'S';
    if (score >= RANK_THRESHOLDS.A) return 'A';
    if (score >= RANK_THRESHOLDS.B) return 'B';
    if (score >= RANK_THRESHOLDS.C) return 'C';
    return 'F';
  }
