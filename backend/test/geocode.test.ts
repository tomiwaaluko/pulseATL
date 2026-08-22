import { describe, expect, it } from "vitest";

import {
  ATLANTA_QUADRANTS,
  buildAddressBatchCsv,
  buildAddressCsvLine,
  buildAtl311Address,
  buildAtl311AddressVariants,
  cleanStreetLine,
  escapeCsvField,
  hasHouseNumber,
  isWithinAtlantaBounds,
  parseCensusBatchResponse,
  resolveQuadrantCandidates,
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
  it("parses a matched row and keeps longitude before latitude", () => {
    const response = [
      '129213674,"6745 CEDAR HURST TRL, ATLANTA, GA, 30349",Match,Non_Exact,',
      '"6745 CEDAR HURST TRL, ATLANTA, GA, 30349",-84.548,33.634,123456789,L',
    ].join("");
    const [result] = parseCensusBatchResponse(response);
    expect(result).toEqual({ id: "129213674", matched: true, lon: -84.548, lat: 33.634, outcome: "match" });
  });

  it("does not swap longitude and latitude", () => {
    const response = '1,"100 MAIN ST, ATLANTA, GA, 30303",Match,Exact,"100 MAIN ST, ATLANTA, GA, 30303",-84.39,33.75,1,L';
    const [result] = parseCensusBatchResponse(response);
    expect(result.lon).toBe(-84.39);
    expect(result.lat).toBe(33.75);
  });

  it("parses a matched row whose coordinates are one quoted \"lon,lat\" field", () => {
    const response = '1,"100 MAIN ST, ATLANTA, GA, 30303",Match,Exact,"100 MAIN ST, ATLANTA, GA, 30303","-84.39,33.75",1,L';
    const [result] = parseCensusBatchResponse(response);
    expect(result).toEqual({ id: "1", matched: true, lon: -84.39, lat: 33.75, outcome: "match" });
  });

  it("marks a No_Match row as unmatched", () => {
    const response = '2,"9999 NOWHERE RD, ATLANTA, GA, 30303",No_Match';
    const [result] = parseCensusBatchResponse(response);
    expect(result).toEqual({ id: "2", matched: false, lon: null, lat: null, outcome: "no_match" });
  });

  it("rejects a match whose coordinates fall outside Atlanta (never fabricates)", () => {
    const response = '3,"1 INFINITE LOOP, CUPERTINO, CA, 95014",Match,Exact,"1 INFINITE LOOP, CUPERTINO, CA, 95014",-122.03,37.33,1,L';
    const [result] = parseCensusBatchResponse(response);
    expect(result).toEqual({ id: "3", matched: false, lon: null, lat: null, outcome: "out_of_bounds" });
  });

  it("flags a non-CSV response (HTML error page under HTTP 200) as unparseable", () => {
    const results = parseCensusBatchResponse("<html><body>Service Unavailable</body></html>");

    expect(results.every((result) => result.outcome === "unparseable")).toBe(true);
    expect(results.every((result) => result.matched === false)).toBe(true);
  });

  it("ignores blank rows from a trailing newline", () => {
    const response = '1,"100 MAIN ST, ATLANTA, GA, 30303",Match,Exact,"100 MAIN ST",-84.39,33.75,1,L\n';

    expect(parseCensusBatchResponse(response)).toHaveLength(1);
  });

  it("parses multiple rows from one response", () => {
    const response = [
      '1,"100 MAIN ST, ATLANTA, GA, 30303",Match,Exact,"100 MAIN ST, ATLANTA, GA, 30303",-84.39,33.75,1,L',
      '2,"9999 NOWHERE RD, ATLANTA, GA, 30303",No_Match',
    ].join("\n");
    const results = parseCensusBatchResponse(response);
    expect(results).toHaveLength(2);
    expect(results[0].matched).toBe(true);
    expect(results[1].matched).toBe(false);
  });
});

describe("cleanStreetLine", () => {
  it("leaves an already-clean street untouched", () => {
    expect(cleanStreetLine("6745 CEDAR HURST TRL")).toBe("6745 CEDAR HURST TRL");
  });

  it("strips a trailing unit designator and a bare unit number", () => {
    expect(cleanStreetLine("100 MAIN ST APT 3")).toBe("100 MAIN ST");
    expect(cleanStreetLine("100 MAIN ST, STE 200")).toBe("100 MAIN ST");
    expect(cleanStreetLine("100 MAIN ST #4B")).toBe("100 MAIN ST");
  });

  it("strips stacked unit designators", () => {
    expect(cleanStreetLine("100 MAIN ST BLDG C APT 3")).toBe("100 MAIN ST");
  });

  it("expands contracted street names the Census stores in full", () => {
    expect(cleanStreetLine("1550 R D ABERNATHY BLVD")).toBe("1550 RALPH DAVID ABERNATHY BLVD");
    expect(cleanStreetLine("3765 FOREST PK RD")).toBe("3765 FOREST PARK RD");
    expect(cleanStreetLine("7491 ST DAVID ST")).toBe("7491 SAINT DAVID ST");
  });

  it("does not turn a trailing ST street type into SAINT", () => {
    expect(cleanStreetLine("77 STAFFORD ST")).toBe("77 STAFFORD ST");
  });

  it("keeps only the first street of an intersection", () => {
    expect(cleanStreetLine("MAIN ST / 5TH AVE")).toBe("MAIN ST");
    expect(cleanStreetLine("MAIN ST & 5TH AVE")).toBe("MAIN ST");
  });
});

describe("hasHouseNumber", () => {
  it("is true for a numbered street and false for a bare street name", () => {
    expect(hasHouseNumber("100 MAIN ST")).toBe(true);
    expect(hasHouseNumber("REDFORD DR")).toBe(false);
  });
});

describe("buildAtl311AddressVariants", () => {
  const row = {
    "Street #": "1550",
    "Street Name": "R D ABERNATHY",
    "Street Type": "BLVD",
    "City/County": "ATLANTA",
    "Postal Code": "30310",
  };

  it("puts the untouched address first", () => {
    const [first] = buildAtl311AddressVariants(row);
    expect(first).toEqual({
      kind: "base",
      quadrant: null,
      address: { street: "1550 R D ABERNATHY BLVD", city: "ATLANTA", state: "GA", zip: "30310" },
    });
  });

  it("adds a cleaned rewrite, a ZIP-only and a city-only retry", () => {
    const variants = buildAtl311AddressVariants(row);
    expect(variants.find((variant) => variant.kind === "cleaned")?.address).toEqual({
      street: "1550 RALPH DAVID ABERNATHY BLVD", city: "ATLANTA", state: "GA", zip: "30310",
    });
    expect(variants.find((variant) => variant.kind === "zip_only")?.address).toEqual({
      street: "1550 RALPH DAVID ABERNATHY BLVD", city: "", state: "GA", zip: "30310",
    });
    expect(variants.find((variant) => variant.kind === "city_only")?.address).toEqual({
      street: "1550 RALPH DAVID ABERNATHY BLVD", city: "ATLANTA", state: "GA", zip: "",
    });
  });

  it("adds one quadrant retry per Atlanta quadrant", () => {
    const quadrants = buildAtl311AddressVariants(row)
      .filter((variant) => variant.kind === "quadrant")
      .map((variant) => variant.quadrant);
    expect(quadrants).toEqual([...ATLANTA_QUADRANTS]);
  });

  it("does not send the same address twice when cleaning changes nothing", () => {
    const variants = buildAtl311AddressVariants({ ...row, "Street Name": "STAFFORD" });
    const rendered = variants.map((variant) => JSON.stringify(variant.address));
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(variants.some((variant) => variant.kind === "cleaned")).toBe(false);
  });

  it("skips quadrant retries for a street with no house number", () => {
    const variants = buildAtl311AddressVariants({ ...row, "Street #": "" });
    expect(variants.some((variant) => variant.kind === "quadrant")).toBe(false);
  });

  it("skips quadrant retries when the street already names a quadrant", () => {
    const variants = buildAtl311AddressVariants({ ...row, "Street Type": "BLVD SW" });
    expect(variants.some((variant) => variant.kind === "quadrant")).toBe(false);
  });

  it("returns nothing for a row with no geocodable address", () => {
    expect(buildAtl311AddressVariants({ "City/County": "ATLANTA" })).toEqual([]);
  });
});

describe("resolveQuadrantCandidates", () => {
  const matched = (id: string, lon: number, lat: number) =>
    ({ id, matched: true, lon, lat, outcome: "match" }) as const;
  const missed = (id: string) =>
    ({ id, matched: false, lon: null, lat: null, outcome: "no_match" }) as const;

  it("accepts the coordinate when exactly one quadrant matches", () => {
    expect(resolveQuadrantCandidates([missed("a~NE"), matched("a~SW", -84.42, 33.73), missed("a~SE")]))
      .toEqual({ lon: -84.42, lat: 33.73 });
  });

  it("refuses to choose when two quadrants match", () => {
    expect(resolveQuadrantCandidates([
      matched("a~NE", -84.38, 33.78),
      matched("a~SW", -84.42, 33.73),
    ])).toBeNull();
  });

  it("returns null when no quadrant matches", () => {
    expect(resolveQuadrantCandidates([missed("a~NE"), missed("a~SW")])).toBeNull();
  });
});
