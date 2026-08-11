import type { EasingType } from '../types/game';

/** Ordered list of supported easing types (used for validation + UI iteration). */
export const EASING_TYPES: EasingType[] = ['linear', 'sine-in', 'sine-out', 'sine-io'];

/**
 * Easing functions mapping progress t∈[0,1] → eased progress ∈[0,1]
 * (with f(0)=0, f(1)=1). These describe how the *path parameter* advances
 * along a slide segment; the slide pipe renderer turns them into a curve.
 */
export const EASING_FNS: Record<EasingType, (t: number) => number> = {
  linear: (t) => t,
  'sine-in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sine-out': (t) => Math.sin((t * Math.PI) / 2),
  'sine-io': (t) => (1 - Math.cos(t * Math.PI)) / 2,
};

/**
 * For the slide pipe, the segment between node A and node B is drawn as a cubic
 * Bézier whose control-point tangents are rotated away from the straight
 * direction (A→B) by an angle determined by the easing. This bends the pipe
 * into a smooth curve while still connecting A and B exactly.
 *
 * Returns the tangent rotation (radians, applied in the screen XY plane) at the
 * start (θ0) and end (θ1) of the segment. +90° means the tangent is
 * perpendicular to A→B (a "flat" ease-in/out look); 0° is a straight segment.
 */
export function easingTangentAngles(easing: EasingType): { start: number; end: number } {
  const HALF_PI = Math.PI / 2;
  switch (easing) {
    case 'linear':
      return { start: 0, end: 0 };
    case 'sine-in':
      return { start: HALF_PI, end: 0 };
    case 'sine-out':
      return { start: 0, end: HALF_PI };
    case 'sine-io':
      return { start: HALF_PI, end: HALF_PI };
  }
}
