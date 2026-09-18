/**
 * 平台 React Context：在应用挂载时异步加载当前平台适配器，并通过 hook 暴露。
 *
 * `platformName` 是同步可得的（直接读 `import.meta.env.VITE_PLATFORM`），
 * 因此 UI 可在适配器加载完成前就按平台做条件渲染；`platform` 为异步加载结果，
 * `ready` 表示适配器已就绪。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { GamePlatform } from './adapter';
import { getPlatform, getPlatformName } from './index';

interface PlatformContextValue {
  platform: GamePlatform | null;
  platformName: 'web' | 'toy';
  ready: boolean;
}

const PlatformContext = createContext<PlatformContextValue>({
  platform: null,
  platformName: 'web',
  ready: false,
});

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [platform, setPlatform] = useState<GamePlatform | null>(null);
  const platformName = getPlatformName();

  useEffect(() => {
    let cancelled = false;
    getPlatform().then((p) => {
      if (!cancelled) setPlatform(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PlatformContext.Provider value={{ platform, platformName, ready: !!platform }}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  return useContext(PlatformContext);
}
