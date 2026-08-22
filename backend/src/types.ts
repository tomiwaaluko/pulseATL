export interface Report {
  npu: string;
  pulse_score: number;
  trend: "improving" | "stable" | "worsening";
  stats_json: unknown;
  cortex_findings: string;
  gemini_report: string;
  updated_at: Date;
}

/** A prior turn supplied to the grounded neighborhood chat. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Aggregate values supplied to the LLM clients. */
export interface NpuStats {
  npu: string;
  incident_count_90d: number;
  incident_count_prior_90d: number;
  open_case_count: number;
  median_resolution_days: number | null;
  counts_by_category: Record<string, number>;
}

/**
 * Narrows a cached `stats_json` blob — typed `unknown` because §3 stores it as
 * JSON — to `NpuStats`. Every route that hands cached stats to an LLM client
 * checks here first rather than trusting the cache, so the guard lives beside
 * the interface instead of being re-declared once per route.
 */
export function isNpuStats(value: unknown): value is NpuStats {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const stats = value as Record<string, unknown>;
  return (
    typeof stats.npu === "string" &&
    typeof stats.incident_count_90d === "number" &&
    typeof stats.incident_count_prior_90d === "number" &&
    typeof stats.open_case_count === "number" &&
    (typeof stats.median_resolution_days === "number" || stats.median_resolution_days === null) &&
    typeof stats.counts_by_category === "object" &&
    stats.counts_by_category !== null
  );
}

export type SourceId = "apd_crime" | "atl311";

export type IncidentStatus = "open" | "closed" | "unknown";

/** Canonical row written to the Snowflake INCIDENTS table. */
export interface Incident {
  id: string;
  source: SourceId;
  category: "crime" | "infrastructure";
  subcategory: string | null;
  occurred_at: Date;
  resolved_at: Date | null;
  status: IncidentStatus;
  lat: number | null;
  lon: number | null;
  npu: string;
}

export type Trend = "improving" | "stable" | "worsening";

/** City-wide medians across all NPUs, supplied to Cortex as the comparison baseline. */
export interface CityMedians {
  incident_count_90d: number;
  incident_count_prior_90d: number;
  open_case_count: number;
  median_resolution_days: number | null;
}
