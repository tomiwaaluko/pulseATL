import path from "path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Every /api/* call is intercepted, so this suite exercises the frontend
 * against the frozen contract (design spec §5) with no backend routes needed.
 */

const SCREENSHOT_DIR = path.join(__dirname, "../../.screenshots");

const TRENDS = ["improving", "stable", "worsening"] as const;
const NPU_IDS = "ABCDEFGHIJKLMNOPQRSTVWXYZ".split("");

const npuList = {
  npus: NPU_IDS.map((npu, index) => ({
    npu,
    pulse_score: Number((8 + index * 3.5).toFixed(1)),
    trend: TRENDS[index % TRENDS.length],
  })),
};

function detailFor(npu: string) {
  const summary =
    npuList.npus.find((row) => row.npu === npu) ?? npuList.npus[0];
  return {
    npu: summary.npu,
    pulse_score: summary.pulse_score,
    trend: summary.trend,
    stats: {
      incident_count_90d: 412,
      incident_count_prior_90d: 388,
      median_resolution_days: 19,
      open_cases: 74,
      by_category: { crime: 190, blight: 132, infrastructure: 90 },
    },
    cortex_findings:
      "Blight cases rose 22% versus the prior 90 days while median resolution time held flat.",
    report_md: [
      `# NPU ${summary.npu} report card`,
      "",
      `Overall pulse is **${summary.pulse_score}**, driven mostly by open blight cases.`,
      "",
      "## What stands out",
      "- Blight reports up 22% quarter over quarter",
      "- Median resolution time steady at 19 days",
      "- Crime incidents flat versus the city median",
      "",
      "## Who to contact",
      `NPU ${summary.npu} meets the third Tuesday of each month.`,
    ].join("\n"),
    updated_at: "2026-08-12T17:00:00Z",
  };
}

/** Tiles may be unreachable in CI — block them so runs are deterministic. */
async function blockTiles(page: Page): Promise<void> {
  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());
}

async function mockHappyPath(page: Page): Promise<void> {
  await page.route("**/api/npus", (route) =>
    route.fulfill({ json: npuList })
  );
  await page.route("**/api/npus/*", (route) => {
    const npu = new URL(route.request().url()).pathname.split("/").pop() ?? "A";
    if (!NPU_IDS.includes(npu)) {
      return route.fulfill({ status: 404, json: { detail: "unknown npu" } });
    }
    return route.fulfill({ json: detailFor(npu) });
  });
}

test.beforeEach(async ({ page }) => {
  await blockTiles(page);
});

test("renders all 25 NPU polygons with a legend", async ({ page }) => {
  await mockHappyPath(page);
  await page.goto("/");

  const polygons = page.locator(".npu-polygon");
  await expect(polygons).toHaveCount(25);
  await expect(page.getByTestId("map-legend")).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "map-default.png"),
    fullPage: false,
  });
});

test("clicking an NPU opens its report panel and outlines the polygon", async ({
  page,
}) => {
  await mockHappyPath(page);
  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);

  await page.locator(".npu-polygon--M").dispatchEvent("click");

  const panel = page.getByTestId("report-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("panel-npu")).toHaveText("NPU M");
  await expect(page.getByTestId("score-dial")).toBeVisible();
  await expect(page.getByTestId("trend-badge")).toBeVisible();
  await expect(page.getByTestId("report-markdown")).toContainText(
    "NPU M report card"
  );
  await expect(page.getByTestId("updated-at")).toContainText("Last updated");
  await expect(page.getByTestId("compare-button")).toBeVisible();
  await expect(page.getByTestId("ask-button")).toBeVisible();

  await expect(page.locator(".npu-polygon--selected")).toHaveCount(1);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "report-panel.png"),
    fullPage: false,
  });
});

test("shows the map skeleton while /api/npus is in flight", async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/npus", async (route) => {
    await gate;
    await route.fulfill({ json: npuList });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-skeleton")).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toBeVisible();

  release();
  await expect(page.getByTestId("map-skeleton")).toBeHidden();
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
});

test("shows the report skeleton while a detail request is in flight", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/npus", (route) => route.fulfill({ json: npuList }));
  await page.route("**/api/npus/*", async (route) => {
    await gate;
    await route.fulfill({ json: detailFor("B") });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await page.locator(".npu-polygon--B").dispatchEvent("click");

  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  release();
  await expect(page.getByTestId("report-panel")).toBeVisible();
});

test("falls back to a full-screen error with a working retry", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/npus", (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({ status: 500, json: { detail: "cache unavailable" } });
    }
    return route.fulfill({ json: npuList });
  });
  await page.route("**/api/npus/*", (route) =>
    route.fulfill({ json: detailFor("A") })
  );

  await page.goto("/");

  const errorScreen = page.getByTestId("error-screen");
  await expect(errorScreen).toBeVisible();
  await expect(page.getByTestId("error-message")).toContainText(
    "cache unavailable"
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "error-state.png"),
    fullPage: false,
  });

  await page.getByTestId("retry-button").click();
  await expect(errorScreen).toBeHidden();
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
});

test("surfaces a 404 from the detail endpoint inside the panel", async ({
  page,
}) => {
  await page.route("**/api/npus", (route) => route.fulfill({ json: npuList }));
  await page.route("**/api/npus/*", (route) =>
    route.fulfill({ status: 404, json: { detail: "unknown npu" } })
  );

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await page.locator(".npu-polygon--C").dispatchEvent("click");

  await expect(page.getByTestId("panel-error")).toContainText("unknown npu");
});
