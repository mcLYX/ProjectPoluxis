import React from 'react';
import { JudgementType } from '../types/game';
import { JUDGEMENT_COLORS } from '../utils/scoring';

export interface TimingMarker {
  id: string;
  dt: number; // ms, negative = early, positive = late
  type: JudgementType;
}

/** Full scale of the bar: ±240ms. Zone lengths mirror the judgement windows. */
const RANGE_MS = 240;

/**
 * ADOFAI-style accuracy bar:
 * 红(Miss >160) - 蓝(Good 80~160) - 黄(Perfect 40~80) - 橙(S-Perfect <40, 0ms at exact center)
 * - 黄 - 蓝 - 红, mirrored for late side. Each zone length ∝ its time range.
 * Miss markers pin to the far right.
 */
const BAR_GRADIENT = `linear-gradient(90deg,
  #ef4444 0%, #ef4444 8%,
  #38bdf8 16.7%, #38bdf8 26%,
  #ffd700 33.3%, #ffd700 37%,
  #ff8c00 44%, #ff8c00 56%,
  #ffd700 63%, #ffd700 66.7%,
  #38bdf8 74%, #38bdf8 83.3%,
  #ef4444 92%, #ef4444 100%)`;

function markerPercent(m: TimingMarker): number {
  if (m.type === 'Miss') return 100; // miss appears at the far right end
  const clamped = Math.max(-RANGE_MS, Math.min(RANGE_MS, m.dt));
  return ((clamped + RANGE_MS) / (RANGE_MS * 2)) * 100;
}

export const TimingBar: React.FC<{ markers: TimingMarker[]; accentColor?: string }> = ({ markers }) => (
  <div className="relative w-full h-3">
    {/* Rainbow gradient track */}
    <div
      className="absolute inset-0 rounded-sm opacity-90"
      style={{ background: BAR_GRADIENT }}
    />
    {/* 0ms center tick (dead center of the orange S-Perfect zone) */}
    <div className="absolute w-px bg-white/60" style={{ left: '50%', top: -3, bottom: -3 }} />
    {/* Boundary ticks at ±40ms and ±80ms */}
    {[41.67, 58.33, 33.33, 66.67].map((p) => (
      <div key={p} className="absolute w-px bg-white/25" style={{ left: `${p}%`, top: -2, bottom: -2 }} />
    ))}

    {/* Judgement marker dots — early left, late right, miss far right */}
    <div className="absolute inset-y-0 left-2 right-2">
      {markers.map((m) => {
        const color = JUDGEMENT_COLORS[m.type].hex;
        return (
          <div key={m.id} className="absolute top-1/2" style={{ left: `${markerPercent(m)}%` }}>
            <div
              className="w-3.5 h-3.5 rounded-full border-2 border-white/85"
              style={{
                backgroundColor: color,
                boxShadow: `0 0 10px ${color}, 0 0 22px ${color}`,
                animation: 'timingMarkerAnim 1.15s ease-out forwards',
              }}
            />
          </div>
        );
      })}
    </div>
  </div>
);
