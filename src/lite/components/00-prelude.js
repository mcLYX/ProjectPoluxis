/* ES5 polyfills MUST be defined before any usage (e.g. the I18N
 * Object.assign calls below). IE lacks Object.assign entirely. */
if (!Object.assign) {
  Object.assign = function (target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  };
}
/* ============================================================
 * Poluxis Lite — lightweight Canvas-2D build
 * ES5 only (Chrome 30+ / IE 11+ compatible). No build step.
 * Sections: 1.Polyfill 2.Constants 3.Core logic 4.LiteAudio
 *           5.Renderer 6.GameLoop 6.5.Input 7.UI 8.Demo charts
 * Mirrors src/components/GameCanvas.tsx + src/audio/AudioManager.ts
 * + src/utils/{scoring,beatTime,chartParser}.ts in plain ES5.
 * ============================================================ */
