import { Router } from "express";
import { z } from "zod";

import { getReport } from "../db";
import { chatAnswer } from "../geminiClient";
import { isNpuStats } from "../types";

const chatBodySchema = z.object({
  npu: z.string().min(1),
  question: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});

export const chatRouter = Router();

chatRouter.post("/", async (req, res, next) => {
  try {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ detail: "npu and question are required" });
      return;
    }
    const { npu, question, history } = parsed.data;

    const report = await getReport(npu);
    if (!report) {
      res.status(404).json({ detail: "unknown npu" });
      return;
    }

    if (!isNpuStats(report.stats_json)) {
      res.status(500).json({ detail: "cached stats are malformed" });
      return;
    }

    const answer = await chatAnswer(report.npu, question, history, report.stats_json);
    res.status(200).json({ answer, npu: report.npu });
  } catch (err) {
    next(err);
  }
});
