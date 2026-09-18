/**
 * 平台适配器动态加载器。
 *
 * 通过 `virtual:toy-platform` 这个 virtual 模块切换实现：
 *  - web 构建：vite.config.ts 把该 virtual 别名到公共占位桩 `adapters/__toy_stub.ts`
 *    （= web 适配器，零 B站代码），web 构建产物永远不含真实 Toy 代码。
 *  - toy 构建：vite.toy.config.ts 把该 virtual 别名到私有 `adapters/toy.ts`
 *    （封装 window.toy），仅私有工作副本中存在，不进入公开仓库。
 *
 * 这样公开仓库（clean-main）始终零 Toy 残留，且 web 构建不会因缺 toy.ts 而失败；
 * Toy 差异收敛在单个 private 文件里，普通版与 Toy 版共享同一套游戏代码。
 */
import type { GamePlatform } from './adapter';

export function getPlatformName(): 'web' | 'toy' {
  const v = import.meta.env.VITE_PLATFORM;
  return v === 'toy' ? 'toy' : 'web';
}

async function loadWeb(): Promise<GamePlatform> {
  const mod = await import('./adapters/web');
  return mod.default;
}

async function loadToy(): Promise<GamePlatform> {
  try {
    // virtual:toy-platform 在 toy 构建指向私有 adapters/toy.ts；在 web 构建指向公共桩。
    const mod = await import('virtual:toy-platform');
    return mod.default;
  } catch {
    console.warn('[platform] toy adapter unavailable, falling back to web');
    return loadWeb();
  }
}

export async function loadPlatform(): Promise<GamePlatform> {
  return getPlatformName() === 'toy' ? loadToy() : loadWeb();
}

let platformPromise: Promise<GamePlatform> | null = null;

/** 获取平台适配器单例（首次调用时异步加载并缓存）。 */
export function getPlatform(): Promise<GamePlatform> {
  if (!platformPromise) platformPromise = loadPlatform();
  return platformPromise;
}
