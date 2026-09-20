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
