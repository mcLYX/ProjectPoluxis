// Capability detection — runs as a classic script BEFORE the ES module
// loads. Browsers that cannot run the full version (IE11, old Chrome
// without WebGL, etc.) get a fallback card with a link to the Lite build.
// Kept ES5-only so it executes even on IE11.
// NOTE: referenced from index.html as /capability.js (a public asset, served
// as-is, NOT bundled as a module) so it can run synchronously before the
// module and still use document.write() for the fallback.
(function () {
  var reason = '';
  // 1. ES6 syntax (arrow fn, let/const, class, template strings)
  try {
    /* jshint -W054 */
    new Function('let a = 1; const b = 2; const f = () => a + b; class C {}; return `${f()}` + b;')();
  } catch (e) { reason = 'browser_too_old'; }
  // 2. WebGL support
  if (!reason) {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) reason = 'no_webgl';
    } catch (e) { reason = 'no_webgl'; }
  }
  // 3. requestAnimationFrame
  if (!reason && typeof window.requestAnimationFrame !== 'function') {
    reason = 'no_raf';
  }
  if (!reason) return; // all checks passed — let the module load normally

  // Build fallback card (ES5 string concat — IE11 safe)
  var cause = reason === 'no_webgl'
    ? '当前浏览器不支持 WebGL'
    : '当前浏览器版本过旧，无法运行完整版';
  // Split </style> and </script> so this string can never be mis-parsed as
  // a real closing tag by any HTML processor.
  var html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">' +
    '<title>浏览器不兼容 - Project:Poluxis</title><style>' +
    '*{box-sizing:border-box;}' +
    'html,body{margin:0;padding:0;height:100%;width:100%;background:#0a0d12;color:#e8edf4;' +
    'font-family:"Segoe UI",Roboto,Arial,sans-serif;}' +
    '.wrap{position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;padding:24px;}' +
    '.card{max-width:480px;width:100%;margin:0 auto;position:relative;top:50%;' +
    '-ms-transform:translateY(-50%);transform:translateY(-50%);' +
    'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.16);' +
    '-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);' +
    'border-radius:20px;padding:40px 32px;text-align:center;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.18);}' +
    '.title{font-size:22px;font-weight:800;color:#fff;margin:0 0 12px 0;letter-spacing:.5px;}' +
    '.cause{font-size:14px;color:#9aa7b8;margin:0 0 28px 0;line-height:1.6;}' +
    '.btn{display:inline-block;text-decoration:none;padding:14px 32px;border-radius:14px;' +
    'background:#06b6d4;color:#fff;font-weight:800;font-size:15px;' +
    'letter-spacing:1px;box-shadow:0 0 25px rgba(6,182,212,0.5);}' +
    '.hint{margin-top:18px;font-size:12px;color:#6b7888;}' +
    '</sty' + 'le></head><body><div class="wrap"><div class="card">' +
    '<h1 class="title">当前浏览器无法运行完整版</h1>' +
    '<p class="cause">' + cause + '。<br>请更换浏览器（推荐最新版 Chrome / Edge / Firefox），或尝试轻量版。</p>' +
    '<a class="btn" href="lite/index.html">尝试 Lite 版</a>' +
    '<p class="hint">Lite 版基于 Canvas 2D，兼容 Chrome 30+ / IE 11+ 及无 WebGL 设备</p>' +
    '</div></div></body></html>';
  document.open();
  document.write(html);
  document.close();
})();
