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

export interface CensusMatchResult {
  id: string;
  matched: boolean;
  lon: number | null;
  lat: number | null;
}

/**
 * Parses the Census batch geocoder's response CSV. Columns (unquoted commas
 * split fields the same as any other CSV row): unique_id, input address,
 * match indicator, match type, matched address, longitude, latitude, tiger
 * line id, side. Unmatched rows only carry the first three columns.
 *
 * A result counts as matched only when the Census match indicator says
 * "Match" AND the coordinates parse to finite numbers inside Atlanta's bbox —
 * a match outside metro Atlanta is treated as a bad geocode, never fabricated.
 */
export function parseCensusBatchResponse(text: string): CensusMatchResult[] {
  return parseCsvRows(text).map((fields): CensusMatchResult => {
    const id = (fields[0] ?? "").trim();
    const matchIndicator = (fields[2] ?? "").trim().toLowerCase();
    const lon = Number(fields[5]);
    const lat = Number(fields[6]);
    const isGoodMatch = matchIndicator === "match"
      && Number.isFinite(lon) && Number.isFinite(lat) && isWithinAtlantaBounds(lon, lat);
    return isGoodMatch ? { id, matched: true, lon, lat } : { id, matched: false, lon: null, lat: null };
  });
}
