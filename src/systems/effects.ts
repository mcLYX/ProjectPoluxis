import type { JudgementType, NoteType } from '../types/game';
import { JUDGEMENT_COLORS } from '../utils/scoring';
import { WORLD_UNITS_PER_SECOND } from './judge';

// 特效尺寸常量（与 GameCanvas 中 note 视觉尺寸同源，集中到此供粒子几何复用）。
const TAP_SIZE = 1.6;
const TOUCH_SIZE = TAP_SIZE * 0.707;
const SLIDE_SIZE = TAP_SIZE * 0.707;
const SLIDE_HALF = (SLIDE_SIZE * Math.SQRT2) / 2;

/** 打击特效框的纯参数推导结果（不含任何 THREE 对象，便于单测）。 */
export interface BurstConfig {
  /** 判定等级对应的染色 hex。 */
  colorHex: string;
  /** 相对缩放动画倍率（S-Perfect 1.2 / Perfect 1.1 / Good 1.05）。 */
  scaleTarget: number;
  /** 特效时长（ms）。 */
  duration: number;
  /** 基础缩放（= noteSizeScale）。 */
  baseScale: number;
  /** 默认外观（无皮肤贴图）时使用的环形种类。 */
  ringKind: 'tap' | 'touch' | 'slide';
}

/**
 * 由判定等级 + 音符类型 + 视觉缩放推导打击特效框参数。
 * 等价替换 spawnBurst 中对 JUDGEMENT_COLORS[j].hex / .scale / 300 / visualScale 的内联取用。
 */
export function deriveBurstConfig(j: JudgementType, nt: NoteType, visualScale: number): BurstConfig {
  const cfg = JUDGEMENT_COLORS[j];
  const ringKind: BurstConfig['ringKind'] = nt === 'tap' ? 'tap' : nt === 'touch' ? 'touch' : 'slide';
  return { colorHex: cfg.hex, scaleTarget: cfg.scale, duration: 300, baseScale: visualScale, ringKind };
}

/** 碎裂粒子初始分布的输入参数。 */
export interface ShatterParams {
  nt: NoteType;
  /** 音符角度（弧度，已含符号约定）。 */
  angle: number;
  x: number;
  y: number;
  z: number;
  visualScale: number;
  speed: number;
  /** 粒子颜色 hex（note 颜色，优先于判定色）。 */
  noteColorHex: string;
  /** 可注入随机数发生器（默认 Math.random），便于确定性单测。 */
  rng?: () => number;
}

/** 碎裂粒子初始分布结果（纯数值，不含 THREE 对象）。 */
export interface ShatterResult {
  positions: Float32Array;
  velocities: Float32Array;
  count: number;
  colorHex: string;
  duration: number;
}

/**
 * 由音符形状 + 角度 + 速度推导碎裂粒子的初始位置/速度分布。
 * 严格等价原 spawnBurst 中 `if (allowHitEffects && j !== 'Miss')` 内的粒子生成逻辑：
 * - 初始位置采样自音符自身形状（tap 方形 / touch 圆形 / slide 菱形），再按角度旋转。
 * - 速度 = 从中心缓慢外漂 + 基础 z 速度（≈9 + noteSpeed*0.1，含 6% 随机散布）。
 */
export function deriveShatterParticles(params: ShatterParams): ShatterResult {
  const { nt, angle, x, y, z, visualScale, speed, noteColorHex } = params;
  const rng = params.rng ?? Math.random;
  const PCOUNT = 90;
  const pos = new Float32Array(PCOUNT * 3);
  const vel = new Float32Array(PCOUNT * 3);
  const vScale = visualScale;
  const baseHalf = (nt === 'touch' ? TOUCH_SIZE / 2 : TAP_SIZE / 2) * vScale;
  const slideHalf = SLIDE_HALF * vScale;
  const noteSpeed = WORLD_UNITS_PER_SECOND * speed;
  const zSpeedBase = 9 + noteSpeed * 0.1;
  const zSpeedRange = noteSpeed * 0.06;
  const rot = -(angle ?? 0);
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  for (let i = 0; i < PCOUNT; i++) {
    let lx: number;
    let ly: number;
    if (nt === 'tap') {
      lx = (rng() * 2 - 1) * baseHalf;
      ly = (rng() * 2 - 1) * baseHalf;
    } else if (nt === 'touch') {
      const r = Math.sqrt(rng()) * baseHalf;
      const a = rng() * Math.PI * 2;
      lx = Math.cos(a) * r;
      ly = Math.sin(a) * r;
    } else {
      const sx = (rng() * 2 - 1) * (slideHalf / Math.SQRT2);
      const sy = (rng() * 2 - 1) * (slideHalf / Math.SQRT2);
      lx = (sx - sy) * Math.SQRT1_2;
      ly = (sx + sy) * Math.SQRT1_2;
    }
    const rx = lx * cosR - ly * sinR;
    const ry = lx * sinR + ly * cosR;
    pos[i * 3] = x + rx;
    pos[i * 3 + 1] = y + ry;
    pos[i * 3 + 2] = z;
    const dlen = Math.hypot(rx, ry) || 1;
    const driftSpeed = 0.4 + rng() * 0.5;
    vel[i * 3] = (rx / dlen) * driftSpeed + (rng() - 0.5) * 0.15;
    vel[i * 3 + 1] = (ry / dlen) * driftSpeed + (rng() - 0.5) * 0.15;
    vel[i * 3 + 2] = zSpeedBase + rng() * zSpeedRange;
  }
  return { positions: pos, velocities: vel, count: PCOUNT, colorHex: noteColorHex, duration: 500 };
}
