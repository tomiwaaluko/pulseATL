/**
 * PULSE-12 smoke test — run against the real Snowflake trial account.
 *
 *   npm run smoke:snowflake --workspace=backend
 *
 * Requires SNOWFLAKE_ACCOUNT/USER/PASSWORD (+ optional WAREHOUSE/DATABASE/
 * SCHEMA/ROLE) in the environment. Credential *values* are never printed —
 * only which variables were found. Exits non-zero on any failure.
 */
import {
  cityMedians,
  computeNpuStats,
  cortexFindings,
  ensureSchema,
  loadIncidents,
  CORTEX_FALLBACK_PREFIX,
} from "../src/ingest/load.js";
import { closeSnowflake, sfQuery } from "../src/snowflakeClient.js";
import type { Incident } from "../src/types.js";

const REQUIRED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD"] as const;
const OPTIONAL = [
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_ROLE",
] as const;

/** Deterministic ids so repeated runs exercise the MERGE upsert path. */
function sampleIncidents(): Incident[] {
  const now = Date.now();
  const daysAgo = (days: number): Date => new Date(now - days * 24 * 60 * 60 * 1000);
  return [
    {
      id: "smoke:apd_crime:1",
      source: "apd_crime",
      category: "crime",
      subcategory: "LARCENY-FROM VEHICLE",
      occurred_at: daysAgo(10),
      resolved_at: daysAgo(4),
      status: "closed",
      lat: 33.7537,
      lon: -84.3901,
      npu: "V",
    },
    {
      id: "smoke:atl311:2",
      source: "atl311",
      category: "infrastructure",
      subcategory: "Pothole",
      occurred_at: daysAgo(120),
      resolved_at: null,
      status: "open",
      lat: 33.7701,
      lon: -84.3733,
      npu: "B",
    },
  ];
}

async function main(): Promise<void> {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const present = [...REQUIRED, ...OPTIONAL].filter((name) => Boolean(process.env[name]));
  console.log(`env: ${present.join(", ")} set (values not printed)`);

  console.log("1/5 connecting…");
  const [version] = await sfQuery<Record<string, unknown>>("SELECT CURRENT_VERSION() AS VERSION");
  console.log(`    connected; Snowflake version ${String(version?.VERSION ?? "unknown")}`);

  console.log("2/5 ensureSchema()…");
  await ensureSchema();
  console.log("    INCIDENTS table present");

  console.log("3/5 loadIncidents() with 2 sample rows…");
  const loaded = await loadIncidents(sampleIncidents());
  console.log(`    MERGE reported ${loaded} row(s) loaded`);

  console.log("4/5 computeNpuStats()…");
  const stats = await computeNpuStats();
  console.log(`    ${stats.length} NPU row(s):`);
  for (const row of stats) {
    console.log(
      `    ${row.npu}: 90d=${row.incident_count_90d} prior=${row.incident_count_prior_90d} ` +
        `open=${row.open_case_count} medianDays=${row.median_resolution_days ?? "n/a"} ` +
        `categories=${JSON.stringify(row.counts_by_category)}`,
    );
  }
  if (!stats.length) {
    throw new Error("computeNpuStats() returned no rows after loading sample incidents");
  }

  console.log("5/5 cortexFindings() — CORTEX.COMPLETE inside Snowflake…");
  const findings = await cortexFindings(stats[0], cityMedians(stats));
  console.log(`    ${findings}`);
  if (findings.startsWith(CORTEX_FALLBACK_PREFIX)) {
    throw new Error(
      "Cortex returned the fallback string — CORTEX.COMPLETE is unavailable on this account " +
        "(check region support and that the role has the SNOWFLAKE.CORTEX_USER database role).",
    );
  }

  console.log("SMOKE OK");
}

main()
  .catch((error: unknown) => {
    console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeSnowflake());
