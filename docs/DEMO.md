# Pulse ATL — Demo Companion

**Live URL:** https://pulse-atl.onrender.com
**Repo:** https://github.com/tomiwaaluko/pulseATL

## What & why

Atlanta publishes civic data — crime incidents, code enforcement, planning data — across at least four disconnected portals in GIS formats residents can't read. A resident has no way to answer "what's happening in my neighborhood, is it getting better or worse, and is the city actually responding?" Response equity is invisible: nobody can see that complaints in some NPUs sit unresolved three times longer than in others. Pulse ATL ingests Atlanta's open civic datasets, computes a 0–100 "pulse score" per Neighborhood Planning Unit (NPU), and turns the underlying statistics into plain-English report cards and an equity comparison view — so residents, NPU leaders, and journalists can see, and act on, response inequity the city currently makes invisible.

## Demo script (≤ 2 minutes)

| Time | Shot | On screen |
|---|---|---|
| 0:00 | Opening | "Hey, I'm Tomiwa and this is my demo for Hack RenderATL." |
| 0:05 | Problem | 15s on fragmented civic data — show the 4 source portals (APD Open Data, City of Atlanta ArcGIS hub, ARC Open Data, gis.atlantaga.gov) |
| 0:20 | Map dashboard | Leaflet map of all 25 NPUs colored by pulse score; click an NPU → its Gemini-written report card slides in (headline, trend, top 3 issues, who to contact) |
| 0:50 | Equity money shot | Two neighborhoods side by side via `/api/compare` — unequal median resolution times, the pulse gap, the "city is leaving X behind" story |
| 1:15 | Under the hood | Fast cut: ingest run log → Snowflake `INCIDENTS` table + `SNOWFLAKE.CORTEX.COMPLETE` anomaly finding → Gemini report generation |
| 1:40 | Close | Impact statement: civic neglect, made measurable |

## Prize-track mapping

| Prize | What to show on screen |
|---|---|
| **Best Use of Render** | Render web service serving the API + static frontend, Render Postgres as the `reports` cache, and the scheduled ingest job (`npm run ingest`) that populates it |
| **Best Use of Snowflake** | The `INCIDENTS` warehouse table (`backend/sql/schema.sql`) and a live `SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', ...)` anomaly finding for a selected NPU, returned in the report's `cortex_findings` field |
| **Best Use of Gemini** | A generated report card (`geminiClient.generateReport`, ≤200-word Markdown: Headline / Trend / Top issues / Who to contact) and the resident chat answering a live question grounded in that NPU's stats (`geminiClient.chatAnswer`) |
| **Best Use of Atlanta Open Data** | `backend/src/ingest/SOURCES.md` — the two validated live sources (APD crime incidents, ATL311 service requests) with field-mapping tables into the canonical incident schema |
| **Best Hack for Good** | The Compare view (`/api/compare?a=<npu>&b=<npu>`) — two NPUs side by side with their pulse gap and resolution-time gap, the evidence a resident can take to their council member |

## Architecture

```
Atlanta open data APIs (APD crime, ATL311)
        │  backend/src/ingest/{sources,normalize,load,run}.ts
        ▼
Ingest run (normalize → canonical Incident rows)
        ▼
Snowflake INCIDENTS table  ──►  SNOWFLAKE.CORTEX.COMPLETE (anomaly findings, in-SQL)
        ▼
computePulse (backend/src/pulse.ts: z-scored incident rate + trend + resolution time → 0–100 score)
        ▼
Gemini generateReport (report card) ──► Postgres `reports` cache (backend/src/db.ts)
        ▼
Express API (backend/src/routes/{npus,compare,chat}.ts) ──► React + Leaflet map (frontend/src)
        └── resident chat: Gemini chatAnswer, grounded in the cached NPU stats
```

- **Ingest**: `backend/src/ingest/run.ts` runs fetch → `normalizeRecord` → `loadIncidents` (Snowflake MERGE) → `computeNpuStats` → per-NPU `computePulse` + `cortexFindings` + Gemini `generateReport` → `upsertReport` into Postgres. Re-running is safe (both writes are keyed upserts). `--seed` mode replays the committed fixtures in `backend/test/fixtures/` for a deterministic demo run.
- **Snowflake**: `backend/src/snowflakeClient.ts` is the REST/SQL client; `backend/sql/schema.sql` defines the `INCIDENTS` table; `cortexFindings` (`backend/src/ingest/load.ts`) calls `SNOWFLAKE.CORTEX.COMPLETE` inside a SQL statement to generate the anomaly narrative, with an explicit `[cortex-unavailable]`-prefixed fallback if Cortex doesn't respond — never a fabricated finding.
- **Gemini**: `backend/src/geminiClient.ts` — `generateReport` writes the report card from the NPU's stats JSON and the Cortex findings; `chatAnswer` answers resident questions grounded only in that NPU's cached stats.
- **API**: Express (`backend/src/server.ts`) serves `/api/npus`, `/api/npus/:npu`, `/api/compare`, `/api/chat`, `/api/health`, plus the built frontend as a static SPA fallback.
- **Frontend**: React + Leaflet (`frontend/src/components/PulseMap.tsx`, `ReportPanel.tsx`) — a map of all 25 NPUs colored by pulse score, click-through to a report panel.

## How this was built

Pulse ATL was built with an agentic SDLC under a hard same-day deadline: an ideation spec and design spec (including a frozen §5 API contract) were written first, then broken into Linear tickets (T1–T14). Each ticket was handed to an isolated AI implementer session on its own branch, working strictly within that ticket's scope. An orchestrator session reviewed each pull request and ran the full test suite (`npm test`, `npm run build`, `npm run e2e`) against it before merging to `main`, so every merged commit is green. This ticket (PUL-18, "Demo hardening") is itself one of those sessions — closing out the punch list and producing this document in the final pre-submission window.

## Compliance checklist (Devpost rules)

- [x] Public repo (stays public post-event)
- [ ] ≤ 2 min demo video, created today, states "Hack RenderATL" at start
- [x] Registered on Devpost; attending RenderATL; one project only
- [x] No prior work — repo created today, all commits today
- [x] Submit before 8:00 PM

## Screenshots

- `.screenshots/map-default.png` — default map view, all 25 NPUs colored by pulse score
- `.screenshots/report-panel.png` — report panel open for a selected NPU
- `.screenshots/error-state.png` — full-screen error state with working retry
