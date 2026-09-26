// Capability detection — runs as a classic script BEFORE the ES module loads.
// Kept ES5-only so it executes even on very old browsers / IE11.
// NOTE: referenced from index.html as /capability.js (a public asset, served
// as-is, NOT bundled as a module) so it can run synchronously before the
// module and still use document.write() for the fallback.
//
// 设计要点（与 vite.config.ts 的 build.target = es2019 配套）：
// 1) 不再用"泛泛的 ES6 检测"：ES6 早就普及，真正卡住老浏览器的是构建产物里的
//    更新语法（可选链 ?. / 空值合并 ?? / class 字段 …）。这些一旦解析失败，
//    整个 module script 一行都跑不了，页面表现为"打不开"。现在产物已降级到
//    es2019，这里用等价的 canary 探测，门限与产物一致。
// 2) WebGL 不再阻断进入：接了 Canvas 2D 渲染器后，无 WebGL 应走 2D 完整版，
//    只在 window.__POLUXIS_NO_WEBGL__ 上标记，由应用据此选择默认渲染器。
//    只有连 Canvas 2D 都没有时才降级到 Lite。
// 3) 暴露 window.__POLUXIS_FALLBACK__ 供 index.html 的"启动看门狗"复用同一张
//    兜底卡片——用于兜住任何这里没检测到的未知缺口（无需预先知道具体版本）。
(function () {
  var MIN_NOTE = 'Chrome 73+';

  var CAUSE = {
    browser_too_old: '当前浏览器版本过旧，无法运行完整版（需要 ' + MIN_NOTE + '）',
    no_canvas: '当前浏览器不支持 Canvas 2D，无法渲染游戏画面',
    missing_api: '当前浏览器缺少必要接口',
    boot_failed: '完整版启动失败（可能是浏览器版本过旧或脚本被拦截）',
  };

  function causeOf(reason, extra) {
    if (reason === 'missing_api' && extra) {
      return CAUSE[reason] + '：' + extra;
    }
    return CAUSE[reason] || CAUSE.boot_failed;
  }

  /** 渲染兜底卡片（ES5 字符串拼接，IE11 也安全）。 */
  function render(reason, extra) {
    var cause = causeOf(reason, extra);
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
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      /* 兜底失败时不再抛出，避免二次错误掩盖原始原因 */
    }
  }

  // 供 index.html 的启动看门狗复用。
  window.__POLUXIS_FALLBACK__ = render;

  // 1) 语法 canary：与 build.target=es2019 对齐。
  //    对象展开（ES2018 / Chrome 60）+ 可选 catch 绑定（ES2019 / Chrome 66）。
  //    用 new Function 在运行时解析，能捕获 SyntaxError——这正是老浏览器"打不开"
  //    的失败模式，且是唯一能在脚本真正执行前发现它的办法。
  try {
    /* jshint -W054 */
    new Function('var o={...{a:1}};try{throw 0}catch{}return o.a;')();
  } catch (e) {
    render('browser_too_old');
    return;
  }

  // 2) Canvas 2D：没有它既渲染不了 2D 也渲染不了 3D，只能去 Lite。
  try {
    var c = document.createElement('canvas');
    if (!c.getContext || !c.getContext('2d')) {
      render('no_canvas');
      return;
    }
  } catch (e) {
    render('no_canvas');
    return;
  }

  // 3) 真正用到的运行时 API（逐个给出门槛，避免"猜版本"）。
  var NEED = [
    ['ResizeObserver', 'ResizeObserver'], // 画布尺寸自适应；Chrome 64+
    ['AbortController', 'AbortController'], // 谱面加载中断；Chrome 66+
    ['fetch', 'fetch'],
    ['Promise', 'Promise'],
    ['requestAnimationFrame', 'requestAnimationFrame'],
  ];
  var missing = [];
  for (var i = 0; i < NEED.length; i++) {
    if (typeof window[NEED[i][0]] === 'undefined') missing.push(NEED[i][1]);
  }
  // 音频：节奏游戏的核心能力（Chrome 35+，含 webkit 前缀）。
  var hasAudio = !!(window.AudioContext || window.webkitAudioContext);
  if (!hasAudio) missing.push('WebAudio');
  if (missing.length) {
    render('missing_api', missing.join('、'));
    return;
  }

  // 4) WebGL：**不阻断**，只用于选择渲染器。
  var webgl = false;
  try {
    var c2 = document.createElement('canvas');
    webgl = !!(c2.getContext('webgl2') || c2.getContext('webgl') || c2.getContext('experimental-webgl'));
  } catch (e) {
    webgl = false;
  }
  // 应用据此把默认视图切到 2D（有 WebGL 时才用 3D）。
  window.__POLUXIS_NO_WEBGL__ = !webgl;
  window.__POLUXIS_CAPABILITY__ = { webgl: webgl, canvas2d: true, webAudio: true };

  // 全部通过 —— 让模块正常加载。
})();
