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
 *
 * Rather than hardcode one query URL, the script *discovers* the layer: it
 * lists each candidate ArcGIS Online organisation's services, keeps the ones
 * whose name looks like an NPU layer, inspects each FeatureServer's layers for
 * a polygon layer with an NPU-ish field, and queries the first one that
 * validates. A hardcoded URL fails silently the day the service is renamed;
 * discovery says exactly what it found instead.
 *
 * The orchestration sandbox's egress proxy blocks *.arcgis.com, so like the
 * geocoder this only runs from a GitHub-hosted runner. No API key is needed:
 * the layer is public open data.
 *
 * Nothing here is invented. Validation is strict and the script fails loudly
 * rather than writing a partial or repaired layer: 25 features, the exact NPU
 * letter set A–Z minus U, real polygon rings, WGS84 coordinates inside metro
 * Atlanta, and a vertex floor the old 7-point Q could never have cleared.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ArcGIS Online organisations that publish City of Atlanta boundary layers.
 * `5RxyIIJ9boPdptdo` is the City's own (coaplangis / Dept. of City Planning);
 * `Et5Qfajgiyosiw4d` is the Atlanta Police Department's, which republishes the
 * 242-neighbourhood layer with NPU letters attached.
 */
const CANDIDATE_ORGS = [
  "https://services5.arcgis.com/5RxyIIJ9boPdptdo/arcgis/rest/services",
  "https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services",
  "https://services1.arcgis.com/Ug5xGQbHsD8zuZzM/arcgis/rest/services",
] as const;

/** Service names worth opening — an NPU layer, not the 242-neighbourhood one. */
const SERVICE_NAME_PATTERN = /npu|neighborhood_planning|planning_unit/i;

const OUTPUT_PATH = join(__dirname, "..", "..", "frontend", "data", "npus.geojson");

/** A, B, … Z with U omitted: Atlanta has never had an NPU U. */
const EXPECTED_NPUS = [..."ABCDEFGHIJKLMNOPQRSTVWXYZ"];

/**
 * A real NPU outline is hundreds of points; the mirror's placeholder Q had 7.
 * Anything under this floor means the layer was generalized or truncated, and a
 * generalized boundary silently misassigns incidents near the edge.
 */
const MIN_VERTICES_PER_NPU = 50;

/** Generous metro Atlanta envelope — a sanity check that the layer is WGS84 lon/lat. */
const SANE_BOUNDS = { minLon: -85, maxLon: -84, minLat: 33, maxLat: 34.5 } as const;

const FETCH_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/** Field names that have carried the NPU letter across the layer's various publications. */
const NPU_FIELDS = ["NPU", "NAME", "NPU_NAME", "NPUNAME", "npu", "name"] as const;

interface Geometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
}

interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: Geometry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * ArcGIS reports plenty of failures as an `{"error": …}` body under HTTP 200,
 * and its gateway answers some malformed URLs with a bare `Bad Request`, so
 * neither the status code nor JSON-parseability alone proves a fetch worked.
 * Both the status and the body are surfaced on failure.
 */
async function fetchJson(url: string, retries = RETRY_DELAYS_MS.length): Promise<Record<string, unknown>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed.error) throw new Error(`ArcGIS error body: ${JSON.stringify(parsed.error).slice(0, 300)}`);
      return parsed;
    } catch (error: unknown) {
      lastError = error;
      console.error(`  ! ${url} — attempt ${attempt + 1}: ${String(error).slice(0, 300)}`);
    }
  }
  throw new Error(`gave up on ${url}: ${String(lastError).slice(0, 300)}`);
}

/**
 * Best-effort probe: a candidate that does not exist should not abort
 * discovery. Discovery probes do not retry — most of them are *expected* to
 * miss, and backing off on each would turn a listing into minutes of waiting.
 */
async function tryFetchJson(url: string, retries = 0): Promise<Record<string, unknown> | null> {
  try {
    return await fetchJson(url, retries);
  } catch {
    return null;
  }
}

interface LayerCandidate {
  queryUrl: string;
  label: string;
}

/**
 * Walks the candidate organisations and returns every polygon layer that could
 * plausibly be the NPU boundary layer, most likely first.
 */
async function discoverLayers(): Promise<LayerCandidate[]> {
  const candidates: LayerCandidate[] = [];

  for (const org of CANDIDATE_ORGS) {
    console.log(`\nlisting services: ${org}`);
    const directory = await tryFetchJson(`${org}?f=json`);
    if (!directory) continue;

    const services = Array.isArray(directory.services) ? directory.services : [];
    const named = services
      .map((entry) => entry as { name?: unknown; type?: unknown })
      .filter((entry) => typeof entry.name === "string" && entry.type === "FeatureServer")
      .map((entry) => String(entry.name));
    console.log(`  ${named.length} feature services; NPU-ish: ${named.filter((n) => SERVICE_NAME_PATTERN.test(n)).join(", ") || "(none)"}`);

    for (const service of named.filter((name) => SERVICE_NAME_PATTERN.test(name))) {
      // A service name can already carry its folder, so it is used verbatim.
      const serviceUrl = `${org.replace(/\/services$/, "/services")}/${service.split("/").pop() ?? service}/FeatureServer`;
      const metadata = await tryFetchJson(`${serviceUrl}?f=json`);
      if (!metadata) continue;
      const layers = Array.isArray(metadata.layers) ? metadata.layers : [];
      for (const raw of layers) {
        const layer = raw as { id?: unknown; name?: unknown; geometryType?: unknown };
        if (typeof layer.id !== "number") continue;
        if (layer.geometryType !== undefined && layer.geometryType !== "esriGeometryPolygon") continue;
        candidates.push({
          queryUrl: `${serviceUrl}/${layer.id}/query`,
          label: `${service}/FeatureServer/${layer.id} (${String(layer.name ?? "?")})`,
        });
      }
    }
  }
  return candidates;
}

/** Shoelace signed area. Esri marks outer rings clockwise (negative here) and holes the other way. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * Converts an Esri JSON polygon (`rings`) to GeoJSON. Needed because not every
 * FeatureServer supports `f=geojson`; when one does, this is never called.
 * Ring winding carries the outer/hole distinction, so it decides the grouping
 * rather than assuming ring order.
 */
function ringsToGeometry(rings: number[][][]): Geometry {
  const polygons: number[][][][] = [];
  for (const ring of rings) {
    if (signedArea(ring) < 0) polygons.push([ring]);
    else if (polygons.length) polygons[polygons.length - 1].push(ring);
    else polygons.push([ring]);
  }
  if (!polygons.length) throw new Error("Esri polygon carried no rings");
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

/** Walks a Polygon/MultiPolygon coordinate tree, counting positions and bounds-checking each. */
function inspectCoordinates(coordinates: unknown, npu: string): number {
  let vertices = 0;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) throw new Error(`NPU ${npu}: geometry contains a non-array node`);
    if (typeof node[0] === "number") {
      const [lon, lat] = node as number[];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`NPU ${npu}: non-finite coordinate`);
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

function readNpuLetter(properties: Record<string, unknown>): string | null {
  for (const field of NPU_FIELDS) {
    const value = properties[field];
    if (typeof value !== "string") continue;
    // Hub items label these variously as "Q", "NPU Q" or "NPU-Q".
    const match = /^(?:NPU[\s-]*)?([A-Z])$/i.exec(value.trim());
    if (match) return match[1].toUpperCase();
  }
  return null;
}

interface Checked {
  feature: GeoJsonFeature;
  npu: string;
  vertices: number;
}

/** Turns one query response — GeoJSON or Esri JSON — into checked features, or throws. */
function checkResponse(payload: Record<string, unknown>): Checked[] {
  if (payload.exceededTransferLimit) {
    throw new Error("the service paginated the response — refusing to write a partial layer");
  }

  const rawFeatures = Array.isArray(payload.features) ? payload.features : null;
  if (!rawFeatures) throw new Error(`response carries no features array (keys: ${Object.keys(payload).join(", ")})`);

  return rawFeatures.map((raw): Checked => {
    const entry = raw as {
      properties?: Record<string, unknown>;
      attributes?: Record<string, unknown>;
      geometry?: { type?: unknown; coordinates?: unknown; rings?: unknown };
    };
    const properties = entry.properties ?? entry.attributes ?? {};
    const npu = readNpuLetter(properties);
    if (!npu) {
      throw new Error(
        `a feature carries no readable NPU letter in ${NPU_FIELDS.join("/")}: `
        + JSON.stringify(properties).slice(0, 200),
      );
    }

    const source = entry.geometry;
    if (!source) throw new Error(`NPU ${npu}: feature has no geometry`);
    let geometry: Geometry;
    if (source.type === "Polygon" || source.type === "MultiPolygon") {
      geometry = { type: source.type, coordinates: source.coordinates };
    } else if (Array.isArray(source.rings)) {
      geometry = ringsToGeometry(source.rings as number[][][]);
    } else {
      throw new Error(`NPU ${npu}: unsupported geometry ${JSON.stringify(source.type ?? Object.keys(source))}`);
    }

    const vertices = inspectCoordinates(geometry.coordinates, npu);

    // `NPU` is the property the frontend map and the ingest NPU join both read
    // (see PulseMap.tsx and ingest/normalize.ts). Every other published field is
    // kept as-is for provenance.
    const rest = { ...properties };
    for (const field of NPU_FIELDS) delete rest[field];
    return { feature: { type: "Feature", properties: { NPU: npu, ...rest }, geometry }, npu, vertices };
  });
}

/** Everything the committed file has to satisfy before it is allowed to be written. */
function assertCompleteLayer(features: Checked[]): void {
  const letters = features.map((entry) => entry.npu).sort();
  const duplicates = letters.filter((letter, index) => letters.indexOf(letter) !== index);
  if (duplicates.length) throw new Error(`duplicate NPU letters: ${[...new Set(duplicates)].join(", ")}`);

  const missing = EXPECTED_NPUS.filter((letter) => !letters.includes(letter));
  const unexpected = letters.filter((letter) => !EXPECTED_NPUS.includes(letter));
  if (missing.length || unexpected.length) {
    throw new Error(`NPU letter set mismatch — missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`);
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
}

async function main(): Promise<void> {
  const candidates = await discoverLayers();
  if (!candidates.length) throw new Error("no NPU-looking polygon layer was found in any candidate organisation");
  console.log(`\n${candidates.length} candidate layer(s):`);
  for (const candidate of candidates) console.log(`  ${candidate.label}`);

  const failures: string[] = [];
  for (const candidate of candidates) {
    // f=geojson first (already WGS84 lon/lat); f=json is the fallback for a
    // service that does not advertise GeoJSON output.
    for (const format of ["geojson", "json"] as const) {
      const url = `${candidate.queryUrl}?where=1%3D1&outFields=*&outSR=4326&returnGeometry=true&f=${format}`;
      console.log(`\ntrying ${candidate.label} as f=${format}`);
      const payload = await tryFetchJson(url, RETRY_DELAYS_MS.length);
      if (!payload) {
        failures.push(`${candidate.label} f=${format}: request failed`);
        continue;
      }
      try {
        const features = checkResponse(payload);
        assertCompleteLayer(features);

        const ordered = [...features].sort((a, b) => a.npu.localeCompare(b.npu));
        const collection = { type: "FeatureCollection" as const, features: ordered.map((entry) => entry.feature) };
        const json = JSON.stringify(collection);
        writeFileSync(OUTPUT_PATH, `${json}\n`);

        console.log("\n=== NPU boundary layer ===");
        console.log(`source:   ${url}`);
        console.log(`features: ${collection.features.length}`);
        console.log(`wrote:    ${OUTPUT_PATH} (${(json.length / 1024).toFixed(0)} KiB)`);
        console.log("vertices per NPU:");
        for (const entry of ordered) {
          console.log(`  ${entry.npu}  ${String(entry.vertices).padStart(5)}  ${entry.feature.geometry.type}`);
        }
        const q = ordered.find((entry) => entry.npu === "Q");
        console.log(`\nNPU Q vertex count: ${q ? q.vertices : "MISSING"}`);
        return;
      } catch (error: unknown) {
        const reason = `${candidate.label} f=${format}: ${String(error).slice(0, 300)}`;
        console.error(`  rejected — ${reason}`);
        failures.push(reason);
      }
    }
  }

  throw new Error(`no candidate layer validated. Reasons:\n  ${failures.join("\n  ")}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
