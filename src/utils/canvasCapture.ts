/**
 * 轻量画布截图注册表。
 *
 * GameCanvas 在挂载时把截图函数注册进来；App / SongCard 通过 `captureGameCanvas()`
 * 抓取当前游戏画面，而无需静态 import 整个 3D 模块（避免把 three.js 拉入首屏包、
 * 也避免与 GameCanvas 的懒加载产生重复打包）。
 */
let capturer: (() => string | null) | null = null;

/** GameCanvas 挂载时注册，卸载时置 null。 */
export function setCanvasCapturer(fn: (() => string | null) | null): void {
  capturer = fn;
}

/** 抓取当前游戏画面（PNG dataURL），无可用渲染上下文时返回 null。 */
export function captureGameCanvas(): string | null {
  return capturer ? capturer() : null;
}
