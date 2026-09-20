/**
 * 把头像引用解析成可直接用于 `<img src>` 的地址。
 *
 * - `idb://…` → 先取 idb 模块的对象 URL 缓存，再 `resolveIdbUrl()`（缓存由 idb 模块统一管理，
 *   此处不 revoke，避免其它消费方拿到失效 URL）。
 * - `http(s)://…`（平台账号提供的远端头像）→ 直接使用。
 * - 空值 → null（由 UI 渲染占位图标）。
 */
import { useEffect, useState } from 'react';
import { getCachedIdbUrl, resolveIdbUrl } from '../data/idb';

const IDB_PREFIX = 'idb://';

export function useAvatarUrl(ref: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) {
      setUrl(null);
      return;
    }
    // 远端地址（平台账号提供）直接可用。
    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      setUrl(ref);
      return;
    }
    if (!ref.startsWith(IDB_PREFIX)) {
      setUrl(null);
      return;
    }
    const fileId = ref.slice(IDB_PREFIX.length);
    const cached = getCachedIdbUrl(fileId);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    resolveIdbUrl(ref)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ref]);

  return url;
}
