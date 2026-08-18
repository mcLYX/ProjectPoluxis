/**
 * SSR / 浏览器扩展 / 隐私模式下安全的 localStorage 封装。
 *
 * 某些环境（如 Safari 隐私模式）在「访问 window.localStorage」本身时即抛错，
 * 而非仅在 setItem 时。因此这里用 try/catch 包裹访问，缺失或抛错时静默降级，
 * 避免未守卫的直读导致整页白屏（P2-8）。
 */
function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

export const safeStorage = {
  getItem(key: string): string | null {
    if (!hasLocalStorage()) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    if (!hasLocalStorage()) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota / private mode — 静默忽略 */
    }
  },
  removeItem(key: string): void {
    if (!hasLocalStorage()) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
