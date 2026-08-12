# Pulse ATL — Ideation Spec

**Hackathon:** Hack RenderATL (Devpost / MLH) · **Deadline:** Today, 8:00 PM ET
**One-liner:** An AI-powered neighborhood pulse dashboard that turns Atlanta's fragmented civic open data into plain-English neighborhood health reports — and shows which neighborhoods the city is leaving behind.

---

## 1. Problem

Atlanta publishes civic data (crime incidents, code enforcement, planning data) across at least four disconnected portals in GIS formats residents can't read. A resident of Adair Park has no way to answer: "What's happening in my neighborhood, is it getting better or worse, and is the city actually responding?" Meanwhile, response equity is invisible — no one can see that complaints in some NPUs sit unresolved 3x longer than in others.

## 2. Target Users

- **Residents** — "What's happening near me? Who do I contact?"
- **Neighborhood associations / NPU leaders** — need evidence to advocate at city council
- **Journalists & civic advocates** — need the equity story surfaced from raw data

## 3. Hack for Good Narrative

Pulse ATL makes civic neglect measurable. The demo's emotional beat: side-by-side pulse reports for two neighborhoods showing unequal city responsiveness — data that residents can take to their council member. Community benefit, social impact, Atlanta-specific. This is the story judges retell.

---

## 4. Prize Track Mapping

| Prize | How Pulse ATL wins it |
|---|---|
| **Best Hack for Good** | Civic equity tool; empowers underserved neighborhoods with evidence |
| **Best Use of Atlanta Open Data** | Ingests 2–3 live Atlanta datasets (crime, code enforcement, city GIS layers); "directly impacting the city and its residents" |
| **Best Use of Render Workflows** | Scheduled ingest pipeline built AND deployed on Render Workflows (not just hosting) |
| **Best Use of Gemini API** | Gemini generates neighborhood pulse reports + powers resident Q&A chat ("summarizes complex data," "personalized advice" — exactly their prompt copy) |
| **Best Use of Snowflake API** | Snowflake = analytics warehouse via REST API; Snowflake Cortex runs the trend/anomaly analysis (their prompt: "LLMs on a single account using Snowflake APIs") |

**Key design rule:** Gemini and Snowflake must each do *distinct, load-bearing* work. Snowflake Cortex does data-side intelligence (trend detection, anomaly scoring in SQL). Gemini does user-side intelligence (report writing, chat). Neither is decorative.

---

## 5. Core Concept & Feature Scope

### P0 — must ship (MVP = demoable)
1. **Ingest pipeline (Render Workflow, cron):** pull Atlanta open datasets → normalize → load to Snowflake. Runs on schedule; demo shows it live.
2. **Neighborhood pulse scores:** Snowflake SQL aggregates incidents/cases by NPU or neighborhood; Cortex flags trends/anomalies ("code enforcement cases up 40% in NPU-V, median resolution 62 days vs city median 21").
3. **Pulse report:** Gemini turns the Snowflake aggregate for a selected neighborhood into a plain-English report card (what's happening, trend, who to contact).
4. **Map dashboard (web):** Atlanta map, neighborhoods colored by pulse score, click → report.

### P1 — strong demo upgrades
5. **Resident chat:** Gemini chat grounded in the neighborhood's Snowflake data ("what's the biggest issue near Grant Park this month?").
6. **Equity comparison view:** two neighborhoods side by side (the Hack for Good money shot).

### P2 — only if time remains
7. Auto-drafted council advocacy letter (Gemini) — one button, huge judge appeal, cheap to build.
8. Weekly digest email via Render Workflow.

**Cut list (do NOT build):** auth/accounts, mobile app, historical backfill beyond ~12 months, user-submitted reports, notifications.

---

## 6. Data Strategy ⚠️ (validated 12:45 PM — read this first)

Atlanta 311 raw data is **not** reliably published for bulk download. Do not build the plan on it. Verified-available alternatives, all with REST/GeoJSON APIs:

| Priority | Source | What | Access |
|---|---|---|---|
| 1 | [Atlanta PD Open Data](https://opendata.atlantapd.org/) | Crime incidents, downloadable + regularly updated | CSV |
| 2 | [City of Atlanta Open Data Hub (ArcGIS)](https://dpcd-coaplangis.opendata.arcgis.com/) | Code enforcement, planning, neighborhood/NPU boundary layers | ArcGIS REST → GeoJSON |
| 3 | [ARC Open Data Hub](https://opendata.atlantaregional.com/) | Regional demographics, equity layers | ArcGIS REST → GeoJSON |
| 4 | [gis.atlantaga.gov Open Data Hub](https://gis.atlantaga.gov/?page=OPEN-DATA-HUB) | City GIS layers backup | ArcGIS REST |

**Ticket #1 (P0, blocking, first agent dispatched):** hit each source, confirm fields (date, category, location, status), pick final 2–3 datasets, commit sample extracts to repo. Timebox: 30 min. Everything downstream consumes a normalized schema, so the ingest ticket defines a canonical `incidents` table shape that any source maps into — datasets stay swappable.

**Neighborhood boundaries:** NPU/neighborhood polygon layer from source 2 or 4; join incidents to polygons point-in-polygon at ingest.

## 7. Architecture (high level — details go in design spec)

```
Atlanta open data APIs
        │  (cron: Render Workflow)
        ▼
Ingest worker (normalize → canonical schema)
        ▼
Snowflake (warehouse) ──► Cortex: trends/anomalies via SQL + REST API
        ▼
API service (Render web service, Postgres for app state/cache)
        ▼
Web dashboard (map + reports + chat) ──► Gemini API (reports, chat)
```

- **Render:** Workflow (scheduled ingest) + web service + Render Postgres (cache/app state — keeps "Render for the database" true while Snowflake stays the analytics warehouse).
- **Snowflake:** free trial account; REST/SQL API from the API service; Cortex functions (`SNOWFLAKE.CORTEX.COMPLETE` / `AI_AGG`) for data-side analysis.
- **Gemini:** flash model for chat + report generation; grounding = structured JSON pulled from Snowflake, passed in context (no RAG infra needed).

## 8. Demo Video Script (≤ 2 min — required)

1. **0:00** — "Hey, I'm Tomiwa and this is my demo for Hack RenderATL." *(required opening)*
2. **0:05** — Problem: 15s on fragmented civic data, show the 4 portals.
3. **0:20** — Map dashboard; click a neighborhood → Gemini pulse report.
4. **0:50** — Equity money shot: two neighborhoods side by side, unequal resolution times.
5. **1:15** — Under the hood, fast: Render Workflow run log → Snowflake query + Cortex call → Gemini.
6. **1:40** — (If built) one-click council letter. Close on impact statement.

## 9. Judging Criteria Alignment

- **Technology:** 3 sponsor integrations doing distinct work + agentic SDLC build process (mention it — it's a differentiator).
- **Design:** map-first UI, one clear user flow; skip settings/admin chrome entirely.
- **Completion:** P0 is a full loop (ingest → warehouse → AI → UI). Cut features, not the loop.
- **Learning:** first time wiring Snowflake Cortex + Render Workflows together — say so in the video.

## 10. Compliance Checklist (Devpost rules)

- [ ] Public repo (stays public post-event)
- [ ] ≤ 2 min demo video, **created today**, states "Hack RenderATL" at start
- [ ] Registered on Devpost; attending RenderATL; one project only
- [ ] No prior work — repo created today, all commits today
- [ ] Submit before 8:00 PM

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Dataset gaps/format surprises | Ticket #1 validates in first 30 min; canonical schema makes sources swappable; worst case: commit a static extract and note "live cron demonstrated against cached data" |
| Snowflake trial signup friction | Do signup manually NOW, before agents start; it's the one step agents can't do |
| Cortex availability/region issues | Fallback: Snowflake stays the warehouse (REST API still hit), Gemini absorbs analysis duty — prize still plausible via REST API usage |
| Integration hell at the end | The P0 loop is one thin vertical slice; build it end-to-end first, then widen |
| Demo video crunch | Feature freeze 6:15 PM, hard. Video recorded by 7:30 |

## 12. Timeline (now → 8:00 PM)

| Time | Phase |
|---|---|
| by 1:30 | Design + planning specs done; Linear tickets dispatched (P0/P1/P2 tagged); Snowflake + Render + Gemini creds ready |
| 1:30–2:15 | Ticket #1 (data validation) + repo scaffold + thin vertical slice started |
| 2:15–5:30 | Agents build P0 in parallel; you review on 2-pass cap; hourly checkpoint branches |
| 5:30–6:15 | P1 only if P0 loop is green end-to-end |
| **6:15** | **Feature freeze** — polish, seed demo data, deploy verify |
| 7:00–7:30 | Record + upload demo video |
| 7:30–7:45 | Devpost submission complete |
| 7:45–8:00 | Buffer |

## 13. Open Questions → resolve in design spec

1. Neighborhood unit: NPU (25, cleaner) vs. named neighborhoods (240+, more relatable)? **Lean NPU with neighborhood names listed inside.**
2. Frontend stack: agent-fastest default (Next.js or Vite/React on Render) — decide in design spec.
3. Pulse score formula: keep dumb-simple (weighted incident counts + trend delta); Cortex narrates, doesn't invent the math.
4. Map: Leaflet + OSM tiles (zero API keys) vs. Mapbox (prettier, key friction). **Lean Leaflet.**

---
*Next artifacts: design spec → planning spec → Linear ticket batch.*
