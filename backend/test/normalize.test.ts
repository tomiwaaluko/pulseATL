import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNpuIndex, normalizeRecord } from "../src/ingest/normalize";

const boundary = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { NPU: "V" },
    geometry: { type: "Polygon", coordinates: [[[-85, 33], [-84, 33], [-84, 34], [-85, 34], [-85, 33]]] },
  }],
};

describe("normalization", () => {
  const index = buildNpuIndex(boundary);

  it("maps an APD fixture row into the canonical shape", () => {
    const rows = JSON.parse(readFileSync(resolve(__dirname, "fixtures/apd_crime.sample.json"), "utf8")) as unknown[];
    const incident = normalizeRecord(rows[0], "apd_crime", index);
    expect(incident).toMatchObject({
      id: "apd_crime:170010040",
      source: "apd_crime",
      category: "crime",
      subcategory: "ROBBERY-PEDESTRIAN",
      npu: "V",
    });
    expect(incident?.occurred_at).toEqual(new Date("2017-01-01T00:00:00Z"));
  });

  it("normalizes geocoded ATL311 rows and local timestamps", () => {
    const incident = normalizeRecord({
      "SR #": "123",
      Opened: "9/17/2015 9:36",
      Closed: "9/18/2015 10:00",
      Status: "Closed",
      "Request Type": "Pothole",
      latitude: 33.7,
      longitude: -84.4,
    }, "atl311", index);
    expect(incident).toMatchObject({
      id: "atl311:123",
      category: "infrastructure",
      status: "closed",
      npu: "V",
    });
    expect(incident?.occurred_at.toISOString()).toBe("2015-09-17T13:36:00.000Z");
  });

  it("rejects missing coordinates and points outside Atlanta NPUs", () => {
    expect(normalizeRecord({ offense_id: "1", occur_datetime: "2026-01-01", npu: "V" }, "apd_crime", index)).toBeNull();
    expect(normalizeRecord({ offense_id: "1", occur_datetime: "2026-01-01", x: 0, y: 0 }, "apd_crime", index)).toBeNull();
  });

  it("supports multipolygons and rejects malformed boundary input", () => {
    const multi = buildNpuIndex({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { NPU: "A" }, geometry: {
        type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]],
      } }],
    });
    expect(multi.find(0.5, 0.5)).toBe("A");
    expect(() => buildNpuIndex({})).toThrow(/FeatureCollection/);
  });
});
