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
import type { ChartData, ResolvedNote, ResolvedEvent } from '../types/game';
import {
  resolveChart as coreResolveChart,
  extractSpeedPoints as coreExtractSpeedPoints,
  type SpeedPoint,
} from '../shared/beatTime';
import { EASING_FNS } from './easing';

export {
  beatToSecondsMultiBpm,
  secondsToBeatMultiBpm,
  getBpmAtBeat,
  SPEED_RAMP_STEPS,
  getScrollDistance,
  buildSpeedPrefix,
  prefixDistanceAt,
  resolveEvents,
  getMaxBeat,
  getFirstNoteTime,
  getChartDuration,
  countPlayableNotes,
  type SpeedPoint,
  type SpeedPrefix,
} from '../shared/beatTime';

/**
 * 变速点提取（注入 full app 的真实 easing，供 `duration > 0` 的时间过渡离散化用）。
 * shared 核心禁止运行时 import，所以 easing 必须由这里注入。
 */
export function extractSpeedPoints(input: ChartData | ResolvedEvent[]): SpeedPoint[] {
  return coreExtractSpeedPoints(input, function (name: string, t: number): number {
    const fn = (EASING_FNS as Record<string, (v: number) => number>)[name] || EASING_FNS['linear'];
    return fn(t);
  });
}

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
