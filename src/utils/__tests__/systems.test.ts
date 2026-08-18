import { describe, it, expect } from 'vitest';
import { WORLD_UNITS_PER_SECOND, isWithinBox, noteHitZ, withinHitWindow } from '../../systems/judge';
import { deriveBurstConfig, deriveShatterParticles } from '../../systems/effects';
import { expandRing, type RingPt } from '../../systems/geometry';

describe('systems/judge: noteHitZ（命中瞬间 z）', () => {
  it('基准：dt=0, speed=1 -> 0.05（JUDGE_Z 偏移）', () => {
    expect(noteHitZ(0, 1)).toBeCloseTo(0.05, 6);
  });

  it('早期命中（dt<0）落在判定面之后', () => {
    // dt=-100ms, speed=1: ( -0.1 ) * 36 + 0.05 = -3.55
    expect(noteHitZ(-100, 1)).toBeCloseTo(-3.55, 6);
  });

  it('晚期命中（dt>0）落在判定面之前', () => {
    expect(noteHitZ(100, 2)).toBeCloseTo((0.1) * (36 * 2) + 0.05, 6);
  });

  it('与 WORLD_UNITS_PER_SECOND 常量一致', () => {
    expect(WORLD_UNITS_PER_SECOND).toBe(36);
    expect(noteHitZ(1000, 1)).toBeCloseTo(1 * 36 + 0.05, 6);
  });
});

describe('systems/judge: isWithinBox（轴对齐命中盒）', () => {
  it('中心命中', () => {
    expect(isWithinBox(0.1, -0.2, 0, 0, 1.2)).toBe(true);
  });
  it('边界外（严格小于 half）', () => {
    expect(isWithinBox(1.2, 0, 0, 0, 1.2)).toBe(false);
    expect(isWithinBox(1.19, 0, 0, 0, 1.2)).toBe(true);
  });
  it('两轴任一越界即不命中', () => {
    expect(isWithinBox(0.5, 2, 0, 0, 1.2)).toBe(false);
  });
});

describe('systems/judge: withinHitWindow', () => {
  it('窗口内含端点', () => {
    expect(withinHitWindow(160, 160)).toBe(true);
    expect(withinHitWindow(-160, 160)).toBe(true);
  });
  it('窗口外', () => {
    expect(withinHitWindow(161, 160)).toBe(false);
  });
});

describe('systems/effects: deriveBurstConfig', () => {
  it('S-Perfect -> 橙色 + scale 1.2 + 时长 300', () => {
    const c = deriveBurstConfig('S-Perfect', 'tap', 0.8);
    expect(c.colorHex).toBe('#ff8c00');
    expect(c.scaleTarget).toBe(1.2);
    expect(c.duration).toBe(300);
    expect(c.baseScale).toBe(0.8);
    expect(c.ringKind).toBe('tap');
  });
  it('touch/slide 映射到对应 ring', () => {
    expect(deriveBurstConfig('Perfect', 'touch', 1).ringKind).toBe('touch');
    expect(deriveBurstConfig('Good', 'slide', 1).ringKind).toBe('slide');
  });
});

describe('systems/effects: deriveShatterParticles（确定性 rng）', () => {
  const seq = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  let i = 0;
  const rng = () => seq[i++ % seq.length];

  it('返回 90 个粒子、时长 500、颜色直传', () => {
    const r = deriveShatterParticles({ nt: 'tap', angle: 0, x: 1, y: 2, z: 0.05, visualScale: 1, speed: 1, noteColorHex: '#abcdef', rng });
    expect(r.count).toBe(90);
    expect(r.duration).toBe(500);
    expect(r.colorHex).toBe('#abcdef');
    expect(r.positions.length).toBe(90 * 3);
    expect(r.velocities.length).toBe(90 * 3);
  });

  it('tap 方形采样：角点应在中心 ±baseHalf 内', () => {
    // rng=0.5 -> tap 局部 (0,0)，旋转 0 -> 位置即 (x,y,z)。
    const r = deriveShatterParticles({ nt: 'tap', angle: 0, x: 3, y: -4, z: 0.05, visualScale: 1, speed: 1, noteColorHex: '#fff', rng });
    expect(r.positions[0]).toBeCloseTo(3, 6);
    expect(r.positions[1]).toBeCloseTo(-4, 6);
    expect(r.positions[2]).toBeCloseTo(0.05, 6);
  });

  it('default rng 生成 Finite 数值', () => {
    const r = deriveShatterParticles({ nt: 'touch', angle: 0.3, x: 0, y: 0, z: 0, visualScale: 0.7, speed: 2, noteColorHex: '#123456' });
    for (let k = 0; k < r.positions.length; k++) expect(Number.isFinite(r.positions[k])).toBe(true);
    for (let k = 0; k < r.velocities.length; k++) expect(Number.isFinite(r.velocities[k])).toBe(true);
  });
});

describe('systems/geometry: expandRing（描边加粗）', () => {
  it('菱形环按 max 半径外扩 width', () => {
    const ring: RingPt[] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    // maxR = 1, width = 0.5 -> 缩放 (1.5/1)=1.5
    const out = expandRing(ring, 0.5);
    expect(out).toEqual([
      [0, -1.5],
      [1.5, 0],
      [0, 1.5],
      [-1.5, 0],
    ]);
  });

  it('零半径环原样返回', () => {
    const ring: RingPt[] = [[0, 0]];
    expect(expandRing(ring, 0.5)).toEqual([[0, 0]]);
  });
});
