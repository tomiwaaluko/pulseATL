import { parseCsvRows } from "./sources.js";
import type { RawRecord } from "./sources.js";

/** Every fixture row geocodes against Georgia; ATL311 only covers metro Atlanta. */
const GEOCODE_STATE = "GA";

/** Atlanta metro bounding box. Anything outside this is treated as a bad match. */
export const ATLANTA_BOUNDS = { minLon: -84.6, maxLon: -84.2, minLat: 33.6, maxLat: 33.9 } as const;

export interface GeocodableAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the street/city/state/zip the Census batch geocoder expects from one
 * raw ATL311 fixture row. Returns null when there isn't enough address data to
 * plausibly geocode (no street, or neither a real city nor a ZIP).
 */
export function buildAtl311Address(row: RawRecord): GeocodableAddress | null {
  const street = [row["Street #"], row["Street Name"], row["Street Type"]]
    .map(asText)
    .filter(Boolean)
    .join(" ");
  if (!street) return null;

  // "City/County" sometimes holds a county name (e.g. "FULTON COUNTY"), which the
  // geocoder cannot resolve as a city — drop it and lean on the ZIP instead.
  const rawCity = asText(row["City/County"]);
  const city = rawCity && !/county/i.test(rawCity) ? rawCity : "";
  const zip = asText(row["Postal Code"]);
  if (!city && !zip) return null;

  return { street, city, state: GEOCODE_STATE, zip };
}

/** RFC 4180 field escaping for the addressFile CSV the batch geocoder consumes. */
export function escapeCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildAddressCsvLine(id: string, address: GeocodableAddress): string {
  return [id, address.street, address.city, address.state, address.zip]
    .map(escapeCsvField)
    .join(",");
}

/** Builds the full (header-less) addressFile body for one batch geocoder request. */
export function buildAddressBatchCsv(entries: ReadonlyArray<{ id: string; address: GeocodableAddress }>): string {
  return entries.map(({ id, address }) => buildAddressCsvLine(id, address)).join("\r\n");
}

export function isWithinAtlantaBounds(lon: number, lat: number): boolean {
  return lon >= ATLANTA_BOUNDS.minLon && lon <= ATLANTA_BOUNDS.maxLon
    && lat >= ATLANTA_BOUNDS.minLat && lat <= ATLANTA_BOUNDS.maxLat;
}

/**
 * Why a row produced no coordinates. Kept distinct because the three cases call
 * for different fixes: `no_match` is an address the Census cannot resolve,
 * `out_of_bounds` means our Atlanta bbox rejected a coordinate the Census was
 * happy with, and `unparseable` means the response was not the CSV we expect —
 * usually an error page returned with HTTP 200.
 */
export type CensusMatchOutcome = "match" | "no_match" | "out_of_bounds" | "unparseable";

export interface CensusMatchResult {
  id: string;
  matched: boolean;
  lon: number | null;
  lat: number | null;
  outcome: CensusMatchOutcome;
}

/**
 * Splits the Census coordinate column. The batch geocoder returns the pair as a
 * SINGLE quoted field — `"-84.360083935273,33.785434545476"` — in
 * longitude,latitude order, not as two adjacent columns. Reading it as two
 * columns silently yields NaN for the longitude and the TIGER line ID for the
 * latitude, which is how this originally failed on all 160 matched rows.
 */
function parseCoordinatePair(field: string | undefined): { lon: number; lat: number } | null {
  const parts = (field ?? "").split(",");
  if (parts.length !== 2) return null;
  const lon = Number(parts[0].trim());
  const lat = Number(parts[1].trim());
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

/**
 * Parses the Census batch geocoder's response CSV. Columns, as observed in a
 * real response (every field quoted, no header row): unique_id, input address,
 * match indicator, match type, matched address, "longitude,latitude", tiger
 * line id, side. Unmatched rows only carry the first three columns.
 *
 * A result counts as matched only when the Census match indicator says
 * "Match" AND the coordinates parse to finite numbers inside Atlanta's bbox —
 * a match outside metro Atlanta is treated as a bad geocode, never fabricated.
 */
export function parseCensusBatchResponse(text: string): CensusMatchResult[] {
  const isBlankRow = (fields: string[]): boolean => fields.every((field) => field.trim() === "");

  return parseCsvRows(text)
    .filter((fields) => !isBlankRow(fields))
    .map((fields): CensusMatchResult => {
      const id = (fields[0] ?? "").trim();
      const matchIndicator = (fields[2] ?? "").trim().toLowerCase();

      const unmatched = (outcome: CensusMatchOutcome): CensusMatchResult =>
        ({ id, matched: false, lon: null, lat: null, outcome });

      // A response that is not the CSV we expect (an HTML error page returned
      // with HTTP 200, say) lands here: too few columns to even hold a verdict.
      if (fields.length < 3) return unmatched("unparseable");
      if (matchIndicator !== "match") return unmatched("no_match");

      const point = parseCoordinatePair(fields[5]);
      if (point === null) return unmatched("unparseable");
      if (!isWithinAtlantaBounds(point.lon, point.lat)) return unmatched("out_of_bounds");
      return { id, matched: true, lon: point.lon, lat: point.lat, outcome: "match" };
    });
}
