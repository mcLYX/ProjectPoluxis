export type NoteType = 'tap' | 'touch' | 'slide';

/** Easing curve for the segment connecting a slide node to its previous node.
 *  - 'linear'  : straight line (default).
 *  - 'sine-in' : curve leaves the previous node perpendicularly, then bends in
 *                (slow "ease-in" start) — visually a smooth entry.
 *  - 'sine-out': straight start, perpendicular exit (smooth "ease-out" end).
 *  - 'sine-io' : perpendicular at both ends (smooth S-curve).
 *  Used by the slide pipe renderer to bend the pipe between two nodes. */
export type EasingType = 'linear' | 'sine-in' | 'sine-out' | 'sine-io';

export type EventType = 'speed_change' | 'text_display' | 'bg_change' | 'note_color_change';

export type JudgementType = 'S-Perfect' | 'Perfect' | 'Good' | 'Miss';

/**
 * Graphics quality tiers.
 * - 'low':     No antialiasing, pixelRatio locked to 1.0, ambient bg is flat color.
 * - 'standard': Antialiasing on, pixelRatio up to 1.5, ambient bg uses audio frequency.
 * - 'high':    Standard + Bloom post-processing (if chart.effectToggles.bloom)
 *              + ambient particle field (if chart.effectToggles.particles).
 * - 'ultra':   High + notes become real light sources illuminating tunnel walls
 *              + hit bursts emit shattering light particles. Heavy GPU cost.
 */
export type QualityMode = 'low' | 'standard' | 'high' | 'ultra';

/** A single child node of a slide chain (the head is the NoteData itself). */
export interface SlideNodeData {
  beat: number;
  x: number;
  y: number;
  /** Rotation (degrees) of this node's visual (note + cross-section) around its
   *  center. Defaults to the head node's `angle` (or 0 if unset) when omitted. */
  angle?: number;
  /** Easing for the segment connecting THIS node to the PREVIOUS node.
   *  Defaults to the head node's `easing` (or 'linear') when omitted. */
  easing?: EasingType;
}

/** BPM change point: from this beat onward, use the new BPM for time calculation. */
export interface BpmPoint {
  beat: number;
  bpm: number;
}

/** Chart event: triggers at a specific beat, used for effects/state changes (not judged). */
export interface EventData {
  id: string;
  type: 'event';
  eventType: EventType;
  beat: number;
  /** speed_change: new speed multiplier */
  speed?: number;
  /** text_display: text to show on screen */
  text?: string;
  /** text_display: duration in seconds (0 = persistent until next text event or end) */
  textDuration?: number;
  /** text_display: normalized x position on screen [-1..1], 0 = center */
  x?: number;
  /** text_display: normalized y position on screen [-1..1], 0 = center */
  y?: number;
  /** text_display: font size in pixels (default: 36) */
  fontSize?: number;
  /** text_display: text color (default: chart accent color / cyan) */
  color?: string;
  /** bg_change: new gradient start color */
  gradientStart?: string;
  /** bg_change: new gradient end color */
  gradientEnd?: string;
  /** note_color_change: new note color */
  noteColor?: string;
}

export interface NoteData {
  id: string;
  /** Time in beats (not seconds). Converted to seconds via BPM+offset at runtime. */
  beat: number;
  x: number;    // normalized 3D x-coordinate on judgement plane [-2.4 .. 2.4]
  y: number;    // normalized 3D y-coordinate on judgement plane [-1.5 .. 1.5]
  type: NoteType;
  /** Optional custom hex color overriding the global chart metadata.noteColor. */
  color?: string;
  /** Slide only: child nodes following the head node, each judged independently (1 note each). */
  nodes?: SlideNodeData[];
  /** Global rotation (degrees) applied to this chain's visuals. Child nodes may
   *  override it. Touch notes ignore it (a rotated circle looks identical). */
  angle?: number;
  /** Slide only: default easing for all child segments (overridable per child). */
  easing?: EasingType;
  hit?: boolean;
  judgement?: JudgementType;
  deltaT?: number;
  speedMul?: number;
}

export interface ResolvedSlideNode extends SlideNodeData {
  timeSec: number;
  /** Effective (resolved) angle in radians for rendering. */
  angle: number;
  /** Effective (resolved) easing for the segment leading into this node. */
  easing: EasingType;
}

/** A rectangular hit region (axis-aligned) in note-space, used by the
 *  overlap-merge tap judgment (方案二): when a tap is consumed, its own
 *  hitbox is merged into the other same-time taps the touch point overlapped. */
export interface HitRegion {
  x: number;
  y: number;
  half: number;
}

/** Runtime-resolved note with absolute time in seconds */
export interface ResolvedNote extends NoteData {
  timeSec: number;
  /** Resolved (effective) rotation in radians for this note's visual. */
  angle?: number;
  /** Resolved (effective) easing for this note (slide head/children only). */
  easing?: EasingType;
  /** Slide only: resolved child nodes */
  resolvedNodes?: ResolvedSlideNode[];
  /** Extra hit regions (besides the note's own TAP_HIT_HALF box) gained from
   *  consuming other overlapping same-time taps. Runtime-only, reset per play. */
  extraHitRegions?: HitRegion[];
}

/** Runtime-resolved event with absolute time in seconds */
export interface ResolvedEvent extends EventData {
  timeSec: number;
}

export interface ChartMetadata {
  title: string;
  artist: string;
  difficulty: string;
  /** Base BPM at beat 0. For multi-BPM charts, use bpmlist. */
  bpm: number;
  /** BPM change points (sorted by beat ascending). First point must not be at beat 0 — use base bpm for that. */
  bpmlist?: BpmPoint[];
  offset: number; // in seconds – audio lead-in before beat 0
  jacket?: string;
  bgScheme: {
    gradientStart: string;
    gradientEnd: string;
    accentColor: string;
  };
  noteColor: string;
  effectToggles: {
    bloom: boolean;
    particles: boolean;
    projection: boolean;
    gridLines: boolean;
  };
}

export interface ChartData {
  metadata: ChartMetadata;
  notes: NoteData[];
  /** @deprecated Use events array with speed_change type instead. Kept for backward compat. */
  speedEvents?: Array<{ beat: number; speed: number }>;
  /** Events mixed into the chart — resolved alongside notes, triggered at their time. */
  events?: EventData[];
}

export interface JudgementFeedback {
  id: string;
  type: JudgementType;
  x: number;
  y: number;
  deltaT: number;
  scoreGained: number;
  createdAt: number;
  noteType: NoteType;
}

export interface GameStats {
  score: number;
  combo: number;
  maxCombo: number;
  sPerfectCount: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  totalNotes: number;
  accuracy: number; // 0 to 100
  rank: 'EX+' | 'EX' | 'S' | 'A' | 'B' | 'C' | 'F';
}
