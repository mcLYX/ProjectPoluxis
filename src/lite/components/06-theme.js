/* === 3.6 Theme — UI accent follows the active chart's bgScheme.accentColor.
   * IE11 has no CSS custom properties, so we inject a concrete <style> block with
   * the derived accent colors baked in (gradients, borders, :hover, etc.). A media
   * query overrides gradient text for IE11 with a solid color. === */
  var Theme = (function () {
    var styleEl = null;
    var current = FALLBACK_SCHEME.accentColor; /* also read by canvas effects */
    /* Glass button recipe (mirrors .glass-btn-primary / .glass-accent in
     * src/index.css): translucent accent fill + accent hairline border +
     * outer accent glow + inner top highlight. backdrop-filter is a
     * progressive enhancement — IE11 ignores it and still looks correct. */
    function glass(accent, fill, brd, glow, rim) {
      return 'background:' + withAlpha(accent, fill) + ';' +
             'border:1px solid ' + withAlpha(accent, brd) + ';' +
             'box-shadow:0 0 ' + glow.px + 'px ' + withAlpha(accent, glow.a) +
             ',inset 0 1px 0 rgba(255,255,255,' + rim + ');';
    }
    function apply(scheme) {
      var accent = (scheme && scheme.accentColor) || FALLBACK_SCHEME.accentColor;
      current = accent;
      var adark = adjustBrightness(accent, 0.55);
      var light = adjustBrightness(accent, 1.35);
      var bright = adjustBrightness(accent, 1.6);
      var a20 = withAlpha(accent, 0.2), a30 = withAlpha(accent, 0.3),
          a35 = withAlpha(accent, 0.35),
          a50 = withAlpha(accent, 0.5), a60 = withAlpha(accent, 0.6);
      var primaryGrad = 'linear-gradient(90deg,' + accent + ',' + adark + ')';
      /* Secondary (tool/upload/pause) and primary (start) glass buttons */
      var gSub = glass(accent, 0.08, 0.42, { px: 12, a: 0.18 }, 0.08);
      var gSubHover = glass(accent, 0.2, 0.62, { px: 20, a: 0.32 }, 0.14);
      var gPri = glass(accent, 0.18, 0.5, { px: 24, a: 0.3 }, 0.2);
      var gPriHover = glass(accent, 0.28, 0.66, { px: 34, a: 0.45 }, 0.26);
      var css =
        '.chart-card{border-color:' + a20 + ';}' +
        /* Hover keeps only the border/glow accent so the card's own gradient
         * background is not replaced by a flat fill. */
        '.chart-card:hover{border-color:' + a50 + ';}' +
        '.chart-card.selected{border-color:' + accent + ';box-shadow:0 0 26px ' + a30 + ';}' +
        '.card-kind{color:' + withAlpha(accent, 0.75) + ';}' +
        '.card-veil{background:linear-gradient(to top,rgba(0,0,0,0.88) 0%,' + withAlpha(adark, 0.4) + ' 46%,rgba(0,0,0,0.12) 100%);}' +
        '.chart-bpm{border-color:' + a30 + ';color:' + light + ';}' +
        '.diff-btn{border-color:' + a35 + ';color:' + bright + ';}' +
        '.diff-btn.active{border-color:' + withAlpha(accent, 0.75) + ';box-shadow:0 0 12px ' + a30 + ';}' +
        '.menu-footer{border-top-color:' + a20 + ';}' +
        '.menu-badge--lite{color:' + bright + ';}' +
        /* .glass-nav (top-left album nav) and .modal-close (modal ✕) share the
         * secondary glass recipe so every plain button follows the active
         * chart's accent color. */
        '.btn-tool,.upload-btn,.pause-btn,.glass-nav,.modal-close{' + gSub + 'color:' + light + ';}' +
        '.btn-tool:hover,.upload-btn:hover,.pause-btn:hover,.glass-nav:hover,.modal-close:hover{' + gSubHover + '}' +
        '.btn-start{' + gPri + 'color:#fff;}' +
        '.btn-start:hover{' + gPriHover + '}' +
        '.hud-score{text-shadow:0 0 12px ' + a60 + ';}' +
        '.hud-acc,.hud-rank{color:' + bright + ';}' +
        '.hud-progress-fill{background:' + accent + ';}' +
        '.result-card{border-color:' + a30 + ';}' +
        '.result-rank{color:' + bright + ';}' +
        '.pause-title{color:' + light + ';}' +
        '.modal-card{border-color:' + a30 + ';}' +
        '.modal-row input[type=number],.editor-textarea{border-color:' + a30 + ';}' +
        '.modal-row .val{color:' + light + ';}' +
        '.menu-title{background:' + primaryGrad + ';-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}' +
        /* Any IE (`.ie` on <html>, set by the head script): no
         * background-clip:text → solid accent text. rgba backgrounds and
         * box-shadow DO work in IE11, so the glass buttons need no override. */
        '.ie .menu-title{background:transparent;color:' + accent + ';-webkit-text-fill-color:' + accent + ';}' +
        '.ie .hud-progress-fill{background:' + accent + ';}';
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'theme-style';
        document.head.appendChild(styleEl);
      }
      /* IE9: <style>.textContent does not always propagate to the active
       * stylesheet; must go through the DOM styleSheet.cssText interface.
       * Modern browsers accept textContent directly. */
      try {
        if (styleEl.styleSheet && styleEl.styleSheet.cssText !== undefined) {
          styleEl.styleSheet.cssText = css;
        } else {
          styleEl.textContent = css;
        }
      } catch (e) {
        /* Last resort: clear and append a text node (IE8 style, works in IE9 too) */
        try {
          while (styleEl.firstChild) styleEl.removeChild(styleEl.firstChild);
          styleEl.appendChild(document.createTextNode(css));
        } catch (e2) { /* give up */ }
      }
    }
    return { apply: apply, accent: function () { return current; } };
  })();
