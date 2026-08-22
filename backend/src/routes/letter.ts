import { Router } from "express";
import { z } from "zod";

import { getReport } from "../db";
import { draftLetter } from "../geminiClient";
import { isNpuStats } from "../types";

const letterBodySchema = z.object({
  npu: z.string().min(1),
});

export const letterRouter = Router();

letterRouter.post("/", async (req, res, next) => {
  try {
    const parsed = letterBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ detail: "npu is required" });
      return;
    }
    const { npu } = parsed.data;

    const report = await getReport(npu);
    if (!report) {
      res.status(404).json({ detail: "unknown npu" });
      return;
    }

    // The draft may only cite numbers that survived this guard: an unverified
    // stats blob would let the model quote whatever shape the cache happens to
    // hold, which is exactly the invented statistic this route must not emit.
    if (!isNpuStats(report.stats_json)) {
      res.status(500).json({ detail: "cached stats are malformed" });
      return;
    }

    const letter = await draftLetter(report.npu, report.stats_json, report.gemini_report);
    res.status(200).json({ letter, npu: report.npu });
  } catch (err) {
    next(err);
  }
});
