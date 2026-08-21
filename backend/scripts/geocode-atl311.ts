/**
 * PULSE-19 — geocodes the committed ATL311 fixture against the US Census
 * batch geocoder so `normalize.ts` can stop rejecting every ATL311 row.
 *
 *   npm run geocode:atl311 --workspace=backend
 *
 * Idempotent: only rows still missing latitude/longitude are sent, so a
 * partial or retried run only fills in what is still unresolved. Never
 * fabricates or approximates a coordinate — a row that fails to geocode, or
 * geocodes outside the Atlanta metro bounding box, is written back with
 * `latitude`/`longitude` set to `null` and counted as a failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATLANTA_BOUNDS,
  buildAddressBatchCsv,
  buildAtl311Address,
  parseCensusBatchResponse,
  type CensusMatchOutcome,
} from "../src/ingest/geocode.js";

const FIXTURE_PATH = join(__dirname, "..", "test", "fixtures", "atl311_service_requests.sample.json");
const CENSUS_BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const CENSUS_BENCHMARK = "Public_AR_Current";
/** Comfortably under the documented 10,000-row batch limit; keeps each request fast. */
const BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 120_000;

type FixtureRow = Record<string, unknown> & { latitude?: unknown; longitude?: unknown };

function needsGeocoding(row: FixtureRow): boolean {
  return typeof row.latitude !== "number" || typeof row.longitude !== "number";
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function geocodeBatch(entries: Array<{ id: string; address: ReturnType<typeof buildAtl311Address> }>) {
  const addressable = entries.filter(
    (entry): entry is { id: string; address: NonNullable<typeof entry.address> } => entry.address !== null,
  );
  if (!addressable.length) return [];
  const csv = buildAddressBatchCsv(addressable);
  const form = new FormData();
  form.append("benchmark", CENSUS_BENCHMARK);
  form.append("addressFile", new Blob([csv], { type: "text/csv" }), "addresses.csv");

  const response = await fetch(CENSUS_BATCH_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();

  // The Census geocoder answers some malformed requests with an HTML error page
  // under HTTP 200, which parses as CSV into rows that all read as No_Match. Log
  // enough of the raw response to tell that apart from genuine non-matches —
  // these are public street addresses, so there is nothing here to redact.
  console.log(
    `[census] sent ${addressable.length} addresses -> HTTP ${response.status} `
    + `${response.headers.get("content-type") ?? "(no content-type)"}, ${body.length} bytes`,
  );
  console.log(`[census] first 200 chars of response: ${JSON.stringify(body.slice(0, 200))}`);

  if (!response.ok) {
    throw new Error(`Census batch geocoder returned HTTP ${response.status}`);
  }
  return parseCensusBatchResponse(body);
}

async function main(): Promise<void> {
  const rows = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureRow[];

  const pending = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => needsGeocoding(row));

  const entries = pending.map(({ index, row }) => ({
    id: String(row["SR #"] ?? index),
    address: buildAtl311Address(row),
  }));

  const results = new Map<string, { lon: number; lat: number }>();
  const outcomes: Record<CensusMatchOutcome, number> = {
    match: 0,
    no_match: 0,
    out_of_bounds: 0,
    unparseable: 0,
  };
  for (const batch of chunk(entries, BATCH_SIZE)) {
    const matches = await geocodeBatch(batch);
    for (const match of matches) {
      outcomes[match.outcome] += 1;
      if (match.matched && match.lon !== null && match.lat !== null) {
        results.set(match.id, { lon: match.lon, lat: match.lat });
      }
    }
  }

  let geocoded = 0;
  for (const { index, row } of pending) {
    const id = String(row["SR #"] ?? index);
    const match = results.get(id);
    if (match) {
      row.latitude = match.lat;
      row.longitude = match.lon;
      geocoded += 1;
    } else {
      row.latitude = null;
      row.longitude = null;
    }
  }
  const failed = pending.length - geocoded;

  const alreadyGeocoded = rows.length - pending.length;
  const totalGeocoded = alreadyGeocoded + geocoded;
  const totalFailed = rows.length - totalGeocoded;

  // A run that geocoded nothing has nothing to record: writing null coordinates
  // over 250 rows produces a large diff that looks like progress and is not, and
  // the nulls buy no idempotency either (needsGeocoding already retries them).
  if (geocoded > 0) {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
  } else {
    console.log("no new coordinates resolved — fixture left untouched");
  }

  const coords = rows
    .map((row) => ({ lat: row.latitude, lon: row.longitude }))
    .filter((point): point is { lat: number; lon: number } =>
      typeof point.lat === "number" && typeof point.lon === "number");
  const bbox = coords.length
    ? {
      minLon: Math.min(...coords.map((point) => point.lon)),
      maxLon: Math.max(...coords.map((point) => point.lon)),
      minLat: Math.min(...coords.map((point) => point.lat)),
      maxLat: Math.max(...coords.map((point) => point.lat)),
    }
    : null;

  const unaddressable = entries.filter((entry) => entry.address === null).length;

  console.log("=== ATL311 geocoding summary ===");
  console.log(`total rows:      ${rows.length}`);
  console.log(`no address:      ${unaddressable} (never sent — missing street, and no city or ZIP)`);
  console.log(
    `census verdicts: ${outcomes.match} match, ${outcomes.no_match} no_match, `
    + `${outcomes.out_of_bounds} out_of_bounds, ${outcomes.unparseable} unparseable`,
  );
  console.log(`geocoded:        ${totalGeocoded}`);
  console.log(`failed:          ${totalFailed}`);
  console.log(`% success:       ${((totalGeocoded / rows.length) * 100).toFixed(1)}%`);
  console.log(`this run:        +${geocoded} geocoded, ${failed} failed (of ${pending.length} pending)`);
  console.log(`expected bbox:   lon [${ATLANTA_BOUNDS.minLon}, ${ATLANTA_BOUNDS.maxLon}], lat [${ATLANTA_BOUNDS.minLat}, ${ATLANTA_BOUNDS.maxLat}]`);
  console.log(`result bbox:     ${bbox ? `lon [${bbox.minLon}, ${bbox.maxLon}], lat [${bbox.minLat}, ${bbox.maxLat}]` : "n/a (no successful matches)"}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
