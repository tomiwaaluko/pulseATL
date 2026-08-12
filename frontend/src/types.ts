/**
 * Mirrors the FROZEN API contract in docs/pulse-atl-design-spec.md §5.
 * Any change here requires updating backend/src/routes/* in the same PR.
 */

/** `trend` column of the Postgres `reports` cache (design spec §3). */
export type Trend = "improving" | "stable" | "worsening";

/**
 * Aggregates precomputed in Snowflake and cached as `stats_json` (§4).
 * The contract pins the field name, not the interior shape, so this stays an
 * open record — consumers must narrow before use rather than assume keys.
 */
export interface NpuStats {
  [key: string]: unknown;
}

/** Element of `GET /api/npus` → `{"npus":[...]}`. */
export interface NpuSummary {
  npu: string;
  pulse_score: number;
  trend: Trend;
}

/** `GET /api/npus` → 200 */
export interface NpuListResponse {
  npus: NpuSummary[];
}

/** `GET /api/npus/{npu}` → 200 */
export interface NpuDetail {
  npu: string;
  pulse_score: number;
  trend: Trend;
  stats: NpuStats;
  cortex_findings: string;
  report_md: string;
  updated_at: string;
}

/** Non-2xx body, e.g. `GET /api/npus/{npu}` → 404 `{"detail":"unknown npu"}`. */
export interface ApiErrorBody {
  detail: string;
}

/**
 * `gap` block of `GET /api/compare`. `resolution_days_gap` is null when either
 * NPU's `stats_json` carries no `median_resolution_days` to difference.
 */
export interface CompareGap {
  pulse_gap: number;
  resolution_days_gap: number | null;
}

/** `GET /api/compare?a=V&b=B` → 200 */
export interface CompareResponse {
  a: NpuDetail;
  b: NpuDetail;
  gap: CompareGap;
}

/** Turn in the `history` array of `POST /api/chat`. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** `POST /api/chat` request body. */
export interface ChatRequest {
  npu: string;
  question: string;
  history: ChatMessage[];
}

/** `POST /api/chat` → 200 (complete answer; streaming not required). */
export interface ChatResponse {
  answer: string;
  npu: string;
}

/** `GET /api/health` → 200. `last_ingest` is null before the first ingest. */
export interface HealthResponse {
  ok: boolean;
  last_ingest: string | null;
  row_count: number;
}
