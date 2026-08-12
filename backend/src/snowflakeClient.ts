import snowflake from "snowflake-sdk";
import type { Connection } from "snowflake-sdk";

import { loadSnowflakeConfig } from "./config.js";

/**
 * Lazy Snowflake connection. Nothing is opened at import time — the server
 * (T8) boots with only DATABASE_URL, and only ingest paths ever connect.
 */
let connectionPromise: Promise<Connection> | null = null;

function openConnection(): Promise<Connection> {
  // Validate before touching the driver so a misconfigured environment fails
  // with variable *names* only — never values.
  const env = loadSnowflakeConfig(process.env);

  const connection = snowflake.createConnection({
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USER,
    password: env.SNOWFLAKE_PASSWORD,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA ?? "PUBLIC",
    role: env.SNOWFLAKE_ROLE,
    application: "PulseATL",
  });

  return new Promise<Connection>((resolve, reject) => {
    connection.connect((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(connection);
    });
  });
}

function getConnection(): Promise<Connection> {
  if (!connectionPromise) {
    // Never cache a failed attempt: a transient network or credential fault
    // must not poison every later query for the life of the process.
    connectionPromise = openConnection().catch((err: unknown) => {
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

/** Run a statement and return its rows. Binds use `?` placeholders. */
export async function sfQuery<T>(sql: string, binds?: unknown[]): Promise<T[]> {
  const connection = await getConnection();
  return new Promise<T[]>((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((rows ?? []) as T[]);
      },
    });
  });
}

/** Close the pooled connection (smoke scripts, ingest teardown, tests). */
export async function closeSnowflake(): Promise<void> {
  const pending = connectionPromise;
  connectionPromise = null;
  if (!pending) return;
  const connection = await pending.catch(() => null);
  if (!connection) return;
  await new Promise<void>((resolve) => {
    connection.destroy(() => resolve());
  });
}
