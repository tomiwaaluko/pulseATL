import type { Incident, NpuStats } from "../types.js";
import { MILLIS_PER_DAY } from "./sources.js";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Whole calendar days between two UTC dates — mirrors Snowflake `DATEDIFF('day', ...)`. */
function dayDiff(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((endUtc - startUtc) / MILLIS_PER_DAY);
}

interface NpuBucket {
  current: Incident[];
  all: Incident[];
}

/**
 * TypeScript re-implementation of `computeNpuStats`' Snowflake aggregate
 * (`load.ts`'s `NPU_STATS_SQL`), for the `--no-snowflake` fallback path.
 *
 * Field semantics mirror the SQL exactly: a 180-day window feeds
 * `median_resolution_days` (resolved rows only, `null` when none), a 90-day
 * sub-window feeds `incident_count_90d` / `open_case_count` /
 * `counts_by_category`, and the remainder of the 180-day window feeds
 * `incident_count_prior_90d`.
 */
export function computeLocalNpuStats(incidents: readonly Incident[], now: Date): NpuStats[] {
  const priorCutoff = now.getTime() - 180 * MILLIS_PER_DAY;
  const currentCutoff = now.getTime() - 90 * MILLIS_PER_DAY;

  const byNpu = new Map<string, NpuBucket>();
  for (const incident of incidents) {
    if (incident.occurred_at.getTime() < priorCutoff) continue;
    const bucket = byNpu.get(incident.npu) ?? { current: [], all: [] };
    bucket.all.push(incident);
    if (incident.occurred_at.getTime() >= currentCutoff) bucket.current.push(incident);
    byNpu.set(incident.npu, bucket);
  }

  const stats: NpuStats[] = [];
  for (const [npu, { current, all }] of byNpu) {
    const countsByCategory: Record<string, number> = {};
    for (const incident of current) {
      countsByCategory[incident.category] = (countsByCategory[incident.category] ?? 0) + 1;
    }
    const resolutionDays = all
      .filter((incident): incident is Incident & { resolved_at: Date } => incident.resolved_at !== null)
      .map((incident) => dayDiff(incident.occurred_at, incident.resolved_at));

    stats.push({
      npu,
      incident_count_90d: current.length,
      incident_count_prior_90d: all.length - current.length,
      open_case_count: current.filter((incident) => incident.resolved_at === null).length,
      median_resolution_days: median(resolutionDays),
      counts_by_category: countsByCategory,
    });
  }

  return stats.sort((a, b) => a.npu.localeCompare(b.npu));
}
