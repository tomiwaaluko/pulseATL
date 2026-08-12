import { describe, expect, it } from "vitest";
import { computePulse } from "../src/pulse";
import type { NpuStats } from "../src/types";

function stats(npu: string, current: number, prior: number, days: number | null): NpuStats {
  return {
    npu,
    incident_count_90d: current,
    incident_count_prior_90d: prior,
    open_case_count: 0,
    median_resolution_days: days,
    counts_by_category: {},
  };
}

describe("computePulse", () => {
  it("gives higher-risk NPUs a lower score and classifies trends", () => {
    const all = [stats("A", 5, 10, 2), stats("B", 10, 10, 10), stats("C", 30, 10, 30)];
    const healthy = computePulse(all[0], all);
    const unhealthy = computePulse(all[2], all);
    expect(healthy.score).toBeGreaterThan(unhealthy.score);
    expect(healthy.trend).toBe("improving");
    expect(unhealthy.trend).toBe("worsening");
  });

  it("is deterministic when every comparison value is identical", () => {
    const all = [stats("A", 10, 10, 5), stats("B", 10, 10, 5)];
    expect(computePulse(all[0], all)).toEqual({ score: 50, trend: "stable" });
    expect(computePulse(all[0], all)).toEqual(computePulse(all[0], all));
  });

  it("handles an empty NPU comparison set and null resolution median", () => {
    expect(computePulse(stats("A", 0, 0, null), [])).toEqual({ score: 50, trend: "stable" });
  });

  it("treats a first nonzero reporting period as worsening", () => {
    expect(computePulse(stats("A", 1, 0, 1), []).trend).toBe("worsening");
  });
});
