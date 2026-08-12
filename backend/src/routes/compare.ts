import { Router } from "express";
import { z } from "zod";

import { getReport } from "../db";
import { serializeReport } from "./npus";

const compareQuerySchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
});

function roundTo1dp(value: number): number {
  return Math.round(value * 10) / 10;
}

function medianResolutionDays(stats: unknown): number | null {
  if (typeof stats !== "object" || stats === null || !("median_resolution_days" in stats)) {
    return null;
  }
  const value = (stats as { median_resolution_days: unknown }).median_resolution_days;
  return typeof value === "number" ? value : null;
}

export const compareRouter = Router();

compareRouter.get("/", async (req, res, next) => {
  try {
    const parsed = compareQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ detail: "query params 'a' and 'b' are required" });
      return;
    }
    const { a, b } = parsed.data;
    const [reportA, reportB] = await Promise.all([getReport(a), getReport(b)]);
    if (!reportA || !reportB) {
      res.status(404).json({ detail: "unknown npu" });
      return;
    }

    const medianA = medianResolutionDays(reportA.stats_json);
    const medianB = medianResolutionDays(reportB.stats_json);
    const resolution_days_gap =
      medianA === null || medianB === null ? null : roundTo1dp(Math.abs(medianA - medianB));

    res.status(200).json({
      a: serializeReport(reportA),
      b: serializeReport(reportB),
      gap: {
        pulse_gap: roundTo1dp(Math.abs(reportA.pulse_score - reportB.pulse_score)),
        resolution_days_gap,
      },
    });
  } catch (err) {
    next(err);
  }
});
