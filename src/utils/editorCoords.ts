import { NOTE_X_RANGE, NOTE_Y_RANGE } from '../types/game';
import { clamp } from './math';

/**
 * 编辑器坐标夹取 —— 判定面范围内**唯一**的权威实现。
 *
 * 此前「坐标 clamp」散在 5 份手写副本里（3D 视口放置 / 2D lite 视口放置与拖拽 /
 * 钢琴卷帘放置·单拖·批量·Y 调整），且分别用 `THREE.MathUtils.clamp`、
 * `Math.max/min`、`utils/math.clamp` 三种写法，存在漂移风险。现全部收敛到这里
 * （连同 `editorRules.sanitizeDslResult` 的 DSL 出口夹取）。
 *
 * 语义：坐标以**显示参考系**为准（= 存储 base + 该音符时刻的图层合成偏移），夹到
 * ±NOTE_X_RANGE / ±NOTE_Y_RANGE。带图层偏移时 base 可合法越界，故一律先换算到
 * 显示坐标再夹、必要时再换回 base。
 *
 * 注意：**不含** 0.1 / round9 取整——各调用点取整口径不同（0.1 vs round9，夹在
 * base 前或后），保持现状不动，以免产生数值行为变更。
 */

/** 夹取**显示坐标**到 ±range。 */
export function clampPlane(v: number, range: number): number {
  return clamp(v, -range, range);
}

/** 夹取**显示坐标** X 到 ±NOTE_X_RANGE。 */
export function clampPlaneX(x: number): number {
  return clampPlane(x, NOTE_X_RANGE);
}

/** 夹取**显示坐标** Y 到 ±NOTE_Y_RANGE。 */
export function clampPlaneY(y: number): number {
  return clampPlane(y, NOTE_Y_RANGE);
}

/** 夹取**显示坐标**并换算回存储坐标 base（offset = 该音符时刻图层偏移）。 */
export function clampDisplayToBaseX(displayX: number, offsetX: number): number {
  return clampPlaneX(displayX) - offsetX;
}

/** 同 {@link clampDisplayToBaseX}，Y 轴。 */
export function clampDisplayToBaseY(displayY: number, offsetY: number): number {
  return clampPlaneY(displayY) - offsetY;
}

/**
 * 按**屏幕坐标**取反一个坐标分量（用于批量 FlipX/FlipY）。
 *
 * 屏幕 = base + offset，取反后 新屏幕 = −旧屏幕，再反解回 base：
 *   base' = −旧屏幕 − offset = **−base − 2·offset**。
 * 不夹范围（带偏移时 base 可合法越界）。对同一 offset 连续两次取反即还原。
 */
export function flipBaseAlongScreen(base: number, offset: number): number {
  return -base - 2 * offset;
}
