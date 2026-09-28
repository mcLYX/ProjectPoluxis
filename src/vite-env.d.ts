/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 构建风味：'toy' 走平台适配器与对应构建配置；缺省为 'web'。 */
  readonly VITE_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// virtual:toy-platform 在默认构建指向公共占位桩（adapters/__toy_stub.ts），
// 在平台构建指向私有适配器；二者均实现 GamePlatform 接口。
declare module 'virtual:toy-platform' {
  const platform: import('./platform/adapter').GamePlatform;
  export default platform;
}

// 构建期脚本（如 scripts/exclude-public-content.mjs）以纯 JS 编写、无类型声明，
// 仅供 vite.config.ts 等构建配置 import，运行时由 esbuild/node 直接执行。
declare module '*.mjs' {
  export const excludePublicContent: () => import('vite').Plugin;
}
