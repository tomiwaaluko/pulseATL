import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const getReport = vi.fn();
const getAllReports = vi.fn();
const initSchema = vi.fn();

vi.mock("../src/db", () => ({
  getReport: (...args: unknown[]) => getReport(...args),
  getAllReports: (...args: unknown[]) => getAllReports(...args),
  initSchema: (...args: unknown[]) => initSchema(...args),
}));

const chatAnswer = vi.fn();
const generateReport = vi.fn();

vi.mock("../src/geminiClient", () => ({
  chatAnswer: (...args: unknown[]) => chatAnswer(...args),
  generateReport: (...args: unknown[]) => generateReport(...args),
}));

import { createApp } from "../src/server";
import type { Report } from "../src/types";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    npu: "V",
    pulse_score: 41,
    trend: "worsening",
    stats_json: { median_resolution_days: 50, incident_count_90d: 10 },
    cortex_findings: "Open cases increased.",
    gemini_report: "# NPU V",
    updated_at: new Date("2026-08-12T17:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  getReport.mockReset();
  getAllReports.mockReset();
  initSchema.mockReset();
  chatAnswer.mockReset();
  generateReport.mockReset();
});

describe("GET /api/npus", () => {
  it("returns 200 with the summary shape for every cached npu", async () => {
    getAllReports.mockResolvedValue([
      makeReport({ npu: "A", pulse_score: 72.1, trend: "stable" }),
      makeReport({ npu: "V", pulse_score: 41, trend: "worsening" }),
    ]);

    const res = await request(createApp()).get("/api/npus");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      npus: [
        { npu: "A", pulse_score: 72.1, trend: "stable" },
        { npu: "V", pulse_score: 41, trend: "worsening" },
      ],
    });
  });

  it("returns 503 when the report cache is empty", async () => {
    getAllReports.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/npus");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ detail: "report cache is empty" });
  });
});

describe("GET /api/npus/:npu", () => {
  it("returns the full report for a known npu", async () => {
    getReport.mockResolvedValue(makeReport());

    const res = await request(createApp()).get("/api/npus/V");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      npu: "V",
      pulse_score: 41,
      trend: "worsening",
      stats: { median_resolution_days: 50, incident_count_90d: 10 },
      cortex_findings: "Open cases increased.",
      report_md: "# NPU V",
      updated_at: "2026-08-12T17:00:00.000Z",
    });
    expect(getReport).toHaveBeenCalledWith("V");
  });

  it("returns 404 with {detail: 'unknown npu'} for an unknown npu", async () => {
    getReport.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/npus/ZZ");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "unknown npu" });
  });
});

describe("GET /api/compare", () => {
  it("returns both reports and the computed gap", async () => {
    getReport.mockImplementation(async (npu: string) => {
      if (npu === "V") {
        return makeReport({ npu: "V", pulse_score: 41, stats_json: { median_resolution_days: 50 } });
      }
      if (npu === "B") {
        return makeReport({ npu: "B", pulse_score: 72.2, stats_json: { median_resolution_days: 9 } });
      }
      return null;
    });

    const res = await request(createApp()).get("/api/compare?a=V&b=B");

    expect(res.status).toBe(200);
    expect(res.body.a.npu).toBe("V");
    expect(res.body.b.npu).toBe("B");
    expect(res.body.gap).toEqual({ pulse_gap: 31.2, resolution_days_gap: 41 });
  });

  it("returns 404 when either npu is unknown", async () => {
    getReport.mockImplementation(async (npu: string) => (npu === "V" ? makeReport() : null));

    const res = await request(createApp()).get("/api/compare?a=V&b=ZZ");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "unknown npu" });
  });

  it("returns null resolution_days_gap when either side lacks the stat", async () => {
    getReport.mockImplementation(async (npu: string) =>
      makeReport({
        npu,
        stats_json: npu === "V" ? { median_resolution_days: null } : { median_resolution_days: 9 },
      }),
    );

    const res = await request(createApp()).get("/api/compare?a=V&b=B");

    expect(res.status).toBe(200);
    expect(res.body.gap.resolution_days_gap).toBeNull();
  });

  it("returns 400 when a or b is missing", async () => {
    const res = await request(createApp()).get("/api/compare?a=V");

    expect(res.status).toBe(400);
    expect(getReport).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat", () => {
  const validStats = {
    npu: "V",
    incident_count_90d: 10,
    incident_count_prior_90d: 8,
    open_case_count: 3,
    median_resolution_days: 50,
    counts_by_category: { crime: 6, infrastructure: 4 },
  };

  it("returns a complete answer for a known npu", async () => {
    getReport.mockResolvedValue(makeReport({ stats_json: validStats }));
    chatAnswer.mockResolvedValue("Crime is down 10% over the last 90 days.");

    const res = await request(createApp())
      .post("/api/chat")
      .send({ npu: "V", question: "How is crime trending?", history: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: "Crime is down 10% over the last 90 days.", npu: "V" });
    expect(chatAnswer).toHaveBeenCalledWith("V", "How is crime trending?", [], validStats);
  });

  it("returns 404 for an unknown npu without calling gemini", async () => {
    getReport.mockResolvedValue(null);

    const res = await request(createApp())
      .post("/api/chat")
      .send({ npu: "ZZ", question: "Any updates?", history: [] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "unknown npu" });
    expect(chatAnswer).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty question", async () => {
    const res = await request(createApp())
      .post("/api/chat")
      .send({ npu: "V", question: "", history: [] });

    expect(res.status).toBe(400);
    expect(getReport).not.toHaveBeenCalled();
    expect(chatAnswer).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the cached stats are malformed", async () => {
    getReport.mockResolvedValue(makeReport({ stats_json: { median_resolution_days: 50 } }));

    const res = await request(createApp())
      .post("/api/chat")
      .send({ npu: "V", question: "How is crime trending?", history: [] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "cached stats are malformed" });
    expect(chatAnswer).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the cached stats are null", async () => {
    getReport.mockResolvedValue(makeReport({ stats_json: null }));

    const res = await request(createApp())
      .post("/api/chat")
      .send({ npu: "V", question: "How is crime trending?", history: [] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "cached stats are malformed" });
    expect(chatAnswer).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("returns ok:true with row_count and the latest updated_at when the db is reachable", async () => {
    getAllReports.mockResolvedValue([
      makeReport({ npu: "A", updated_at: new Date("2026-08-12T10:00:00Z") }),
      makeReport({ npu: "B", updated_at: new Date("2026-08-12T17:00:00Z") }),
    ]);

    const res = await request(createApp()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      last_ingest: "2026-08-12T17:00:00.000Z",
      row_count: 2,
    });
  });

  it("degrades to ok:false 200 when the db is unreachable", async () => {
    getAllReports.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await request(createApp()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, last_ingest: null, row_count: 0 });
  });
});

describe("unmatched /api routes", () => {
  it("do not fall through to the SPA static handler", async () => {
    const res = await request(createApp()).get("/api/does-not-exist");

    expect(res.status).not.toBe(200);
  });
});

describe("JSON error-handling middleware", () => {
  it("returns a JSON 500 instead of Express's default HTML error page", async () => {
    getAllReports.mockRejectedValue(new Error("boom"));

    const res = await request(createApp()).get("/api/npus");

    expect(res.status).toBe(500);
    expect(res.type).toBe("application/json");
    expect(res.body).toEqual({ detail: "internal server error" });
  });

  it("does not interfere with existing 404 JSON responses", async () => {
    getReport.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/npus/ZZ");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "unknown npu" });
  });

  it("does not interfere with existing 503 JSON responses", async () => {
    getAllReports.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/npus");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ detail: "report cache is empty" });
  });

  it("does not interfere with the SPA fallback for non-api routes", async () => {
    const res = await request(createApp()).get("/some/frontend/route");

    expect(res.status).not.toBe(500);
  });
});
