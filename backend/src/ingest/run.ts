import { initSchema, upsertReport } from "../db.js";
import { generateReport } from "../geminiClient.js";
import { computePulse } from "../pulse.js";
import { closeSnowflake } from "../snowflakeClient.js";
import type { CityMedians, Incident, NpuStats, Report, SourceId } from "../types.js";
import { cityMedians, computeNpuStats, cortexFindings, ensureSchema, loadIncidents } from "./load.js";
import { normalizeRecord, type NpuIndex } from "./normalize.js";
import {
  SOURCES,
  listNpus,
  loadNpuIndex,
  shiftIncidentsToRecent,
  type RawRecord,
  type SourceDefinition,
} from "./sources.js";

/** Written to `reports.gemini_report` when no Gemini key is configured (never a fake report). */
export const REPORT_PLACEHOLDER = "[report pending]";

export interface IngestOptions {
  /** Read committed fixtures instead of the live portals, and date-shift them. */
  seed: boolean;
}

export interface SourceOutcome {
  source: SourceId;
  fetched: number;
  normalized: number;
  rejected: number;
}

export interface IngestSummary {
  seed: boolean;
  sources: SourceOutcome[];
  incidents: number;
  incidentsLoaded: number;
  npusReported: number;
  geminiReports: number;
}

/**
 * Everything the pipeline touches outside its own process. Snowflake, Postgres
 * and Gemini all arrive through here so the pipeline can be exercised offline.
 */
export interface IngestDeps {
  sources: readonly SourceDefinition[];
  npuIndex: NpuIndex;
  npus: string[];
  ensureSchema(): Promise<void>;
  loadIncidents(rows: Incident[]): Promise<number>;
  computeNpuStats(): Promise<NpuStats[]>;
  cityMedians(allStats: NpuStats[]): CityMedians;
  cortexFindings(stats: NpuStats, medians: CityMedians): Promise<string>;
  /** `null` when GEMINI_API_KEY is absent — the report column gets the placeholder. */
  generateReport: ((npu: string, stats: NpuStats, findings: string) => Promise<string>) | null;
  initSchema(): Promise<void>;
  upsertReport(report: Report): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export function parseArgs(argv: readonly string[]): IngestOptions {
  return { seed: argv.includes("--seed") };
}

/**
 * Guarantee a stats row for every NPU in the boundary layer. `computeNpuStats`
 * only returns NPUs that have incidents, but §4's z-scores are defined over the
 * whole city and every NPU needs a report row, so quiet NPUs get an explicit
 * zero-count entry rather than being dropped.
 */
export function fullNpuStats(stats: readonly NpuStats[], npus: readonly string[]): NpuStats[] {
  const observed = new Map(stats.map((item) => [item.npu.toUpperCase(), item]));
  return [...npus].sort().map((npu) => observed.get(npu.toUpperCase()) ?? {
    npu,
    incident_count_90d: 0,
    incident_count_prior_90d: 0,
    open_case_count: 0,
    median_resolution_days: null,
    counts_by_category: {},
  });
}

function readSource(source: SourceDefinition, seed: boolean): Promise<RawRecord[]> {
  return seed ? Promise.resolve(source.readFixture()) : source.fetchLive();
}

async function collectIncidents(deps: IngestDeps, options: IngestOptions): Promise<{
  incidents: Incident[];
  outcomes: SourceOutcome[];
}> {
  const incidents: Incident[] = [];
  const outcomes: SourceOutcome[] = [];

  for (const source of deps.sources) {
    const raw = await readSource(source, options.seed);
    const normalized = raw
      .map((row) => normalizeRecord(row, source.id, deps.npuIndex))
      .filter((incident): incident is Incident => incident !== null);
    const shifted = options.seed ? shiftIncidentsToRecent(normalized, deps.now()) : normalized;
    outcomes.push({
      source: source.id,
      fetched: raw.length,
      normalized: shifted.length,
      rejected: raw.length - shifted.length,
    });
    // Rejections are expected (ATL311 rows without coordinates cannot be joined
    // to an NPU); they are reported, never patched with invented values.
    deps.log(
      `[${source.id}] ${raw.length} rows read, ${shifted.length} normalized, `
      + `${raw.length - shifted.length} rejected (unusable id/date/coordinates)`,
    );
    incidents.push(...shifted);
  }

  return { incidents, outcomes };
}

async function reportNarrative(deps: IngestDeps, stats: NpuStats, findings: string): Promise<string> {
  if (!deps.generateReport) return REPORT_PLACEHOLDER;
  try {
    return await deps.generateReport(stats.npu, stats, findings);
  } catch (error) {
    deps.log(`[gemini] NPU ${stats.npu} report unavailable (${(error as Error).name}); wrote placeholder`);
    return REPORT_PLACEHOLDER;
  }
}

/**
 * fetch → normalize → load → aggregate → score → narrate → cache.
 *
 * Re-running is safe: incidents MERGE on ID and reports upsert on NPU, so a
 * second run rewrites the same 25 rows instead of appending.
 */
export async function runIngest(deps: IngestDeps, options: IngestOptions): Promise<IngestSummary> {
  deps.log(`[ingest] starting (${options.seed ? "seed fixtures" : "live sources"})`);
  const { incidents, outcomes } = await collectIncidents(deps, options);

  await deps.ensureSchema();
  const incidentsLoaded = await deps.loadIncidents(incidents);
  deps.log(`[ingest] ${incidentsLoaded} incident rows merged into Snowflake`);

  const stats = fullNpuStats(await deps.computeNpuStats(), deps.npus);
  const medians = deps.cityMedians(stats);
  await deps.initSchema();

  let geminiReports = 0;
  const updatedAt = deps.now();
  for (const npuStats of stats) {
    const { score, trend } = computePulse(npuStats, stats);
    const findings = await deps.cortexFindings(npuStats, medians);
    const gemini = await reportNarrative(deps, npuStats, findings);
    if (gemini !== REPORT_PLACEHOLDER) geminiReports += 1;
    await deps.upsertReport({
      npu: npuStats.npu,
      pulse_score: score,
      trend,
      stats_json: npuStats,
      cortex_findings: findings,
      gemini_report: gemini,
      updated_at: updatedAt,
    });
  }
  deps.log(`[ingest] wrote ${stats.length} report rows (${geminiReports} Gemini narratives)`);

  return {
    seed: options.seed,
    sources: outcomes,
    incidents: incidents.length,
    incidentsLoaded,
    npusReported: stats.length,
    geminiReports,
  };
}

/** Real Snowflake + Postgres + Gemini wiring. Gemini is skipped when unkeyed. */
export function defaultDeps(): IngestDeps {
  return {
    sources: SOURCES,
    npuIndex: loadNpuIndex(),
    npus: listNpus(),
    ensureSchema,
    loadIncidents,
    computeNpuStats,
    cityMedians,
    cortexFindings,
    generateReport: process.env.GEMINI_API_KEY ? generateReport : null,
    initSchema,
    upsertReport,
    now: () => new Date(),
    log: (message) => console.log(message),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    const summary = await runIngest(defaultDeps(), options);
    console.log(`[ingest] done: ${JSON.stringify(summary)}`);
  } finally {
    await closeSnowflake();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`[ingest] failed: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
