import { Router } from "express";

import { getAllReports, getReport } from "../db";
import type { Report } from "../types";

export interface FullReport {
  npu: string;
  pulse_score: number;
  trend: Report["trend"];
  stats: unknown;
  cortex_findings: string;
  report_md: string;
  updated_at: string;
}

export function serializeReport(report: Report): FullReport {
  return {
    npu: report.npu,
    pulse_score: report.pulse_score,
    trend: report.trend,
    stats: report.stats_json,
    cortex_findings: report.cortex_findings,
    report_md: report.gemini_report,
    updated_at:
      report.updated_at instanceof Date
        ? report.updated_at.toISOString()
        : (report.updated_at as unknown as string),
  };
}

export const npusRouter = Router();

npusRouter.get("/", async (_req, res, next) => {
  try {
    const reports = await getAllReports();
    if (reports.length === 0) {
      res.status(503).json({ detail: "report cache is empty" });
      return;
    }
    res.status(200).json({
      npus: reports.map((report) => ({
        npu: report.npu,
        pulse_score: report.pulse_score,
        trend: report.trend,
      })),
    });
  } catch (err) {
    next(err);
  }
});

npusRouter.get("/:npu", async (req, res, next) => {
  try {
    const report = await getReport(req.params.npu);
    if (!report) {
      res.status(404).json({ detail: "unknown npu" });
      return;
    }
    res.status(200).json(serializeReport(report));
  } catch (err) {
    next(err);
  }
});
