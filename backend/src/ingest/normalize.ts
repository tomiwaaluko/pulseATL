import type { Incident, IncidentStatus, SourceId } from "../types";

type Position = [number, number];
type Polygon = Position[][];

export interface NpuIndex {
  find(lon: number, lat: number): string | null;
  has(npu: string): boolean;
}

interface IndexedNpu {
  npu: string;
  polygons: Polygon[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result && result.toUpperCase() !== "NA" ? result : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const result = new Date(text);
  return Number.isNaN(result.getTime()) ? null : result;
}

function atlantaDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return asDate(text);
  const [, month, day, year, hour, minute] = match;
  // These archived rows are local Atlanta wall times. Noon UTC lets Intl tell us
  // whether that date used EST or EDT without depending on the process timezone.
  const probe = new Date(Date.UTC(+year, +month - 1, +day, 12));
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value;
  const offsetHours = Number(zoneName?.match(/GMT([+-]\d+)/)?.[1] ?? -5);
  return new Date(Date.UTC(+year, +month - 1, +day, +hour - offsetHours, +minute));
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Polygon): boolean {
  return polygon.length > 0 && pointInRing(point, polygon[0])
    && polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

function parsePolygons(geometry: Record<string, unknown>): Polygon[] {
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates)) return [];
  if (geometry.type === "Polygon") return [coordinates as Polygon];
  if (geometry.type === "MultiPolygon") return coordinates as Polygon[];
  return [];
}

export function buildNpuIndex(geojson: unknown): NpuIndex {
  if (!isRecord(geojson) || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new TypeError("NPU GeoJSON must be a FeatureCollection");
  }
  const entries: IndexedNpu[] = [];
  for (const feature of geojson.features) {
    if (!isRecord(feature) || !isRecord(feature.properties) || !isRecord(feature.geometry)) continue;
    const npu = asString(feature.properties.NPU)?.toUpperCase();
    const polygons = parsePolygons(feature.geometry);
    if (npu && polygons.length) entries.push({ npu, polygons });
  }
  if (!entries.length) throw new TypeError("NPU GeoJSON contains no usable polygons");
  const names = new Set(entries.map(({ npu }) => npu));
  return {
    has: (npu) => names.has(npu.toUpperCase()),
    find: (lon, lat) => entries.find(({ polygons }) =>
      polygons.some((polygon) => pointInPolygon([lon, lat], polygon)))?.npu ?? null,
  };
}

function normalizeStatus(value: unknown): IncidentStatus {
  const status = asString(value)?.toLowerCase();
  if (!status) return "unknown";
  if (status.includes("closed") || status.includes("complete")) return "closed";
  if (status.includes("open") || status.includes("pending") || status.includes("new")) return "open";
  return "unknown";
}

export function normalizeRecord(raw: unknown, source: SourceId, npuIndex: NpuIndex): Incident | null {
  if (!isRecord(raw)) return null;
  const isApd = source === "apd_crime";
  const nativeId = asString(raw[isApd ? "offense_id" : "SR #"]);
  const occurredAt = isApd ? asDate(raw.occur_datetime) : atlantaDate(raw.Opened);
  const lat = isApd ? asNumber(raw.y) : asNumber(raw.lat ?? raw.latitude);
  const lon = isApd ? asNumber(raw.x) : asNumber(raw.lon ?? raw.longitude);
  if (!nativeId || !occurredAt || lat === null || lon === null) return null;

  const spatialNpu = npuIndex.find(lon, lat);
  const suppliedNpu = isApd ? asString(raw.npu)?.toUpperCase() : null;
  const npu = spatialNpu ?? (suppliedNpu && npuIndex.has(suppliedNpu) ? suppliedNpu : null);
  if (!npu) return null;

  const resolvedAt = isApd ? null : atlantaDate(raw.Closed);
  return {
    id: `${source}:${nativeId}`,
    source,
    category: isApd ? "crime" : "infrastructure",
    subcategory: asString(isApd ? raw["UC2 Literal"] : raw["Request Type"] ?? raw["Incident Type"] ?? raw.Area),
    occurred_at: occurredAt,
    resolved_at: resolvedAt,
    status: isApd ? normalizeStatus(raw.dispo_code) : normalizeStatus(raw.Status),
    lat,
    lon,
    npu,
  };
}
