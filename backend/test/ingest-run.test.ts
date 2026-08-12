import { describe, expect, it, vi } from "vitest";

import {
  REPORT_PLACEHOLDER,
  fullNpuStats,
  parseArgs,
  runIngest,
  type IngestDeps,
} from "../src/ingest/run.js";
import { cityMedians } from "../src/ingest/load.js";
import { MILLIS_PER_DAY, SOURCES, listNpus, loadNpuIndex } from "../src/ingest/sources.js";
import type { Incident, NpuStats, Report } from "../src/types.js";

const NOW = new Date("2026-08-12T16:00:00.000Z");
const CORTEX_STUB = "[cortex-unavailable] stubbed findings";

/**
 * Stand-in for the Snowflake aggregate in `load.ts` (this container has no
 * warehouse). It mirrors the SQL's window semantics — 90-day current window,
 * 90–180-day prior window — over the rows the pipeline actually merged.
 */
function aggregate(incidents: Iterable<Incident>, now: Date): NpuStats[] {
  const byNpu = new Map<string, NpuStats>();
  for (const incident of incidents) {
    const age = now.getTime() - incident.occurred_at.getTime();
    if (age < 0 || age > 180 * MILLIS_PER_DAY) continue;
    const stats = byNpu.get(incident.npu) ?? {
      npu: incident.npu,
      incident_count_90d: 0,
      incident_count_prior_90d: 0,
      open_case_count: 0,
      median_resolution_days: null,
      counts_by_category: {},
    };
    if (age <= 90 * MILLIS_PER_DAY) {
      stats.incident_count_90d += 1;
      stats.counts_by_category[incident.category] = (stats.counts_by_category[incident.category] ?? 0) + 1;
      if (!incident.resolved_at) stats.open_case_count += 1;
    } else {
      stats.incident_count_prior_90d += 1;
    }
    byNpu.set(incident.npu, stats);
  }
  return [...byNpu.values()].sort((a, b) => a.npu.localeCompare(b.npu));
}

interface Harness {
  deps: IngestDeps;
  /** MERGE-on-ID emulation: a re-run rewrites rows instead of appending. */
  warehouse: Map<string, Incident>;
  /** Upsert-on-NPU emulation of the Postgres `reports` cache. */
  reports: Map<string, Report>;
  logs: string[];
}

function harness(overrides: Partial<IngestDeps> = {}): Harness {
  const warehouse = new Map<string, Incident>();
  const reports = new Map<string, Report>();
  const logs: string[] = [];

  const deps: IngestDeps = {
    sources: SOURCES,
    npuIndex: loadNpuIndex(),
    npus: listNpus(),
    ensureSchema: vi.fn(async () => {}),
    loadIncidents: vi.fn(async (rows: Incident[]) => {
      for (const row of rows) warehouse.set(row.id, row);
      return rows.length;
    }),
    computeNpuStats: vi.fn(async () => aggregate(warehouse.values(), NOW)),
    cityMedians,
    cortexFindings: vi.fn(async () => CORTEX_STUB),
    generateReport: null,
    initSchema: vi.fn(async () => {}),
    upsertReport: vi.fn(async (report: Report) => {
      reports.set(report.npu, report);
    }),
    now: () => NOW,
    log: (message: string) => logs.push(message),
    ...overrides,
  };

  return { deps, warehouse, reports, logs };
}

describe("parseArgs", () => {
  it("defaults to live sources and enables seed mode with --seed", () => {
    expect(parseArgs([])).toEqual({ seed: false });
    expect(parseArgs(["--seed"])).toEqual({ seed: true });
  });
});

describe("fullNpuStats", () => {
  it("synthesizes zero-count rows so the array always covers all 25 NPUs", () => {
    const observed: NpuStats = {
      npu: "V",
      incident_count_90d: 12,
      incident_count_prior_90d: 4,
      open_case_count: 3,
      median_resolution_days: 2,
      counts_by_category: { crime: 12 },
    };
    const stats = fullNpuStats([observed], listNpus());

    expect(stats.length).toBe(25);
    expect(stats.map((item) => item.npu)).toEqual(listNpus());
    expect(stats.find((item) => item.npu === "V")).toEqual(observed);
    expect(stats.find((item) => item.npu === "A")).toEqual({
      npu: "A",
      incident_count_90d: 0,
      incident_count_prior_90d: 0,
      open_case_count: 0,
      median_resolution_days: null,
      counts_by_category: {},
    });
  });
});

describe("runIngest --seed", () => {
  it("writes a valid report row for every NPU without touching the network", async () => {
    const { deps, reports } = harness();
    const summary = await runIngest(deps, { seed: true });

    expect(summary.seed).toBe(true);
    expect(summary.npusReported).toBe(25);
    expect(reports.size).toBe(25);
    expect([...reports.keys()].sort()).toEqual(listNpus());

    for (const report of reports.values()) {
      expect(Number.isFinite(report.pulse_score)).toBe(true);
      expect(report.pulse_score).toBeGreaterThanOrEqual(0);
      expect(report.pulse_score).toBeLessThanOrEqual(100);
      expect(["improving", "stable", "worsening"]).toContain(report.trend);
      expect(report.cortex_findings).toBe(CORTEX_STUB);
      expect(report.updated_at).toEqual(NOW);
      expect((report.stats_json as NpuStats).npu).toBe(report.npu);
    }
  });

  it("date-shifts the archived fixtures into non-zero 90-day counts for multiple NPUs", async () => {
    const { deps, warehouse, reports } = harness();
    await runIngest(deps, { seed: true });

    const active = [...reports.values()].filter(
      (report) => (report.stats_json as NpuStats).incident_count_90d > 0,
    );
    expect(active.length).toBeGreaterThan(5);

    const newest = Math.max(...[...warehouse.values()].map((row) => row.occurred_at.getTime()));
    expect(NOW.getTime() - newest).toBeLessThan(2 * MILLIS_PER_DAY);
  });

  it("records per-source rejects instead of inventing NPU assignments", async () => {
    const { deps, logs } = harness();
    const summary = await runIngest(deps, { seed: true });

    const apd = summary.sources.find((item) => item.source === "apd_crime");
    const atl311 = summary.sources.find((item) => item.source === "atl311");
    expect(apd?.fetched).toBe(250);
    expect(apd?.normalized).toBeGreaterThan(200);
    // The committed ATL311 export carries no coordinates, so every row is rejected.
    expect(atl311).toEqual({ source: "atl311", fetched: 250, normalized: 0, rejected: 250 });
    expect(logs.some((line) => line.includes("[atl311] 250 rows read, 0 normalized, 250 rejected"))).toBe(true);
  });

  it("writes the placeholder narrative when Gemini is unconfigured", async () => {
    const { deps, reports } = harness();
    const summary = await runIngest(deps, { seed: true });

    expect(summary.geminiReports).toBe(0);
    expect([...reports.values()].every((report) => report.gemini_report === REPORT_PLACEHOLDER)).toBe(true);
  });

  it("uses Gemini when a key is configured and falls back to the placeholder on failure", async () => {
    const generateReport = vi.fn(async (npu: string) =>
      (npu === "A" ? Promise.reject(new Error("quota")) : `Report for ${npu}`));
    const { deps, reports } = harness({ generateReport });
    const summary = await runIngest(deps, { seed: true });

    expect(generateReport).toHaveBeenCalledTimes(25);
    expect(summary.geminiReports).toBe(24);
    expect(reports.get("A")?.gemini_report).toBe(REPORT_PLACEHOLDER);
    expect(reports.get("B")?.gemini_report).toBe("Report for B");
  });

  it("publishes nothing when narrative generation fails part-way through", async () => {
    const cortexFindings = vi.fn(async (stats: NpuStats) =>
      (stats.npu === "M" ? Promise.reject(new Error("cortex down")) : CORTEX_STUB));
    const { deps, reports } = harness({ cortexFindings });

    await expect(runIngest(deps, { seed: true })).rejects.toThrow("cortex down");
    // Reports are generated in full before any are published, so the cache is
    // never left holding half of this generation and half of the previous one.
    expect(reports.size).toBe(0);
  });

  it("is idempotent: a second run rewrites the same rows", async () => {
    const { deps, warehouse, reports } = harness();
    const first = await runIngest(deps, { seed: true });
    const incidentsAfterFirst = warehouse.size;
    const scores = new Map([...reports].map(([npu, report]) => [npu, report.pulse_score]));

    const second = await runIngest(deps, { seed: true });

    expect(warehouse.size).toBe(incidentsAfterFirst);
    expect(reports.size).toBe(25);
    expect(second.incidents).toBe(first.incidents);
    expect(new Map([...reports].map(([npu, report]) => [npu, report.pulse_score]))).toEqual(scores);
  });
});
