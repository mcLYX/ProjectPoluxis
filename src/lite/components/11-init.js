/* === Init === */
  resize();
  /* IE9: install click-forwarding layer so overlay/hud (pointer-events:none
   * in CSS, which IE9 ignores) don't block clicks to the canvas. */
  installPointerEventsFallback();
  /* Load beatmaps manifest, then build menu */
  loadBeatmapsManifest(function () {
    buildMenu();
  });
  showMenu();
  /* Detect IE11 (no Web Audio API) early — without creating an AudioContext.
   * In HTML5 mode, demo tracks are silent (no synth). Show a hint on the
   * upload button so the user knows to import an audio file for sound. */
  if (!(window.AudioContext || window.webkitAudioContext)) {
    audio.useHtml5 = true;
    var _upLabel = document.getElementById('editor-audio-label');
    if (_upLabel) _upLabel.textContent = L('edImportAudio');
  }
  /* UI click sound — delegated from the document so every button/card gets it
   * without touching each handler. Walks a few levels up from the event target
   * because buttons may contain inline elements. */
  (function () {
    var UI_HIT = /(^|\s)(btn-tool|btn-start|card-start|upload-btn|pause-btn|chart-card|diff-btn)(\s|$)/;
    document.addEventListener('click', function (e) {
      var el = e.target || e.srcElement;
      for (var depth = 0; el && el.nodeType === 1 && depth < 4; depth++) {
        var cn = el.className;
        /* SVG elements expose an SVGAnimatedString here, hence the typeof guard */
        if (typeof cn === 'string' && UI_HIT.test(cn)) { audio.playUiSound(); return; }
        el = el.parentNode;
      }
    }, false);
  })();

  Theme.apply(FALLBACK_SCHEME);
  loop();
