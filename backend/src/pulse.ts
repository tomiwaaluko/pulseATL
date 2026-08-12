import type { NpuStats, Trend } from "./types";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function zScore(value: number, values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  return deviation === 0 ? 0 : (value - mean) / deviation;
}

function trendDelta(stats: NpuStats): number {
  if (stats.incident_count_prior_90d === 0) return stats.incident_count_90d === 0 ? 0 : 1;
  return (stats.incident_count_90d - stats.incident_count_prior_90d) / stats.incident_count_prior_90d;
}

function trendFor(delta: number): Trend {
  if (delta <= -0.1) return "improving";
  if (delta >= 0.1) return "worsening";
  return "stable";
}

/**
 * Compute a stable 0–100 pulse score; 50 = city average, higher is healthier.
 *
 * Design-spec §4 reconciliation (reviewed in PR #7): the spec's literal text
 * clamps the raw weighted z-composite to [0, 100-scale], which degenerates —
 * z-composites live in roughly [-2, 2], so nearly every NPU would peg at ~100.
 * We keep §4's substance (weights 0.5 incident-rate z + 0.3 trend z +
 * 0.2 resolution z, z-scored across all NPUs, deterministic) and map the
 * composite onto the 0–100 scale as score = clamp(50 - 10·riskZ, 0, 100):
 * demo-explainable as "50 is city average; ~10 points per standard deviation".
 */
export function computePulse(stats: NpuStats, allStats: NpuStats[]): { score: number; trend: Trend } {
  const comparison = allStats.length ? allStats : [stats];
  const deltas = comparison.map(trendDelta);
  const openDays = comparison.map((item) => item.median_resolution_days ?? 0);
  const riskZ = 0.5 * zScore(stats.incident_count_90d, comparison.map((item) => item.incident_count_90d))
    + 0.3 * zScore(trendDelta(stats), deltas)
    + 0.2 * zScore(stats.median_resolution_days ?? 0, openDays);
  const score = Math.round(clamp(100 - (50 + 10 * riskZ), 0, 100) * 10) / 10;
  return { score, trend: trendFor(trendDelta(stats)) };
}
