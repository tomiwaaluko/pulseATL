import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const runIngest = vi.fn();
const defaultDeps = vi.fn(() => ({}));

vi.mock("../src/ingest/run", () => ({
  runIngest: (...args: unknown[]) => runIngest(...args),
  defaultDeps: (...args: unknown[]) => defaultDeps(...args),
}));

import { createApp } from "../src/server";

const SUMMARY_STUB = {
  seed: true,
  sources: [
    { source: "atl311", fetched: 10, normalized: 8, rejected: 2 },
    { source: "crime", fetched: 15, normalized: 15, rejected: 0 },
  ],
  incidents: 23,
  incidentsLoaded: 23,
  npusReported: 25,
  geminiReports: 25,
};

const ORIGINAL_TOKEN = process.env.INGEST_TOKEN;

beforeEach(() => {
  runIngest.mockReset();
  defaultDeps.mockClear();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.INGEST_TOKEN;
  else process.env.INGEST_TOKEN = ORIGINAL_TOKEN;
});

describe("GET /api/admin/ingest", () => {
  it("returns 404 when INGEST_TOKEN is unset", async () => {
    delete process.env.INGEST_TOKEN;

    const res = await request(createApp()).get("/api/admin/ingest?token=anything");

    expect(res.status).toBe(404);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("returns 404 when INGEST_TOKEN is set to an empty string", async () => {
    process.env.INGEST_TOKEN = "";

    const res = await request(createApp()).get("/api/admin/ingest?token=");

    expect(res.status).toBe(404);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("returns 401 when the token does not match", async () => {
    process.env.INGEST_TOKEN = "correct-token";

    const res = await request(createApp()).get("/api/admin/ingest?token=wrong-token");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "unauthorized" });
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("returns 401 when no token query param is supplied", async () => {
    process.env.INGEST_TOKEN = "correct-token";

    const res = await request(createApp()).get("/api/admin/ingest");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "unauthorized" });
  });

  it("runs the seed ingest and returns the summary shape when the token matches", async () => {
    process.env.INGEST_TOKEN = "correct-token";
    runIngest.mockResolvedValue(SUMMARY_STUB);

    const res = await request(createApp()).get("/api/admin/ingest?token=correct-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      reports_written: 25,
      normalized: 23,
      rejected: 2,
      duration_ms: expect.any(Number),
    });
    expect(runIngest).toHaveBeenCalledWith(expect.anything(), { seed: true });
  });

  it("returns 500 with a redacted error when the ingest run throws", async () => {
    process.env.INGEST_TOKEN = "correct-token";
    runIngest.mockRejectedValue(new Error("connect failed for postgres://user:hunter2@db.internal:5432/pulse"));

    const res = await request(createApp()).get("/api/admin/ingest?token=correct-token");

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).not.toContain("hunter2");
    expect(res.body.error).not.toContain("user:hunter2@db.internal");
  });

  it("returns 409 when a run is already in flight", async () => {
    process.env.INGEST_TOKEN = "correct-token";
    runIngest.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(SUMMARY_STUB), 20)),
    );

    const app = createApp();
    const [first, second] = await Promise.all([
      request(app).get("/api/admin/ingest?token=correct-token"),
      request(app).get("/api/admin/ingest?token=correct-token"),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const conflict = first.status === 409 ? first : second;
    expect(conflict.body).toEqual({ detail: "ingest already running" });
  });
});
