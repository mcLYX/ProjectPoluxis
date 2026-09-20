/**
 * 平台适配器动态加载器。
 *
 * 通过 `virtual:toy-platform` 这个 virtual 模块切换实现：
 *  - 默认构建：对应构建配置把该 virtual 别名到公共占位桩 `adapters/__toy_stub.ts`
 *    （= 公开默认适配器，零平台私有代码），构建产物永远不含私有平台代码。
 *  - 平台构建：对应构建配置把该 virtual 别名到私有适配器（封装宿主注入的 SDK），
 *    仅私有工作副本中存在，不进入公开仓库。
 *
 * 这样公开仓库始终零平台私有残留，且默认构建不会因缺私有适配器而失败；
 * 平台差异收敛在单个 private 文件里，各构建风味共享同一套游戏代码。
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
    console.warn('[platform] platform adapter unavailable, falling back to default');
    return loadWeb();
  }
}

/**
 * 当前构建是否具备「平台账号」能力（即非纯 web 的公开版）。
 *
 * 公开版恒为 false。能力差异全部收敛在私有适配器内部，
 * 业务代码只问「有没有平台账号能力」，不出现任何平台专有名词。
 */
export function hasPlatformIdentity(): boolean {
  return getPlatformName() !== 'web';
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
