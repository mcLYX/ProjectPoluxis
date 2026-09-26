import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import packageJson from "./package.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
// 标准多文件构建（适合 OpenResty / nginx 静态托管）。
//
// 版本号注入：web 构建为 package.json 的 version（toy 构建在 vite.toy.config.ts
// 追加 `_toy` 后缀），供 DocModal 等统一消费，避免硬编码。

// 部署说明：
// - 默认根目录部署：base 用 './'（相对路径），PWA 的 start_url/scope 也走相对，
//   子目录下同样可正常注册 Service Worker 与 manifest。
// - 若部署到子目录（如 http://域名/poluxis/），把 base 改成 '/poluxis/' 即可；
//   其余 PWA 配置（manifest.start_url、scope、SW 注册路径）都会被插件按 base 自动处理，
//   无需逐处手动加前缀。
/**
 * 内联 PostCSS 工具（不新增依赖）：为不支持的目标浏览器补 sRGB 回退。
 *
 * Tailwind v4 默认用 oklch() 输出颜色（Chrome 111+），且 `/透明度` 修饰符会编译成
 * color-mix(in …)（同样 Chrome 111+）。更老的浏览器会把整条声明当成无效值丢弃 →
 * 颜色退化成继承值（深色底上可能直接看不见）。
 *
 * 两套回退都不依赖 @supports，而是「在生效声明之前插入同属性的 rgb(a) 回退值」：
 * 支持 oklch/color-mix 的浏览器用后一条覆盖前一条；不支持的丢弃后一条、命中前面的
 * sRGB 值。标准 CSS 回退写法。
 *
 * - oklchFallbackPlugin：处理「整条值就是一个 oklch()」的声明（渐变等多值不改写）。
 * - colorMixFallbackPlugin：把 color-mix(in <space>, C <pct>%, transparent) 这类
 *   透明度混合在构建期算成 rgba()，覆盖 Tailwind 全部 `/透明度` 工具类（含
 *   var(--color-*)、字面 oklch/hex/rgb）。仅改写可静态算出结果的两种颜色混合；
 *   无法解析的情形（如命名色）保持原样，交由现代浏览器处理。
 */

// ---- 共享颜色解析 ----
function parseNum(s: string, scale: number): number {
  var v = parseFloat(s);
  return s.indexOf('%') >= 0 ? (v / 100) * scale : v;
}

/** OKLCh → sRGB（0..255），带 gamma 编码与钳位。 */
function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  var h = (H * Math.PI) / 180;
  var a = C * Math.cos(h);
  var b = C * Math.sin(h);
  var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  var s_ = L - 0.0894841775 * a - 1.291485548 * b;
  var l = l_ * l_ * l_;
  var m = m_ * m_ * m_;
  var s = s_ * s_ * s_;
  var lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  var lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  var lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  function enc(c: number): number {
    var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c > 0 ? c : 0, 1 / 2.4) - 0.055;
    var out = Math.round(v * 255);
    return out < 0 ? 0 : out > 255 ? 255 : out;
  }
  return [enc(lr), enc(lg), enc(lb)];
}

/** #rgb / #rrggbb / #rgba / #rrggbbaa → [r,g,b,a]（a 为 0..1）。 */
function hexToRgb(hex: string): [number, number, number, number] | null {
  var h = hex.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + (h[3] ? h[3] + h[3] : '');
  }
  var r = parseInt(h.slice(0, 2), 16);
  var g = parseInt(h.slice(2, 4), 16);
  var b = parseInt(h.slice(4, 6), 16);
  var a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b, a];
}

var RE_OKLCH = /^\s*oklch\(\s*([0-9.]+(?:%)?)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)(?:\s*\/\s*([0-9.]+(?:%)?))?\s*\)\s*$/;
var RE_RGB = /^\s*rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*(?:[,\/]\s*([0-9.]+%?))?\s*\)\s*$/;

/** 把颜色字符串解析为 [r,g,b,a]（a 为 0..1）。支持 var(--x)（递归查表）、
 *  oklch()、hex、rgb()/rgba()；解析失败返回 null。 */
function resolveColorToRgb(input: string, vars: Record<string, string>, depth: number): [number, number, number, number] | null {
  if (depth > 6) return null;
  var s = (input || '').trim();
  if (s === '') return null;
  var varM = /^var\(\s*(--[^\s,)]+)\s*(?:,\s*([^)]*))?\)$/.exec(s);
  if (varM) {
    var name = varM[1];
    var fb = varM[2];
    var val = vars[name];
    if (val == null) return fb != null ? resolveColorToRgb(fb, vars, depth + 1) : null;
    return resolveColorToRgb(val, vars, depth + 1);
  }
  if (s.indexOf('oklch(') === 0) {
    var m = RE_OKLCH.exec(s);
    if (!m) return null;
    var rgb = oklchToRgb(parseNum(m[1], 1), parseFloat(m[2]), parseFloat(m[3]));
    var a = m[4] !== undefined ? parseNum(m[4], 1) : 1;
    return [rgb[0], rgb[1], rgb[2], a];
  }
  if (s.charAt(0) === '#') return hexToRgb(s);
  var rm = RE_RGB.exec(s);
  if (rm) {
    return [parseFloat(rm[1]), parseFloat(rm[2]), parseFloat(rm[3]), rm[4] != null ? parseNum(rm[4], 1) : 1];
  }
  return null; // 命名色等暂不处理
}

/** 按顶层逗号切分（忽略括号内部的逗号）。 */
function splitTopCommas(str: string): string[] {
  var parts: string[] = [], depth = 0, cur = '';
  for (var k = 0; k < str.length; k++) {
    var ch = str[k];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/** 解析 color-mix 的一个分量，返回 { rgb, pct }（pct 为百分号数值或 null=省略）。 */
function parseMixPart(part: string, vars: Record<string, string>): { rgb: [number, number, number, number]; pct: number | null } | null {
  part = part.trim();
  if (part === '') return null;
  var pct: number | null = null;
  // 百分比是末尾 token，可能以空白分隔（如 `var(--x) 30%`）或紧贴右括号
  // （如 `var(--x)30%`，无空格）。只消费「可选空白 + 数字」，把颜色的 `)` 留在串内。
  var pm = /(\s*)([0-9]+(?:\.[0-9]+)?%?)\s*$/.exec(part);
  var colorStr = part;
  if (pm) {
    pct = parseNum(pm[2], 100); // 百分号形式 → 数值（6% → 6）
    colorStr = part.slice(0, pm.index).trim();
  }
  if (colorStr === 'transparent') return { rgb: [0, 0, 0, 0], pct: pct };
  var rgb = resolveColorToRgb(colorStr, vars, 0);
  if (!rgb) return null;
  return { rgb: rgb, pct: pct };
}

/** 把单个 color-mix(...) 内部字符串算成 rgba()；无法解析返回 null。 */
function transformOneColorMix(inner: string, vars: Record<string, string>): string | null {
  var parts = splitTopCommas(inner);
  if (parts.length < 3) return null; // parts[0] 为 "in <space>"
  var a = parseMixPart(parts[1], vars);
  var b = parseMixPart(parts[2], vars);
  if (!a || !b) return null;
  var p1 = a.pct, p2 = b.pct;
  if (p1 == null && p2 == null) { p1 = 50; p2 = 50; }
  else if (p1 == null) { p1 = Math.max(0, Math.min(100, 100 - (p2 as number))); }
  else if (p2 == null) { p2 = Math.max(0, Math.min(100, 100 - (p1 as number))); }
  p1 = (p1 as number) / 100;
  p2 = (p2 as number) / 100;
  var ca = a.rgb, cb = b.rgb;
  var wa = p1 * ca[3], wb = p2 * cb[3];
  var total = wa + wb;
  if (total <= 0) return 'rgba(0, 0, 0, 0)';
  var r = (ca[0] * wa + cb[0] * wb) / total;
  var g = (ca[1] * wa + cb[1] * wb) / total;
  var bl = (ca[2] * wa + cb[2] * wb) / total;
  var al = total;
  function r4(x: number): number { return Math.round(x * 10000) / 10000; }
  return 'rgba(' + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(bl) + ', ' + r4(al) + ')';
}

/** 扫描并替换值里所有 color-mix(...)（保留无法解析的）。 */
function transformColorMixValue(value: string, vars: Record<string, string>): string {
  var out = '', i = 0;
  while (i < value.length) {
    var idx = value.indexOf('color-mix(', i);
    if (idx < 0) { out += value.slice(i); break; }
    out += value.slice(i, idx);
    var depth = 0, j = idx;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    var inner = value.slice(idx + 'color-mix('.length, j - 1);
    var repl = transformOneColorMix(inner, vars);
    out += repl !== null ? repl : ('color-mix(' + inner + ')');
    i = j;
  }
  return out;
}

// ---- 插件 1：oklch() → rgb() 回退 ----
function oklchFallbackPlugin() {
  return {
    postcssPlugin: 'poluxis-oklch-fallback',
    Declaration: function (decl: { prop: string; value: string; cloneBefore: (o: { prop: string; value: string }) => void }) {
      var v = decl.value;
      if (!v || v.indexOf('oklch(') < 0) return;
      var m = RE_OKLCH.exec(v);
      if (!m) return; // 渐变等多值场景：不改写
      var rgb = oklchToRgb(parseNum(m[1], 1), parseFloat(m[2]), parseFloat(m[3]));
      var fallback =
        m[4] !== undefined
          ? 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + parseNum(m[4], 1) + ')'
          : 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
      decl.cloneBefore({ prop: decl.prop, value: fallback });
    },
  };
}

// ---- 插件 2：color-mix(...) → rgba() 回退 ----
function colorMixFallbackPlugin() {
  return {
    postcssPlugin: 'poluxis-colormix-fallback',
    Root: function (root: any) {
      // 先收集所有自定义属性（含 Tailwind 的 --color-*），供 var() 解析使用。
      var vars: Record<string, string> = {};
      root.walkDecls(function (decl: any) {
        if (decl.prop.charAt(0) === '-' && decl.prop.charAt(1) === '-') vars[decl.prop] = decl.value;
      });
      root.walkDecls(function (decl: any) {
        if (decl.value.indexOf('color-mix(') < 0) return;
        var transformed = transformColorMixValue(decl.value, vars);
        if (transformed !== decl.value) decl.value = transformed;
      });
    },
  };
}

export default defineConfig({
  // 版本号注入（toy 构建在 vite.toy.config.ts 追加 `_toy` 后缀）。
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  base: "./",
  // 颜色回退：oklch()/color-mix() → rgb()/rgba()（见上方两个 PostCSS 插件注释）。
  // 目标浏览器（如 Chrome 99，不支持 oklch/color-mix）会命中前面的 sRGB 回退值。
  css: {
    postcss: {
      plugins: [oklchFallbackPlugin(), colorMixFallbackPlugin()],
    },
  },
  // 产物语法目标：es2019（≈ Chrome 73）。
  // 之前未设置 → 用默认的 'modules'（chrome87 基线），产物里保留 ES2020 语法
  // （可选链 ?. / 空值合并 ?? 等），老 Chrome 直接解析失败、整个 module 一行都
  // 跑不了，于是"支持 ES6+WebGL 却打不开完整版"。降级到 es2019 后这些语法会被
  // esbuild 转译，失败模式从"无法检测的解析错误"变成"可以检测的 API 缺失"。
  // 配套：public/capability.js 用与 es2019 对齐的语法 canary + 真实 API 检测。
  esbuild: {
    target: "es2019",
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2019" },
  },
  build: {
    target: "es2019",
    cssTarget: "chrome73",
    assetsDir: "assets",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 将体积最大的第三方库拆分到独立 chunk：
        // - three 单独成块（仅在进入游戏/编辑器时按需下载，不再被拽入首屏主链）。
        // - 常用依赖聚合到 vendor，利于浏览器缓存复用。
        manualChunks: {
          three: ["three"],
          vendor: [
            "react",
            "react-dom",
            "lucide-react",
            "canvas-confetti",
            "fflate",
            "liquid-glass-react",
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 自动在页面注入 manifest 链接与 SW 注册脚本（全版本 SPA 入口）。
      registerType: "autoUpdate",
      // 把静态资源（图标、本地字体）纳入预缓存清单。字体改为本地随包分发后，
      // 必须显式进预缓存，否则纯离线（仅靠 SW）场景下 /fonts/*.woff2 取不到、
      // 会回退到系统字体，丢失 Orbitron/Rajdhani/Inter 的视觉效果。
      includeAssets: [
        "icons/icon.svg",
        "icons/icon-maskable.svg",
        "fonts/*.woff2",
        "fonts/OFL.txt",
      ],
      manifest: {
        name: "Project:Poluxis",
        short_name: "Poluxis",
        description: "简约风格 3D 音乐节奏游戏",
        theme_color: "#0b1120",
        background_color: "#0a0d12",
        display: "standalone",
        // 相对 start_url：根目录或子目录部署都能正确作为 PWA 起点。
        start_url: ".",
        scope: ".",
        icons: [
          {
            src: "icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "icons/icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 预缓存应用外壳（JS/CSS/HTML/字体/图标）。
        globPatterns: ["**/*.{js,css,html,svg,woff2,ttf}"],
        // 外部内容（谱面 / 音效）体积可能较大且不固定，走运行时缓存而非预缓存。
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/beatmaps/"),
            handler: "CacheFirst",
            options: {
              cacheName: "poluxis-beatmaps",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes("/sounds/"),
            handler: "CacheFirst",
            options: {
              cacheName: "poluxis-sounds",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // web 构建：virtual:toy-platform → 公共占位桩（零 B站代码）。
      // toy 构建由 vite.toy.config.ts 覆盖此别名指向私有 adapters/toy.ts。
      "virtual:toy-platform": path.resolve(__dirname, "src/platform/adapters/__toy_stub.ts"),
    },
  },
  server: {
    port: 61616,
    host: true,
  },
});
