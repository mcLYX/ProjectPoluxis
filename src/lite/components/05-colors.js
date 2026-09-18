/* === 3.5 Color helpers (ES5, IE11-safe) === */
  var FALLBACK_SCHEME = { accentColor: '#06b6d4', gradientStart: '#050816', gradientEnd: '#02040c' };
  function hexToRgb(hex) {
    var h = ('' + hex).replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function withAlpha(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function adjustBrightness(hex, f) {
    var c = hexToRgb(hex);
    function cl(x) { x = Math.round(x); return x < 0 ? 0 : (x > 255 ? 255 : x); }
    return 'rgb(' + cl(c.r * f) + ',' + cl(c.g * f) + ',' + cl(c.b * f) + ')';
  }
