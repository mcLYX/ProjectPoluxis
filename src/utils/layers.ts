/**
 * Full-app entry for the shared layer-composition module.
 *
 * The pure logic lives in src/shared/layers.ts (single source of truth, also
 * inlined into the Lite build). Because the shared core **cannot** use runtime
 * imports (it would break inside the Lite IIFE), it takes beat→seconds and
 * easing as injected dependencies; this wrapper supplies the full app's real
 * implementations so callers don't have to care.
 */
import type { ChartData } from '../types/game';
import { beatToSecondsMultiBpm } from './beatTime';
import { SPEED_RAMP_STEPS } from './beatTime';
import { EASING_FNS } from './easing';
import {
  buildLayerTree as coreBuildLayerTree,
  type LayerTree,
} from '../shared/layers';

export {
  DEFAULT_LAYER_ID,
  noteLayerIdx,
  ownOffsetAt,
  layerOffsetAt,
  resolvedNotePosAt,
  landingPos,
  toStoredPos,
  layerSpeedMul,
  layerHasOwnSpeed,
  layerSpeedTimeline,
  layerMinRelSpeed,
  layerColorAt,
  resolveLayerNoteColor,
  type OffsetStep,
  type SpeedEvent,
  type LayerNode,
  type LayerTree,
  type LayerDeps,
} from '../shared/layers';

/**
 * 构建图层树（注入 full app 的真实依赖）。
 * 谱面对象请尽量缓存结果，不要在每帧调用。
 */
export function buildLayerTree(chart: ChartData): LayerTree {
  const meta = chart.metadata;
  return coreBuildLayerTree(chart, {
    beatToSec: function (beat: number): number {
      return beatToSecondsMultiBpm(beat, meta.bpm, meta.offset, meta.bpmlist);
    },
    ease: function (name: string, t: number): number {
      const fn = (EASING_FNS as Record<string, (v: number) => number>)[name] || EASING_FNS['linear'];
      return fn(t);
    },
    // 与全局变速轴用同一离散步进，保证图层斜坡与顶层斜坡采样一致。
    rampSteps: SPEED_RAMP_STEPS,
  });
}
