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

describe("optional Snowflake secrets", () => {
  const base = {
    SNOWFLAKE_ACCOUNT: "wc84723.us-east-2.aws",
    SNOWFLAKE_USER: "SVC",
    SNOWFLAKE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  };

  it("treats empty-string optional secrets as absent", () => {
    // GitHub Actions substitutes "" for any secret that does not exist, so an
    // unset SNOWFLAKE_PASSWORD arrives as an empty string rather than undefined.
    const config = loadSnowflakeConfig({
      ...base,
      SNOWFLAKE_PASSWORD: "",
      SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: "",
      SNOWFLAKE_ROLE: "   ",
    });
    expect(config.SNOWFLAKE_PASSWORD).toBeUndefined();
    expect(config.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE).toBeUndefined();
    expect(config.SNOWFLAKE_ROLE).toBeUndefined();
    expect(config.SNOWFLAKE_PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");
  });

  it("still reports genuinely missing required variables", () => {
    expect(() => loadSnowflakeConfig({ SNOWFLAKE_USER: "SVC" })).toThrow(/SNOWFLAKE_ACCOUNT/);
  });
});
