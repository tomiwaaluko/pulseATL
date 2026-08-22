# Pulse ATL source validation

Validated 2026-08-12. The committed samples are **unaltered source rows** (250
rows per dataset), rather than normalized or invented demo data. Network fetchers
should retain the field names below and let `normalize.ts` create canonical
incidents.

## Selected source 1: Atlanta Police Department crime incidents

- Publisher landing page: <https://opendata.atlantapd.org/>
- Download endpoint used by the public APD download index:
  <http://www.atlantapd.org/Home/ShowDocument?id=684> (`COBRA-YTD2017.zip`)
- Reproducible consolidated mirror used to cut the fixture:
  <https://github.com/CivicTechAtlanta/apd-crime-data/blob/master/Data/crime_data.csv>
- Fixture: `backend/test/fixtures/apd_crime.sample.json` (250 real rows)
- Result: usable without enrichment. Coordinates are WGS84 and the export
  already includes NPU assignments.

| Canonical field | APD field | Mapping |
| --- | --- | --- |
| `id` | `offense_id` | prefix with `apd_crime:` |
| `source` | — | constant `apd_crime` |
| `category` | — | constant `crime` |
| `subcategory` | `UC2 Literal` | preserve offense label |
| `occurred_at` | `occur_datetime` | parse ISO timestamp |
| `resolved_at` | — | `null` (not published) |
| `status` | `dispo_code` | value when present, otherwise `unknown` |
| `lat` | `y` | parse number |
| `lon` | `x` | parse number |
| `npu` | `npu` | uppercase; reject missing/invalid values |

## Selected source 2: ATL311 service requests

- City service page: <https://www.atlantaga.gov/government/departments/atl311>
- Exact archived bulk export used for validation:
  <https://github.com/brian-murphy/atl-311-parser/raw/master/311-data.tar.gz>
  (`ATL311 SR Data 2015.csv` inside the archive)
- Fixture: `backend/test/fixtures/atl311_service_requests.sample.json` (250 real rows)
- Result: usable for infrastructure/service-request trends. The export exposes a
  GIS geocoding result plus a structured address, but not numeric coordinates;
  the live fetcher must geocode the address or reject the row when it cannot be
  spatially joined. That limitation is preferable to fabricating coordinates.

| Canonical field | ATL311 field | Mapping |
| --- | --- | --- |
| `id` | `SR #` | prefix with `atl311:` |
| `source` | — | constant `atl311` |
| `category` | — | constant `infrastructure` |
| `subcategory` | `Request Type` | fall back to `Incident Type`, then `Area` |
| `occurred_at` | `Opened` | parse as Atlanta local time |
| `resolved_at` | `Closed` | parse when populated, otherwise `null` |
| `status` | `Status` | `Closed` → `closed`; other values → `open`/`unknown` |
| `lat`, `lon` | — | geocode structured address; otherwise `null` |
| address input | `Street #`, `Street Name`, `Street Type`, `City/County`, `Postal Code` | concatenate non-empty parts |
| `npu` | — | point-in-polygon join after geocoding |

### ATL311 geocoding (PULSE-19)

The 2015 export has no numeric coordinates, so `normalize.ts` rejects every
ATL311 row today (`lat`/`lon` come from `raw.lat ?? raw.latitude` and
`raw.lon ?? raw.longitude`, and the fixture has neither). `backend/scripts/geocode-atl311.ts`
fills that gap by geocoding the fixture's structured address fields against the
**US Census Bureau batch geocoder**
(`https://geocoding.geo.census.gov/geocoder/locations/addressbatch`,
`benchmark=Public_AR_Current`) — a free, keyless public service, so no secret is
required.

- Address input per row: `Street #` + `Street Name` + `Street Type` (joined
  with spaces) as the street; `City/County` as the city, unless it names a
  county (e.g. `FULTON COUNTY`) rather than a real city, in which case the
  city is left blank and the ZIP carries that weight; state is always `GA`;
  `Postal Code` as the ZIP. A row with no street, or with neither a usable
  city nor a ZIP, is never sent — see `buildAtl311Address` in
  `backend/src/ingest/geocode.ts`.
- The geocoder is called once per batch of up to 500 addresses (`addressFile`,
  multipart/form-data, no header row: `unique_id,street,city,state,zip`),
  well under its documented 10,000-row batch limit.
- A result only counts as geocoded when the Census match indicator is
  `Match` **and** the returned longitude/latitude fall inside the Atlanta
  metro bounding box (`lon` −84.6..−84.2, `lat` 33.6..33.9). Anything else —
  no match, a tie, or a match outside that box — is written back as
  `latitude: null, longitude: null` and counted as a failure. Coordinates are
  never fabricated or approximated.
- The script writes `latitude`/`longitude` (not `lat`/`lon`) onto each fixture
  row, matching the `raw.latitude`/`raw.longitude` fallback `normalize.ts`
  already reads for the `atl311` source. It is idempotent: a row that already
  has numeric `latitude`/`longitude` is left untouched on a re-run, and only
  rows still `null` (or missing the fields) are retried.
- The sandbox's egress proxy answers **403 to CONNECT for
  `geocoding.geo.census.gov`**, so the script cannot run there at all. Run it
  locally with `npm run geocode:atl311 --workspace=backend`, or on a
  GitHub-hosted runner via the `Refresh NPU boundaries and geocode ATL311`
  workflow (`.github/workflows/refresh-boundaries-and-geocode.yml`, triggered by
  pushing to `ops/run-npu-geocode`), which commits the updated fixture back to
  the branch it ran on. The older `Geocode ATL311 fixture` workflow
  (`.github/workflows/geocode.yml`, branch `ops/run-geocode`) still works and
  runs the geocoder alone.

### Address cleaning and retry passes

A single query per row left 185/250 rows geocoded. Reading the failures back
showed three repeatable, fixable causes, so `geocode-atl311.ts` now makes
several passes, each retrying only what the earlier passes left unresolved.
The rewrites are built by `buildAtl311AddressVariants` in `geocode.ts`:

| Pass | Rewrite |
| --- | --- |
| `base` | the address exactly as `buildAtl311Address` builds it |
| `cleaned` | trailing unit designators removed (`APT 3`, `STE 200`, `#4B`, stacked), an intersection tail after `/`, `&` or `AND` dropped, and contractions expanded to the spelling the Census gazetteer stores (`R D ABERNATHY` → `RALPH DAVID ABERNATHY`, `FOREST PK RD` → `FOREST PARK RD`, `ST DAVID` → `SAINT DAVID`) |
| `zip_only` | cleaned street + ZIP, city dropped — the export's city column is often the billing city, not the service address's |
| `city_only` | cleaned street + city, ZIP dropped — the mirror-image error |
| `quadrant` | cleaned street with each of `NE`/`NW`/`SE`/`SW` appended |

Atlanta reuses the same house number and street name across all four quadrants,
so a quadrant retry is a question, not an answer. `resolveQuadrantCandidates`
accepts a coordinate **only when exactly one** quadrant comes back as a match.
Two matches means two real Atlanta addresses fit the row, and picking one would
be a guess dressed up as data — the row stays `null`. Four rows in the current
fixture hit that case (`513 EDGEWOOD AVE`, `77 STAFFORD ST`, `230 HOWARD ST`,
`188 PIEDMONT AVE`) and are deliberately left unresolved.

- **Coverage — before**: 185/250 rows (74.0%) carried a coordinate inside the
  Atlanta bbox.
- **Coverage — after** (run 2026-08-22, GitHub-hosted runner): **187/250
  (74.8%)**. The `cleaned` pass resolved 2 rows; `zip_only`, `city_only` and
  `quadrant` resolved none.
- **This is below the 85% (213-row) target, and the target is not reachable on
  this fixture without fabricating coordinates.** Of the 63 rows still `null`,
  45 are `out_of_bounds`: the Census matched the address exactly, and the
  coordinate it returned falls outside the Atlanta bbox because the address is
  genuinely in Sandy Springs (30328/30350), Dunwoody (30338), Fairburn (30213),
  Union City (30291), Palmetto/Chattahoochee Hills (30268), Riverdale (30296),
  south Fulton below 33.6°N (30349), or — in one case — Sumter, **South
  Carolina** (29154). Those are correct rejections, not failures to fix.
  The remaining 18 are `no_match`: 3 carry no house number at all
  (`REDFORD DR`, `BOOKER AVE`, `JONESBORO RD`), 4 are the quadrant-ambiguous
  rows above, and the rest are addresses current TIGER address ranges do not
  carry. Even if every one of those 18 resolved inside the bbox, the ceiling
  would be 205/250 = 82.0%.
- Raising coverage further needs a different **fixture** (resampling with a
  city-limits filter), not a different geocoder. That is a separate change from
  PULSE-19 and would alter the sampling contract `resample-atl311.ts`
  documents, so it is not done here.
- Every coordinate in the fixture was returned by the Census for that row's own
  address. None is copied from another row, approximated from a ZIP or city
  centroid, or inferred in any other way.

## NPU boundary layer

- Publisher/catalog: [City of Atlanta Department of City Planning Open Data
  Hub](https://dpcd-coaplangis.opendata.arcgis.com/)
- ArcGIS REST query form used by fetchers (GeoJSON output):
  `<layer-query-url>?where=1%3D1&outFields=*&outSR=4326&f=geojson`
- Reproducible snapshot used for the committed file:
  <https://raw.githubusercontent.com/andrewvora/mynpu/master/app/src/main/res/raw/npus.geojson>
- Output: `frontend/data/npus.geojson`, a WGS84 FeatureCollection containing 25
  polygon features with a unique uppercase `NPU` property (A–Z, excluding U).

The archived snapshot lacked NPU Q, so its missing feature was restored before
commit. The ingest contract depends only on WGS84 polygon geometry and the
`NPU` property; source-only fields such as `AREA` and `ATL_NPU_ID` are retained
for provenance.

## Portals evaluated but not selected

| Portal | Check | Decision |
| --- | --- | --- |
| [ARC Open Data Hub](https://opendata.atlantaregional.com/) | Regional demographic/equity layers are available through ArcGIS REST. | Not incident/case data; useful later for enrichment, not the P0 event table. |
| [City GIS Open Data Hub](https://gis.atlantaga.gov/?page=OPEN-DATA-HUB) | Provides overlapping boundary and planning layers. | Kept as boundary backup; no second event feed needed after APD + ATL311 validation. |
| City planning/code enforcement catalog | ArcGIS layers were discoverable through the planning hub, but service-host requests were blocked by the build environment's proxy during validation. | Timebox applied: do not make seed mode depend on a portal that could not be fetched reliably. |

## Fixture integrity quick check

```sh
node -e "for (const f of ['backend/test/fixtures/apd_crime.sample.json','backend/test/fixtures/atl311_service_requests.sample.json']) { const rows=require('./'+f); if(rows.length<200) throw Error(f); console.log(f, rows.length) }"
node -e "const g=require('./frontend/data/npus.geojson'); if(g.type!=='FeatureCollection'||g.features.length!==25||g.features.some(f=>!f.properties.NPU)) throw Error('invalid NPU GeoJSON'); console.log(g.features.length)"
```
