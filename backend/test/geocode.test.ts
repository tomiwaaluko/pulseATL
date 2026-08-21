import { describe, expect, it } from "vitest";

import {
  buildAddressBatchCsv,
  buildAddressCsvLine,
  buildAtl311Address,
  escapeCsvField,
  isWithinAtlantaBounds,
  parseCensusBatchResponse,
} from "../src/ingest/geocode.js";

describe("buildAtl311Address", () => {
  it("joins the real ATL311 street fields and keeps a real city", () => {
    const address = buildAtl311Address({
      "Street #": "6745",
      "Street Name": "CEDAR HURST",
      "Street Type": "TRL",
      "City/County": "ATLANTA",
      "Postal Code": "30349",
    });
    expect(address).toEqual({ street: "6745 CEDAR HURST TRL", city: "ATLANTA", state: "GA", zip: "30349" });
  });

  it("drops a county name and leans on the ZIP instead", () => {
    const address = buildAtl311Address({
      "Street #": "100",
      "Street Name": "MAIN",
      "Street Type": "ST",
      "City/County": "FULTON COUNTY",
      "Postal Code": "30303",
    });
    expect(address).toEqual({ street: "100 MAIN ST", city: "", state: "GA", zip: "30303" });
  });

  it("returns null when there is no street to geocode", () => {
    expect(buildAtl311Address({ "City/County": "ATLANTA", "Postal Code": "30303" })).toBeNull();
  });

  it("returns null when there is a street but neither a real city nor a ZIP", () => {
    expect(buildAtl311Address({
      "Street #": "100",
      "Street Name": "MAIN",
      "Street Type": "ST",
      "City/County": "FULTON COUNTY",
      "Postal Code": "",
    })).toBeNull();
  });
});

describe("CSV row building", () => {
  it("leaves plain fields unescaped", () => {
    expect(escapeCsvField("ATLANTA")).toBe("ATLANTA");
  });

  it("quotes and doubles internal quotes for fields with commas", () => {
    expect(escapeCsvField('123 Main St, Apt "B"')).toBe('"123 Main St, Apt ""B"""');
  });

  it("builds a single addressFile row in unique_id,street,city,state,zip order", () => {
    const line = buildAddressCsvLine("129213674", { street: "6745 CEDAR HURST TRL", city: "ATLANTA", state: "GA", zip: "30349" });
    expect(line).toBe("129213674,6745 CEDAR HURST TRL,ATLANTA,GA,30349");
  });

  it("escapes a comma-bearing street within a full batch", () => {
    const csv = buildAddressBatchCsv([
      { id: "1", address: { street: "100 Main St, Suite 2", city: "ATLANTA", state: "GA", zip: "30303" } },
      { id: "2", address: { street: "200 Peachtree St", city: "ATLANTA", state: "GA", zip: "30303" } },
    ]);
    expect(csv).toBe(
      '1,"100 Main St, Suite 2",ATLANTA,GA,30303\r\n2,200 Peachtree St,ATLANTA,GA,30303',
    );
  });
});

describe("isWithinAtlantaBounds", () => {
  it("accepts a point inside the metro Atlanta bbox", () => {
    expect(isWithinAtlantaBounds(-84.388, 33.749)).toBe(true);
  });

  it("rejects a point outside the bbox", () => {
    expect(isWithinAtlantaBounds(-73.99, 40.73)).toBe(false); // New York
  });
});

describe("parseCensusBatchResponse", () => {
  // Captured verbatim from a real Census batch response (workflow run 32516369127).
  // Two details only a real response shows: every field is quoted, and the
  // coordinates arrive as ONE field holding "longitude,latitude" — not as two
  // adjacent columns. An earlier hand-written fixture guessed two columns, so the
  // tests passed against a parser that could not read an actual response.
  const REAL_MATCH_ROW =
    '"129186129","844 BROOKRIDGE DR, ATLANTA, GA, 30306","Match","Non_Exact",'
    + '"844 BROOKRIDGE DR NE, ATLANTA, GA, 30306","-84.360083935273,33.785434545476","17356888","L"';

  it("parses a real matched row, splitting the combined coordinate field", () => {
    const [result] = parseCensusBatchResponse(REAL_MATCH_ROW);

    expect(result).toEqual({
      id: "129186129",
      matched: true,
      lon: -84.360083935273,
      lat: 33.785434545476,
      outcome: "match",
    });
  });

  it("does not swap longitude and latitude", () => {
    const [result] = parseCensusBatchResponse(REAL_MATCH_ROW);

    // Atlanta is near 33.75 N, 84.39 W: latitude is positive, longitude negative.
    expect(result.lon).toBeLessThan(0);
    expect(result.lat).toBeGreaterThan(0);
  });

  it("never reads the TIGER line id as a latitude", () => {
    const [result] = parseCensusBatchResponse(REAL_MATCH_ROW);

    expect(result.lat).not.toBe(17356888);
  });

  it("marks a No_Match row as unmatched", () => {
    const response = '"2","9999 NOWHERE RD, ATLANTA, GA, 30303","No_Match"';
    const [result] = parseCensusBatchResponse(response);

    expect(result).toEqual({ id: "2", matched: false, lon: null, lat: null, outcome: "no_match" });
  });

  it("rejects a match whose coordinates fall outside Atlanta (never fabricates)", () => {
    const response =
      '"3","1 INFINITE LOOP, CUPERTINO, CA, 95014","Match","Exact",'
      + '"1 INFINITE LOOP, CUPERTINO, CA, 95014","-122.03,37.33","1","L"';
    const [result] = parseCensusBatchResponse(response);

    expect(result).toEqual({ id: "3", matched: false, lon: null, lat: null, outcome: "out_of_bounds" });
  });

  it("flags a coordinate field that is not a pair as unparseable", () => {
    const response =
      '"4","100 MAIN ST, ATLANTA, GA, 30303","Match","Exact","100 MAIN ST","-84.39","1","L"';
    const [result] = parseCensusBatchResponse(response);

    expect(result.outcome).toBe("unparseable");
    expect(result.matched).toBe(false);
  });

  it("flags a non-CSV response (HTML error page under HTTP 200) as unparseable", () => {
    const results = parseCensusBatchResponse("<html><body>Service Unavailable</body></html>");

    expect(results.every((result) => result.outcome === "unparseable")).toBe(true);
    expect(results.every((result) => result.matched === false)).toBe(true);
  });

  it("ignores blank rows from a trailing newline", () => {
    expect(parseCensusBatchResponse(`${REAL_MATCH_ROW}\n`)).toHaveLength(1);
  });

  it("parses multiple rows from one response", () => {
    const response = [REAL_MATCH_ROW, '"2","9999 NOWHERE RD, ATLANTA, GA, 30303","No_Match"'].join("\n");
    const results = parseCensusBatchResponse(response);

    expect(results).toHaveLength(2);
    expect(results[0].matched).toBe(true);
    expect(results[1].matched).toBe(false);
  });
});
