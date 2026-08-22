---
title: "Building Pulse ATL — decisions, trade-offs, and why every green checkmark lied"
problem_type: architecture_pattern
severity: high
resolution_type: pattern_established
component: [ingest-pipeline, llm-integration, ci-workflows, data-quality]
root_cause: [status-code-as-evidence, llm-ungrounded-output, mis-specified-acceptance-criteria, sandbox-egress-policy]
track: knowledge
created: 2026-08-22
repo: tomiwaaluko/pulseATL
---

# Building Pulse ATL — decisions, trade-offs, and why every green checkmark lied

> Project-scope retrospective. Written at the point the build reached a resting state: all tickets closed except one blocked on a product decision, `main` at `c35cdfd`, 189 unit tests and 18 e2e green.

---

## Context

**Pulse ATL** is an AI-assisted civic-data dashboard for Atlanta's 25 Neighborhood Planning Units (NPUs). It ingests open city data, computes a per-neighborhood "pulse score", and renders a map with generated report cards, side-by-side neighborhood comparison, grounded Q&A, and a draft advocacy letter to a city council member.

It was built for Hack RenderATL under a one-day deadline. **That deadline was missed.** The decision was made deliberately to keep building afterwards rather than abandon it, so this document describes a project that failed its original delivery constraint and continued — which is itself one of the trade-offs recorded below.

### The shape of the system

```
Atlanta open data → geocode → normalize → Snowflake INCIDENTS (MERGE)
                                              ↓
                                       computeNpuStats
                                              ↓
                        Cortex findings ──────┴────── Gemini narrative
                                              ↓
                              Postgres `reports` cache
                                              ↓
                          Express API → React + Leaflet map
```

### The constraint that shaped everything

Two separate LLMs sit in the middle of a data pipeline whose entire claim is that it surfaces **real** civic inequity. An invented number does not merely degrade the product — it manufactures the finding the product exists to report. Every design decision below descends from that.

---

## Guidance

### 1. A green status code is not evidence when an LLM is in the pipeline

This is the single most important lesson and it recurred **four times** in different disguises.

The pipeline reported `{"ok":true,"reports_written":25}` while writing 25 rows of placeholder text. CI was green. The ingest exit code was green. `/api/health` reported `row_count: 25`. Every observable signal was healthy and every one of them was measuring the wrong thing — they confirmed that *rows existed*, never that the rows contained anything real.

**The rule that came out of it:** for any step where a model produces content, the test must read the content back and assert on its substance. Status, length, and row count are all satisfiable by garbage.

Concretely, `e2e/tests/deployed.spec.ts` asserts the deployed report text does **not** contain `[report unavailable` or `[cortex unavailable`, and checks that Cortex, Gemini and the chat answer independently agree on the same incident count. Agreement across three independently-generated texts is the strongest cheap signal that none of them is improvising.

### 2. Deterministic core, LLM narration — never let the model compute

The pulse score is computed in TypeScript by `computePulse` (`backend/src/pulse.ts`), a fixed z-score composite over all 25 NPUs:

```ts
const riskZ = 0.5 * zScore(stats.incident_count_90d, ...)
  + 0.3 * zScore(trendDelta(stats), deltas)
  + 0.2 * zScore(stats.median_resolution_days ?? 0, openDays);
const score = Math.round(clamp(100 - (50 + 10 * riskZ), 0, 100) * 10) / 10;
```

No language model touches that arithmetic. The LLMs narrate what the number means; they never produce it. When the chat was finally given the score (`c35cdfd`), it was given the *derivation* too, and explicitly told not to recompute:

> The pulse score is NOT produced by a language model. It is computed in TypeScript by a fixed, deterministic formula over all 25 NPUs...

**Why the derivation and not just the number:** handed a score alone and asked "how is that calculated?", a model will produce a formula that sounds plausible instead of the real one. Supplying the actual weights is the difference between explaining and confabulating.

### 3. Refusal is a feature — but a refusal is still a 200

A deployed test passed **green** while the chat replied:

> "The provided data does not contain information about a 'pulse score.' Therefore, I cannot answer what is driving it."

Two distinct findings sat inside that one line.

**First**, the guardrail worked. The prompt instructs the model to refuse when the data does not support an answer, and it refused rather than inventing. That is the system behaving correctly under a gap.

**Second**, the test could not tell. A refusal is a `200 OK` with fluent sentences in it — indistinguishable from a good answer by status or length. The assertion was changed to require the response quote a real figure (`incident_count_90d`), so a refusal can no longer pass.

**Third and underneath both**, the gap was real: `chatAnswer` received the `stats_json` aggregates but never `pulse_score`. The score is the largest element on the panel and the [Ask] button sits directly beside it, so the most natural question the interface invites was the one question the model was blind to.

### 4. Never fabricate data to satisfy a metric — the metric is the thing that should move

This came up three times, and holding the line each time is what makes the product's central claim defensible.

- **The ATL311 resample** draws rows uniformly at random. From `backend/scripts/resample-atl311.ts:16`:
  > `Rows are drawn UNIFORMLY AT RANDOM, never ranked or filtered by how long they took to resolve. Selecting slow-resolving rows would manufacture the disparity the dashboard claims to have discovered.`
- **Geocoding** left 63 rows `null` rather than filling them. Four rows matched more than one Atlanta quadrant (`513 EDGEWOOD AVE`, `77 STAFFORD ST`, `230 HOWARD ST`, `188 PIEDMONT AVE`) and were deliberately left unresolved — Atlanta reuses house numbers across NE/NW/SE/SW, so a multi-quadrant match is a question, not an answer.
- **The council letter** refuses to draft at all below three citable figures, and does not call Gemini in that case (`MIN_CITED_FIGURES = 3`, `backend/src/geminiClient.ts:124`). Asking a model for three citations that do not exist is precisely how a letter acquires an invented statistic.

The letter is the sharpest case because it is the one artifact a resident might actually mail to a real official. When generation fails it returns `[letter-unavailable]` and the UI renders **no textarea and no copy button** — a failure notice cannot be copied and mistaken for a letter.

### 5. Measure the acceptance criterion before trusting it

The geocoding criterion — *≥85% of the 250 fixture rows inside the Atlanta bounding box* — was never satisfiable, and the reason was invisible until measured.

Final coverage was **74.8%** (187/250). Of the 63 unresolved rows, **45 were matched exactly by the Census geocoder** and fall outside the box because the address is genuinely in Sandy Springs, Dunwoody, Fairburn, Union City, Palmetto, south Fulton — and in one case **Sumter, South Carolina**.

Checking the newly-installed official boundary layer settled it:

```
Official NPU layer bounds:  lon -84.5509 .. -84.2896   lat 33.6480 .. 33.8869
Acceptance bbox:            lon -84.6000 .. -84.2000   lat 33.6000 ..  33.9000
bbox fully contains the real NPU extent?  true
```

The bbox is sound, so those 45 rows lie outside **every** NPU polygon — they can never contribute to a per-NPU statistic however well they geocode. The criterion's denominator counted rows definitionally incapable of satisfying it. Against the in-study-area denominator, coverage is **187/205 = 91.2%**.

**The discipline that matters here:** the failing number was left recorded as a failure. Re-scoping the denominator is a legitimate fix, but it is a *decision*, and quietly adopting the flattering number would be the same error as the fabricated polygon in §6. Both figures are true; they answer different questions.

### 6. Fabricated data hides in inputs, not just outputs

`frontend/data/npus.geojson` was sourced from a third-party mirror that ships **24 features** — NPU Q is absent from it entirely. Someone had added a **7-vertex placeholder** to make the count reach 25. Every other NPU had 107+ vertices.

Seven points cannot describe a neighborhood boundary. Every point-in-polygon join near Q was resolving against invented geometry, feeding `computeNpuStats`, feeding the pulse score — for Q *and* its neighbours, in both directions.

Replaced with the City of Atlanta Department of City Planning's own ArcGIS layer. **Q went from 7 vertices to 403**, and is no longer the smallest NPU (that is now Y at 134).

The fetch script (`backend/scripts/fetch-npus.ts`) writes nothing unless the response satisfies *all* of: 25 features, the exact letter set A–Z minus U, no duplicates, Polygon/MultiPolygon geometry, every coordinate inside a metro-Atlanta envelope, and ≥50 vertices per NPU. Validation is proportional to the fact that this file poisoned the joins silently once already.

### 7. When a model is retired, everything downstream fails silently

Two separate LLM calls were pointing at retired models simultaneously, and **both failed quietly**:

- Gemini pinned to `gemini-2.0-flash`, retired by Google. The API key was valid and listed 37 available models.
- Cortex pinned to `mistral-large2`, answering `400 'The model mistral-large2 has been in legacy state, please use other models.'`

Both were hidden by a bare `catch {}` that swallowed the reason. The fix was not another hard-coded name but an ordered candidate list that caches the first model that answers (`backend/src/ingest/load.ts:266`):

```ts
export const CORTEX_MODEL_CANDIDATES = [
  "claude-sonnet-4-5",
  "llama3.1-70b",
  "mistral-large",
  "snowflake-arctic",
] as const;
```

Model availability varies by region and entitlement as well as retirement, so an ordered list covers all three. `SNOWFLAKE_CORTEX_MODEL` pins one exactly when set.

### 8. Fixing a bottleneck can break the thing that measured it

After both models were repaired, the hourly ingest workflow started **failing** — and the failure was caused by the fix.

While both LLM calls were failing fast, all 25 NPUs took the placeholder path and the whole pipeline finished in about 34 seconds. Once the models worked, a run made ~25 Cortex completions plus ~25 Gemini generations. The workflow's confirmation poll allowed 5 minutes.

Measured duration of a working run: **5m20s**. The pipeline was overshooting the timeout by **twenty seconds**.

The lesson generalises past this bug: a timeout calibrated against a broken system encodes the brokenness as an assumption. The replacement uses a wall-clock deadline rather than an iteration count (each health probe can itself take up to 60s), and reports elapsed time plus the last payload on failure — because the old message could not distinguish "service stalled" from "service unreachable".

---

## Decision log and trade-offs

| Decision | Chosen | Rejected | Trade-off accepted |
|---|---|---|---|
| Neighborhood unit | 25 NPUs | 240+ named neighborhoods | Less relatable to residents; far cleaner statistics and a tractable 25-way comparison |
| Pulse score | Deterministic TypeScript z-scores | LLM-computed score | Less "impressive" AI surface; the number is reproducible, testable, and explainable — the whole basis of trusting it |
| Intelligence split | Cortex = SQL-side anomaly analysis; Gemini = user-facing narrative | One model for both | Two integrations, two failure modes (both bit us); satisfies two prize tracks and keeps analysis next to the data |
| Cortex model | Ordered candidate list | Single pinned model | Slight nondeterminism in which model answers; survives retirement, region and entitlement differences |
| Ingest trigger | GitHub Actions → deployed admin endpoint | Run pipeline on the runner | Extra hop and a token to protect; **necessary** — external TLS to Render Postgres is terminated, so only the service can write to its own database |
| Scheduling | GitHub Actions cron | Render Workflows / cron jobs | Lives outside the platform running the app; Render's schedulers require a paid plan |
| Map tiles | Leaflet + OpenStreetMap | Mapbox | Plainer visuals; zero API keys, zero key-provisioning friction |
| Snowflake auth | RSA key-pair (`SNOWFLAKE_JWT`) | Password | More setup, key material to handle; **forced** — MFA blocks password auth (error 394509) |
| Geocoding | US Census batch geocoder | Commercial geocoder | Lower match rate on messy addresses; free, no key, and defensible provenance for a civic-data claim |
| Unmatched addresses | Left `null` | Centroid / ZIP fallback | Coverage metric misses its bar; **non-negotiable** — synthetic coordinates would manufacture the equity finding |
| Letter length | Prompt-enforced 300-word budget | Hard truncation like `generateReport` | Occasional overrun; truncating a letter someone is about to send, mid-sentence, is the worse failure |
| Deployed e2e | Separate spec, `test.skip` gated, runner-only | Point the whole suite at prod | Two suites to maintain; local runs stay fast and hermetic |
| Missed deadline | Kept building | Abandon at the deadline | No Devpost submission; a working, honest system instead of an unfinished one |

### Constraints that dictated rather than invited a choice

- **Sandbox egress is closed.** The orchestration environment answers `403` to `CONNECT` for `*.arcgis.com`, `geocoding.geo.census.gov`, `tile.openstreetmap.org` and the deployed Render URL. Every task needing the open internet — boundary fetch, geocoding, deployed e2e — runs from a GitHub-hosted runner and commits results back. `.github/workflows/geocode.yml` is the precedent the others follow.
- **Tokens lack `actions: write`.** Workflows cannot be fired via `workflow_dispatch`, so each has a push trigger on an `ops/run-*` branch. Pushing to the branch *is* the trigger.
- **Render free tier.** No paid Postgres, no cron, no Workflows. Free Postgres **expires 2026-09-11**. Cold start measured at **29.3 seconds**; warm chat responses at **1.09–1.21 s**.

---

## Why This Matters

The generalisable claim is narrow and worth stating precisely:

**When a language model sits inside a data pipeline, the pipeline's observability was designed for a world where components fail loudly. Models do not fail loudly. They fail fluently.**

A crashed service returns 500. A model given no data returns a well-formed paragraph explaining that it cannot help — with a 200, a plausible length, and correct grammar. Every conventional health signal reads that as success. Four separate times on this project, the monitoring said healthy while the product was empty, placeholder, or refusing.

The corollary is that **verification has to move down to content**, and content assertions have to be written to fail on the *specific* fluent-but-empty outputs a model produces: placeholder markers, refusals, restated questions. Generic assertions ("returns 200", "length > 0") are exactly the ones a confabulating model satisfies.

The second claim is about data integrity under metric pressure. Three times, a number could have been improved by degrading the data — filtering the sample, inferring coordinates, loosening a citation floor. Each time the metric was allowed to stay unmet instead. For a system whose output is *"this neighborhood is underserved"*, that is not fastidiousness; it is the only thing separating the product from an elaborate way of generating plausible civic grievances.

---

## When to Apply

**Reach for this pattern when:**

- An LLM generates user-facing content from structured data, and someone will act on that content
- A pipeline has multiple stages where a failure can produce well-formed-but-empty output
- Acceptance criteria are expressed as thresholds over a dataset you did not author
- A metric can be moved either by improving the system or by degrading the data

**It is overkill when:**

- The model's output is decorative and no decision depends on it
- The pipeline is short enough that a human reads every output before it ships
- The data is synthetic or illustrative and makes no claim about the world

---

## Examples

Each of these is a merged commit on `main` and can be read in full.

| Learning | Commit | What it fixed |
|---|---|---|
| Retired models fail silently | `d3a5e7d` (#28) | Gemini off `gemini-2.0-flash`; fallbacks say *why* they fired |
| Model pinning is fragile | `7f61bdd` (#30) | Cortex candidate list replaces a single pinned model |
| Only the service can write to its own DB | `ecf55a9` (#29) | Ingest triggers the deployed admin endpoint instead of running on the runner |
| Sampling must not select on the outcome | `dba7354` (#27) | ATL311 resample drawn uniformly at random |
| A timeout can encode a broken system | `53a03e4` (#32) | Confirmation window widened 5m → 15m, wall-clock, with diagnostics |
| Nothing had ever tested the deployment | `152a32a` (#33) | `E2E_BASE_URL` + real-API spec; `webServer` disabled for remote targets |
| Fluent refusal ≠ answer | `152a32a` (#33) | Chat assertion requires quoting a real figure |
| Failure notices must be unusable | `a1ca719` (#34) | `[letter-unavailable]` renders with no copy affordance |
| Fabricated input data | `a61a65b` (#35) | Official NPU layer; Q 7 → 403 vertices |
| Grounding gaps invite confabulation | `c35cdfd` (#36) | Chat receives `pulse_score`, `trend`, and the real derivation |

### The most reusable single artifact

`backend/src/redact.ts` — shared secret redaction applied to every error surface, so that improving diagnostics never becomes a way to leak credentials into logs or PR bodies:

```ts
const SECRET_ENV_VARS = [
  "INGEST_TOKEN", "SNOWFLAKE_PASSWORD", "SNOWFLAKE_PRIVATE_KEY",
  "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE", "DATABASE_URL", "GEMINI_API_KEY",
] as const;
```

Most of this project's debugging progress came from making errors *more* verbose. That is only safe if redaction is centralised first.

---

## Open items at time of writing

Recorded so this document does not overstate completeness:

1. **PUL-19 geocode criterion** remains formally failed at 74.8%. The denominator question above is a pending product decision, not an unfinished implementation.
2. **Live prompt quality is unmeasured.** Every LLM test mocks the SDK. The deployed spec proves the score and stats *reach* Gemini; it does not prove Gemini uses them well.
3. **`PULSE_DERIVATION` duplicates `backend/src/pulse.ts` in prose** and will drift if the weights change. Per-weight test assertions fail loudly on divergence, which is the best available guard short of generating the prose from the code.
4. **The Devpost deadline was missed** and cannot be recovered. Items 2 and 5 of the compliance checklist in `docs/pulse-atl-ideation-spec.md` §10 are permanently unmet.
5. **Free Postgres expires 2026-09-11.**

---

## Related

- `docs/DEMO.md` — demo script and the honesty rules governing what the demo may claim
- `docs/pulse-atl-design-spec.md` §5 — the frozen API contract; `POST /api/letter` is the one post-freeze addition and says so
- `backend/src/ingest/SOURCES.md` — data provenance, geocoding method and measured success rates
