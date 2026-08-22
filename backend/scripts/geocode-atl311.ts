/**
 * PULSE-19 — geocodes the committed ATL311 fixture against the US Census
 * batch geocoder so `normalize.ts` can stop rejecting every ATL311 row.
 *
 *   npm run geocode:atl311 --workspace=backend
 *
 * Idempotent: only rows still missing latitude/longitude are sent, so a
 * partial or retried run only fills in what is still unresolved.
 *
 * The run makes several passes over the rows that are still unresolved, each
 * one rewriting the *query* a little differently (see
 * `buildAtl311AddressVariants` in `src/ingest/geocode.ts`): the raw address
 * first, then the address with unit noise stripped and contracted street names
 * expanded, then ZIP-only and city-only retries, and finally an Atlanta
 * quadrant retry that is accepted only when exactly one of NE/NW/SE/SW comes
 * back as a match.
 *
 * NEVER FABRICATES A COORDINATE. Every coordinate written here was returned by
 * the Census for that row's own address. A row that fails to geocode, geocodes
 * outside the Atlanta metro bounding box, or is ambiguous between quadrants is
 * written back with `latitude`/`longitude` set to `null` and counted as a
 * failure. Coordinates are never copied between rows, and no ZIP, city or
 * neighbourhood centroid is ever substituted for a real match.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATLANTA_BOUNDS,
  buildAddressBatchCsv,
  buildAtl311AddressVariants,
  parseCensusBatchResponse,
  resolveQuadrantCandidates,
  type AddressVariant,
  type AddressVariantKind,
  type CensusMatchOutcome,
  type CensusMatchResult,
  type GeocodableAddress,
} from "../src/ingest/geocode.js";

const FIXTURE_PATH = join(__dirname, "..", "test", "fixtures", "atl311_service_requests.sample.json");
const CENSUS_BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const CENSUS_BENCHMARK = "Public_AR_Current";
/** Comfortably under the documented 10,000-row batch limit; keeps each request fast. */
const BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 120_000;

/** Passes run in this order; each only sees rows the earlier ones left unresolved. */
const PASSES: readonly AddressVariantKind[] = ["base", "cleaned", "zip_only", "city_only", "quadrant"];

/** Separates a row id from its quadrant tag in the batch file's unique_id column. */
const QUADRANT_TAG = "~";

type FixtureRow = Record<string, unknown> & { latitude?: unknown; longitude?: unknown };

interface Coordinate {
  lon: number;
  lat: number;
}

function needsGeocoding(row: FixtureRow): boolean {
  return typeof row.latitude !== "number" || typeof row.longitude !== "number";
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function geocodeBatch(
  entries: ReadonlyArray<{ id: string; address: GeocodableAddress }>,
): Promise<CensusMatchResult[]> {
  if (!entries.length) return [];
  const csv = buildAddressBatchCsv(entries);
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
    `[census] sent ${entries.length} addresses -> HTTP ${response.status} `
    + `${response.headers.get("content-type") ?? "(no content-type)"}, ${body.length} bytes`,
  );
  console.log(`[census] first 200 chars of response: ${JSON.stringify(body.slice(0, 200))}`);

  if (!response.ok) {
    throw new Error(`Census batch geocoder returned HTTP ${response.status}`);
  }
  return parseCensusBatchResponse(body);
}

/**
 * Runs every batch for one pass and returns the raw Census verdicts keyed by
 * the unique_id we sent, so quadrant candidates can be regrouped by row.
 */
async function runPass(
  entries: ReadonlyArray<{ id: string; address: GeocodableAddress }>,
): Promise<Map<string, CensusMatchResult>> {
  const verdicts = new Map<string, CensusMatchResult>();
  for (const batch of chunk([...entries], BATCH_SIZE)) {
    for (const result of await geocodeBatch(batch)) verdicts.set(result.id, result);
  }
  return verdicts;
}

function describeAddress(address: GeocodableAddress): string {
  return [address.street, address.city, address.state, address.zip].filter(Boolean).join(", ");
}

async function main(): Promise<void> {
  const rows = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureRow[];

  const pending = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => needsGeocoding(row));

  // Variants are computed once per row; each pass just picks the ones it owns.
  const variantsByIndex = new Map<number, AddressVariant[]>();
  for (const { index, row } of pending) {
    variantsByIndex.set(index, buildAtl311AddressVariants(row));
  }

  const unaddressable = pending.filter(({ index }) => (variantsByIndex.get(index) ?? []).length === 0).length;

  const resolved = new Map<number, Coordinate>();
  /** Which pass earned each row's coordinate — reported so the gain is attributable. */
  const wonBy = new Map<number, AddressVariantKind>();
  /** Last Census verdict seen per unresolved row, for the failure breakdown. */
  const lastOutcome = new Map<number, CensusMatchOutcome>();
  const outcomes: Record<CensusMatchOutcome, number> = {
    match: 0,
    no_match: 0,
    out_of_bounds: 0,
    unparseable: 0,
  };
  const gainByPass = new Map<AddressVariantKind, number>();

  for (const pass of PASSES) {
    const rowsForPass = pending.filter(({ index }) => !resolved.has(index));
    const entries: Array<{ id: string; address: GeocodableAddress }> = [];
    for (const { index } of rowsForPass) {
      for (const variant of variantsByIndex.get(index) ?? []) {
        if (variant.kind !== pass) continue;
        const id = variant.quadrant ? `${index}${QUADRANT_TAG}${variant.quadrant}` : String(index);
        entries.push({ id, address: variant.address });
      }
    }
    if (!entries.length) {
      console.log(`\n=== pass "${pass}": nothing to send ===`);
      continue;
    }

    console.log(`\n=== pass "${pass}": ${entries.length} addresses for ${rowsForPass.length} unresolved rows ===`);
    const verdicts = await runPass(entries);

    let gained = 0;
    for (const { index } of rowsForPass) {
      if (pass === "quadrant") {
        const candidates = [...verdicts.entries()]
          .filter(([id]) => id.startsWith(`${index}${QUADRANT_TAG}`))
          .map(([, verdict]) => verdict);
        if (!candidates.length) continue;
        for (const candidate of candidates) {
          outcomes[candidate.outcome] += 1;
          if (candidate.outcome !== "match") lastOutcome.set(index, candidate.outcome);
        }
        const coordinate = resolveQuadrantCandidates(candidates);
        if (coordinate) {
          resolved.set(index, coordinate);
          wonBy.set(index, pass);
          lastOutcome.delete(index);
          gained += 1;
        } else if (candidates.filter((candidate) => candidate.matched).length > 1) {
          // Two real Atlanta addresses fit this row. Picking one would be a
          // guess dressed up as data, so the row stays null.
          console.log(`[quadrant] row ${index} matched more than one quadrant — left unresolved`);
        }
        continue;
      }

      const verdict = verdicts.get(String(index));
      if (!verdict) continue;
      outcomes[verdict.outcome] += 1;
      if (verdict.matched && verdict.lon !== null && verdict.lat !== null) {
        resolved.set(index, { lon: verdict.lon, lat: verdict.lat });
        wonBy.set(index, pass);
        lastOutcome.delete(index);
        gained += 1;
      } else {
        lastOutcome.set(index, verdict.outcome);
      }
    }
    gainByPass.set(pass, gained);
    console.log(`=== pass "${pass}": +${gained} rows resolved ===`);
  }

  for (const { index, row } of pending) {
    const coordinate = resolved.get(index);
    if (coordinate) {
      row.latitude = coordinate.lat;
      row.longitude = coordinate.lon;
    } else {
      row.latitude = null;
      row.longitude = null;
    }
  }

  const geocoded = resolved.size;
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
    .filter((point): point is Coordinate & { lat: number } =>
      typeof point.lat === "number" && typeof point.lon === "number");
  const bbox = coords.length
    ? {
      minLon: Math.min(...coords.map((point) => point.lon)),
      maxLon: Math.max(...coords.map((point) => point.lon)),
      minLat: Math.min(...coords.map((point) => point.lat)),
      maxLat: Math.max(...coords.map((point) => point.lat)),
    }
    : null;

  console.log("\n=== ATL311 geocoding summary ===");
  console.log(`total rows:      ${rows.length}`);
  console.log(`already had:     ${alreadyGeocoded}`);
  console.log(`retried:         ${pending.length}`);
  console.log(`no address:      ${unaddressable} (never sent — missing street, and no city or ZIP)`);
  console.log(
    `census verdicts: ${outcomes.match} match, ${outcomes.no_match} no_match, `
    + `${outcomes.out_of_bounds} out_of_bounds, ${outcomes.unparseable} unparseable `
    + `(counted per address sent, not per row)`,
  );
  console.log("gain by pass:");
  for (const pass of PASSES) console.log(`  ${pass.padEnd(10)} +${gainByPass.get(pass) ?? 0}`);
  console.log(`geocoded:        ${totalGeocoded}`);
  console.log(`failed:          ${totalFailed}`);
  console.log(`% success:       ${((totalGeocoded / rows.length) * 100).toFixed(1)}%`);
  console.log(`this run:        +${geocoded} geocoded, ${failed} still failing (of ${pending.length} retried)`);
  console.log(`expected bbox:   lon [${ATLANTA_BOUNDS.minLon}, ${ATLANTA_BOUNDS.maxLon}], lat [${ATLANTA_BOUNDS.minLat}, ${ATLANTA_BOUNDS.maxLat}]`);
  console.log(`result bbox:     ${bbox ? `lon [${bbox.minLon}, ${bbox.maxLon}], lat [${bbox.minLat}, ${bbox.maxLat}]` : "n/a (no successful matches)"}`);

  // Print every row that is still null with its address and the Census's own
  // verdict. This is the honest accounting: a reader can check that the
  // remaining failures are addresses outside Atlanta or genuinely unresolvable,
  // not rows that were quietly dropped.
  const stillNull = pending.filter(({ index }) => !resolved.has(index));
  if (stillNull.length) {
    console.log(`\n=== ${stillNull.length} rows still without coordinates ===`);
    for (const { index } of stillNull) {
      const variants = variantsByIndex.get(index) ?? [];
      const shown = variants.length ? describeAddress(variants[0].address) : "(no usable address)";
      console.log(`  ${String(index).padStart(3)}  ${(lastOutcome.get(index) ?? "not_sent").padEnd(14)}  ${shown}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
