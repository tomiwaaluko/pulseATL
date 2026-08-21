import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sfQuery } = vi.hoisted(() => ({ sfQuery: vi.fn() }));

vi.mock("../src/snowflakeClient.js", () => ({ sfQuery }));

import {
  CORTEX_FALLBACK_PREFIX,
  CORTEX_MODEL_CANDIDATES,
  cityMedians,
  computeNpuStats,
  cortexFindings,
  resetCortexModel,
  ensureSchema,
  loadIncidents,
} from "../src/ingest/load.js";
import type { CityMedians, Incident, NpuStats } from "../src/types.js";

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "apd_crime:1",
    source: "apd_crime",
    category: "crime",
    subcategory: "LARCENY",
    occurred_at: new Date("2026-05-01T12:30:00.000Z"),
    resolved_at: null,
    status: "open",
    lat: 33.75,
    lon: -84.39,
    npu: "V",
    ...overrides,
  };
}

const stats: NpuStats = {
  npu: "V",
  incident_count_90d: 42,
  incident_count_prior_90d: 30,
  open_case_count: 8,
  median_resolution_days: 12,
  counts_by_category: { crime: 20, infrastructure: 22 },
};

const medians: CityMedians = {
  incident_count_90d: 25,
  incident_count_prior_90d: 24,
  open_case_count: 4,
  median_resolution_days: 9,
};

describe("ensureSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sfQuery.mockResolvedValue([]);
  });

  it("runs the committed INCIDENTS DDL", async () => {
    await ensureSchema();

    const statements = sfQuery.mock.calls.map((call) => call[0] as string);
    const ddl = statements.join("\n");
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS INCIDENTS/i);
    expect(ddl).toMatch(/OCCURRED_AT\s+TIMESTAMP_NTZ NOT NULL/i);
    expect(ddl).toMatch(/NPU\s+STRING NOT NULL/i);
    expect(statements.every((sql) => !sql.trim().endsWith(";;"))).toBe(true);
  });
});

describe("loadIncidents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sfQuery.mockResolvedValue([]);
  });

  it("upserts with a MERGE keyed on ID and returns the loaded count", async () => {
    sfQuery.mockResolvedValue([{ "number of rows inserted": 1, "number of rows updated": 1 }]);

    const count = await loadIncidents([incident(), incident({ id: "atl311:2", source: "atl311" })]);

    expect(count).toBe(2);
    expect(sfQuery).toHaveBeenCalledTimes(1);
    const [sql, binds] = sfQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/MERGE INTO INCIDENTS/i);
    expect(sql).toMatch(/ON\s+t\.ID = s\.ID/i);
    expect(sql).toMatch(/WHEN MATCHED THEN UPDATE/i);
    expect(sql).toMatch(/WHEN NOT MATCHED THEN INSERT/i);
    expect(binds).toHaveLength(20);
    expect(binds[0]).toBe("apd_crime:1");
  });

  it("binds timestamps as Snowflake-parsable UTC strings and nulls as null", async () => {
    await loadIncidents([incident({ resolved_at: null, lat: null, lon: null, subcategory: null })]);

    const binds = sfQuery.mock.calls[0][1] as unknown[];
    expect(binds).toContain("2026-05-01 12:30:00.000");
    expect(binds[3]).toBeNull();
    expect(binds[5]).toBeNull();
    expect(binds[7]).toBeNull();
    expect(binds[8]).toBeNull();
  });

  it("chunks large batches into multiple MERGE statements", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => incident({ id: `apd_crime:${index}` }));

    const count = await loadIncidents(rows);

    expect(count).toBe(1200);
    expect(sfQuery).toHaveBeenCalledTimes(3);
  });

  it("is a no-op for an empty batch", async () => {
    await expect(loadIncidents([])).resolves.toBe(0);
    expect(sfQuery).not.toHaveBeenCalled();
  });

  it("falls back to the batch size when the driver omits MERGE counters", async () => {
    sfQuery.mockResolvedValue([]);

    await expect(loadIncidents([incident()])).resolves.toBe(1);
  });
});

describe("computeNpuStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns every NPU's stats in one array from a single aggregate query", async () => {
    sfQuery.mockResolvedValue([
      {
        NPU: "B",
        INCIDENT_COUNT_90D: 10,
        INCIDENT_COUNT_PRIOR_90D: 12,
        OPEN_CASE_COUNT: 2,
        MEDIAN_RESOLUTION_DAYS: 3.5,
        COUNTS_BY_CATEGORY: '{"crime":6,"infrastructure":4}',
      },
      {
        NPU: "V",
        INCIDENT_COUNT_90D: 42,
        INCIDENT_COUNT_PRIOR_90D: 30,
        OPEN_CASE_COUNT: 8,
        MEDIAN_RESOLUTION_DAYS: null,
        COUNTS_BY_CATEGORY: { crime: 20, infrastructure: 22 },
      },
    ]);

    const result = await computeNpuStats();

    expect(sfQuery).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      npu: "B",
      incident_count_90d: 10,
      incident_count_prior_90d: 12,
      open_case_count: 2,
      median_resolution_days: 3.5,
      counts_by_category: { crime: 6, infrastructure: 4 },
    });
    expect(result[1].median_resolution_days).toBeNull();
    expect(result[1].counts_by_category).toEqual({ crime: 20, infrastructure: 22 });
  });

  it("queries a 90d window against the prior 90d window", async () => {
    sfQuery.mockResolvedValue([]);

    await computeNpuStats();

    const sql = sfQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/-90/);
    expect(sql).toMatch(/-180/);
    expect(sql).toMatch(/MEDIAN/i);
    expect(sql).toMatch(/OBJECT_AGG/i);
    expect(sql).toMatch(/GROUP BY/i);
  });

  it("tolerates unparsable category payloads", async () => {
    sfQuery.mockResolvedValue([
      {
        NPU: "A",
        INCIDENT_COUNT_90D: 0,
        INCIDENT_COUNT_PRIOR_90D: 0,
        OPEN_CASE_COUNT: 0,
        MEDIAN_RESOLUTION_DAYS: null,
        COUNTS_BY_CATEGORY: "not-json",
      },
    ]);

    const result = await computeNpuStats();

    expect(result[0].counts_by_category).toEqual({});
  });
});

describe("cityMedians", () => {
  it("computes the median of each metric across NPUs", () => {
    const result = cityMedians([
      { ...stats, npu: "A", incident_count_90d: 10, open_case_count: 1, median_resolution_days: 2 },
      { ...stats, npu: "B", incident_count_90d: 20, open_case_count: 3, median_resolution_days: 4 },
      { ...stats, npu: "C", incident_count_90d: 30, open_case_count: 5, median_resolution_days: 9 },
    ]);

    expect(result.incident_count_90d).toBe(20);
    expect(result.open_case_count).toBe(3);
    expect(result.median_resolution_days).toBe(4);
  });

  it("ignores NPUs with no resolution data and reports null when none resolve", () => {
    expect(
      cityMedians([{ ...stats, median_resolution_days: null }]).median_resolution_days,
    ).toBeNull();
  });

  it("returns zeroed medians for an empty population", () => {
    expect(cityMedians([])).toEqual({
      incident_count_90d: 0,
      incident_count_prior_90d: 0,
      open_case_count: 0,
      median_resolution_days: null,
    });
  });
});

describe("cortexFindings", () => {
  const ORIGINAL_MODEL = process.env.SNOWFLAKE_CORTEX_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCortexModel();
    delete process.env.SNOWFLAKE_CORTEX_MODEL;
  });

  afterEach(() => {
    if (ORIGINAL_MODEL === undefined) delete process.env.SNOWFLAKE_CORTEX_MODEL;
    else process.env.SNOWFLAKE_CORTEX_MODEL = ORIGINAL_MODEL;
  });

  it("runs CORTEX.COMPLETE inside Snowflake with the first candidate model and the locked prompt", async () => {
    sfQuery.mockResolvedValue([{ FINDINGS: "Blight cases rose 40% against a flat city median." }]);

    const result = await cortexFindings(stats, medians);

    expect(result).toBe("Blight cases rose 40% against a flat city median.");
    const [sql, binds] = sfQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`SNOWFLAKE.CORTEX.COMPLETE('${CORTEX_MODEL_CANDIDATES[0]}'`);
    expect(sql).toContain("You are a civic data analyst.");
    expect(sql).toMatch(/2 most significant anomalies or trends in <=80 words, neutral tone/);
    expect(sql).toMatch(/AS findings/);
    expect(binds).toHaveLength(1);
    const payload = JSON.parse(binds[0] as string);
    expect(payload).toEqual({ npu: "V", stats, city_medians: medians });
  });

  it("falls through to the next candidate when a model is retired", async () => {
    // The real failure: Cortex answers 400 "has been in legacy state".
    sfQuery
      .mockRejectedValueOnce(new Error("The model mistral-large2 has been in legacy state"))
      .mockResolvedValueOnce([{ FINDINGS: "Second model answered." }]);

    const result = await cortexFindings(stats, medians);

    expect(result).toBe("Second model answered.");
    expect(sfQuery).toHaveBeenCalledTimes(2);
    expect(sfQuery.mock.calls[1][0]).toContain(`'${CORTEX_MODEL_CANDIDATES[1]}'`);
  });

  it("reuses the model that worked instead of retrying the dead ones", async () => {
    sfQuery
      .mockRejectedValueOnce(new Error("legacy state"))
      .mockResolvedValue([{ FINDINGS: "ok" }]);

    await cortexFindings(stats, medians);
    const afterFirst = sfQuery.mock.calls.length;
    await cortexFindings(stats, medians);

    // One extra call, not another walk down the candidate list.
    expect(sfQuery.mock.calls.length).toBe(afterFirst + 1);
    expect(sfQuery.mock.calls[afterFirst][0]).toContain(`'${CORTEX_MODEL_CANDIDATES[1]}'`);
  });

  it("honours SNOWFLAKE_CORTEX_MODEL exactly, without substituting a candidate", async () => {
    process.env.SNOWFLAKE_CORTEX_MODEL = "llama3.1-8b";
    sfQuery.mockRejectedValue(new Error("nope"));

    const result = await cortexFindings(stats, medians);

    expect(sfQuery).toHaveBeenCalledTimes(1);
    expect(sfQuery.mock.calls[0][0]).toContain("'llama3.1-8b'");
    expect(result).toContain(CORTEX_FALLBACK_PREFIX);
  });

  it("refuses a model name that is not a plain identifier", async () => {
    process.env.SNOWFLAKE_CORTEX_MODEL = "x', 'injected";
    sfQuery.mockResolvedValue([{ FINDINGS: "should not be reached" }]);

    const result = await cortexFindings(stats, medians);

    expect(sfQuery).not.toHaveBeenCalled();
    expect(result).toContain(CORTEX_FALLBACK_PREFIX);
  });

  it("returns a clearly-marked fallback instead of throwing when Cortex fails", async () => {
    sfQuery.mockRejectedValue(new Error("Unknown function CORTEX.COMPLETE"));

    const result = await cortexFindings(stats, medians);

    expect(result.startsWith(CORTEX_FALLBACK_PREFIX)).toBe(true);
    expect(result).toContain("V");
  });

  it("returns the fallback when Cortex responds with no findings text", async () => {
    sfQuery.mockResolvedValue([{ FINDINGS: null }]);

    await expect(cortexFindings(stats, medians)).resolves.toContain(CORTEX_FALLBACK_PREFIX);
  });

  it("never leaks credential values into the fallback message", async () => {
    process.env.SNOWFLAKE_PASSWORD = "super-secret";
    sfQuery.mockRejectedValue(new Error("auth failed for super-secret"));

    const result = await cortexFindings(stats, medians);

    expect(result).not.toContain("super-secret");
  });
});

describe("ensureSchema namespace bootstrap", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    sfQuery.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("creates and selects the configured database and schema before the DDL", async () => {
    process.env.SNOWFLAKE_DATABASE = "pulse";
    process.env.SNOWFLAKE_SCHEMA = "public";
    await ensureSchema();

    const statements = sfQuery.mock.calls.map((call) => call[0] as string);
    expect(statements.slice(0, 4)).toEqual([
      "CREATE DATABASE IF NOT EXISTS PULSE",
      "USE DATABASE PULSE",
      "CREATE SCHEMA IF NOT EXISTS PUBLIC",
      "USE SCHEMA PUBLIC",
    ]);
    // The table DDL must still run, after the namespace exists.
    expect(statements.join("\n")).toMatch(/CREATE TABLE IF NOT EXISTS INCIDENTS/i);
  });

  it("is a no-op when no database is configured", async () => {
    delete process.env.SNOWFLAKE_DATABASE;
    await ensureSchema();

    const statements = sfQuery.mock.calls.map((call) => call[0] as string);
    expect(statements.some((sql) => /CREATE DATABASE/i.test(sql))).toBe(false);
  });

  it("rejects an unsafe database identifier instead of interpolating it", async () => {
    process.env.SNOWFLAKE_DATABASE = "pulse; DROP DATABASE prod";
    await expect(ensureSchema()).rejects.toThrow(/Unsafe Snowflake identifier/);
  });
});
