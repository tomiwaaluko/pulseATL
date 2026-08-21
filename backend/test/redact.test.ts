import { describe, expect, it } from "vitest";

import { describeError, redactSecrets } from "../src/redact";

const ENV = {
  DATABASE_URL: "postgresql://pulse:hunter2@db.internal:5432/pulse",
  GEMINI_API_KEY: "AIzaSyEXAMPLEKEY123",
  SNOWFLAKE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
} as unknown as NodeJS.ProcessEnv;

describe("redactSecrets", () => {
  it("removes a known secret value wherever it appears", () => {
    const result = redactSecrets(`connect failed for ${ENV.DATABASE_URL}`, ENV);

    expect(result).not.toContain("hunter2");
    expect(result).toContain("***");
  });

  it("removes inline credentials even when the value is not a known env var", () => {
    const result = redactSecrets("failed: postgres://someone:s3cret@other.host:5432/db", ENV);

    expect(result).not.toContain("s3cret");
  });

  it("removes an API key echoed back in an error message", () => {
    const result = redactSecrets("API key not valid: AIzaSyEXAMPLEKEY123", ENV);

    expect(result).not.toContain("AIzaSyEXAMPLEKEY123");
  });

  it("removes a multi-line private key", () => {
    const result = redactSecrets(`bad key: ${ENV.SNOWFLAKE_PRIVATE_KEY}`, ENV);

    expect(result).not.toContain("MIIabc");
  });

  it("ignores a short or empty value rather than redacting every character", () => {
    const result = redactSecrets("a perfectly ordinary message", { GEMINI_API_KEY: "" } as NodeJS.ProcessEnv);

    expect(result).toBe("a perfectly ordinary message");
  });
});

describe("describeError", () => {
  it("includes the error name and message", () => {
    expect(describeError(new TypeError("bad shape"), {} as NodeJS.ProcessEnv)).toBe("TypeError: bad shape");
  });

  it("includes a driver error code when present", () => {
    const error = Object.assign(new Error("no such function"), { code: "002003" });

    expect(describeError(error, {} as NodeJS.ProcessEnv)).toBe("Error [002003]: no such function");
  });

  it("redacts secrets inside the message", () => {
    const error = new Error(`auth failed for ${ENV.DATABASE_URL}`);

    expect(describeError(error, ENV)).not.toContain("hunter2");
  });

  it("handles a non-Error throw", () => {
    expect(describeError("plain string failure", {} as NodeJS.ProcessEnv)).toBe("plain string failure");
  });
});
