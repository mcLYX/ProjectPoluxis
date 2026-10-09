/* === 3. Chart resolution ===
 * The pure resolution logic (beatToSecondsMultiBpm, resolveChart, resolveEvents,
 * extractSpeedPoints, getScrollDistance, getFirstNoteTime, countPlayableNotes,
 * getMaxBeat, getChartDuration, secondsToBeatMultiBpm) now lives in
 * src/shared/beatTime.ts and is inlined into this build by scripts/build-lite.mjs
 * (single source of truth with the full app). Do NOT redefine those here — edit
 * the shared file instead.
 *
 * Scoring (evaluateJudgement / calculateNoteScore / calculateRank) likewise now
 * lives in src/shared/gameplaySpec.ts and is inlined here — the hand-copied
 * versions were deleted so all three builds share one implementation.
 *
 * `angle` from the inlined resolveChart is in DEGREES (raw JSON unit); the Lite
 * renderer consumes degrees directly, so no conversion is needed. */
