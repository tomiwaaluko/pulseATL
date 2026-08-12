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
