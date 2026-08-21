# Pulse ATL Implementation Plan

> **For agentic workers:** Tickets T1–T14 map 1:1 to Linear issues. Codex implements; a Claude Code reviewer gates every PR; the orchestrator (§B) dispatches and merges. Each ticket is self-contained — implementers see only their ticket + the repo. Specs live in-repo at `docs/` (committed in T1).

**Goal:** Ship the Pulse ATL P0 loop (ingest → Snowflake → AI → map UI) deployed on Render by 6:15 PM feature freeze.

**Architecture:** TS monorepo per `docs/pulse-atl-design-spec.md`. Express API reads a Postgres cache; a Render Workflow ingest job populates Snowflake and refreshes the cache; Gemini renders reports/chat; Vite/React/Leaflet frontend.

**Tech Stack:** Node 20, TypeScript strict, Express, pg, snowflake-sdk, @google/genai, Vite, React, react-leaflet, vitest, supertest, Playwright.

## Global Constraints (every ticket inherits these)

- API contract in design spec §5 is **frozen**. Changing it requires updating `backend/src/routes/*` + `frontend/src/types.ts` in the same PR and flagging the orchestrator.
- TypeScript `strict: true`; no `any` at module boundaries.
- Approved deps only: those in Tech Stack + `zod`, `turf` (point-in-polygon), `tailwindcss`. Anything else = ask orchestrator in PR comment.
- **Push after every commit.** Never hold local-only work — orchestrator and Claude track progress via remote.
- Branch naming: `ticket/PULSE-<n>-<slug>`. PR title: `[PULSE-<n>] <summary>`. PR body links the Linear issue.
- Before opening/updating a PR, run and pass: `npm test && npm run build && npm run e2e`. Paste output summary in PR body.
- Frontend-touching PRs must include Playwright screenshots of changed UI in a PR comment (§C).
- Feature freeze 6:15 PM ET. P2 tickets are not dispatched after 5:00 PM.

---

## A. Codex Session Contract (paste into every dispatch prompt)

```
You are implementing Linear ticket PULSE-<n> in repo <repo-url>.
Model policy for this ticket: <model from ticket header>.
1. git pull origin main; branch ticket/PULSE-<n>-<slug>.
2. Read docs/pulse-atl-design-spec.md sections referenced by the ticket. Do not
   relitigate locked decisions.
3. TDD: write failing tests first (vitest; Playwright for UI), then implement
   minimally, then refactor. Commit + push at each green state.
4. Definition of done: acceptance criteria all pass; npm test && npm run build
   && npm run e2e green locally; pushed; PR opened with test output + (if UI)
   screenshots comment; Linear issue moved to "In Review".
5. If blocked >20 min on anything, comment findings on the Linear issue and PR,
   push WIP, and stop — do not thrash.
```

**Model assignment rule:** `codex-5.6-sol-high` for exploratory, integration-heavy, or UI-quality-critical tickets; `codex-5.6-terra-medium` for well-scoped pure-code tickets with frozen interfaces. Per-ticket assignment is in each ticket header. Reviewer fix-loops reuse the ticket's model.

## B. Orchestrator Spec (Claude Code session — you talk to it from your phone)

Long-running Claude Code session with Linear MCP + `gh` CLI + Codex dispatch (Codex cloud API/MCP). Loop:

```
while open tickets remain:
  ready   = Linear issues: status=Todo, all blockedBy merged, priority P0>P1>P2
  active  = dispatched Codex sessions (cap: 3 concurrent)
  for each free slot: claim next ready ticket (status→In Progress, assignee=codex),
    dispatch Codex session with §A prompt + full ticket body + model from header
  on PR opened (poll gh, 60s):
    dispatch reviewer subagent (§C). 
    review loop: max 2 change-request rounds → 3rd failure escalates to Tomiwa
  on reviewer approval AND CI green:
    squash-merge; delete branch; Linear status→Done
    unblock dependents; tag hourly checkpoint (ckpt-HHMM) on main
  every 30 min: post status summary to Tomiwa (merged / active / blocked / ETA risk)
hard stops: 5:00 PM = no new P2 dispatches; 6:15 PM = freeze, only fix-PRs merge
```

**Escalation triggers (ping Tomiwa immediately):** contract-change request, dependency approval, 2-round review failure, any ticket >75 min in progress, CI red on main.

## C. Review Protocol (Claude Code reviewer subagent)

Per PR: check out branch; run `npm test && npm run build && npm run e2e` (execute, don't trust the PR body); run `ce-code-review` in `mode:agent` over the diff; verify acceptance criteria from the Linear ticket one by one; verify screenshots present for UI PRs. Post GitHub PR review: Approve, or Request Changes with a numbered, actionable list. No style nitpicks — bugs, contract violations, test gaps, security only.

**Playwright + screenshots:** `e2e/` at repo root; `npm run e2e` runs headless against a dev server with `--seed` data. Config captures screenshots (`test-results/`). UI PRs post them: `gh pr comment <n> --body "..."` with images uploaded via `gh api` (or committed to a `/.screenshots` branch folder if upload fights back — do not burn >15 min on image hosting).

---

## D. Tickets

Dependency graph (→ = blocks):

```
T1 → everything
T2 → T3 → T4 → T6        T5 → T6, T8       T7 → T8
T6, T8, T9 → T12 → T14    T8, T9 → T10(P1) → T13(P2)    T8, T9 → T11(P1)
```

### T1 [P0 · terra-medium · no deps] Repo scaffold + CI
**Files:** root `package.json` (workspaces: backend, frontend, e2e), `tsconfig.base.json`, `backend/` + `frontend/` skeletons per design spec §2, `e2e/playwright.config.ts` + one smoke spec, `.github/workflows/ci.yml` (jobs: test, build, e2e on PR), `docs/` (copy all three spec files), `.env.example`, README with run commands.
**Produces:** `npm test` / `npm run build` / `npm run e2e` green from fresh clone (empty-but-real tests OK); CI runs on PR.
**Accept:** fresh clone → `npm ci && npm test && npm run build && npm run e2e` exits 0; CI visible on a test PR.

### T2 [P0 · sol-high · deps: T1] Data source validation + fixtures
**Files:** Create `backend/src/ingest/SOURCES.md` (findings), `backend/test/fixtures/<source>.sample.json` (≥200 records each, real data), `frontend/data/npus.geojson` (NPU polygons from City ArcGIS hub).
**Work:** Hit the 4 portals in design spec §6 (ideation). Confirm fields (date, category, lat/lon, status). Pick final 2–3 datasets; document exact API URLs + field mappings in SOURCES.md. **Timebox 45 min; if a source is unusable, say so in SOURCES.md and move on — 2 sources is enough.**
**Produces:** fixture files + documented field mapping every downstream ticket relies on; NPU geojson with `NPU` property per polygon.
**Accept:** fixtures parse as JSON; geojson loads in geojson.io; SOURCES.md lists chosen sources with URLs + mapping tables.

### T3 [P0 · terra-medium · deps: T2] Canonical types + normalize + pulse math
**Files:** Create `backend/src/types.ts` (`Incident` matching design §3), `backend/src/ingest/normalize.ts`, `backend/src/pulse.ts`; tests `backend/test/normalize.test.ts`, `backend/test/pulse.test.ts`.
**Interfaces (Produces):**
```ts
normalizeRecord(raw: unknown, source: SourceId, npuIndex: NpuIndex): Incident | null  // null = unmappable, count + log
buildNpuIndex(geojson: FeatureCollection): NpuIndex                                    // turf point-in-polygon lookup
computePulse(stats: NpuStats, allStats: NpuStats[]): { score: number; trend: Trend }   // formula: design §4, deterministic
```
**Accept:** TDD from T2 fixtures; edge cases tested: missing coords → null NPU rejection, z-score with identical values, empty NPU.

### T4 [P0 · sol-high · deps: T3] Snowflake client + DDL + precompute
**Files:** Create `backend/src/snowflakeClient.ts`, `backend/src/ingest/load.ts` (Snowflake half), `backend/sql/schema.sql` (design §3 DDL); tests with snowflake-sdk mocked.
**Interfaces (Produces):**
```ts
sfQuery<T>(sql: string, binds?: unknown[]): Promise<T[]>
loadIncidents(rows: Incident[]): Promise<number>                    // MERGE upsert, returns count
computeNpuStats(): Promise<NpuStats[]>                              // aggregate SQL, 90d vs prior 90d + resolution medians
cortexFindings(stats: NpuStats, cityMedians: CityMedians): Promise<string>  // CORTEX.COMPLETE per design §4
```
**Accept:** mocked-unit tests green; a `scripts/smoke-snowflake.ts` run against the real trial account succeeds (orchestrator provides env; paste output in PR).

### T5 [P0 · terra-medium · deps: T1] Postgres + config
**Files:** Create `backend/src/config.ts` (zod-validated env), `backend/src/db.ts` (pg pool, `initSchema()` with design §3 `reports` DDL, `getReport(npu)`, `getAllReports()`, `upsertReport(r)`); tests with pg mocked or pg-mem.
**Produces:** exact signatures above; `Report` type in `backend/src/types.ts` (extend, don't rename existing).
**Accept:** tests green; `initSchema` idempotent (run twice in test).

### T6 [P0 · sol-high · deps: T2,T3,T4,T5] Ingest pipeline + seed mode
**Files:** Create `backend/src/ingest/sources.ts` (fetchers per SOURCES.md), `backend/src/ingest/run.ts` (fetch → normalize → loadIncidents → computeNpuStats → cortexFindings + Gemini report via T7 if merged, else placeholder string → upsertReport × 25). `--seed` flag: read fixtures instead of network.
**Accept:** `npm run ingest -- --seed` populates all 25 reports rows locally (against real Postgres, mocked/real Snowflake per env); fetcher unit tests use fixtures, no network in tests; idempotent re-run.

### T7 [P0 · terra-medium · deps: T1] Gemini client
**Files:** Create `backend/src/geminiClient.ts`; tests with SDK mocked.
**Interfaces (Produces):**
```ts
generateReport(npu: string, stats: NpuStats, cortexFindings: string): Promise<string> // markdown, ≤200 words, sections: headline/trend/top issues/contact
chatAnswer(npu: string, question: string, history: ChatTurn[], stats: NpuStats): Promise<string>
```
System prompts pin answers to provided data; refuse out-of-data speculation. Model: `gemini-2.5-flash` (override with `GEMINI_MODEL`; `gemini-2.0-flash` has been retired).
**Accept:** mocked tests assert prompt includes stats JSON; one real-API smoke script output pasted in PR.

### T8 [P0 · terra-medium · deps: T5,T7] API routes + server
**Files:** Create `backend/src/server.ts`, `backend/src/routes/{npus,compare,chat}.ts` implementing design §5 **exactly** (shapes frozen); static serving of `frontend/dist`; `/api/health`. Tests: supertest against mocked db/gemini.
**Accept:** every §5 endpoint tested incl. 404 unknown npu and empty-cache 503 on `/api/npus`; server boots with only `DATABASE_URL` (Snowflake not needed at request time).

### T9 [P0 · sol-high · deps: T1] Frontend: map + report panel
**Files:** Create `frontend/src/{App,api,types}.tsx|ts`, `components/{PulseMap,ReportPanel}.tsx` per design §6; Tailwind dark theme; `e2e/dashboard.spec.ts` (Playwright, API mocked via route interception): map renders 25 NPUs, click → panel shows report, loading + error states.
**Produces:** `types.ts` mirroring design §5 verbatim — backend agents diff against it.
**Accept:** `npm run e2e` green; screenshots (map, panel, error state) in PR comment; contract types match §5 field-for-field.

### T10 [P1 · terra-medium · deps: T8,T9] Compare view (ships before chat)
**Files:** Create `frontend/src/components/CompareView.tsx` + route/modal wiring + `e2e/compare.spec.ts`.
**Accept:** select two NPUs → side-by-side with huge gap callouts (pulse gap, resolution-days gap); screenshots in PR.

### T11 [P1 · terra-medium · deps: T8,T9] Chat drawer — **cut first if behind**
**Files:** Create `frontend/src/components/ChatDrawer.tsx` + `e2e/chat.spec.ts` (API mocked).
**Accept:** ask → answer renders; error state on 500; screenshots in PR.

### T12 [P0 · sol-high · deps: T6,T8,T9] Render deploy + Workflows
**Files:** Create `render.yaml` per design §7. Deploy: web service + Postgres via Render MCP/dashboard; ingest as **Render Workflow** — **timebox 45 min, then fall back to Render Cron Job** (same entrypoint, note the attempt in README). Set env vars; run one real ingest; verify `/api/health` shows row_count > 0.
**Accept:** public URL serves dashboard with real data; scheduled job visible in Render; `docs/DEMO.md` updated with URL + job screenshot.

### T13 [P2 · terra-medium · deps: T10] Council letter button
**Files:** `POST /api/letter {npu}` → Gemini drafts advocacy letter from report + stats; button in ReportPanel; copy-to-clipboard. e2e spec + screenshot.
**Accept:** letter cites ≥3 real stats from the NPU's data.

### T14 [P0 · sol-high · deps: T12] Demo hardening + final E2E
**Files/Work:** Seed prod cache (`--seed` fallback ready); full Playwright pass against the **deployed** URL; fix anything broken (fix-PRs allowed post-freeze); pre-warm one chat question; `docs/DEMO.md` final: demo script (ideation §8), URLs, screenshots of Render Workflow run + Snowflake query history + repo public check.
**Accept:** deployed e2e green; DEMO.md complete; compliance checklist (ideation §10) all checked except video.

---

## E. Self-Review (done)

Coverage: design §2 files all appear in exactly one ticket; §5 endpoints in T8 + consumed T9–T11; §4 split: Cortex in T4, Gemini in T7; prize-critical Workflows in T12. Type consistency: `Incident`/`NpuStats`/`Report` defined T3/T5, consumed T4/T6/T8 by exact name. No placeholders: every ticket has files, signatures or acceptance criteria, and run commands. Gap accepted knowingly: full implementation code omitted per deadline adaptation — interface contracts + TDD mandate carry correctness instead.
