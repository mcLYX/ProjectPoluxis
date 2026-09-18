/**
 * Easing functions: progress t∈[0,1] → eased progress ∈[0,1] (f(0)=0, f(1)=1).
 *
 * Single source of truth, inlined into the Lite build by scripts/build-lite.mjs
 * (the Lite slide renderer consumes these to apply easing to pipe consumption).
 * No type imports — ES5-clean so it can be inlined verbatim.
 */
export var EASING_FNS = {
  linear: function (t: number) { return t; },
  'sine-in': function (t: number) { return 1 - Math.cos((t * Math.PI) / 2); },
  'sine-out': function (t: number) { return Math.sin((t * Math.PI) / 2); },
  'sine-io': function (t: number) { return (1 - Math.cos(t * Math.PI)) / 2; },
};
