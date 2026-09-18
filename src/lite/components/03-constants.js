/* === 2. Constants (mirrors src/components/GameCanvas.tsx L30-51) === */
  var TAP_SIZE = 1.6;
  var TOUCH_SIZE = TAP_SIZE * 0.707;
  var SLIDE_SIZE = TAP_SIZE * 0.707;
  var SLIDE_HALF = (SLIDE_SIZE * Math.SQRT2) / 2;
  var SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
  var JUDGE_Z = 0;
  var TAP_HIT_HALF = 1.2;
  var TOUCH_HIT_HALF = 1.0;
  var SLIDE_HIT_HALF = 1.2;
  var HIT_WINDOW_MS = 160;
  var SLIDE_RED = '#ff0000';
  /* Easing identifiers valid in the chart spec (mirrors src/utils/easing.ts). */
  var EASING_TYPES = ['linear', 'sine-in', 'sine-out', 'sine-io'];
  var CAMERA_VFOV = 52;
  var FIT_HALF = 2.42;
  var CAMERA_AXIS_Y = 0;
  var TAN_HALF_FOV = Math.tan(CAMERA_VFOV * Math.PI / 180 / 2); /* ≈0.4877 */
  var FADE_ZONE = 12;
  /* Judge plane border (mirrors full version tunnel plane corners ±3.8/±2.5).
   * Previous ±3.0/±1.9 made the play area look smaller than the full version. */
  var PLANE_HALF_X = 3.8;
  var PLANE_HALF_Y = 2.5;
  var JUDGE_THRESH = { S_PERFECT: 40, PERFECT: 80, GOOD: 160 };
  var JUDGE_COLORS = {
    'S-Perfect': '#ff8c00',
    'Perfect': '#ffd700',
    'Good': '#38bdf8',
    'Miss': '#ef4444'
  };
  /* Burst animation scale target per judgment — mirrors JUDGEMENT_COLORS[].scale
   * in src/utils/scoring.ts. The burst starts at the note's size and grows by
   * this factor (1.2 = 20% growth for S-Perfect, etc.) using a sine curve. */
  var JUDGE_SCALE = {
    'S-Perfect': 1.2,
    'Perfect': 1.1,
    'Good': 1.05,
    'Miss': 1.0
  };
