import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { Incident, SourceId } from "../types.js";
import { buildNpuIndex, type NpuIndex } from "./normalize.js";

/** One untyped source row exactly as the portal publishes it. */
export type RawRecord = Record<string, unknown>;

/** Milliseconds in a day — the seed date shift only moves whole days. */
export const MILLIS_PER_DAY = 86_400_000;

const BACKEND_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(BACKEND_ROOT, "..");

/** Committed WGS84 NPU boundaries (SOURCES.md “NPU boundary layer”). */
export const NPU_GEOJSON_PATH = join(REPO_ROOT, "frontend", "data", "npus.geojson");

export interface SourceDefinition {
  readonly id: SourceId;
  /** Documented live endpoint (SOURCES.md). Portal egress may be blocked in CI/sandboxes. */
  readonly liveUrl: string;
  /** Committed sample of unaltered source rows, used by `--seed`. */
  readonly fixturePath: string;
  readFixture(): RawRecord[];
  fetchLive(): Promise<RawRecord[]>;
}

function fixturePath(name: string): string {
  return join(BACKEND_ROOT, "test", "fixtures", name);
}

function readJsonArray(path: string): RawRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new TypeError(`Fixture ${path} is not a JSON array`);
  return parsed.filter((row): row is RawRecord => typeof row === "object" && row !== null);
}

/** A stalled portal must abort rather than hang the whole batch. */
const FETCH_TIMEOUT_MS = 180_000;

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * RFC 4180 row splitter, header-agnostic. Both the source portals and the Census
 * batch geocoder publish CSV where quoted fields carry commas and newlines, so a
 * naive split loses rows.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.replace(/^﻿/, "");

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (body[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") endField();
    else if (char === "\n") endRow();
    else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length) endRow();

  return rows;
}

/** RFC 4180 CSV reader that maps rows onto their header row. */
export function parseCsv(text: string): RawRecord[] {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) return [];
  return rows.map((values) => {
    const record: RawRecord = {};
    header.forEach((column, index) => {
      record[column.trim()] = values[index] ?? "";
    });
    return record;
  });
}

/**
 * Read one member out of a gzipped tar without adding a dependency: POSIX tar is
 * 512-byte header blocks (name at 0, octal size at 124, type flag at 156) followed
 * by 512-byte-padded content.
 */
export function extractFromTarGz(archive: Buffer, matches: (name: string) => boolean): string {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/, "").trim();
    if (!name) break;
    const size = parseInt(tar.toString("utf8", offset + 124, offset + 136).replace(/\0.*$/, "").trim() || "0", 8);
    const typeFlag = tar.toString("utf8", offset + 156, offset + 157);
    const start = offset + 512;
    // macOS-created archives carry an AppleDouble sidecar (`._name`) next to the
    // real member; it matches the same name pattern but holds binary metadata.
    const basename = name.slice(name.lastIndexOf("/") + 1);
    const isSidecar = basename.startsWith("._") || name.includes("PaxHeader");
    if ((typeFlag === "0" || typeFlag === "\0") && !isSidecar && matches(name)) {
      return tar.toString("utf8", start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error("Archive does not contain the expected CSV member");
}

/** APD publishes `occur_date` + `occur_time`; the fixture carries the joined ISO value. */
export function withApdOccurredAt(row: RawRecord): RawRecord {
  if (typeof row.occur_datetime === "string" && row.occur_datetime.trim()) return row;
  const date = typeof row.occur_date === "string" ? row.occur_date.trim() : "";
  if (!date) return row;
  const time = typeof row.occur_time === "string" && row.occur_time.trim() ? row.occur_time.trim() : "00:00:00";
  return { ...row, occur_datetime: `${date}T${time}Z` };
}

const APD_CRIME: SourceDefinition = {
  id: "apd_crime",
  liveUrl: "https://raw.githubusercontent.com/CivicTechAtlanta/apd-crime-data/master/Data/crime_data.csv",
  fixturePath: fixturePath("apd_crime.sample.json"),
  readFixture: () => readJsonArray(APD_CRIME.fixturePath),
  fetchLive: async () => parseCsv((await fetchBuffer(APD_CRIME.liveUrl)).toString("utf8")).map(withApdOccurredAt),
};

const ATL311: SourceDefinition = {
  id: "atl311",
  liveUrl: "https://github.com/brian-murphy/atl-311-parser/raw/master/311-data.tar.gz",
  fixturePath: fixturePath("atl311_service_requests.sample.json"),
  readFixture: () => readJsonArray(ATL311.fixturePath),
  fetchLive: async () => parseCsv(
    extractFromTarGz(await fetchBuffer(ATL311.liveUrl), (name) => /ATL311 SR Data 2015\.csv$/i.test(name)),
  ),
};

export const SOURCES: readonly SourceDefinition[] = [APD_CRIME, ATL311];

/** Parse the committed NPU boundary layer into the point-in-polygon index. */
export function loadNpuIndex(path: string = NPU_GEOJSON_PATH): NpuIndex {
  return buildNpuIndex(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** Every NPU name in the boundary layer — the report table must cover all of them. */
export function listNpus(path: string = NPU_GEOJSON_PATH): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features)) throw new TypeError("NPU GeoJSON must be a FeatureCollection");
  const names = features
    .map((feature) => (feature as { properties?: { NPU?: unknown } }).properties?.NPU)
    .filter((npu): npu is string => typeof npu === "string" && npu.trim() !== "")
    .map((npu) => npu.trim().toUpperCase());
  return [...new Set(names)].sort();
}

/**
 * Seed mode only: move a source's archived incidents forward so its newest row
 * lands on yesterday.
 *
 * The committed fixtures are archives (APD ≈2016–17, ATL311 = 2015), so an
 * unshifted seed produces zero 90-day counts and an empty-looking demo. The
 * shift is a single whole-day offset applied to every `occurred_at` and
 * `resolved_at` in the batch, so relative deltas — including resolution
 * durations — survive exactly. It is deterministic in `now`, never moves data
 * backwards, and is applied per source: each source's archive covers a
 * different year, and one global offset would leave the older source outside
 * the reporting window entirely.
 */
export function shiftIncidentsToRecent(incidents: Incident[], now: Date): Incident[] {
  if (!incidents.length) return incidents;
  const latest = Math.max(...incidents.map((incident) => incident.occurred_at.getTime()));
  const offsetDays = Math.floor((now.getTime() - MILLIS_PER_DAY - latest) / MILLIS_PER_DAY);
  if (offsetDays <= 0) return incidents;
  const offset = offsetDays * MILLIS_PER_DAY;
  return incidents.map((incident) => ({
    ...incident,
    occurred_at: new Date(incident.occurred_at.getTime() + offset),
    resolved_at: incident.resolved_at ? new Date(incident.resolved_at.getTime() + offset) : null,
  }));
}
