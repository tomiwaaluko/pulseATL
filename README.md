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

## CI

`.github/workflows/ci.yml` runs `test`, `build`, and `e2e` jobs on every PR and on push to `main`, targeting Node 20.
