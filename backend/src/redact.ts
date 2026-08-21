/**
 * Strips credential values out of text that is about to be logged or returned.
 *
 * Error messages from the Postgres, Snowflake and Gemini clients can echo the
 * connection details they were given, so anything derived from a driver error
 * goes through here first.
 */

/** Env vars whose values must never appear in a log line or an API response. */
const SECRET_ENV_VARS = [
  "INGEST_TOKEN",
  "SNOWFLAKE_PASSWORD",
  "SNOWFLAKE_PRIVATE_KEY",
  "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE",
  "DATABASE_URL",
  "GEMINI_API_KEY",
] as const;

export function redactSecrets(message: string, env: NodeJS.ProcessEnv = process.env): string {
  // Generic `scheme://user:pass@host` credentials, whether or not they came
  // from a variable we know the name of.
  let redacted = message.replace(/:\/\/[^\s@/]+@/g, "://***@");
  for (const key of SECRET_ENV_VARS) {
    const value = env[key];
    // Guard against a short or empty value turning every character into "***".
    if (value !== undefined && value.length >= 4) redacted = redacted.split(value).join("***");
  }
  return redacted;
}

/** One-line `name [code]: message` summary of an unknown throw, safe to log. */
export function describeError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (!(error instanceof Error)) return redactSecrets(String(error), env);
  const code = (error as Error & { code?: unknown }).code;
  const codePart = code === undefined ? "" : ` [${String(code)}]`;
  return `${error.name}${codePart}: ${redactSecrets(error.message, env)}`;
}
