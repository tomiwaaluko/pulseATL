import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url().refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must be a Postgres URL",
  ),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return configSchema.parse(env);
}

export function getConfig(): Config {
  return loadConfig(process.env);
}

/**
 * Snowflake credentials are OPTIONAL at boot (T8: the server must start with
 * only DATABASE_URL). This block is validated lazily — the first time a
 * Snowflake connection is actually opened — never at import time.
 */
/**
 * Treat an empty string as "not provided".
 *
 * Secret stores substitute an EMPTY STRING for a secret that does not exist —
 * GitHub Actions does this for every `${{ secrets.X }}` that is unset — so an
 * absent optional credential arrives as "" rather than undefined. Without this,
 * deleting an unused secret turns a valid config into a validation error.
 */
const optionalSecret = () =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  );

const snowflakeConfigSchema = z.object({
  SNOWFLAKE_ACCOUNT: z.string().min(1),
  SNOWFLAKE_USER: z.string().min(1),
  // Password auth is legacy: Snowflake MFA blocks it for programmatic access
  // (error 394509), so key-pair auth is the supported path going forward.
  // Both are optional here — snowflakeClient.ts picks one and throws a clear
  // error naming both env vars if neither is set.
  SNOWFLAKE_PASSWORD: optionalSecret(),
  SNOWFLAKE_PRIVATE_KEY: optionalSecret(),
  SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: optionalSecret(),
  SNOWFLAKE_WAREHOUSE: optionalSecret(),
  SNOWFLAKE_DATABASE: optionalSecret(),
  SNOWFLAKE_SCHEMA: optionalSecret(),
  SNOWFLAKE_ROLE: optionalSecret(),
});

export type SnowflakeConfig = z.infer<typeof snowflakeConfigSchema>;

/** Throws a redacted error listing only the missing variable names. */
export function loadSnowflakeConfig(env: NodeJS.ProcessEnv): SnowflakeConfig {
  const parsed = snowflakeConfigSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Snowflake configuration is incomplete or invalid: ${missing}`);
  }
  return parsed.data;
}

/** True when every required Snowflake variable is present. */
export function hasSnowflakeConfig(env: NodeJS.ProcessEnv): boolean {
  return snowflakeConfigSchema.safeParse(env).success;
}
