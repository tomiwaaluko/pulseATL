import { beforeEach, describe, expect, it, vi } from "vitest";

interface ExecuteOptions {
  sqlText: string;
  binds?: unknown[];
  complete: (err: Error | undefined, stmt: unknown, rows: unknown[] | undefined) => void;
}

const { connect, execute, destroy, createConnection } = vi.hoisted(() => {
  const connect = vi.fn((cb: (err: Error | undefined, conn: unknown) => void) => cb(undefined, {}));
  const execute = vi.fn();
  const destroy = vi.fn((cb: (err: Error | undefined) => void) => cb(undefined));
  const createConnection = vi.fn(() => ({ connect, execute, destroy }));
  return { connect, execute, destroy, createConnection };
});

vi.mock("snowflake-sdk", () => ({
  default: { createConnection },
  createConnection,
}));

import { closeSnowflake, sfQuery } from "../src/snowflakeClient.js";

/** Queue a single result set for the next execute() call. */
function respondWith(rows: unknown[]): void {
  execute.mockImplementationOnce((options: ExecuteOptions) => {
    options.complete(undefined, {}, rows);
  });
}

const SNOWFLAKE_ENV = {
  SNOWFLAKE_ACCOUNT: "acct",
  SNOWFLAKE_USER: "user",
  SNOWFLAKE_PASSWORD: "secret",
  SNOWFLAKE_WAREHOUSE: "wh",
  SNOWFLAKE_DATABASE: "PULSE",
};

describe("sfQuery", () => {
  beforeEach(async () => {
    await closeSnowflake();
    vi.clearAllMocks();
    connect.mockImplementation((cb) => cb(undefined, {}));
    destroy.mockImplementation((cb) => cb(undefined));
    Object.assign(process.env, SNOWFLAKE_ENV);
  });

  it("does not open a connection at import time", () => {
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("connects lazily and returns typed rows", async () => {
    respondWith([{ N: 1 }]);

    const rows = await sfQuery<{ N: number }>("SELECT 1 AS N");

    expect(rows).toEqual([{ N: 1 }]);
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(createConnection.mock.calls[0][0]).toMatchObject({
      account: "acct",
      username: "user",
      password: "secret",
      warehouse: "wh",
      database: "PULSE",
    });
  });

  it("reuses one connection across queries", async () => {
    respondWith([{ N: 1 }]);
    respondWith([{ N: 2 }]);

    await sfQuery("SELECT 1 AS N");
    await sfQuery("SELECT 2 AS N");

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("passes binds through to the driver", async () => {
    respondWith([]);

    await sfQuery("SELECT ? AS X", ["value"]);

    expect(execute.mock.calls[0][0].binds).toEqual(["value"]);
  });

  it("returns an empty array when the driver yields no rows", async () => {
    respondWith(undefined as unknown as unknown[]);

    await expect(sfQuery("SELECT 1")).resolves.toEqual([]);
  });

  it("rejects with a redacted message when credentials are missing", async () => {
    delete process.env.SNOWFLAKE_PASSWORD;

    await expect(sfQuery("SELECT 1")).rejects.toThrow(/SNOWFLAKE_PASSWORD/);
    await expect(sfQuery("SELECT 1")).rejects.not.toThrow(/secret/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("surfaces statement errors and allows a later query to reconnect", async () => {
    execute.mockImplementationOnce((options: ExecuteOptions) => {
      options.complete(new Error("SQL compilation error"), {}, undefined);
    });

    await expect(sfQuery("SELECT bad")).rejects.toThrow("SQL compilation error");

    respondWith([{ N: 1 }]);
    await expect(sfQuery("SELECT 1 AS N")).resolves.toEqual([{ N: 1 }]);
  });

  it("does not cache a failed connection attempt", async () => {
    connect.mockImplementationOnce((cb) => cb(new Error("network down"), {}));

    await expect(sfQuery("SELECT 1")).rejects.toThrow("network down");

    connect.mockImplementation((cb) => cb(undefined, {}));
    respondWith([{ N: 1 }]);
    await expect(sfQuery("SELECT 1 AS N")).resolves.toEqual([{ N: 1 }]);
    expect(createConnection).toHaveBeenCalledTimes(2);
  });
});
