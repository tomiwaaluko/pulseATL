import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { normalizeRecord } from "../src/ingest/normalize.js";
import {
  MILLIS_PER_DAY,
  SOURCES,
  extractFromTarGz,
  listNpus,
  loadNpuIndex,
  parseCsv,
  shiftIncidentsToRecent,
  withApdOccurredAt,
} from "../src/ingest/sources.js";
import type { Incident } from "../src/types.js";

const NOW = new Date("2026-08-12T16:00:00.000Z");

function source(id: string) {
  const found = SOURCES.find((item) => item.id === id);
  if (!found) throw new Error(`unknown source ${id}`);
  return found;
}

function tarGz(names: string[], contents: string[]): Buffer {
  const blocks = names.flatMap((name, index) => {
    const content = contents[index];
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124, "utf8");
    header.write("0", 156, "utf8");
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    body.write(content, 0, "utf8");
    return [header, body];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "apd_crime:1",
    source: "apd_crime",
    category: "crime",
    subcategory: "LARCENY",
    occurred_at: new Date("2017-01-24T14:00:00.000Z"),
    resolved_at: null,
    status: "unknown",
    lat: 33.75,
    lon: -84.39,
    npu: "V",
    ...overrides,
  };
}

describe("source fixtures", () => {
  it("reads unaltered APD rows that normalize into canonical incidents", () => {
    const npuIndex = loadNpuIndex();
    const rows = source("apd_crime").readFixture();
    expect(rows.length).toBe(250);

    const incidents = rows
      .map((row) => normalizeRecord(row, "apd_crime", npuIndex))
      .filter((item): item is Incident => item !== null);
    expect(incidents.length).toBeGreaterThan(200);
    expect(new Set(incidents.map((item) => item.npu)).size).toBeGreaterThan(10);
    expect(incidents.every((item) => item.source === "apd_crime" && item.category === "crime")).toBe(true);
  });

  it("reads ATL311 rows, geocoded by PULSE-19, and normalizes most into a real NPU", () => {
    const npuIndex = loadNpuIndex();
    const rows = source("atl311").readFixture();
    expect(rows.length).toBe(250);

    // SOURCES.md: backend/scripts/geocode-atl311.ts fills latitude/longitude via
    // the Census batch geocoder. A row still rejects when Census can't match it,
    // the match falls outside the Atlanta bbox, or the address is real but in
    // another Fulton County city outside every NPU polygon — never fabricated.
    const normalized = rows.map((row) => normalizeRecord(row, "atl311", npuIndex));
    expect(normalized.some((item) => item !== null)).toBe(true);
    expect(normalized.some((item) => item === null)).toBe(true);
  });

  it("points each fetcher at its documented endpoint", () => {
    expect(source("apd_crime").liveUrl).toContain("crime_data.csv");
    expect(source("atl311").liveUrl).toContain("311-data.tar.gz");
  });
});

describe("live-fetch parsing", () => {
  it("parses quoted CSV fields containing commas and newlines", () => {
    const rows = parseCsv('offense_id,location,"UC2 Literal"\r\n1,"1192 PRYOR, SW","LARCENY\nFROM VEHICLE"\r\n');
    expect(rows).toEqual([{ offense_id: "1", location: "1192 PRYOR, SW", "UC2 Literal": "LARCENY\nFROM VEHICLE" }]);
  });

  it("joins APD occur_date and occur_time into the timestamp normalize expects", () => {
    expect(withApdOccurredAt({ occur_date: "2017-01-01", occur_time: "00:05:00" }).occur_datetime)
      .toBe("2017-01-01T00:05:00Z");
    expect(withApdOccurredAt({ occur_datetime: "2017-01-01T00:00:00Z", occur_date: "2017-02-02" }).occur_datetime)
      .toBe("2017-01-01T00:00:00Z");
  });

  it("extracts the named CSV member from a gzipped tar, skipping AppleDouble sidecars", () => {
    const archive = tarGz(
      ["./._ATL311 SR Data 2015.csv", "ATL311 SR Data 2015.csv"],
      ["\u0000\u0005\u0016\u0007 Mac OS X metadata", "SR #,Status\n1,Closed\n"],
    );
    expect(parseCsv(extractFromTarGz(archive, (name) => /ATL311 SR Data 2015\.csv$/i.test(name))))
      .toEqual([{ "SR #": "1", Status: "Closed" }]);
    expect(() => extractFromTarGz(archive, (name) => name === "missing.csv")).toThrow(/expected CSV member/);
  });
});

describe("NPU boundary layer", () => {
  it("exposes all 25 NPU names and a working point-in-polygon index", () => {
    const npus = listNpus();
    expect(npus.length).toBe(25);
    expect(npus).toContain("Q");
    expect(npus).not.toContain("U");
    expect(loadNpuIndex().find(-84.39375, 33.72164)).toBe("V");
  });
});

describe("seed date shift", () => {
  it("moves the newest incident to about yesterday", () => {
    const shifted = shiftIncidentsToRecent([incident()], NOW);
    const age = NOW.getTime() - shifted[0].occurred_at.getTime();
    expect(age).toBeGreaterThanOrEqual(MILLIS_PER_DAY);
    expect(age).toBeLessThan(2 * MILLIS_PER_DAY);
  });

  it("preserves relative deltas and resolution durations", () => {
    const older = incident({ id: "a", occurred_at: new Date("2017-01-01T00:00:00.000Z") });
    const newest = incident({
      id: "b",
      occurred_at: new Date("2017-01-24T14:00:00.000Z"),
      resolved_at: new Date("2017-01-26T14:00:00.000Z"),
    });
    const [shiftedOlder, shiftedNewest] = shiftIncidentsToRecent([older, newest], NOW);

    expect(shiftedNewest.occurred_at.getTime() - shiftedOlder.occurred_at.getTime())
      .toBe(newest.occurred_at.getTime() - older.occurred_at.getTime());
    expect(shiftedNewest.resolved_at!.getTime() - shiftedNewest.occurred_at.getTime())
      .toBe(2 * MILLIS_PER_DAY);
    expect(shiftedOlder.resolved_at).toBeNull();
  });

  it("is deterministic and never moves already-current data backwards", () => {
    const recent = incident({ occurred_at: new Date(NOW.getTime() - 3600_000) });
    expect(shiftIncidentsToRecent([recent], NOW)[0].occurred_at).toEqual(recent.occurred_at);
    expect(shiftIncidentsToRecent([incident()], NOW)).toEqual(shiftIncidentsToRecent([incident()], NOW));
    expect(shiftIncidentsToRecent([], NOW)).toEqual([]);
  });

  it("brings the APD fixture into the 90-day window for many NPUs", () => {
    const npuIndex = loadNpuIndex();
    const incidents = shiftIncidentsToRecent(
      source("apd_crime").readFixture()
        .map((row) => normalizeRecord(row, "apd_crime", npuIndex))
        .filter((item): item is Incident => item !== null),
      NOW,
    );
    const recentNpus = new Set(
      incidents
        .filter((item) => NOW.getTime() - item.occurred_at.getTime() <= 90 * MILLIS_PER_DAY)
        .map((item) => item.npu),
    );
    expect(recentNpus.size).toBeGreaterThan(5);
  });
});
