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
const snowflakeConfigSchema = z.object({
  SNOWFLAKE_ACCOUNT: z.string().min(1),
  SNOWFLAKE_USER: z.string().min(1),
  // Password auth is legacy: Snowflake MFA blocks it for programmatic access
  // (error 394509), so key-pair auth is the supported path going forward.
  // Both are optional here — snowflakeClient.ts picks one and throws a clear
  // error naming both env vars if neither is set.
  SNOWFLAKE_PASSWORD: z.string().min(1).optional(),
  SNOWFLAKE_PRIVATE_KEY: z.string().min(1).optional(),
  SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: z.string().min(1).optional(),
  SNOWFLAKE_WAREHOUSE: z.string().min(1).optional(),
  SNOWFLAKE_DATABASE: z.string().min(1).optional(),
  SNOWFLAKE_SCHEMA: z.string().min(1).optional(),
  SNOWFLAKE_ROLE: z.string().min(1).optional(),
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
