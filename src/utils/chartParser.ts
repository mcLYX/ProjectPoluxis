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
  let out: any = chart;
  // 「单根图层的导出与旧格式逐字兼容」的另一半保证：
  //  - 没有显式图层 → 一个字段都不加（连 schemaVersion 也不写），保证旧谱导出逐字一致；
  //  - 有显式图层 → 标记为 v2；
  //  - layers 是空数组 → 直接剥掉，不留无意义的键。
  if (Array.isArray(chart.layers) && chart.layers.length > 0) {
    out = { ...chart, metadata: { ...chart.metadata, schemaVersion: 'v2' } };
  } else if (Array.isArray(chart.layers)) {
    out = { ...chart };
    delete out.layers;
  }
  return JSON.stringify(out, null, 2);
}
