import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("requires a valid Postgres URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it("returns the validated environment", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://localhost/pulse" })).toEqual({
      DATABASE_URL: "postgresql://localhost/pulse",
    });
  });
});
