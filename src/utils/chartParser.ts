import type { ChartData } from '../types/game';
import { parseAndValidateChart as sharedParseAndValidateChart } from '../shared/chartSchema';

/**
 * Validation result returned by parseAndValidateChart.
 * `chart` is present only when `valid` is true.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  /**
   * 非致命问题的说明。谱面仍然可用（已用缺省值修补或丢弃了坏数据），
   * 仅用于提示作者，不影响 valid。
   */
  warnings?: string[];
  chart?: ChartData;
}

/**
 * Tolerant chart parse/validate. The actual rule set lives in
 * src/shared/chartSchema.ts so the full app and the Lite build share ONE
 * implementation (editing it updates both). This module only re-casts the shared
 * result into the typed ChartData shape the rest of the app expects.
 */
export function parseAndValidateChart(input: string | unknown): ValidationResult {
  const r = sharedParseAndValidateChart(input);
  return {
    valid: r.valid,
    error: r.error,
    warnings: r.warnings,
    chart: r.chart as ChartData | undefined,
  };
}

export function exportChartJson(chart: ChartData): string {
  return JSON.stringify(chart, null, 2);
}
