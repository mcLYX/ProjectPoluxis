import { ChartData, ResolvedNote, ResolvedEvent, BpmPoint, EasingType } from '../types/game';

/** A point where scroll speed changes, in absolute seconds + speed multiplier */
export interface SpeedPoint {
  timeSec: number;
  speed: number;
}

/**
 * Pre-compute scroll speed change points from chart events.
 * Returns speed points sorted by time, with an implicit initial speed of 1 at t=0.
 */
export function extractSpeedPoints(chart: ChartData): SpeedPoint[] {
  const events = resolveEvents(chart);
  const points: SpeedPoint[] = [];
  for (const e of events) {
    if (e.eventType === 'speed_change' && e.speed != null) {
      points.push({ timeSec: e.timeSec, speed: e.speed });
    }
  }
  points.sort((a, b) => a.timeSec - b.timeSec);
  return points;
}

/**
 * Get the cumulative scroll distance from t=0 up to t=timeSec.
 * This is the integral of scroll speed over time, where speed changes
 * are defined by speedPoints. Distance unit: "1x-seconds" (at 1x speed, 1s = 1 unit of distance).
 *
 * Notes always sit at a fixed "scroll distance" from the judge line;
 * as time advances, the judge line's distance increases, making notes appear to move toward it.
 * This approach avoids "teleportation" artifacts when speed changes trigger:
 * note spacing is already correct before the speed change visually arrives.
 */
export function getScrollDistance(timeSec: number, speedPoints: SpeedPoint[]): number {
  if (speedPoints.length === 0) {
    return timeSec;
  }
  let dist = 0;
  let currentTime = 0;
  let currentSpeed = 1;
  for (const p of speedPoints) {
    if (p.timeSec <= 0) {
      currentSpeed = p.speed;
      continue;
    }
    if (p.timeSec >= timeSec) break;
    dist += (p.timeSec - currentTime) * currentSpeed;
    currentTime = p.timeSec;
    currentSpeed = p.speed;
  }
  dist += (timeSec - currentTime) * currentSpeed;
  return dist;
}

/**
 * Convert a beat number to absolute seconds with constant BPM.
 * 1 beat at BPM=60 → 1 second, BPM=120 → 0.5 second, etc.
 */
export function beatToSeconds(beat: number, bpm: number, offset: number): number {
  return offset + (beat * 60) / bpm;
}

/**
 * Convert a beat number to absolute seconds, supporting BPM changes via bpmlist.
 * Walks through BPM segments and accumulates time per segment.
 *
 * Algorithm:
 * - Start at beat 0 with baseBpm
 * - For each BPM point at beat b_i with bpm v_i:
 *   - Add time for segment [currentBeat, b_i) using current BPM
 *   - Switch to new BPM
 * - Add time for remaining beats from last BPM change to target beat
 */
export function beatToSecondsMultiBpm(
  beat: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  if (!bpmlist || bpmlist.length === 0) {
    return beatToSeconds(beat, baseBpm, offset);
  }

  let currentBeat = 0;
  let currentBpm = baseBpm;
  let accumulatedTime = 0;

  for (const point of bpmlist) {
    if (point.beat <= 0) continue;
    if (point.beat >= beat) break;

    const segmentBeats = point.beat - currentBeat;
    accumulatedTime += (segmentBeats * 60) / currentBpm;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }

  const remainingBeats = beat - currentBeat;
  accumulatedTime += (remainingBeats * 60) / currentBpm;

  return offset + accumulatedTime;
}

/**
 * Exact inverse of `beatToSecondsMultiBpm`: absolute seconds -> beat.
 *
 * This is the ONLY sanctioned seconds->beat conversion. Do not re-derive it
 * with `(sec - offset) * bpm / 60` at call sites: that linear form is only
 * correct for charts without a bpmlist, and silently drifts on variable-tempo
 * charts (playhead, HUD beat readout and background pulse all desync).
 *
 * `offset` is the chart's own metadata offset (the same one baked into
 * `note.timeSec` by `resolveChart`). It is removed here so callers never have
 * to touch `metadata.offset` themselves.
 *
 * Times before the offset map to beat 0 (clamped) — there is no musical beat
 * before the chart starts.
 */
export function secondsToBeatMultiBpm(
  sec: number,
  baseBpm: number,
  offset: number,
  bpmlist?: BpmPoint[]
): number {
  const t = sec - offset;
  if (t <= 0) return 0;

  if (!bpmlist || bpmlist.length === 0) {
    return (t * baseBpm) / 60;
  }

  let currentBeat = 0;
  let currentBpm = baseBpm;
  let accumulatedTime = 0;

  for (const point of bpmlist) {
    if (point.beat <= 0) continue;
    const segmentSeconds = ((point.beat - currentBeat) * 60) / currentBpm;
    // The target time falls inside this segment — interpolate and stop.
    if (accumulatedTime + segmentSeconds > t) {
      return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
    }
    accumulatedTime += segmentSeconds;
    currentBeat = point.beat;
    currentBpm = point.bpm;
  }

  // Past the last BPM change: extrapolate at the final tempo.
  return currentBeat + ((t - accumulatedTime) * currentBpm) / 60;
}

/**
 * Get the BPM value at a specific beat, considering BPM changes.
 */
export function getBpmAtBeat(beat: number, baseBpm: number, bpmlist?: BpmPoint[]): number {
  if (!bpmlist || bpmlist.length === 0) return baseBpm;
  let bpm = baseBpm;
  for (const point of bpmlist) {
    if (point.beat > beat) break;
    bpm = point.bpm;
  }
  return bpm;
}

/**
 * Resolve all notes in a chart from beat-based to absolute seconds.
 * Slide child nodes are resolved as well.
 *
 * The output is sorted by `timeSec` (ascending) so that the render loop in
 * GameCanvas can use a binary search to find the visible window of notes
 * each frame, instead of iterating the full chart (which can be 1000+ notes).
 * The sort is stable for equal timeSec values, preserving original order
 * among same-time notes (matters for editor determinism).
 */
export function resolveChart(chart: ChartData): ResolvedNote[] {
  const { bpm, offset, bpmlist } = chart.metadata;
  const resolved: ResolvedNote[] = [];
  chart.notes.forEach((n) => {
    // Resolve the head's global angle (degrees→radians) and easing. Child nodes
    // fall back to these when they don't specify their own.
    const headAngle = ((n.angle ?? 0) * Math.PI) / 180;
    const headEasing: EasingType = n.easing ?? 'linear';
    if (n.type === 'slide') {
      resolved.push({
        ...n,
        timeSec: beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist),
        angle: headAngle,
        easing: headEasing,
        resolvedNodes: (n.nodes ?? []).map((sn) => ({
          ...sn,
          timeSec: beatToSecondsMultiBpm(sn.beat, bpm, offset, bpmlist),
          angle: ((sn.angle ?? n.angle ?? 0) * Math.PI) / 180,
          easing: sn.easing ?? n.easing ?? 'linear',
        })),
      });
      return;
    }
    // tap / touch chains: every child node is an independent note of the same
    // type, inheriting the head node's parameters (color, angle, easing, ...).
    resolved.push({
      ...n,
      nodes: undefined,
      timeSec: beatToSecondsMultiBpm(n.beat, bpm, offset, bpmlist),
      angle: headAngle,
      easing: headEasing,
      resolvedNodes: undefined,
    });
    (n.nodes ?? []).forEach((sn, k) => {
      resolved.push({
        ...n,
        nodes: undefined,
        id: `${n.id}#${k + 1}`,
        beat: sn.beat,
        x: sn.x,
        y: sn.y,
        timeSec: beatToSecondsMultiBpm(sn.beat, bpm, offset, bpmlist),
        resolvedNodes: undefined,
        angle: ((sn.angle ?? n.angle ?? 0) * Math.PI) / 180,
        easing: sn.easing ?? n.easing ?? 'linear',
      });
    });
  });
  resolved.sort((a, b) => a.timeSec - b.timeSec);
  return resolved;
}

/**
 * Resolve all events in a chart from beat-based to absolute seconds.
 * Returns empty array if no events defined.
 */
export function resolveEvents(chart: ChartData): ResolvedEvent[] {
  const { bpm, offset, bpmlist } = chart.metadata;
  if (!chart.events || chart.events.length === 0) {
    // Migrate legacy speedEvents to event format
    if (chart.speedEvents && chart.speedEvents.length > 0) {
      return chart.speedEvents
        .map((se, idx) => ({
          id: `legacy-speed-${idx}`,
          type: 'event' as const,
          eventType: 'speed_change' as const,
          beat: se.beat,
          speed: se.speed,
          timeSec: beatToSecondsMultiBpm(se.beat, bpm, offset, bpmlist),
        }))
        .sort((a, b) => a.timeSec - b.timeSec);
    }
    return [];
  }
  const resolved = chart.events.map((e) => ({
    ...e,
    timeSec: beatToSecondsMultiBpm(e.beat, bpm, offset, bpmlist),
  }));
  resolved.sort((a, b) => a.timeSec - b.timeSec);
  return resolved;
}

/** Max beat across all notes, including slide child nodes. */
export function getMaxBeat(chart: ChartData): number {
  let max = 0;
  chart.notes.forEach((n) => {
    max = Math.max(max, n.beat);
    n.nodes?.forEach((sn) => {
      max = Math.max(max, sn.beat);
    });
  });
  return max;
}

/** Earliest note time in seconds (including offset and slide child nodes). */
export function getFirstNoteTime(chart: ChartData): number {
  if (chart.notes.length === 0) return 0;
  const { bpm, offset, bpmlist } = chart.metadata;
  let minBeat = Infinity;
  chart.notes.forEach((n) => {
    minBeat = Math.min(minBeat, n.beat);
    n.nodes?.forEach((sn) => {
      minBeat = Math.min(minBeat, sn.beat);
    });
  });
  return beatToSecondsMultiBpm(minBeat, bpm, offset, bpmlist);
}

/** Total duration (seconds) of a chart: last node time + 1.5s buffer. */
export function getChartDuration(chart: ChartData): number {
  if (chart.notes.length === 0) return 5;
  const { bpm, offset, bpmlist } = chart.metadata;
  return beatToSecondsMultiBpm(getMaxBeat(chart), bpm, offset, bpmlist) + 1.5;
}

/**
 * Count all scoreable notes: tap/touch = 1 each; slide = head + each child node (1 each).
 */
export function countPlayableNotes(chart: ChartData): number {
  return chart.notes.reduce((acc, n) => acc + 1 + (n.nodes?.length ?? 0), 0);
}
