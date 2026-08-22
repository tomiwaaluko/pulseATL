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
 * Parses the Census batch geocoder's response CSV: unique_id, input address,
 * match indicator, match type, matched address, then coordinates, TIGER line
 * ID, and side. Unmatched rows only carry the first three columns.
 *
 * The coordinates column is documented as one "longitude,latitude" value, but
 * whether Census quotes it varies by response — quoted, it survives
 * RFC 4180 parsing as a single field; unquoted, the same parser splits it on
 * its internal comma into two plain fields. Rather than guess, this locates
 * coordinates by position from the *end* of the row (the trailing TIGER line
 * ID and side are always exactly two fields) and handles both shapes.
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

      // The coordinates column is documented as one "longitude,latitude" value,
      // but whether Census quotes it varies by response — quoted, it survives
      // RFC 4180 parsing as a single field; unquoted, the same parser splits it
      // on its internal comma into two plain fields. Locate it by position from
      // the row's *end* (TIGER line ID and side are always the trailing two
      // fields) so both shapes work without guessing which one Census sent.
      const coordFields = fields.slice(5, fields.length - 2);
      const [lonText, latText] = coordFields.length === 1 ? coordFields[0].split(",") : coordFields;
      const lon = Number(lonText);
      const lat = Number(latText);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return unmatched("unparseable");
      if (!isWithinAtlantaBounds(lon, lat)) return unmatched("out_of_bounds");
      return { id, matched: true, lon, lat, outcome: "match" };
    });
}

/**
 * ---------------------------------------------------------------------------
 * Address cleaning and retry variants (PULSE-19 follow-up)
 * ---------------------------------------------------------------------------
 *
 * The first real geocode run left a large block of rows unmatched. Reading the
 * failures back showed three repeatable causes, none of which need a different
 * data source to fix:
 *
 *  1. Unit noise — "APT 3", "STE 200", "#4" trailing the street line.
 *  2. Contracted street names the Census gazetteer spells out in full
 *     ("R D ABERNATHY BLVD", "FOREST PK RD", "ST DAVID ST").
 *  3. Missing Atlanta quadrant. Atlanta reuses the same house number and street
 *     name in NE/NW/SE/SW, so an address without a quadrant is ambiguous and
 *     the Census answers `Tie` rather than `Match`.
 *
 * Everything below only ever *rewrites the query*. A coordinate still has to
 * come back from the Census for a row to be filled in, and the quadrant retry
 * accepts a result only when exactly one quadrant matches — see
 * `resolveQuadrantCandidates`. No coordinate is ever inferred, copied from a
 * neighbouring row, or approximated from a ZIP or city centroid.
 */

/** Atlanta's four street quadrants, in the order the retry pass sends them. */
export const ATLANTA_QUADRANTS = ["NE", "NW", "SE", "SW"] as const;

export type AtlantaQuadrant = (typeof ATLANTA_QUADRANTS)[number];

/**
 * Trailing unit designators. Anchored to the end so a street genuinely named
 * "Lot Line Rd" or "Room Rd" is untouched — only a designator that trails the
 * whole line, with or without its number, is removed.
 */
const TRAILING_UNIT = /[\s,]+(?:#\s*[\w-]+|(?:APT|APARTMENT|UNIT|STE|SUITE|BLDG|BUILDING|FL|FLR|FLOOR|RM|ROOM|TRLR|SPC|SPACE|DEPT)\.?(?:\s*#?\s*[\w-]+)?)$/i;

/**
 * Contractions the ATL311 call-centre typed that the Census gazetteer stores
 * spelled out. Applied as whole words only, so "ST" as a street *type* at the
 * end of the line (…" MAIN ST") is left alone by the trailing-token guard.
 */
const NAME_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bR\s+D\s+ABERNATHY\b/gi, "RALPH DAVID ABERNATHY"],
  [/\bRD\s+ABERNATHY\b/gi, "RALPH DAVID ABERNATHY"],
  [/\bM\s*L\s*K(?:\s+JR)?\b/gi, "MARTIN LUTHER KING JR"],
  [/\bM\s+L\s+KING(?:\s+JR)?\b/gi, "MARTIN LUTHER KING JR"],
  [/\bPK\b/gi, "PARK"],
  [/\bMT\b/gi, "MOUNT"],
  [/\bFT\b/gi, "FORT"],
];

/**
 * Everything from the first intersection marker onward — "MAIN ST / 5TH AVE".
 * Deliberately narrow: only "/", "&" and a free-standing "AND" count. "AT" is
 * excluded because it appears inside ordinary street names far too often to
 * treat as a separator.
 */
const INTERSECTION_TAIL = /\s*(?:\/|\s*&\s*|\sAND\s)[\s\S]*$/i;

/**
 * Normalises one street line for the Census batch geocoder.
 *
 * Order matters: the intersection tail goes first (so a unit designator on the
 * *second* cross street cannot survive), then unit designators are stripped
 * repeatedly ("… APT 3 #B" carries two), then contractions are expanded.
 *
 * "ST" is expanded to "SAINT" only when another word follows it, so it is read
 * as a name prefix ("ST DAVID ST" -> "SAINT DAVID ST") and never as the street
 * type that ends the line.
 */
export function cleanStreetLine(street: string): string {
  let cleaned = street.replace(INTERSECTION_TAIL, "");
  cleaned = cleaned.replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();

  let previous = "";
  while (previous !== cleaned) {
    previous = cleaned;
    cleaned = cleaned.replace(TRAILING_UNIT, "").trim();
  }

  cleaned = cleaned.replace(/\bST\b(?=\s+\S)/gi, "SAINT");
  for (const [pattern, replacement] of NAME_EXPANSIONS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/** True when the street line starts with a house number the Census can anchor to. */
export function hasHouseNumber(street: string): boolean {
  return /^\d/.test(street.trim());
}

/**
 * Which rewrite produced a candidate. Reported per pass so a run says which
 * repair actually earned its coordinates rather than claiming credit vaguely.
 */
export type AddressVariantKind = "base" | "cleaned" | "zip_only" | "city_only" | "quadrant";

export interface AddressVariant {
  readonly kind: AddressVariantKind;
  /** Set only for `quadrant` variants; `null` for every other kind. */
  readonly quadrant: AtlantaQuadrant | null;
  readonly address: GeocodableAddress;
}

function sameAddress(a: GeocodableAddress, b: GeocodableAddress): boolean {
  return a.street === b.street && a.city === b.city && a.state === b.state && a.zip === b.zip;
}

/**
 * Ordered retry candidates for one ATL311 row, most faithful first.
 *
 * - `base`      — the address exactly as `buildAtl311Address` builds it today.
 * - `cleaned`   — unit noise removed and contractions expanded.
 * - `zip_only`  — cleaned street + ZIP, city dropped (the export's city column
 *                 is often the billing city rather than the service address's).
 * - `city_only` — cleaned street + city, ZIP dropped (the mirror-image error).
 * - `quadrant`  — cleaned street with each Atlanta quadrant appended. Only
 *                 emitted for a street that carries a house number and no
 *                 quadrant already; a caller must accept these solely through
 *                 `resolveQuadrantCandidates`.
 *
 * Duplicates are dropped, so a row whose cleaned street is unchanged is not
 * sent to the Census twice.
 */
export function buildAtl311AddressVariants(row: RawRecord): AddressVariant[] {
  const base = buildAtl311Address(row);
  if (!base) return [];

  const variants: AddressVariant[] = [{ kind: "base", quadrant: null, address: base }];
  const push = (kind: AddressVariantKind, quadrant: AtlantaQuadrant | null, address: GeocodableAddress): void => {
    if (!address.street) return;
    if (!address.city && !address.zip) return;
    if (variants.some((variant) => sameAddress(variant.address, address))) return;
    variants.push({ kind, quadrant, address });
  };

  const street = cleanStreetLine(base.street);
  push("cleaned", null, { ...base, street });
  push("zip_only", null, { ...base, street, city: "" });
  push("city_only", null, { ...base, street, zip: "" });

  const hasQuadrant = new RegExp(`\\b(?:${ATLANTA_QUADRANTS.join("|")})$`, "i").test(street);
  if (hasHouseNumber(street) && !hasQuadrant) {
    for (const quadrant of ATLANTA_QUADRANTS) {
      push("quadrant", quadrant, { ...base, street: `${street} ${quadrant}` });
    }
  }
  return variants;
}

/**
 * Picks the coordinate for a row whose quadrant was unknown.
 *
 * Atlanta reuses house numbers across NE/NW/SE/SW, so appending a quadrant is a
 * question, not an answer. The ZIP in the query is what makes the question
 * answerable: a quadrant that does not exist inside that ZIP simply fails to
 * match. Exactly one surviving match is a real disambiguation; two or more
 * means the address is genuinely ambiguous and the row stays null rather than
 * being assigned one of several plausible points.
 */
export function resolveQuadrantCandidates(
  candidates: ReadonlyArray<CensusMatchResult>,
): { lon: number; lat: number } | null {
  const matched = candidates.filter(
    (candidate): candidate is CensusMatchResult & { lon: number; lat: number } =>
      candidate.matched && candidate.lon !== null && candidate.lat !== null,
  );
  if (matched.length !== 1) return null;
  return { lon: matched[0].lon, lat: matched[0].lat };
}
