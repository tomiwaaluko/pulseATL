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

Scaffold, run commands, and deploy instructions land with T1 (PUL-5).
