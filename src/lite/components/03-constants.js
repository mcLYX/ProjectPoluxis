/* === 2. Constants (Lite-only render constants) ===
 * The shared gameplay *spec* (note sizes, hit half, hit window, easing types,
 * judge thresholds/colours/scale, score base, rank thresholds) now lives in
 * src/shared/gameplaySpec.ts and is injected at the IIFE top by the build.
 * Edit that one file to update BOTH the full app and this Lite build. */
  var SLIDE_PIPE_HALF = SLIDE_HALF * 0.82;
  var SLIDE_RED = '#ff0000';
  var CAMERA_VFOV = 52;
  var FIT_HALF = 2.42;
  var CAMERA_AXIS_Y = 0;
  var TAN_HALF_FOV = Math.tan(CAMERA_VFOV * Math.PI / 180 / 2); /* ≈0.4877 */
  var FADE_ZONE = 12;
  /* Judge plane border (mirrors full version tunnel plane corners ±3.8/±2.5).
   * Previous ±3.0/±1.9 made the play area look smaller than the full version. */
  var PLANE_HALF_X = 3.8;
  var PLANE_HALF_Y = 2.5;
