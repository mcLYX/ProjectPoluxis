import type { ChartData } from '../types/game';
import { DEMO_CHARTS as SHARED_DEMO_CHARTS } from '../shared/demoCharts';

/**
 * Built-in demo charts for the full app.
 *
 * The data is the single source of truth in src/shared/demoCharts.ts (also
 * inlined into the Lite build by scripts/build-lite.mjs). We re-export it here
 * so existing import paths (`from './demoCharts'` / `'../data/demoCharts'`)
 * keep working and the values are typed as Record<string, ChartData>.
 */
export const DEMO_CHARTS: Record<string, ChartData> =
  SHARED_DEMO_CHARTS as unknown as Record<string, ChartData>;
