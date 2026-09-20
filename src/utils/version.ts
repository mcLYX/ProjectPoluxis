/**
 * 应用版本号（唯一来源 = package.json 的 `version`）。
 *
 * 构建时由 Vite `define` 注入：
 *  - 默认构建：原版本号（见对应构建配置）
 *  - 平台构建：追加对应风味后缀（见对应构建配置）
 * 其余代码一律消费本常量，不再散落硬编码（如 DocModal）。
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
