/**
 * PULSE-19 follow-up — rebuilds the committed ATL311 fixture from the full 2015
 * export so the resolution-time metric has something real to measure.
 *
 *   npm run resample:atl311 --workspace=backend
 *
 * Why: the existing fixture is the head of a date-sorted export — every row was
 * opened between 9:31 and 9:36 on one 2015 morning and closed within minutes.
 * That makes `median_resolution_days` ~0 for every NPU, so the equity gap on
 * /api/compare is 0 for every pair: a confident-looking number that says the
 * city treats every neighborhood identically, which the data cannot support.
 *
 * Sampling integrity — the point of this script is to stop the fixture lying,
 * so it must not lie in a new direction:
 *
 *  - Rows are drawn UNIFORMLY AT RANDOM, never ranked or filtered by how long
 *    they took to resolve. Selecting slow-resolving rows would manufacture the
 *    very disparity the dashboard claims to have discovered. Whatever spread
 *    falls out is what the source says.
 *  - The RNG is seeded, so the fixture is reproducible from this script.
 *  - Rows are kept verbatim from the source, never edited or synthesised.
 *  - One deliberate filter: a row must carry an address, because a row that
 *    cannot be geocoded cannot be joined to an NPU and is dead weight. This is
 *    a usability filter, not an outcome filter — but it is not neutral, and is
 *    reported below: address-bearing rows skew toward physical service requests
 *    (potholes, illegal dumping) over phone enquiries closed on the call.
 *  - The window is the most recent 90 days present in the export, because the
 *    ingest date-shift moves the newest row to yesterday and the analysis
 *    window is 90 days. A wider draw would land most rows outside it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildAtl311Address } from "../src/ingest/geocode.js";
import { extractFromTarGz, parseCsv, type RawRecord } from "../src/ingest/sources.js";

const ARCHIVE_URL = "https://github.com/brian-murphy/atl-311-parser/raw/master/311-data.tar.gz";
const MEMBER = /ATL311 SR Data 2015\.csv$/i;
const FIXTURE_PATH = join(__dirname, "..", "test", "fixtures", "atl311_service_requests.sample.json");
const SAMPLE_SIZE = 250;
const WINDOW_DAYS = 90;
const SEED = 20260821;
const DAY_MS = 86_400_000;

/** Deterministic PRNG (mulberry32) so the fixture is reproducible from this script. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The export writes `M/D/YYYY H:MM`; Date.parse handles it, but verify rather than assume. */
function parseStamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

function shuffleInPlace<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function describeDurations(rows: RawRecord[]): void {
  const days: number[] = [];
  for (const row of rows) {
    const opened = parseStamp(row["Opened"]);
    const closed = parseStamp(row["Closed"]);
    if (opened !== null && closed !== null && closed >= opened) days.push((closed - opened) / DAY_MS);
  }
  if (days.length === 0) {
    console.log("resolution durations: none (no row has both Opened and Closed)");
    return;
  }
  days.sort((a, b) => a - b);
  const at = (q: number): string => days[Math.min(days.length - 1, Math.floor(days.length * q))].toFixed(2);
  console.log(`resolution durations over ${days.length} closed rows:`);
  console.log(`  min ${at(0)}d  p25 ${at(0.25)}d  median ${at(0.5)}d  p75 ${at(0.75)}d  p90 ${at(0.9)}d  max ${days[days.length - 1].toFixed(2)}d`);
  console.log(`  >= 1 day: ${days.filter((d) => d >= 1).length}   >= 7 days: ${days.filter((d) => d >= 7).length}`);
}

async function main(): Promise<void> {
  console.log(`fetching ${ARCHIVE_URL}`);
  const response = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`archive fetch returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  console.log(`archive: ${(archive.length / 1e6).toFixed(1)} MB`);

  const csv = extractFromTarGz(archive, (name) => MEMBER.test(name));
  console.log(`member CSV: ${(csv.length / 1e6).toFixed(1)} MB`);

  const all = parseCsv(csv);
  console.log(`parsed rows: ${all.length}`);

  const dated = all
    .map((row) => ({ row, opened: parseStamp(row["Opened"]) }))
    .filter((item): item is { row: RawRecord; opened: number } => item.opened !== null);
  if (dated.length === 0) throw new Error("no rows carry a parseable Opened timestamp");

  const newest = Math.max(...dated.map((item) => item.opened));
  const cutoff = newest - WINDOW_DAYS * DAY_MS;
  console.log(
    `window: ${new Date(cutoff).toISOString().slice(0, 10)} .. ${new Date(newest).toISOString().slice(0, 10)}`,
  );

  const inWindow = dated.filter((item) => item.opened >= cutoff);
  const addressable = inWindow.filter((item) => buildAtl311Address(item.row) !== null);
  console.log(`in window: ${inWindow.length}   with a usable address: ${addressable.length}`);
  if (addressable.length < SAMPLE_SIZE) {
    throw new Error(`only ${addressable.length} usable rows in the window; need ${SAMPLE_SIZE}`);
  }

  // Uniform random draw. Never sorted or filtered by resolution duration.
  const sample = shuffleInPlace([...addressable], mulberry32(SEED))
    .slice(0, SAMPLE_SIZE)
    .map((item) => item.row)
    .sort((a, b) => (parseStamp(a["Opened"]) ?? 0) - (parseStamp(b["Opened"]) ?? 0));

  console.log(`\n=== sample of ${sample.length} rows ===`);
  const opens = sample.map((row) => parseStamp(row["Opened"]) ?? 0);
  console.log(
    `opened span: ${new Date(Math.min(...opens)).toISOString().slice(0, 10)}`
    + ` .. ${new Date(Math.max(...opens)).toISOString().slice(0, 10)}`,
  );
  console.log(`with a Closed value: ${sample.filter((row) => parseStamp(row["Closed"]) !== null).length}`);
  describeDurations(sample);

  console.log("\n--- for comparison, the same stats over the whole window (unsampled) ---");
  describeDurations(addressable.map((item) => item.row));

  writeFileSync(FIXTURE_PATH, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`\nwrote ${FIXTURE_PATH}`);
  console.log("NOTE: coordinates are not carried over — run the geocode workflow next.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
