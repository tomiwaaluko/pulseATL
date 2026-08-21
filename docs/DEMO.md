# Pulse ATL — Demo Companion

**Live URL:** https://pulse-atl.onrender.com
**Repo:** https://github.com/tomiwaaluko/pulseATL

> This document describes what the system **actually does today**, verified against
> the deployed service. Where something is partially built or not built, it says
> so. A demo companion that oversells is worse than one that undersells: a judge
> who clicks a claim and finds nothing discounts everything else on the page.

## What & why

Atlanta publishes civic data — crime incidents and 311 service requests among
others — across disconnected portals in formats residents can't read. A resident
has no easy way to answer "what's happening in my neighborhood, is it getting
better or worse, and is the city actually responding?" Pulse ATL ingests two
validated Atlanta open datasets, computes a 0–100 pulse score per Neighborhood
Planning Unit (NPU), and turns the underlying statistics into plain-English
report cards and a side-by-side equity comparison.

**On the equity claim, precisely.** The dashboard surfaces a real, measured
difference in median resolution time between NPUs — currently a **0 to 4 day
spread** across the 24 NPUs that have enough closed requests to produce a median.
That is a genuine difference computed from unmodified source rows. It is not a
dramatic one, and this document does not dress it up as one. The contribution is
that the number is *visible and comparable at all*, which it is not on any city
portal.

## Demo script (≤ 2 minutes)

| Time | Shot | On screen |
|---|---|---|
| 0:00 | Opening | "Hey, I'm Tomiwa and this is my demo for Hack RenderATL." |
| 0:05 | Problem | 15s on fragmented civic data — show the two source portals actually used (APD Open Data crime incidents, the ATL311 service-request export) |
| 0:20 | Map dashboard | Leaflet map of all 25 NPUs colored by pulse score; click an NPU → its Gemini-written report card slides in (headline, trend, top issues, who to contact) |
| 0:50 | Equity comparison | Two NPUs side by side via the Compare view — the pulse gap and the median resolution-time gap, computed from real rows |
| 1:15 | Under the hood | Fast cut: ingest log → Snowflake `INCIDENTS` table + `SNOWFLAKE.CORTEX.COMPLETE` finding → Gemini report generation |
| 1:40 | Close | Impact statement: response-time differences, made visible and comparable |

**Do not demo the resident chat.** `POST /api/chat` works and is covered by
tests, but there is no chat UI — the frontend has the types and an unused API
helper, and no drawer component. Showing a chat on screen would require building
PUL-14 first.

## Prize-track mapping

| Prize | What to show on screen | Status |
|---|---|---|
| **Best Use of Render** | Render web service serving the API + static frontend, and Render Postgres as the `reports` cache | ✅ working |
| **Best Use of Snowflake** | The `INCIDENTS` warehouse table (`backend/sql/schema.sql`) and a live `SNOWFLAKE.CORTEX.COMPLETE` finding in an NPU's `cortex_findings` — the anomaly analysis runs *inside the warehouse*, in SQL, not in application code | ✅ working |
| **Best Use of Gemini** | A generated report card (`geminiClient.generateReport` — ≤200-word Markdown: headline / trend / top issues / who to contact) | ✅ working |
| **Best Use of Atlanta Open Data** | `backend/src/ingest/SOURCES.md` — the two validated live sources with field-mapping tables into the canonical incident schema, and the Census-geocoding step that makes ATL311 rows joinable to an NPU at all | ✅ working |
| **Best Hack for Good** | The Compare view — two NPUs side by side with their pulse gap and resolution-time gap | ✅ working |

**Scheduling caveat for the Render track:** the ingest is *not* a Render cron
job — Render cron jobs and Workflows both require a paid plan. It runs hourly
from a GitHub Actions workflow that calls an authenticated admin endpoint on the
service. That indirection exists for a real reason worth mentioning if asked:
external TLS connections to the Render Postgres instance are terminated for
everything outside the service, so the service is the only host that can write
to its own database.

## Architecture

```
Atlanta open data (APD crime, ATL311 service requests)
        │  backend/src/ingest/{sources,geocode,normalize,load,run}.ts
        ▼
Census batch geocoder ──► ATL311 addresses → coordinates → NPU point-in-polygon join
        ▼
Snowflake INCIDENTS table (MERGE) ──► SNOWFLAKE.CORTEX.COMPLETE (anomaly findings, in-SQL)
        ▼
computePulse (backend/src/pulse.ts: z-scored incident rate + trend + resolution time → 0–100)
        ▼
Gemini generateReport (report card) ──► Postgres `reports` cache (backend/src/db.ts)
        ▼
Express API (backend/src/routes/*) ──► React + Leaflet map (frontend/src)
```

- **Ingest** — `backend/src/ingest/run.ts`: fetch → `normalizeRecord` → `loadIncidents`
  (Snowflake MERGE) → `computeNpuStats` → per-NPU `computePulse` + `cortexFindings`
  + `generateReport` → `upsertReport`. Both writes are keyed upserts, so re-running
  is safe. `--seed` replays the committed fixtures for a deterministic run.
- **Geocoding** — the ATL311 export publishes a street address, not coordinates,
  so `.github/workflows/geocode.yml` resolves them against the US Census batch
  geocoder and commits the result. 185 of 250 rows resolve; the rest stay `null`
  and are counted as rejected. **Coordinates are never invented** — a row that
  fails to match, or matches outside the Atlanta bounding box, is dropped.
- **Snowflake** — `backend/src/snowflakeClient.ts` uses the `snowflake-sdk` driver
  with RSA key-pair auth (`SNOWFLAKE_JWT`); password auth is blocked by MFA on this
  account. `cortexFindings` calls `CORTEX.COMPLETE` inside a SQL statement. The
  model is *not* pinned: a candidate list is tried in order and the first that
  answers is reused, because a hard-coded model silently broke this once already.
- **Gemini** — `backend/src/geminiClient.ts`: `generateReport` writes the card from
  the NPU's stats JSON plus the Cortex findings. `chatAnswer` exists and is tested
  but has no UI.
- **API** — Express serves `/api/npus`, `/api/npus/:npu`, `/api/compare`,
  `/api/chat`, `/api/health`, plus the built frontend as a static SPA fallback.
- **Frontend** — React + Leaflet: map of all 25 NPUs by pulse score, click-through
  report panel, and the Compare modal.

## The honesty rules this pipeline follows

Worth stating explicitly, because they are the design decisions that most affect
what a judge sees:

- **LLMs narrate, they never compute.** The pulse score is deterministic
  TypeScript z-scores (`backend/src/pulse.ts`). Gemini and Cortex describe those
  numbers; neither invents one.
- **Missing data is reported, not patched.** ATL311 rows that cannot be geocoded
  are counted and dropped rather than assigned a plausible NPU. NPUs with no
  closed requests get a `null` median, not a zero.
- **Unavailable services are marked, not faked.** If Cortex fails, the field gets
  a literal `[cortex-unavailable]` prefix. If Gemini fails, the report reads
  `[report pending]`. Neither is ever replaced with a fabricated narrative.

## How this was built

Pulse ATL was built with an agentic SDLC: an ideation spec and design spec
(including a frozen §5 API contract) were written first, then broken into Linear
tickets. Each ticket went to an isolated AI implementer session on its own
branch, scoped to that ticket. An orchestrator session reviewed each pull request
by *executing* the full suite (`npm test`, `npm run build`, `npm run e2e`) rather
than trusting the PR description, and merged only on green.

That review discipline earned its keep. Two separate LLM calls in this project
were silently pointing at models their vendors had retired — Gemini's
`gemini-2.0-flash` and Cortex's `mistral-large2` — and both failed into
placeholder text while the ingest reported success. They were caught by a health
check that reads a report back through the API and asks whether the content is
real or a placeholder, not by the green status code.

## Current state

- All 25 NPUs have a report row; the most recent ingest normalized 402 incident
  rows and rejected 98 (rejections are counted, never patched).
- Cortex findings and Gemini narratives are both real content, verified through
  the deployed API rather than from the ingest's exit status.
- Median resolution time is populated for 24 of 25 NPUs, spanning 0–4 days.
- **Not built:** the chat drawer (PUL-14) and the council advocacy letter
  (PUL-17). The chat backend exists; the UI does not.
- **Known data limitation:** NPU Q's boundary polygon is a 7-vertex placeholder
  against 100+ vertices for every other NPU, so point-in-polygon assignment near
  its edges is unreliable. Tracked in issue #25.

## Devpost compliance checklist

- [x] Public repo (stays public post-event)
- [ ] ≤ 2 min demo video stating "Hack RenderATL" at the start
- [x] Registered on Devpost; one project only
- [ ] **Submitted** — the original 8:00 PM deadline was missed; development
      continued afterward, so this is no longer a valid same-day submission.
      Anything submitted from this repo now must disclose that honestly.

## Screenshots

- `.screenshots/map-default.png` — default map view, all 25 NPUs colored by pulse score
- `.screenshots/report-panel.png` — report panel open for a selected NPU
- `.screenshots/compare-view.png` — Compare modal with both NPUs and the gap callouts
- `.screenshots/compare-null-gap.png` — Compare modal where an NPU has no median, showing the explicit "data unavailable" message rather than a fabricated 0
- `.screenshots/error-state.png` — full-screen error state with working retry
