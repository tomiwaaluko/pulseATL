import { Pool } from "pg";
import { getConfig } from "./config";
import type { Report } from "./types";

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: getConfig().DATABASE_URL });
  return pool;
}

const createReportsTable = `
  CREATE TABLE IF NOT EXISTS reports (
    npu TEXT PRIMARY KEY,
    pulse_score REAL NOT NULL,
    trend TEXT NOT NULL,
    stats_json JSONB NOT NULL,
    cortex_findings TEXT NOT NULL,
    gemini_report TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const reportColumns = `
  npu, pulse_score, trend, stats_json, cortex_findings, gemini_report, updated_at
`;

export async function initSchema(): Promise<void> {
  await getPool().query(createReportsTable);
}

export async function getReport(npu: string): Promise<Report | null> {
  const result = await getPool().query<Report>(
    `SELECT ${reportColumns} FROM reports WHERE npu = $1`,
    [npu.toUpperCase()],
  );
  return result.rows[0] ?? null;
}

export async function getAllReports(): Promise<Report[]> {
  const result = await getPool().query<Report>(
    `SELECT ${reportColumns} FROM reports ORDER BY npu`,
  );
  return result.rows;
}

export async function upsertReport(report: Report): Promise<void> {
  await getPool().query(
    `INSERT INTO reports (${reportColumns})
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (npu) DO UPDATE SET
       pulse_score = EXCLUDED.pulse_score,
       trend = EXCLUDED.trend,
       stats_json = EXCLUDED.stats_json,
       cortex_findings = EXCLUDED.cortex_findings,
       gemini_report = EXCLUDED.gemini_report,
       updated_at = EXCLUDED.updated_at`,
    [
      report.npu,
      report.pulse_score,
      report.trend,
      JSON.stringify(report.stats_json),
      report.cortex_findings,
      report.gemini_report,
      report.updated_at,
    ],
  );
}
