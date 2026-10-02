/**
 * 故事板 three.js 共享（消除双实例）。
 *
 * 背景：story.js 若把 three 打进包里，浏览器会同时跑游戏与故事板两套 three
 * （双份解析内存 + 双实例类层级，且控制台出现重复实例相关警告）。
 *
 * 方案：**共享模块、不共享渲染管线** ——
 *  - 宿主把自己的 three 命名空间挂到 `globalThis.__THREE_SHARED__`，并注入一个
 *    importmap：`"three" → shim blob`（shim 模块从共享命名空间 re-export 全部
 *    命名导出 + default）。story.js 以 `external: ['three']` 构建，运行时经
 *    importmap 拿到**与游戏同一份** three（同类、同 class 身份、只解析一份）。
 *  - 故事板仍自建 renderer / canvas / composer —— 宿主**不暴露**游戏的
 *    scene / camera / renderer，对游戏渲染零影响（`api.three` 只是命名空间）。
 *
 * 时序保证：importmap 必须在任何裸名 'three' 模块解析前注入。应用本体由打包器
 * 合并 three（运行时不存在裸名解析），故事板的 `import(storyUrl)` 是首个消费者，
 * 因此在动态 import 前同步注入即可。
 */

export const THREE_SHARED_KEY = '__THREE_SHARED__';

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 生成 shim 模块源码：从共享命名空间 re-export 全部命名导出 + default。 */
export function buildThreeShimCode(names: readonly string[], sharedKey: string = THREE_SHARED_KEY): string {
  const lines: string[] = [
    `const m = globalThis[${JSON.stringify(sharedKey)}];`,
    'export default m;',
  ];
  for (const k of names) {
    // three 的导出名都是合法标识符；兜底跳过非法名（此类名无法被 import 语法引用）。
    if (JS_IDENT_RE.test(k)) lines.push(`export const ${k} = m[${JSON.stringify(k)}];`);
  }
  return lines.join('\n');
}

/**
 * 确保「three → 共享命名空间」的 importmap 已注入（幂等）。
 * 必须在动态 import(storyUrl) **之前**同步调用。
 */
export function ensureThreeImportMap(THREE: object): void {
  if (typeof document === 'undefined') return; // 非 DOM 环境（单测）跳过
  const w = globalThis as Record<string, unknown>;
  w[THREE_SHARED_KEY] = THREE;
  if (document.querySelector('script[data-three-shim="1"]')) return;
  const names = Object.keys(THREE).filter((k) => JS_IDENT_RE.test(k));
  const shimUrl = URL.createObjectURL(
    new Blob([buildThreeShimCode(names)], { type: 'text/javascript' }),
  );
  const el = document.createElement('script');
  el.type = 'importmap';
  el.dataset.threeShim = '1';
  el.textContent = JSON.stringify({ imports: { three: shimUrl } });
  document.head.appendChild(el);
}
