import type { CSSProperties } from 'react';

/**
 * 将含 CSS 自定义属性（如 `--hud-accent`）的普通对象安全地转为 React.CSSProperties，
 * 集中处理一次性类型断言，避免在 JSX 里每处写 `as any`（P2-7）。
 */
export function cssVars(vars: Record<string, string | undefined>): CSSProperties {
  return vars as CSSProperties;
}
