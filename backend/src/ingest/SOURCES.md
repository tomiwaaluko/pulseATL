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
