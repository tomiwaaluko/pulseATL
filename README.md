# Pulse ATL

An AI-powered neighborhood pulse dashboard that turns Atlanta's fragmented civic open data into plain-English neighborhood health reports — and shows which neighborhoods the city is leaving behind.

Built for **Hack RenderATL** (August 12, 2026) with an agentic SDLC: Codex implementers, a Claude Code orchestrator/reviewer, and Linear-driven tickets.

## How it works

```
Atlanta open data (crime, code enforcement, GIS)
        │  scheduled ingest (Render Workflow)
        ▼
Snowflake warehouse ──► Cortex trend/anomaly analysis
        ▼
Express API + Render Postgres cache
        ▼
React + Leaflet map dashboard ──► Gemini reports & resident chat
```

## Docs

- [Ideation spec](docs/pulse-atl-ideation-spec.md) — problem, prize mapping, data strategy
- [Design spec](docs/pulse-atl-design-spec.md) — locked decisions, data model, **frozen API contract (§5)**
- [Implementation plan](docs/pulse-atl-implementation-plan.md) — tickets T1–T14, orchestration & review protocol

## Repo structure

Monorepo with npm workspaces: `backend/` (Express + TypeScript API), `frontend/` (Vite + React + Tailwind), `e2e/` (Playwright). See `docs/pulse-atl-design-spec.md` §2 for the full target layout.

## Prerequisites

- Node 20+
- npm 10+

## Run commands

```bash
# install all workspace dependencies
npm ci

# run backend unit tests (vitest)
npm test

# type-check + build backend and frontend
npm run build

# run the Playwright e2e smoke suite (builds first, then boots the server)
npm run e2e

# local dev servers
npm run dev:backend    # Express API on :3000 (tsx watch)
npm run dev:frontend   # Vite dev server on :5173
```

Copy `.env.example` to `.env` and fill in real values before running anything that touches Postgres, Snowflake, or Gemini (not required for this scaffold ticket).

## Ingest pipeline

`backend/src/ingest/run.ts` is the batch entrypoint (T6). It runs
fetch → `normalizeRecord` → `loadIncidents` (Snowflake MERGE) → `computeNpuStats`
→ per NPU `computePulse` + `cortexFindings` + Gemini `generateReport` →
`upsertReport` into the Postgres `reports` cache. Both incident and report writes
are keyed upserts, so re-running is safe.

```bash
# demo/seed mode: read the committed fixtures instead of the portals
npm run ingest -- --seed

# live mode: fetch the endpoints documented in backend/src/ingest/SOURCES.md
npm run ingest

# demo-insurance mode: never touch Snowflake at all (see below)
npm run ingest -- --no-snowflake
```

Required environment for a real run (both modes still write to Snowflake and
Postgres — `--seed` only changes where the *input rows* come from):

| Variable | Needed for | Behaviour when missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres `reports` cache | required — the run fails |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER` | incident load + stats | required — the run fails |
| `SNOWFLAKE_PRIVATE_KEY` (+ optional `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`) or `SNOWFLAKE_PASSWORD` | Snowflake auth | one of the two is required — the run fails naming both if neither is set |
| `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE` | connection defaults | optional |

### Demo-only: triggering ingest over HTTP

`GET /api/admin/ingest?token=<INGEST_TOKEN>` runs the same seed ingest as
`npm run ingest -- --seed`, but from the already-deployed service — for
environments (like a demo host) where nothing outside the service can reach
Postgres/Snowflake directly. It is a demo convenience, not a general admin
API: the route is **disabled (404) unless `INGEST_TOKEN` is set**, requires
the token as a query param, and only ever runs the seed pipeline. Do not set
`INGEST_TOKEN` in a deployment you don't want this reachable on.
| `GEMINI_API_KEY` | report narratives | reports are written with the literal placeholder `[report pending]`, never a fabricated narrative |

### Snowflake authentication: key-pair vs. password

Snowflake accounts with MFA enforced reject password authentication for
programmatic/API clients — Snowflake returns error `394509` ("MFA
authentication is required, but none of your current MFA methods are
supported for programmatic authentication"). Key-pair authentication
(`SNOWFLAKE_JWT`) is the supported workaround: it authenticates a dedicated
service user with an RSA key pair instead of a password, and isn't subject
to MFA.

To use it:

1. Generate an RSA key pair (PKCS#8, unencrypted or passphrase-protected):
   ```bash
   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
   openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
   ```
2. Assign the public key to the Snowflake service user (`ALTER USER <user>
   SET RSA_PUBLIC_KEY='<contents of rsa_key.pub, header/footer stripped>';`).
3. Set `SNOWFLAKE_PRIVATE_KEY` to the full contents of `rsa_key.p8` (the
   `-----BEGIN PRIVATE KEY-----` PEM block). If your secret store collapses
   the key to one line with literal `\n` sequences instead of real
   newlines, that's handled automatically — no manual re-formatting needed.
   Set `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` too if the key is encrypted.

`snowflakeClient.ts` prefers `SNOWFLAKE_PRIVATE_KEY` when present and falls
back to `SNOWFLAKE_PASSWORD` (legacy, non-MFA accounts only) otherwise; if
neither is set, it throws naming both variables.

Notes:

- **Seed date shift.** The committed fixtures are archives (APD ≈2016–17,
  ATL311 = 2015). In `--seed` every `occurred_at`/`resolved_at` is moved forward
  by a single whole-day offset per source, so the newest row lands on yesterday
  and the 90-day window is populated. Relative deltas — including resolution
  durations — are preserved exactly, and the shift is deterministic.
- **Rejected rows are counted, not patched.** The 2015 ATL311 export publishes an
  address rather than coordinates, so those rows cannot be joined to an NPU and
  are rejected with a per-source count in the log. Coordinates and NPU
  assignments are never invented.
- **All 25 NPUs get a row.** NPUs with no incidents are scored from a synthesized
  zero-count stats entry inside the full 25-element array that `computePulse`
  z-scores against.
- **`--no-snowflake` (demo insurance).** Skips `loadIncidents` and
  `computeNpuStats` entirely — nothing on this path ever reaches Snowflake, so a
  bad trial account or credential typo on demo night can't zero out the
  dashboard. It always reads and date-shifts the committed fixtures (like
  `--seed`, regardless of whether `--seed` is also passed), aggregates
  `NpuStats` locally in TypeScript (`backend/src/ingest/localStats.ts`), and
  writes the literal `[cortex-unavailable] Snowflake Cortex was not reachable
  for this run.` to `cortex_findings`. Postgres and Gemini still run
  normally. Use it only as a fallback when Snowflake itself is the thing that's
  broken — the default path is unchanged and should stay the primary route.
- **Live fetchers may be blocked.** The fetchers target the endpoints in
  `SOURCES.md`; some sandboxes and CI runners block that egress. Unit tests never
  hit the network — they run against the committed fixtures. Verified once from
  this container: the APD mirror returns 268,748 CSV rows with the fixture's
  field names, and the ATL311 archive expands to a 146 MB CSV, so a live ATL311
  run needs headroom that `--seed` does not.

## CI

`.github/workflows/ci.yml` runs `test`, `build`, and `e2e` jobs on every PR and on push to `main`, targeting Node 20.
