# Pulse ATL — Design Spec

Consumes: `pulse-atl-ideation-spec.md`. Every open question from §13 is resolved here. Decisions are final — agents do not relitigate them.

---

## 1. Locked Decisions

| Decision | Choice | Why |
|---|---|---|
| Neighborhood unit | **NPU (25 units)** | Clean official polygons, small enough to precompute all reports |
| Backend | **Node 20 + TypeScript + Express** | One language end-to-end; matches Tomiwa's review fluency under time pressure (brainstorm override of original Python pick) |
| Frontend | **Vite + React + TypeScript**, static build served by Express | One deployable web service on Render; no SSR complexity |
| Map | **Leaflet + react-leaflet, OSM tiles** | Zero API keys, zero signup friction |
| Ingest | **TS job on Render Workflows** (fallback: Render Cron Job if Workflows SDK blocks) | Prize requires Workflows; fallback protects the demo |
| App DB | **Render Postgres** — cache of computed reports + chat context | Keeps dashboard fast + survives Snowflake trial hiccups during live demo |
| Warehouse | **Snowflake trial** via `snowflake-sdk` (Node); **Cortex** via `SNOWFLAKE.CORTEX.COMPLETE` in SQL | Hits "Snowflake API + LLMs" prize language directly |
| Gemini | **gemini-2.5-flash** via `@google/genai` SDK (override with `GEMINI_MODEL`) | Fast + cheap; reports and chat. Was `gemini-2.0-flash`, which Google has since retired — it is no longer in the models list the API key can reach, so every call returned `ApiError`. |
| Styling | Tailwind CDN-free (vite plugin), dark map-first UI | Agents move fastest in Tailwind |
| Repo | Monorepo, single Render Blueprint (`render.yaml`) | One-command infra |

## 2. Repo Structure

```
pulse-atl/
├── render.yaml                  # Blueprint: web service + workflow + postgres
├── backend/
│   ├── package.json             # workspaces root also fine; keep simple
│   ├── src/
│   │   ├── server.ts            # Express app, serves /api/* + static frontend
│   │   ├── config.ts            # env loading (zod-validated)
│   │   ├── db.ts                # Postgres (pg) pool + schema init
│   │   ├── snowflakeClient.ts   # query helper + Cortex wrapper
│   │   ├── geminiClient.ts      # report + chat generation
│   │   ├── routes/
│   │   │   ├── npus.ts          # GET /api/npus, GET /api/npus/:id
│   │   │   ├── compare.ts       # GET /api/compare?a=V&b=B
│   │   │   └── chat.ts          # POST /api/chat
│   │   ├── pulse.ts             # pulse score math (pure functions)
│   │   └── ingest/
│   │       ├── sources.ts       # per-dataset fetchers → canonical records
│   │       ├── normalize.ts     # schema mapping, point-in-polygon NPU join
│   │       ├── load.ts          # Snowflake load + Postgres cache refresh
│   │       └── run.ts           # entrypoint: fetch → normalize → load → precompute
│   └── test/                    # vitest; one file per module
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # layout: map + side panel
│   │   ├── api.ts               # typed fetch client (mirrors §5 contracts)
│   │   ├── components/
│   │   │   ├── PulseMap.tsx     # Leaflet choropleth of NPUs
│   │   │   ├── ReportPanel.tsx  # Gemini report card
│   │   │   ├── CompareView.tsx  # side-by-side equity view
│   │   │   └── ChatDrawer.tsx   # resident Q&A
│   │   └── types.ts             # shared response types
│   └── data/npus.geojson        # committed boundary file (fetched once in ticket 1)
└── docs/                        # specs + plan live here in-repo
```

## 3. Data Model

### Canonical incident (Snowflake `PULSE.PUBLIC.INCIDENTS`)

```sql
CREATE TABLE IF NOT EXISTS INCIDENTS (
  ID           STRING PRIMARY KEY,      -- source_prefix + native id
  SOURCE       STRING NOT NULL,         -- 'apd_crime' | 'code_enforcement' | ...
  CATEGORY     STRING NOT NULL,         -- normalized: 'crime' | 'blight' | 'infrastructure'
  SUBCATEGORY  STRING,                  -- raw offense/case type
  OCCURRED_AT  TIMESTAMP_NTZ NOT NULL,
  RESOLVED_AT  TIMESTAMP_NTZ,           -- null = open
  STATUS       STRING,                  -- 'open' | 'closed' | 'unknown'
  LAT          FLOAT, LON FLOAT,
  NPU          STRING NOT NULL          -- 'A'..'Z' (joined at ingest)
);
```

Every source fetcher maps into this shape. A source that lacks a field emits null — downstream code must tolerate nulls everywhere except `ID, SOURCE, CATEGORY, OCCURRED_AT, NPU`.

### Postgres cache (`reports` table)

```sql
CREATE TABLE IF NOT EXISTS reports (
  npu TEXT PRIMARY KEY,
  pulse_score REAL NOT NULL,          -- 0-100
  trend TEXT NOT NULL,                -- 'improving' | 'stable' | 'worsening'
  stats_json JSONB NOT NULL,          -- aggregates from Snowflake (§4)
  cortex_findings TEXT NOT NULL,      -- Cortex anomaly narrative
  gemini_report TEXT NOT NULL,        -- rendered markdown report card
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Precomputed for all 25 NPUs at end of every ingest run. Dashboard reads are cache-only — no live Snowflake/Gemini call on page load. Chat is the only live-LLM path.

## 4. Intelligence Split (prize-critical)

**Pulse score (pure TS, `pulse.ts`):** `score = 100 - clamp(0.5*z(incident_rate_90d) + 0.3*z(trend_delta) + 0.2*z(median_open_days), 0, 100-scale)`. z = z-score across NPUs. Deterministic, testable, explainable in demo.

**Snowflake side (per NPU, in `load.ts` precompute):**
1. Aggregate SQL: counts by category (90d vs prior 90d), median days-to-resolution, open case count → `stats_json`.
2. Cortex call *inside Snowflake SQL*:
```sql
SELECT SNOWFLAKE.CORTEX.COMPLETE('<model>',
  'You are a civic data analyst. Given these NPU stats vs city medians, identify the 2 most significant anomalies or trends in <=80 words, neutral tone: ' || :stats_and_medians_json
) AS findings;
```

The prompt is locked; the **model is not**. `mistral-large2` was the original
choice and Cortex has since moved it to legacy state, answering every call with
`400 'The model mistral-large2 has been in legacy state, please use other
models.'` — so all 25 NPUs silently took the fallback. Which models a Cortex
account can reach also varies by region and entitlement. `load.ts` therefore
tries `CORTEX_MODEL_CANDIDATES` in order and reuses the first that answers,
or uses `SNOWFLAKE_CORTEX_MODEL` exactly when it is set.

**Gemini side (`geminiClient.ts`):**
- `generate_report(npu, stats_json, cortex_findings) -> markdown` — report card: headline, 3 bullets, trend, "who to contact" (NPU meeting info from a small static dict).
- `chat(npu, history, question, stats_json) -> answer` — system prompt pins it to provided data; must refuse speculation beyond data.

## 5. API Contract (frozen — frontend and backend build against this in parallel)

```
GET /api/npus
→ 200 {"npus":[{"npu":"A","pulse_score":72.1,"trend":"stable"}, ...]}   # all 25

GET /api/npus/{npu}
→ 200 {"npu":"V","pulse_score":41.0,"trend":"worsening",
       "stats":{...stats_json...},"cortex_findings":"...","report_md":"...",
       "updated_at":"2026-08-12T17:00:00Z"}
→ 404 {"detail":"unknown npu"}

GET /api/compare?a=V&b=B
→ 200 {"a":{<same as GET npu>},"b":{...},
       "gap":{"pulse_gap":31.2,"resolution_days_gap":41}}

POST /api/chat  {"npu":"V","question":"...","history":[{"role":"user","content":"..."}]}
→ 200 {"answer":"...","npu":"V"}       # streaming NOT required — return complete

GET /api/health → 200 {"ok":true,"last_ingest":"...","row_count":12345}
```

`frontend/src/types.ts` mirrors these shapes exactly; any change requires updating both files in the same PR.

## 6. Frontend Design

Single screen, dark theme, map-first. Layout: full-bleed Leaflet map; right side panel (drawer on mobile).

- **PulseMap:** NPU choropleth from `data/npus.geojson`, fill = score gradient (red 0 → green 100), click selects NPU. Legend bottom-left. Selected NPU outlined.
- **ReportPanel:** score dial, trend badge, Gemini report markdown, "last updated" stamp, buttons: [Compare] [Ask about this area].
- **CompareView:** modal, two NPU columns + computed gap callouts. This is the demo money shot — make the gap numbers huge.
- **ChatDrawer:** bottom drawer, message list + input, calls `/api/chat`.
- Empty/loading states: skeleton panel; if `/api/npus` fails, full-screen error with retry (judges may hit a cold start).

## 7. Deployment (`render.yaml`)

- **web** — Node; build: `npm ci && npm run build` (backend tsc + frontend vite build, dist served statically by Express); start: `node backend/dist/server.js`. Health check: `/api/health`.
- **ingest workflow** — Render Workflows task wrapping `python -m ingest.run`; schedule hourly. **Fallback if Workflows SDK fights back (timebox 45 min): Render Cron Job, same entrypoint** — demo narration still shows Render-managed scheduled pipeline; keep Workflows attempt visible in repo either way.
- **postgres** — free tier instance.

Env vars (set in Render dashboard, `.env.example` committed): `DATABASE_URL`, `SNOWFLAKE_ACCOUNT/USER/PASSWORD/WAREHOUSE/DATABASE`, `GEMINI_API_KEY`.

## 8. Seeding & Demo Resilience

`ingest/run.ts --seed` mode loads committed sample extracts (from ticket 1) instead of live fetch — guarantees a populated dashboard even if a portal goes down before the demo. Postgres cache means the live demo never blocks on Snowflake/Gemini except in chat; pre-warm chat with one canned question before recording.

## 9. Testing Bar (what tickets enforce)

- `pulse.ts`, `normalize.ts` (incl. point-in-polygon): unit tests, TDD, no mocks needed.
- Routes: vitest + supertest against fake Postgres rows; Snowflake/Gemini clients mocked at module boundary.
- Ingest fetchers: one test per source against committed sample fixture files (no network in tests).
- Frontend: skip unit tests (time); one manual QA checklist item per component in the final ticket.
- Every PR: agents must run full `npm test` + `npm run build` before marking done (verification-before-completion).
- **P1 priority order (brainstorm override): CompareView ships before ChatDrawer.** If time runs short, chat is cut first.

---
*Next: implementation plan (`pulse-atl-implementation-plan.md`) — tasks map 1:1 to Linear tickets.*
