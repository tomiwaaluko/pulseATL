/**
 * PULSE-19 — replaces `frontend/data/npus.geojson` with the City of Atlanta's
 * own published NPU boundary layer.
 *
 *   npm run fetch:npus --workspace=backend
 *
 * Why this exists: the committed file was cut from a third-party GitHub mirror
 * of the layer, and that mirror ships 24 features — NPU Q is missing from it
 * entirely. The Q polygon in the repo was a 7-vertex stand-in, which is not a
 * boundary; every point-in-polygon join against it was wrong. The fix has to be
 * the authoritative layer, not a patch on top of the mirror.
 *
 * Source: `Official_NPU`, published by the City of Atlanta Department of City
 * Planning GIS (`coaplangis`) on ArcGIS Online.
 *   Hub item: https://dpcd-coaplangis.opendata.arcgis.com/datasets/official-npu-open-data
 *   Service:  https://services5.arcgis.com/5RxyIIJ9boPdptdo/arcgis/rest/services/Official_NPU/FeatureServer/0
 *
 * The orchestration sandbox's egress proxy blocks *.arcgis.com, so like the
 * geocoder this only runs from a GitHub-hosted runner. No API key is needed:
 * the layer is public open data.
 *
 * Nothing here is invented. The script validates hard and fails loudly rather
 * than writing a partial or repaired layer: 25 features, the exact NPU letter
 * set A–Z minus U, real polygon rings, WGS84 coordinates inside metro Atlanta,
 * and a vertex floor that the old 7-point Q could never have cleared.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE_URL =
  "https://services5.arcgis.com/5RxyIIJ9boPdptdo/arcgis/rest/services/Official_NPU/FeatureServer/0/query";
const QUERY = "where=1%3D1&outFields=*&outSR=4326&returnGeometry=true&f=geojson";
const SOURCE_URL = `${SERVICE_URL}?${QUERY}`;

const OUTPUT_PATH = join(__dirname, "..", "..", "frontend", "data", "npus.geojson");

/** A, B, … Z with U omitted: Atlanta has never had an NPU U. */
const EXPECTED_NPUS = [..."ABCDEFGHIJKLMNOPQRSTVWXYZ"];

/**
 * A real NPU outline is hundreds of points; the mirror's placeholder Q had 7.
 * Anything under this floor means the layer was generalized or truncated, and
 * a generalized boundary silently misassigns incidents near the edge.
 */
const MIN_VERTICES_PER_NPU = 50;

/** Generous metro Atlanta envelope — a sanity check that the layer is WGS84 lon/lat. */
const SANE_BOUNDS = { minLon: -85, maxLon: -84, minLat: 33, maxLat: 34.5 } as const;

const FETCH_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/** The NPU letter lives in `NAME` on the official layer; the others are mirrors' spellings. */
const NPU_FIELDS = ["NPU", "NAME", "NPU_NAME", "NPUNAME", "npu", "name"] as const;

interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

interface GeoJsonFeatureCollection {
  type: string;
  features: GeoJsonFeature[];
  exceededTransferLimit?: boolean;
  properties?: Record<string, unknown>;
  error?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * ArcGIS reports plenty of failures as an `{"error": …}` body under HTTP 200,
 * so a status check alone is not enough to call a fetch successful.
 */
async function fetchLayer(): Promise<GeoJsonFeatureCollection> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.log(`retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
    }
    try {
      const response = await fetch(SOURCE_URL, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await response.text();
      console.log(`GET ${SOURCE_URL} -> HTTP ${response.status}, ${body.length} bytes`);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);

      const parsed = JSON.parse(body) as GeoJsonFeatureCollection;
      if (parsed.error) throw new Error(`ArcGIS returned an error body: ${JSON.stringify(parsed.error).slice(0, 300)}`);
      return parsed;
    } catch (error: unknown) {
      lastError = error;
      console.error(`attempt ${attempt + 1} failed: ${String(error)}`);
    }
  }
  throw new Error(`could not fetch the NPU layer after ${RETRY_DELAYS_MS.length + 1} attempts: ${String(lastError)}`);
}

/** Walks a Polygon/MultiPolygon coordinate tree, counting positions and bounds-checking each. */
function inspectCoordinates(coordinates: unknown, npu: string): number {
  let vertices = 0;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) throw new Error(`NPU ${npu}: geometry contains a non-array node`);
    if (typeof node[0] === "number") {
      const [lon, lat] = node as number[];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error(`NPU ${npu}: non-finite coordinate`);
      }
      if (lon < SANE_BOUNDS.minLon || lon > SANE_BOUNDS.maxLon || lat < SANE_BOUNDS.minLat || lat > SANE_BOUNDS.maxLat) {
        throw new Error(
          `NPU ${npu}: coordinate [${lon}, ${lat}] is outside metro Atlanta — `
          + "the layer is probably not WGS84 lon/lat",
        );
      }
      vertices += 1;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coordinates);
  return vertices;
}

function readNpuLetter(properties: Record<string, unknown> | null): string | null {
  if (!properties) return null;
  for (const field of NPU_FIELDS) {
    const value = properties[field];
    if (typeof value !== "string") continue;
    // Hub items label these variously as "Q", "NPU Q" or "NPU-Q".
    const match = /^(?:NPU[\s-]*)?([A-Z])$/i.exec(value.trim());
    if (match) return match[1].toUpperCase();
  }
  return null;
}

async function main(): Promise<void> {
  const layer = await fetchLayer();

  if (layer.type !== "FeatureCollection" || !Array.isArray(layer.features)) {
    throw new Error(`expected a GeoJSON FeatureCollection, got ${JSON.stringify(layer.type)}`);
  }
  if (layer.exceededTransferLimit) {
    throw new Error("the service paginated the response — refusing to write a partial layer");
  }

  const features = layer.features.map((feature) => {
    const npu = readNpuLetter(feature.properties);
    if (!npu) {
      throw new Error(
        `a feature carries no readable NPU letter in ${NPU_FIELDS.join("/")}: `
        + JSON.stringify(feature.properties).slice(0, 200),
      );
    }
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      throw new Error(`NPU ${npu}: expected Polygon/MultiPolygon, got ${JSON.stringify(geometry?.type ?? null)}`);
    }
    const vertices = inspectCoordinates(geometry.coordinates, npu);

    // `NPU` is the property the frontend map and the ingest NPU join both read
    // (see PulseMap.tsx and ingest/normalize.ts). Every other published field is
    // kept as-is for provenance.
    const rest = { ...(feature.properties ?? {}) };
    for (const field of NPU_FIELDS) delete rest[field];
    return { feature: { type: "Feature" as const, properties: { NPU: npu, ...rest }, geometry }, npu, vertices };
  });

  const letters = features.map((entry) => entry.npu).sort();
  const duplicates = letters.filter((letter, index) => letters.indexOf(letter) !== index);
  if (duplicates.length) throw new Error(`duplicate NPU letters in the layer: ${[...new Set(duplicates)].join(", ")}`);

  const missing = EXPECTED_NPUS.filter((letter) => !letters.includes(letter));
  const unexpected = letters.filter((letter) => !EXPECTED_NPUS.includes(letter));
  if (missing.length || unexpected.length) {
    throw new Error(
      `NPU letter set mismatch — missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
    );
  }
  if (features.length !== EXPECTED_NPUS.length) {
    throw new Error(`expected ${EXPECTED_NPUS.length} features, got ${features.length}`);
  }

  const thin = features.filter((entry) => entry.vertices < MIN_VERTICES_PER_NPU);
  if (thin.length) {
    throw new Error(
      `these NPUs have fewer than ${MIN_VERTICES_PER_NPU} vertices, which is not a real boundary: `
      + thin.map((entry) => `${entry.npu}=${entry.vertices}`).join(", "),
    );
  }

  const ordered = [...features].sort((a, b) => a.npu.localeCompare(b.npu));
  const collection = {
    type: "FeatureCollection" as const,
    features: ordered.map((entry) => entry.feature),
  };
  const json = JSON.stringify(collection);
  writeFileSync(OUTPUT_PATH, `${json}\n`);

  console.log("\n=== NPU boundary layer ===");
  console.log(`source:   ${SOURCE_URL}`);
  console.log(`features: ${collection.features.length}`);
  console.log(`letters:  ${ordered.map((entry) => entry.npu).join(",")}`);
  console.log(`wrote:    ${OUTPUT_PATH} (${(json.length / 1024).toFixed(0)} KiB)`);
  console.log("vertices per NPU:");
  for (const entry of ordered) {
    console.log(`  ${entry.npu}  ${String(entry.vertices).padStart(5)}  ${entry.feature.geometry.type}`);
  }
  const q = ordered.find((entry) => entry.npu === "Q");
  console.log(`\nNPU Q vertex count: ${q ? q.vertices : "MISSING"}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
