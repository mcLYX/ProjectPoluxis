/**
 * 应用版本号（唯一来源 = package.json 的 `version`）。
 *
 * 构建时由 Vite `define` 注入：
 *  - web 构建：原版本号（见 vite.config.ts）
 *  - toy 构建：追加 `_toy` 后缀（见 vite.toy.config.ts）
 * 其余代码一律消费本常量，不再散落硬编码（如 DocModal）。
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
