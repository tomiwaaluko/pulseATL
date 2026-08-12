import path from "path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Compare view (design spec §6, "demo money shot"). All /api/* calls are
 * mocked, mirroring the dashboard.spec.ts pattern — no backend routes needed.
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
    report_md: `# NPU ${summary.npu} report card\n\nOverall pulse is **${summary.pulse_score}**.`,
    updated_at: "2026-08-12T17:00:00Z",
  };
}

/** Tiles may be unreachable in CI — block them so runs are deterministic. */
async function blockTiles(page: Page): Promise<void> {
  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());
}

async function mockDashboard(page: Page): Promise<void> {
  await page.route("**/api/npus", (route) => route.fulfill({ json: npuList }));
  await page.route("**/api/npus/*", (route) => {
    const npu = new URL(route.request().url()).pathname.split("/").pop() ?? "A";
    if (!NPU_IDS.includes(npu)) {
      return route.fulfill({ status: 404, json: { detail: "unknown npu" } });
    }
    return route.fulfill({ json: detailFor(npu) });
  });
}

async function openCompareFor(page: Page, npu: string): Promise<void> {
  await page.locator(`.npu-polygon--${npu}`).dispatchEvent("click");
  await expect(page.getByTestId("report-panel")).toBeVisible();
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("compare-modal")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await blockTiles(page);
});

test("selecting two NPUs shows both columns and the gap callouts", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.route("**/api/compare*", (route) => {
    const url = new URL(route.request().url());
    const a = url.searchParams.get("a") ?? "A";
    const b = url.searchParams.get("b") ?? "B";
    return route.fulfill({
      json: {
        a: detailFor(a),
        b: detailFor(b),
        gap: { pulse_gap: 31.2, resolution_days_gap: 41 },
      },
    });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openCompareFor(page, "A");

  await page.getByTestId("compare-npu-select").selectOption("M");

  await expect(page.getByTestId("compare-column-a")).toContainText("NPU A");
  await expect(page.getByTestId("compare-column-b")).toContainText("NPU M");
  await expect(page.getByTestId("compare-gap-pulse")).toHaveText("31.2");
  await expect(page.getByTestId("compare-gap-resolution")).toHaveText(
    "41days"
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "compare-view.png"),
    fullPage: false,
  });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("compare-modal")).toBeHidden();
});

test("shows a graceful message instead of a fabricated number when resolution_days_gap is null", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.route("**/api/compare*", (route) => {
    const url = new URL(route.request().url());
    const a = url.searchParams.get("a") ?? "A";
    const b = url.searchParams.get("b") ?? "B";
    return route.fulfill({
      json: {
        a: detailFor(a),
        b: detailFor(b),
        gap: { pulse_gap: 12.4, resolution_days_gap: null },
      },
    });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openCompareFor(page, "C");

  await page.getByTestId("compare-npu-select").selectOption("V");

  await expect(page.getByTestId("compare-gap-pulse")).toHaveText("12.4");
  await expect(page.getByTestId("compare-gap-resolution")).toHaveText(
    "Resolution data unavailable for these neighborhoods"
  );
  await expect(page.getByTestId("compare-gap-resolution")).not.toContainText(
    "0"
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "compare-null-gap.png"),
    fullPage: false,
  });
});

test("closing via the close button returns to the map", async ({ page }) => {
  await mockDashboard(page);
  await page.route("**/api/compare*", (route) =>
    route.fulfill({
      json: {
        a: detailFor("A"),
        b: detailFor("B"),
        gap: { pulse_gap: 5, resolution_days_gap: 3 },
      },
    })
  );

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openCompareFor(page, "A");
  await page.getByTestId("compare-npu-select").selectOption("B");
  await expect(page.getByTestId("compare-column-b")).toBeVisible();

  await page.getByTestId("compare-close-button").click();
  await expect(page.getByTestId("compare-modal")).toBeHidden();
  await expect(page.getByTestId("report-panel")).toBeVisible();
});
