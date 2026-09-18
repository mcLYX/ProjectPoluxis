/**
 * Full-app chart-resolution API.
 *
 * The pure resolution logic lives in src/shared/beatTime.ts (single source of
 * truth, also inlined into the Lite build). This module re-exports it, then
 * adapts the one render-facing difference: **`angle` is converted from degrees
 * to radians here** (route X). The Lite build consumes the shared core
 * directly in degrees, so its rendering needs no change. Keep all angle
 * conversions in this wrapper — do not push them into the shared core.
 */
import type { ChartData, ResolvedNote } from '../types/game';
import { resolveChart as coreResolveChart } from '../shared/beatTime';

export {
  beatToSeconds,
  beatToSecondsMultiBpm,
  secondsToBeatMultiBpm,
  getBpmAtBeat,
  extractSpeedPoints,
  getScrollDistance,
  resolveEvents,
  getMaxBeat,
  getFirstNoteTime,
  getChartDuration,
  countPlayableNotes,
  type SpeedPoint,
} from '../shared/beatTime';

/**
 * Resolve notes to absolute seconds, with `angle` in RADIANS (the unit the
 * Three.js render pipeline expects). The shared core stores degrees; this is
 * the single place where the conversion happens for the full app.
 */
export function resolveChart(chart: ChartData): ResolvedNote[] {
  const notes = coreResolveChart(chart);
  for (const n of notes) {
    n.angle = (n.angle ?? 0) * Math.PI / 180;
    if (n.resolvedNodes) {
      for (const rn of n.resolvedNodes) rn.angle = (rn.angle ?? 0) * Math.PI / 180;
    }
  }
  return notes;
}
