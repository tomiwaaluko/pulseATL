import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sfQuery } from "../snowflakeClient.js";
import type { CityMedians, Incident, NpuStats } from "../types.js";

/** Rows per MERGE statement; 500 × 10 binds stays well inside Snowflake limits. */
const MERGE_CHUNK_SIZE = 500;

/** Prefix that marks a narrative as *not* Cortex-generated (ideation §11 fallback). */
export const CORTEX_FALLBACK_PREFIX = "[cortex-unavailable]";

const COLUMNS = [
  "ID",
  "SOURCE",
  "CATEGORY",
  "SUBCATEGORY",
  "OCCURRED_AT",
  "RESOLVED_AT",
  "STATUS",
  "LAT",
  "LON",
  "NPU",
] as const;

const SCHEMA_PATH = join(__dirname, "..", "..", "sql", "schema.sql");

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC — unambiguous for `::TIMESTAMP_NTZ`. */
function toSnowflakeTimestamp(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/** Apply the committed DDL. Idempotent — safe at the start of every ingest. */
export async function ensureSchema(): Promise<void> {
  const statements = readFileSync(SCHEMA_PATH, "utf8")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !/^(--[^\n]*\n?)+$/.test(statement));

  for (const statement of statements) {
    await sfQuery(statement);
  }
}

function mergeStatement(rowCount: number): string {
  const projection = COLUMNS.map((column, index) => {
    const source = `column${index + 1}`;
    if (column === "OCCURRED_AT" || column === "RESOLVED_AT") return `${source}::TIMESTAMP_NTZ AS ${column}`;
    if (column === "LAT" || column === "LON") return `${source}::FLOAT AS ${column}`;
    return `${source}::STRING AS ${column}`;
  }).join(",\n           ");

  const tuples = Array.from({ length: rowCount }, () => `(${COLUMNS.map(() => "?").join(", ")})`).join(",\n           ");
  const updates = COLUMNS.filter((column) => column !== "ID")
    .map((column) => `t.${column} = s.${column}`)
    .join(",\n       ");

  return `MERGE INTO INCIDENTS t
USING (
  SELECT ${projection}
  FROM VALUES ${tuples}
) s
ON t.ID = s.ID
WHEN MATCHED THEN UPDATE SET
       ${updates}
WHEN NOT MATCHED THEN INSERT (${COLUMNS.join(", ")})
  VALUES (${COLUMNS.map((column) => `s.${column}`).join(", ")})`;
}

function bindsFor(rows: Incident[]): unknown[] {
  return rows.flatMap((row) => [
    row.id,
    row.source,
    row.category,
    row.subcategory,
    toSnowflakeTimestamp(row.occurred_at),
    toSnowflakeTimestamp(row.resolved_at),
    row.status,
    row.lat,
    row.lon,
    row.npu,
  ]);
}

/** Snowflake reports MERGE outcomes as `number of rows inserted` / `... updated`. */
function mergedCount(result: unknown[], fallback: number): number {
  const row = result[0];
  if (!row || typeof row !== "object") return fallback;
  const entries = Object.entries(row as Record<string, unknown>);
  const counted = entries
    .filter(([key]) => /^number of rows (inserted|updated)$/i.test(key))
    .map(([, value]) => (typeof value === "number" ? value : Number(value) || 0));
  return counted.length ? counted.reduce((sum, value) => sum + value, 0) : fallback;
}

/** MERGE-upsert canonical incidents keyed on ID. Returns the loaded row count. */
export async function loadIncidents(rows: Incident[]): Promise<number> {
  let loaded = 0;
  for (let offset = 0; offset < rows.length; offset += MERGE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + MERGE_CHUNK_SIZE);
    const result = await sfQuery<Record<string, unknown>>(mergeStatement(chunk.length), bindsFor(chunk));
    loaded += mergedCount(result, chunk.length);
  }
  return loaded;
}

const NPU_STATS_SQL = `WITH recent AS (
  SELECT NPU, CATEGORY, OCCURRED_AT, RESOLVED_AT,
         DATEDIFF('day', OCCURRED_AT, RESOLVED_AT) AS RESOLUTION_DAYS,
         OCCURRED_AT >= DATEADD('day', -90, CURRENT_TIMESTAMP()) AS IS_CURRENT
  FROM INCIDENTS
  WHERE OCCURRED_AT >= DATEADD('day', -180, CURRENT_TIMESTAMP())
),
agg AS (
  SELECT NPU,
         COUNT_IF(IS_CURRENT) AS INCIDENT_COUNT_90D,
         COUNT_IF(NOT IS_CURRENT) AS INCIDENT_COUNT_PRIOR_90D,
         COUNT_IF(IS_CURRENT AND RESOLVED_AT IS NULL) AS OPEN_CASE_COUNT,
         MEDIAN(CASE WHEN RESOLVED_AT IS NOT NULL THEN RESOLUTION_DAYS END) AS MEDIAN_RESOLUTION_DAYS
  FROM recent
  GROUP BY NPU
),
per_category AS (
  SELECT NPU, CATEGORY, COUNT(*) AS N
  FROM recent
  WHERE IS_CURRENT
  GROUP BY NPU, CATEGORY
),
cat AS (
  SELECT NPU, OBJECT_AGG(CATEGORY, N::VARIANT) AS COUNTS_BY_CATEGORY
  FROM per_category
  GROUP BY NPU
)
SELECT agg.NPU AS NPU,
       agg.INCIDENT_COUNT_90D,
       agg.INCIDENT_COUNT_PRIOR_90D,
       agg.OPEN_CASE_COUNT,
       agg.MEDIAN_RESOLUTION_DAYS,
       COALESCE(cat.COUNTS_BY_CATEGORY, OBJECT_CONSTRUCT()) AS COUNTS_BY_CATEGORY
FROM agg
LEFT JOIN cat ON cat.NPU = agg.NPU
ORDER BY agg.NPU`;

interface NpuStatsRow {
  NPU: string;
  INCIDENT_COUNT_90D: number | string | null;
  INCIDENT_COUNT_PRIOR_90D: number | string | null;
  OPEN_CASE_COUNT: number | string | null;
  MEDIAN_RESOLUTION_DAYS: number | string | null;
  COUNTS_BY_CATEGORY: unknown;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Snowflake returns OBJECT_AGG as a VARIANT — a JSON string over the wire. */
function toCategoryCounts(value: unknown): Record<string, number> {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object") return {};
  const counts: Record<string, number> = {};
  for (const [category, count] of Object.entries(source as Record<string, unknown>)) {
    counts[category] = toNumber(count as number | string | null);
  }
  return counts;
}

/**
 * Aggregate stats for **every** NPU in one query — downstream z-scores
 * (`computePulse`) need the full population, not a single NPU's slice.
 */
export async function computeNpuStats(): Promise<NpuStats[]> {
  const rows = await sfQuery<NpuStatsRow>(NPU_STATS_SQL);
  return rows.map((row) => ({
    npu: row.NPU,
    incident_count_90d: toNumber(row.INCIDENT_COUNT_90D),
    incident_count_prior_90d: toNumber(row.INCIDENT_COUNT_PRIOR_90D),
    open_case_count: toNumber(row.OPEN_CASE_COUNT),
    median_resolution_days: toNullableNumber(row.MEDIAN_RESOLUTION_DAYS),
    counts_by_category: toCategoryCounts(row.COUNTS_BY_CATEGORY),
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** City-wide baseline handed to Cortex alongside a single NPU's stats. */
export function cityMedians(allStats: NpuStats[]): CityMedians {
  const resolutionDays = allStats
    .map((item) => item.median_resolution_days)
    .filter((value): value is number => value !== null);

  return {
    incident_count_90d: median(allStats.map((item) => item.incident_count_90d)) ?? 0,
    incident_count_prior_90d: median(allStats.map((item) => item.incident_count_prior_90d)) ?? 0,
    open_case_count: median(allStats.map((item) => item.open_case_count)) ?? 0,
    median_resolution_days: median(resolutionDays),
  };
}

const CORTEX_SQL = `SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2',
  'You are a civic data analyst. Given these NPU stats vs city medians, identify the 2 most significant anomalies or trends in <=80 words, neutral tone: ' || ?) AS findings`;

/**
 * Run the anomaly narrative *inside* Snowflake via CORTEX.COMPLETE.
 *
 * Never throws: a Cortex outage (or a trial account without the function)
 * must not take the whole ingest down, so a clearly-marked fallback string is
 * returned instead and Gemini absorbs the narrative downstream. The fallback
 * deliberately omits the driver error text, which can echo connection details.
 */
export async function cortexFindings(stats: NpuStats, medians: CityMedians): Promise<string> {
  const payload = JSON.stringify({ npu: stats.npu, stats, city_medians: medians });
  try {
    const rows = await sfQuery<{ FINDINGS?: unknown; findings?: unknown }>(CORTEX_SQL, [payload]);
    const raw = rows[0]?.FINDINGS ?? rows[0]?.findings;
    const findings = typeof raw === "string" ? raw.trim() : "";
    if (findings) return findings;
  } catch {
    // fall through to the marked fallback
  }
  return `${CORTEX_FALLBACK_PREFIX} Snowflake Cortex did not return findings for NPU ${stats.npu}; the report narrative falls back to the Gemini summary of the same statistics.`;
}
