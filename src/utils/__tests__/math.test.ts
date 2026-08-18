import { describe, it, expect } from 'vitest';
import { EASING_FNS, easingTangentAngles, EASING_TYPES } from '../easing';
import { getScrollDistance } from '../beatTime';
import { NOTE_X_RANGE, NOTE_Y_RANGE } from '../../types/game';

describe('坐标常量（P1-1 统一源）', () => {
  it('NOTE_X_RANGE / NOTE_Y_RANGE 为既定边界', () => {
    expect(NOTE_X_RANGE).toBe(2.4);
    expect(NOTE_Y_RANGE).toBe(1.5);
  });
});

describe('EASING_FNS 边界与单调性', () => {
  for (const type of EASING_TYPES) {
    it(`${type}: f(0)=0, f(1)=1`, () => {
      expect(EASING_FNS[type](0)).toBeCloseTo(0, 6);
      expect(EASING_FNS[type](1)).toBeCloseTo(1, 6);
    });
  }

  it('linear 恒等', () => {
    expect(EASING_FNS.linear(0.37)).toBeCloseTo(0.37, 6);
  });

  it('sine-in 起点慢、终点快', () => {
    expect(EASING_FNS['sine-in'](0.5)).toBeLessThan(0.5);
    expect(EASING_FNS['sine-in'](0.5)).toBeGreaterThan(0);
  });
});

describe('easingTangentAngles', () => {
  it('linear 两端无偏转', () => {
    expect(easingTangentAngles('linear')).toEqual({ start: 0, end: 0 });
  });
  it('sine-io 两端均垂直', () => {
    const HALF_PI = Math.PI / 2;
    expect(easingTangentAngles('sine-io')).toEqual({ start: HALF_PI, end: HALF_PI });
  });
});

describe('getScrollDistance（纯滚动距离积分）', () => {
  it('无速度点时距离等于时间', () => {
    expect(getScrollDistance(3, [])).toBeCloseTo(3, 6);
  });

  it('单速度点：分段积分正确', () => {
    // 0~2s 速度 1，2~5s 速度 2 → 前 2s 走 2 单位，后 3s 走 6 单位，合计 8。
    const points = [{ timeSec: 2, speed: 2 }];
    expect(getScrollDistance(5, points)).toBeCloseTo(8, 6);
  });
});
