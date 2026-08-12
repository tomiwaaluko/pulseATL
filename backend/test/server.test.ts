import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server";

describe("GET /healthz", () => {
  it("returns 200 ok status", async () => {
    const app = createApp();
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
