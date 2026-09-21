import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { JudgementType } from '../types/game';
import { JUDGEMENT_COLORS } from '../utils/scoring';
import { clamp } from '../utils/math';

export interface TimingMarker {
  id: string;
  dt: number; // ms, negative = early, positive = late
  type: JudgementType;
}

/** marker 存活时长（ms），与下方 timingMarkerAnim(1.15s) 对齐。 */
const MARKER_LIFETIME_MS = 1150;
/** 同时保留的最大 marker 数（超出丢弃最旧的）。 */
const MAX_MARKERS = 24;

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
  const clamped = clamp(m.dt, -RANGE_MS, RANGE_MS);
  return ((clamped + RANGE_MS) / (RANGE_MS * 2)) * 100;
}

/**
 * 命令式接口：判定回传经 ref 调用 `push`，marker 的生命周期（截断 / 到期清理）
 * 全部封在本组件内部。
 *
 * 为什么从「props 传入 markers 数组」改成命令式：
 *  - 原实现由 App 持有 `timingMarkers` state，每次判定回传 setTimingMarkers 都会
 *    触发 **App 全树重渲染**（与 setStats 同一轮），是完整版 2D 比 Lite 更耗电的
 *    主要原因之一；
 *  - 改为组件内部 state 后，每 ~33ms 的重渲染被限制在**本组件这一小段子树**，
 *    App 不再参与。视觉表现完全不变。
 */
export interface TimingBarHandle {
  push(marker: TimingMarker): void;
}

interface TimingBarProps {
  accentColor?: string;
}

export const TimingBar = forwardRef<TimingBarHandle, TimingBarProps>(function TimingBar(_props, ref) {
  const [markers, setMarkers] = useState<TimingMarker[]>([]);
  const cleanTimerRef = useRef<number | null>(null);

  /** 移除全部到期 marker（任意时刻至多一个清理 timer）。 */
  const prune = useCallback(() => {
    cleanTimerRef.current = null;
    const now = performance.now();
    setMarkers((prev) => prev.filter((m) => (m as TimingMarker & { expiresAt: number }).expiresAt > now));
  }, []);

  const push = useCallback(
    (marker: TimingMarker) => {
      (marker as TimingMarker & { expiresAt: number }).expiresAt = performance.now() + MARKER_LIFETIME_MS;
      setMarkers((prev) => [...prev.slice(-(MAX_MARKERS - 1)), marker]);
      if (cleanTimerRef.current === null) {
        cleanTimerRef.current = window.setTimeout(prune, MARKER_LIFETIME_MS);
      }
    },
    [prune]
  );

  useImperativeHandle(ref, () => ({ push }), [push]);

  useEffect(
    () => () => {
      if (cleanTimerRef.current !== null) window.clearTimeout(cleanTimerRef.current);
    },
    []
  );

  return (
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
});
