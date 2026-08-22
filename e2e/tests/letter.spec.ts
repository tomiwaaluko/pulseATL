import path from "path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Council advocacy letter (ticket PUL-17, contract §5). `POST /api/letter` is
 * mocked alongside the dashboard reads, mirroring the chat.spec.ts pattern —
 * no Gemini key needed.
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

interface MockDetail {
  npu: string;
  pulse_score: number;
  trend: (typeof TRENDS)[number];
  stats: Record<string, unknown>;
  cortex_findings: string;
  report_md: string;
  updated_at: string;
}

interface LetterBody {
  npu: string;
}

/** The draft the mocked backend returns — only figures from `stats` appear in it. */
const LETTER_TEXT = [
  "Dear Council Member,",
  "",
  "NPU A recorded 412 incidents in the last 90 days, against 388 in the prior",
  "90 days, and 74 cases remain open. Please fund a faster case triage.",
  "",
  "A resident of NPU A",
].join("\n");

function detailFor(npu: string): MockDetail {
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

/**
 * Replace `navigator.clipboard` before the app loads. Asserting on a real
 * clipboard needs permissions that vary by channel; recording the writes (or
 * rejecting them) keeps both branches deterministic.
 */
async function stubClipboard(page: Page, mode: "works" | "blocked"): Promise<void> {
  await page.addInitScript((behaviour: string) => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          if (behaviour === "blocked") {
            return Promise.reject(new Error("clipboard blocked by the browser"));
          }
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  }, mode);
}

async function openLetterFor(page: Page, npu: string): Promise<void> {
  await page.locator(`.npu-polygon--${npu}`).dispatchEvent("click");
  await expect(page.getByTestId("report-panel")).toBeVisible();
  await page.getByTestId("letter-button").click();
  await expect(page.getByTestId("letter-modal")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await blockTiles(page);
});

test("the letter button drafts a letter for the selected npu and copies it", async ({
  page,
}) => {
  await mockDashboard(page);
  await stubClipboard(page, "works");
  const bodies: LetterBody[] = [];
  await page.route("**/api/letter", (route) => {
    const body = route.request().postDataJSON() as LetterBody;
    bodies.push(body);
    return route.fulfill({ json: { letter: LETTER_TEXT, npu: body.npu } });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openLetterFor(page, "A");

  await expect(page.getByTestId("letter-text")).toHaveValue(LETTER_TEXT);
  expect(bodies).toEqual([{ npu: "A" }]);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "letter-modal.png"),
    fullPage: false,
  });

  await page.getByTestId("letter-copy-button").click();
  await expect(page.getByTestId("letter-copy-ok")).toBeVisible();

  const copied = await page.evaluate(
    () => (window as unknown as { __copied: string[] }).__copied
  );
  expect(copied).toEqual([LETTER_TEXT]);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("letter-modal")).toBeHidden();
});

test("a blocked clipboard shows the manual-copy fallback instead of breaking", async ({
  page,
}) => {
  await mockDashboard(page);
  await stubClipboard(page, "blocked");
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.route("**/api/letter", (route) =>
    route.fulfill({ json: { letter: LETTER_TEXT, npu: "C" } })
  );

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openLetterFor(page, "C");

  await page.getByTestId("letter-copy-button").click();

  await expect(page.getByTestId("letter-copy-failed")).toContainText("Ctrl+C");
  await expect(page.getByTestId("letter-copy-ok")).toBeHidden();
  // The modal and the letter must survive a clipboard refusal.
  await expect(page.getByTestId("letter-text")).toHaveValue(LETTER_TEXT);
  await expect(page.getByTestId("letter-modal")).toBeVisible();
  expect(pageErrors).toEqual([]);

  await page.getByTestId("letter-close-button").click();
  await expect(page.getByTestId("letter-modal")).toBeHidden();
  await expect(page.getByTestId("report-panel")).toBeVisible();
});

test("a failed draft is shown as a failure, with nothing to copy", async ({
  page,
}) => {
  await mockDashboard(page);
  await stubClipboard(page, "works");
  await page.route("**/api/letter", (route) =>
    route.fulfill({
      json: {
        letter:
          "[letter-unavailable] Gemini could not draft a council letter for NPU V; no letter text was generated. This is a failure notice, not a draft — do not send it. Try again later.",
        npu: "V",
      },
    })
  );

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openLetterFor(page, "V");

  await expect(page.getByTestId("letter-unavailable")).toContainText(
    "not a draft"
  );
  // No copy affordance and no letter body: a failed generation is never
  // offered as something a resident could send.
  await expect(page.getByTestId("letter-copy-button")).toHaveCount(0);
  await expect(page.getByTestId("letter-text")).toHaveCount(0);
});

test("a 500 shows the error state and the draft can be retried", async ({
  page,
}) => {
  await mockDashboard(page);
  await stubClipboard(page, "works");
  let calls = 0;
  await page.route("**/api/letter", (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({
        status: 500,
        json: { detail: "cached stats are malformed" },
      });
    }
    return route.fulfill({ json: { letter: LETTER_TEXT, npu: "B" } });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openLetterFor(page, "B");

  await expect(page.getByTestId("letter-error")).toContainText(
    "cached stats are malformed"
  );
  await expect(page.getByTestId("letter-modal")).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "letter-error.png"),
    fullPage: false,
  });

  await page.getByTestId("letter-retry-button").click();

  await expect(page.getByTestId("letter-text")).toHaveValue(LETTER_TEXT);
  await expect(page.getByTestId("letter-error")).toBeHidden();
});
