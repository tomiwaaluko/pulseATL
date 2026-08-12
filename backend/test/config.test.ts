import { describe, expect, it } from "vitest";
import { hasSnowflakeConfig, loadConfig, loadSnowflakeConfig } from "../src/config";

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

const SNOWFLAKE_ENV = {
  SNOWFLAKE_ACCOUNT: "acct",
  SNOWFLAKE_USER: "user",
  SNOWFLAKE_PASSWORD: "secret",
};

describe("Snowflake config", () => {
  it("is not required to boot: loadConfig ignores Snowflake variables", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://localhost/pulse" })).toEqual({
      DATABASE_URL: "postgresql://localhost/pulse",
    });
    expect(hasSnowflakeConfig({ DATABASE_URL: "postgresql://localhost/pulse" })).toBe(false);
  });

  it("accepts the required trio with optional warehouse/database/schema/role", () => {
    expect(hasSnowflakeConfig(SNOWFLAKE_ENV)).toBe(true);
    expect(loadSnowflakeConfig({ ...SNOWFLAKE_ENV, SNOWFLAKE_WAREHOUSE: "wh" })).toEqual({
      ...SNOWFLAKE_ENV,
      SNOWFLAKE_WAREHOUSE: "wh",
    });
  });

  it("names the missing variables without echoing any secret value", () => {
    let message = "";
    try {
      loadSnowflakeConfig({ SNOWFLAKE_ACCOUNT: "acct", SNOWFLAKE_PASSWORD: "secret" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SNOWFLAKE_USER");
    expect(message).not.toContain("secret");
  });
});
