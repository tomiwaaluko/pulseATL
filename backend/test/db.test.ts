import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ query })),
}));

import { getAllReports, getReport, initSchema, upsertReport } from "../src/db";
import type { Report } from "../src/types";

const report: Report = {
  npu: "V",
  pulse_score: 41,
  trend: "worsening",
  stats_json: { open_cases: 12 },
  cortex_findings: "Open cases increased.",
  gemini_report: "# NPU V",
  updated_at: new Date("2026-08-12T17:00:00Z"),
};

describe("report cache", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://localhost/pulse";
    query.mockReset();
  });

  it("initializes the schema idempotently", async () => {
    query.mockResolvedValue({ rows: [] });

    await initSchema();
    await initSchema();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS reports");
    expect(query.mock.calls[1][0]).toContain("CREATE TABLE IF NOT EXISTS reports");
  });

  it("gets one report by NPU", async () => {
    query.mockResolvedValue({ rows: [report] });

    await expect(getReport("v")).resolves.toEqual(report);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE npu = $1"), ["V"]);
  });

  it("returns null when a report is absent", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(getReport("Z")).resolves.toBeNull();
  });

  it("gets every report in NPU order", async () => {
    query.mockResolvedValue({ rows: [report] });
    await expect(getAllReports()).resolves.toEqual([report]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY npu"));
  });

  it("upserts a report", async () => {
    query.mockResolvedValue({ rows: [] });
    await upsertReport(report);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (npu) DO UPDATE"),
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
  });
});
