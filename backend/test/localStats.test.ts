import { describe, expect, it } from "vitest";

import { computeLocalNpuStats } from "../src/ingest/localStats.js";
import type { Incident } from "../src/types.js";

const NOW = new Date("2026-08-12T16:00:00.000Z");
const DAY = 86_400_000;

let sequence = 0;

function incident(overrides: Partial<Incident>): Incident {
  sequence += 1;
  return {
    id: `test:${sequence}`,
    source: "apd_crime",
    category: "crime",
    subcategory: null,
    occurred_at: new Date(NOW.getTime() - 10 * DAY),
    resolved_at: null,
    status: "open",
    lat: 33.75,
    lon: -84.39,
    npu: "V",
    ...overrides,
  };
}

describe("computeLocalNpuStats", () => {
  it("returns nothing for NPUs with no incidents in the 180-day window", () => {
    expect(computeLocalNpuStats([], NOW)).toEqual([]);
  });

  it("splits incidents into the current (0-90d) and prior (90-180d) windows", () => {
    const rows = [
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 20 * DAY) }),
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 120 * DAY) }),
    ];
    const [stats] = computeLocalNpuStats(rows, NOW);

    expect(stats.npu).toBe("V");
    expect(stats.incident_count_90d).toBe(2);
    expect(stats.incident_count_prior_90d).toBe(1);
  });

  it("excludes incidents older than 180 days entirely", () => {
    const rows = [
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 200 * DAY) }),
    ];
    const [stats] = computeLocalNpuStats(rows, NOW);

    expect(stats.incident_count_90d).toBe(1);
    expect(stats.incident_count_prior_90d).toBe(0);
  });

  it("counts open_case_count only from the current window's unresolved rows", () => {
    const rows = [
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 10 * DAY), resolved_at: null }),
      incident({
        npu: "V",
        occurred_at: new Date(NOW.getTime() - 10 * DAY),
        resolved_at: new Date(NOW.getTime() - 5 * DAY),
      }),
      // Unresolved but in the prior window - must not count as an open case.
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 120 * DAY), resolved_at: null }),
    ];
    const [stats] = computeLocalNpuStats(rows, NOW);

    expect(stats.open_case_count).toBe(1);
  });

  it("returns null (never 0) for median_resolution_days when nothing is resolved", () => {
    const rows = [
      incident({ npu: "V", resolved_at: null }),
      incident({ npu: "V", resolved_at: null }),
    ];
    const [stats] = computeLocalNpuStats(rows, NOW);

    expect(stats.median_resolution_days).toBeNull();
  });

  it("computes median_resolution_days across the whole 180-day window, odd and even counts", () => {
    const base = NOW.getTime() - 100 * DAY;
    const oddRows = [
      incident({ npu: "ODD", occurred_at: new Date(base), resolved_at: new Date(base + 1 * DAY) }),
      incident({ npu: "ODD", occurred_at: new Date(base), resolved_at: new Date(base + 3 * DAY) }),
      incident({ npu: "ODD", occurred_at: new Date(base), resolved_at: new Date(base + 5 * DAY) }),
    ];
    const evenRows = [
      incident({ npu: "EVEN", occurred_at: new Date(base), resolved_at: new Date(base + 2 * DAY) }),
      incident({ npu: "EVEN", occurred_at: new Date(base), resolved_at: new Date(base + 4 * DAY) }),
    ];
    const stats = computeLocalNpuStats([...oddRows, ...evenRows], NOW);

    expect(stats.find((item) => item.npu === "ODD")?.median_resolution_days).toBe(3);
    expect(stats.find((item) => item.npu === "EVEN")?.median_resolution_days).toBe(3);
  });

  it("counts counts_by_category only from the current (90d) window", () => {
    const rows = [
      incident({ npu: "V", category: "crime", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "V", category: "crime", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "V", category: "infrastructure", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      // Prior window - must not be counted.
      incident({ npu: "V", category: "crime", occurred_at: new Date(NOW.getTime() - 120 * DAY) }),
    ];
    const [stats] = computeLocalNpuStats(rows, NOW);

    expect(stats.counts_by_category).toEqual({ crime: 2, infrastructure: 1 });
  });

  it("aggregates multiple NPUs independently and sorts the result by NPU", () => {
    const rows = [
      incident({ npu: "V", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "A", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
      incident({ npu: "A", occurred_at: new Date(NOW.getTime() - 10 * DAY) }),
    ];
    const stats = computeLocalNpuStats(rows, NOW);

    expect(stats.map((item) => item.npu)).toEqual(["A", "V"]);
    expect(stats.find((item) => item.npu === "A")?.incident_count_90d).toBe(2);
    expect(stats.find((item) => item.npu === "V")?.incident_count_90d).toBe(1);
  });
});
