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
