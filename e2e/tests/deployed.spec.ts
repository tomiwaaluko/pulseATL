import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Deployed-only smoke suite. Every other spec in this directory intercepts
 * `/api/*` with `page.route`, which proves the frontend honours the frozen
 * contract but says nothing about whether the deployment actually serves real
 * data. Nothing here is mocked: the assertions read what the deployment
 * returns, including the *content* of the generated report, because a 200 with
 * a placeholder body is the failure mode this project has already shipped
 * twice.
 *
 * Run with:
 *   E2E_BASE_URL=https://pulse-atl.onrender.com npx playwright test deployed.spec.ts
 */
test.skip(!process.env.E2E_BASE_URL, "deployed-only");

/**
 * Placeholder markers the pipeline writes when a generator is unreachable. The
 * first two are the strings named in the ticket; the last two are the literals
 * the backend actually writes today (`REPORT_PLACEHOLDER` in
 * `backend/src/ingest/run.ts`, `CORTEX_FALLBACK_PREFIX` in
 * `backend/src/ingest/load.ts`). All four are checked so a rename on either
 * side cannot let a placeholder through unnoticed.
 */
const REPORT_PLACEHOLDER_MARKERS = [
  "[report unavailable",
  "[cortex unavailable",
  "[report pending]",
  "[cortex-unavailable]",
];

const CHAT_QUESTION = "What is driving this neighborhood's pulse score right now?";

interface HealthBody {
  ok: boolean;
  last_ingest: string | null;
  row_count: number;
}

interface NpuSummaryBody {
  npu: string;
  pulse_score: number;
  trend: string;
}

interface NpuDetailBody {
  npu: string;
  pulse_score: number;
  trend: string;
  stats: unknown;
  cortex_findings: string;
  report_md: string;
  updated_at: string;
}

/**
 * Render's free plan suspends an idle instance; the first request pays the
 * cold start. Poll health until the service answers so a wake-up does not get
 * charged to whichever test happened to run first.
 */
async function wakeService(request: APIRequestContext): Promise<HealthBody> {
  const attempts = 4;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now();
    try {
      const res = await request.get("/api/health", { timeout: 180_000 });
      const elapsed = Date.now() - started;
      if (res.ok()) {
        console.log(`[deployed] /api/health answered ${res.status()} in ${elapsed} ms (attempt ${attempt})`);
        return (await res.json()) as HealthBody;
      }
      lastError = `status ${res.status()} after ${elapsed} ms`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    console.log(`[deployed] wake attempt ${attempt}/${attempts} failed: ${lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** (attempt - 1)));
  }
  throw new Error(`Deployed service never answered /api/health: ${lastError}`);
}

test.beforeAll(async ({ playwright, baseURL }) => {
  const request = await playwright.request.newContext({ baseURL });
  try {
    await wakeService(request);
  } finally {
    await request.dispose();
  }
});

test("health endpoint reports a populated report cache", async ({ request }) => {
  const started = Date.now();
  const res = await request.get("/api/health", { timeout: 180_000 });
  console.log(`[deployed] GET /api/health -> ${res.status()} in ${Date.now() - started} ms`);

  expect(res.status()).toBe(200);
  const body = (await res.json()) as HealthBody;
  console.log(`[deployed] health body: ${JSON.stringify(body)}`);

  expect(body.ok).toBe(true);
  expect(body.row_count).toBeGreaterThan(0);
  // The health route answers 200 with ok:false when the database is
  // unreachable, so last_ingest carrying a real timestamp is the only proof
  // that an ingest ever wrote anything.
  expect(body.last_ingest).not.toBeNull();
  expect(Number.isNaN(Date.parse(body.last_ingest ?? ""))).toBe(false);
});

test("dashboard renders the map with all 25 NPU polygons", async ({ page }) => {
  // Not an API mock: OpenStreetMap tiles are a third party unrelated to the
  // system under test, and an unreachable tile CDN must not decide the result.
  // Every /api/* call below goes to the deployment untouched.
  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse ATL" })).toBeVisible();
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await expect(page.getByTestId("map-legend")).toBeVisible();
});

test("a real NPU report card renders generated prose, not a placeholder", async ({
  page,
  request,
}) => {
  const listRes = await request.get("/api/npus", { timeout: 180_000 });
  expect(listRes.status()).toBe(200);
  const list = (await listRes.json()) as { npus: NpuSummaryBody[] };
  expect(list.npus.length).toBe(25);

  const target = list.npus[0].npu;
  const detailRes = await request.get(`/api/npus/${target}`, { timeout: 180_000 });
  expect(detailRes.status()).toBe(200);
  const detail = (await detailRes.json()) as NpuDetailBody;

  console.log(
    `[deployed] NPU ${detail.npu}: report_md ${detail.report_md.length} chars, `
      + `cortex_findings ${detail.cortex_findings.length} chars, updated_at ${detail.updated_at}`,
  );
  console.log(`[deployed] report_md head: ${JSON.stringify(detail.report_md.slice(0, 240))}`);
  console.log(`[deployed] cortex_findings head: ${JSON.stringify(detail.cortex_findings.slice(0, 240))}`);

  // Content, not status code: a 200 carrying "[report pending]" is exactly the
  // green-but-empty result this suite exists to catch.
  expect(detail.report_md.length).toBeGreaterThan(100);
  for (const marker of REPORT_PLACEHOLDER_MARKERS) {
    expect(
      detail.report_md,
      `report_md for NPU ${detail.npu} contains the placeholder marker ${marker}`,
    ).not.toContain(marker);
  }

  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await page.locator(`.npu-polygon--${target}`).dispatchEvent("click");

  const panel = page.getByTestId("report-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("panel-npu")).toHaveText(`NPU ${target}`);
  await expect(page.getByTestId("score-dial")).toBeVisible();
  await expect(page.getByTestId("updated-at")).toContainText("Last updated");

  // The panel must show the same generated prose the API returned, so the
  // rendered text is read back rather than trusting the request assertions.
  const rendered = (await page.getByTestId("report-markdown").innerText()).trim();
  console.log(`[deployed] rendered panel text: ${rendered.length} chars`);
  expect(rendered.length).toBeGreaterThan(100);
  for (const marker of REPORT_PLACEHOLDER_MARKERS) {
    expect(
      rendered,
      `rendered report panel for NPU ${target} contains the placeholder marker ${marker}`,
    ).not.toContain(marker);
  }

  // Cortex findings are asserted separately so a Cortex outage is reported as
  // a Cortex outage rather than being blamed on the Gemini narrative.
  expect(detail.cortex_findings.length).toBeGreaterThan(0);
  for (const marker of REPORT_PLACEHOLDER_MARKERS) {
    expect(
      detail.cortex_findings,
      `cortex_findings for NPU ${detail.npu} contains the placeholder marker ${marker}`,
    ).not.toContain(marker);
  }
});

test("POST /api/chat answers a grounded question", async ({ request }) => {
  const listRes = await request.get("/api/npus", { timeout: 180_000 });
  expect(listRes.status()).toBe(200);
  const list = (await listRes.json()) as { npus: NpuSummaryBody[] };
  const target = list.npus[0].npu;

  const started = Date.now();
  const res = await request.post("/api/chat", {
    data: { npu: target, question: CHAT_QUESTION },
    timeout: 180_000,
  });
  const elapsedMs = Date.now() - started;

  // The demo recording needs this number, so it is printed whether or not the
  // assertions below pass.
  console.log(
    `[deployed] POST /api/chat NPU ${target} -> ${res.status()} in ${elapsedMs} ms `
      + `(${(elapsedMs / 1000).toFixed(2)} s)`,
  );
  test.info().annotations.push({
    type: "chat-response-time",
    description: `${elapsedMs} ms (${(elapsedMs / 1000).toFixed(2)} s)`,
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as { answer: string; npu: string };
  console.log(`[deployed] chat answer (${body.answer.length} chars): ${JSON.stringify(body.answer.slice(0, 400))}`);

  expect(body.npu).toBe(target);
  expect(typeof body.answer).toBe("string");
  expect(body.answer.trim().length).toBeGreaterThan(0);
  for (const marker of REPORT_PLACEHOLDER_MARKERS) {
    expect(
      body.answer,
      `chat answer for NPU ${target} contains the placeholder marker ${marker}`,
    ).not.toContain(marker);
  }
});
