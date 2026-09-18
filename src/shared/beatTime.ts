/**
 * Single source of truth for *chart resolution* (beat→seconds, slide/node
 * expansion, scroll distance, events, duration helpers). Shared by the full
 * app (src/utils/beatTime.ts re-exports this and adapts `angle` to radians)
 * and the Lite ES5 build (inlined verbatim by scripts/build-lite.mjs).
 *
 * Rules (same as chartSchema.ts):
 *  - ES5-clean: `var` / `function` / `forEach` only — no `const`/`let`/`for-of`
 *    / arrow / object-spread. esbuild's *transform* (used by the Lite build)
 *    cannot down-level those to ES5, so they are banned here on purpose.
 *  - `import type` only — erased on inline, so the Lite build has zero runtime
 *    imports. Do NOT add runtime `import`s here.
 *  - `angle` is stored in **DEGREES** (the raw JSON unit). The full app's
 *    src/utils/beatTime.ts wrapper converts it to radians at the render
 *    boundary; the Lite build consumes degrees directly.
 */

import type { ChartData, BpmPoint, EasingType, ResolvedNote, ResolvedEvent } from '../types/game';

/** A point where scroll speed changes, in absolute seconds + speed multiplier */
export interface SpeedPoint {
  timeSec: number;
  speed: number;
}

/**
 * Pre-compute scroll speed change points from chart events.
 * Returns speed points sorted by time, with an implicit initial speed of 1 at t=0.
 */
export function extractSpeedPoints(input: ChartData | ResolvedEvent[]): SpeedPoint[] {
  // Accept either a raw ChartData (re-resolve its events) or an already-resolved
  // event array — the Lite engine passes `game.events` (resolved), the full app
  // passes the chart. Keeping both call sites working avoids a signature split.
  var events: ResolvedEvent[] = Array.isArray(input) ? input : resolveEvents(input);
  var points: SpeedPoint[] = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.eventType === 'speed_change' && e.speed != null) {
      points.push({ timeSec: e.timeSec, speed: e.speed });
    }
  }
  points.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return points;
}

/**
 * Get the cumulative scroll distance from t=0 up to t=timeSec.
 * Integral of scroll speed over time (speed changes defined by speedPoints).
 * Distance unit: "1x-seconds" (at 1x speed, 1s = 1 unit of distance).
 */
export function getScrollDistance(timeSec: number, speedPoints: SpeedPoint[]): number {
  if (!speedPoints || speedPoints.length === 0) return timeSec;
  var dist = 0;
  var currentTime = 0;
  var currentSpeed = 1;
  for (var i = 0; i < speedPoints.length; i++) {
    var p = speedPoints[i];
    if (p.timeSec <= 0) { currentSpeed = p.speed; continue; }
    if (p.timeSec >= timeSec) break;
    dist += (p.timeSec - currentTime) * currentSpeed;
    currentTime = p.timeSec;
    currentSpeed = p.speed;
  }
  dist += (timeSec - currentTime) * currentSpeed;
  return dist;
}

/** Convert a beat number to absolute seconds with constant BPM. */
export function beatToSeconds(beat: number, bpm: number, offset: number): number {
  return offset + (beat * 60) / bpm;
}

/** Convert a beat number to absolute seconds, supporting BPM changes via bpmlist. */
export function beatToSecondsMultiBpm(
  beat: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  if (!bpmlist || bpmlist.length === 0) return beatToSeconds(beat, baseBpm, offset);
  var currentBeat = 0;
  var currentBpm = baseBpm;
  var accumulatedTime = 0;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat <= 0) continue;
    if (point.beat >= beat) break;
    accumulatedTime += ((point.beat - currentBeat) * 60) / currentBpm;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }
  accumulatedTime += ((beat - currentBeat) * 60) / currentBpm;
  return offset + accumulatedTime;
}

/** Exact inverse of `beatToSecondsMultiBpm`: absolute seconds -> beat. */
export function secondsToBeatMultiBpm(
  sec: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  var t = sec - offset;
  if (!bpmlist || bpmlist.length === 0) return (t * baseBpm) / 60;
  var currentBeat = 0;
  var currentBpm = baseBpm;
  var accumulatedTime = 0;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat <= 0) continue;
    var segmentSeconds = ((point.beat - currentBeat) * 60) / currentBpm;
    if (accumulatedTime + segmentSeconds > t) {
      return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
    }
    accumulatedTime += segmentSeconds;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }
  return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
}

/** Get the BPM value at a specific beat, considering BPM changes. */
export function getBpmAtBeat(beat: number, baseBpm: number, bpmlist?: BpmPoint[]): number {
  if (!bpmlist || bpmlist.length === 0) return baseBpm;
  var bpm = baseBpm;
  for (var i = 0; i < bpmlist.length; i++) {
    var point = bpmlist[i];
    if (point.beat > beat) break;
    bpm = point.bpm;
  }
  return bpm;
}

/** Copy a note's own fields (minus `nodes`) into a fresh plain object — the
 * ES5 equivalent of `{ ...n, nodes: undefined }`. */
function copyNoteFields(n: { [k: string]: any }): { [k: string]: any } {
  var o: { [k: string]: any } = {};
  for (var k in n) {
    if (n.hasOwnProperty(k) && k !== 'nodes') o[k] = n[k];
  }
  return o;
}

/**
 * Resolve all notes in a chart from beat-based to absolute seconds.
 * Slide child nodes are resolved as well.
 *
 * `angle` is stored in DEGREES (raw JSON). Child note ids are 1-based
 * (`${id}#${k+1}`) to match the full app. Output is sorted by `timeSec`
 * (ascending, stable) so render loops can binary-search the visible window.
 */
export function resolveChart(chart: ChartData): ResolvedNote[] {
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  var resolved: ResolvedNote[] = [];

  chart.notes.forEach(function (n) {
    var headAngle = n.angle == null ? 0 : n.angle;
    var headEasing: EasingType = n.easing == null ? 'linear' : n.easing;

    if (n.type === 'slide') {
      var kids: { [k: string]: any }[] = [];
      var src = n.nodes || [];
      for (var k = 0; k < src.length; k++) {
        var sn = src[k];
        kids.push({
          timeSec: beatToSecondsMultiBpm(sn.beat, bpm, offset, bpmlist),
          angle: sn.angle == null ? headAngle : sn.angle,
          easing: sn.easing == null ? headEasing : sn.easing,
          beat: sn.beat,
          x: sn.x,
          y: sn.y,
        });
      }
      var head = copyNoteFields(n);
      head.timeSec = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
      head.angle = headAngle;
      head.easing = headEasing;
      head.resolvedNodes = kids;
      head.nodes = undefined;
      resolved.push(head as ResolvedNote);
      return;
    }

    var head2 = copyNoteFields(n);
    head2.timeSec = beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist);
    head2.angle = headAngle;
    head2.easing = headEasing;
    head2.resolvedNodes = undefined;
    head2.nodes = undefined;
    resolved.push(head2 as ResolvedNote);

    var csrc = n.nodes || [];
    for (var c = 0; c < csrc.length; c++) {
      var cn = csrc[c];
      var child = copyNoteFields(n);
      child.id = n.id + '#' + (c + 1);
      child.beat = cn.beat;
      child.x = cn.x;
      child.y = cn.y;
      child.timeSec = beatToSecondsMultiBpm(cn.beat, bpm, offset, bpmlist);
      child.angle = cn.angle == null ? headAngle : cn.angle;
      child.easing = cn.easing == null ? headEasing : cn.easing;
      child.resolvedNodes = undefined;
      child.nodes = undefined;
      resolved.push(child as ResolvedNote);
    }
  });

  resolved.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return resolved;
}

/** Resolve all events in a chart from beat-based to absolute seconds. */
export function resolveEvents(chart: ChartData): ResolvedEvent[] {
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  if (!chart.events || chart.events.length === 0) {
    if (chart.speedEvents && chart.speedEvents.length > 0) {
      var legacy: ResolvedEvent[] = chart.speedEvents.map(function (se, idx) {
        return {
          id: 'legacy-speed-' + idx,
          type: 'event' as const,
          eventType: 'speed_change' as const,
          beat: se.beat,
          speed: se.speed,
          timeSec: beatToSecondsMultiBpm(se.beat, bpm, offset, bpmlist),
        };
      });
      legacy.sort(function (a, b) { return a.timeSec - b.timeSec; });
      return legacy;
    }
    return [];
  }
  var out: ResolvedEvent[] = [];
  for (var ei = 0; ei < chart.events.length; ei++) {
    var e: any = chart.events[ei];
    var re: { [k: string]: any } = {};
    for (var ek in e) { if (e.hasOwnProperty(ek)) re[ek] = e[ek]; }
    re.timeSec = beatToSecondsMultiBpm(e.beat, bpm, offset, bpmlist);
    out.push(re as ResolvedEvent);
  }
  out.sort(function (a, b) { return a.timeSec - b.timeSec; });
  return out;
}

/** Max beat across all notes, including slide child nodes. */
export function getMaxBeat(chart: ChartData): number {
  var max = 0;
  chart.notes.forEach(function (n) {
    if (n.beat > max) max = n.beat;
    var ns = n.nodes || [];
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].beat > max) max = ns[i].beat;
    }
  });
  return max;
}

/** Earliest note time in seconds (including offset and slide child nodes). */
export function getFirstNoteTime(chart: ChartData): number {
  if (chart.notes.length === 0) return 0;
  var meta = chart.metadata;
  var bpm = meta.bpm;
  var offset = meta.offset;
  var bpmlist = meta.bpmlist;
  var minBeat = Infinity;
  chart.notes.forEach(function (n) {
    if (n.beat < minBeat) minBeat = n.beat;
    var ns = n.nodes || [];
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].beat < minBeat) minBeat = ns[i].beat;
    }
  });
  return beatToSecondsMultiBpm(minBeat, bpm, offset, bpmlist);
}

/** Total duration (seconds) of a chart: last node time + 1.5s buffer. */
export function getChartDuration(chart: ChartData): number {
  if (chart.notes.length === 0) return 5;
  var meta = chart.metadata;
  return beatToSecondsMultiBpm(getMaxBeat(chart), meta.bpm, meta.offset, meta.bpmlist) + 1.5;
}

/** Count all scoreable notes: tap/touch = 1 each; slide = head + each child (1 each). */
export function countPlayableNotes(chart: ChartData): number {
  var total = 0;
  chart.notes.forEach(function (n) {
    total += 1 + ((n.nodes ? n.nodes.length : 0));
  });
  return total;
}
