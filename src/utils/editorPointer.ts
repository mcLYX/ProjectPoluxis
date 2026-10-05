/**
 * 编辑器「右键 = 取消选中」的判定（§编辑器输入）。
 *
 * 交互约定：在**单选 / 音符放置工具**下，鼠标右键单击画布任意处（含音符本体上）
 * 视为「取消选中当前音符」，同时由各画布拦掉浏览器上下文菜单。
 * 触屏与中键不参与（`button` 恒为 0 的触摸事件不受影响）。
 *
 * 抽成纯函数以便单测，并让 3D / 2D / Lite 三条画布路径共用同一判据
 * （Editor2DCanvas / GameCanvas / GameCanvas2D 各自只负责拦 contextmenu）。
 */

/** 鼠标按键值（PointerEvent/MouseEvent.button）。 */
export const RIGHT_BUTTON = 2;

/**
 * 参与「右键取消选中」的工具：单选 + 三个音符放置工具。
 *
 * `quick-create` 刻意排除：它是按住拖动手势（快速制谱），右键在其中无实义，
 * 且可能被当作手势起点，误清选中反而打断输入节奏。
 */
export function isRightClickDeselectTool(tool: string | null | undefined): boolean {
  return tool === 'select' || tool === 'place-tap' || tool === 'place-touch' || tool === 'place-slide';
}

/** 这次 pointerdown 是否应按「右键取消选中」处理。 */
export function shouldDeselectOnRightClick(
  button: number,
  isEditorMode: boolean,
  tool: string | null | undefined,
): boolean {
  return isEditorMode && button === RIGHT_BUTTON && isRightClickDeselectTool(tool);
}
