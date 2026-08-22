import path from "path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Chat drawer (design spec §6). `POST /api/chat` is mocked alongside the
 * dashboard reads, mirroring the compare.spec.ts pattern — no Gemini key needed.
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

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface ChatBody {
  npu: string;
  question: string;
  history: ChatTurn[];
}

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

async function openChatFor(page: Page, npu: string): Promise<void> {
  await page.locator(`.npu-polygon--${npu}`).dispatchEvent("click");
  await expect(page.getByTestId("report-panel")).toBeVisible();
  await page.getByTestId("ask-button").click();
  await expect(page.getByTestId("chat-drawer")).toBeVisible();
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId("chat-input").fill(question);
  await page.getByTestId("chat-send-button").click();
}

/** Lets a test hold a mocked response open so the pending UI can be asserted. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

test.beforeEach(async ({ page }) => {
  await blockTiles(page);
});

test("asking a question renders the answer and replays history on the next turn", async ({
  page,
}) => {
  await mockDashboard(page);
  const bodies: ChatBody[] = [];
  await page.route("**/api/chat", (route) => {
    const body = route.request().postDataJSON() as ChatBody;
    bodies.push(body);
    return route.fulfill({
      json: {
        answer: `Answer ${bodies.length} for NPU ${body.npu}.`,
        npu: body.npu,
      },
    });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openChatFor(page, "A");

  await expect(page.getByTestId("chat-input")).toBeFocused();

  await ask(page, "How many blight cases are open?");
  await expect(page.getByTestId("chat-message-assistant")).toHaveText(
    "Answer 1 for NPU A."
  );
  await expect(page.getByTestId("chat-message-user")).toHaveText(
    "How many blight cases are open?"
  );

  await ask(page, "And how does that compare with last quarter?");
  await expect(page.getByTestId("chat-message-assistant").nth(1)).toHaveText(
    "Answer 2 for NPU A."
  );

  // The second turn must carry the first exchange so the backend keeps context.
  expect(bodies[0].npu).toBe("A");
  expect(bodies[0].history).toEqual([]);
  expect(bodies[1].question).toBe("And how does that compare with last quarter?");
  expect(bodies[1].history).toEqual([
    { role: "user", content: "How many blight cases are open?" },
    { role: "assistant", content: "Answer 1 for NPU A." },
  ]);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "chat-drawer.png"),
    fullPage: false,
  });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-drawer")).toBeHidden();
});

test("input and send button are disabled while the answer is pending", async ({
  page,
}) => {
  await mockDashboard(page);
  const gate = deferred();
  await page.route("**/api/chat", async (route) => {
    await gate.promise;
    await route.fulfill({ json: { answer: "Resolution is 19 days.", npu: "C" } });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openChatFor(page, "C");

  await ask(page, "What is the median resolution time?");

  await expect(page.getByTestId("chat-thinking")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeDisabled();
  await expect(page.getByTestId("chat-send-button")).toBeDisabled();

  gate.resolve();

  await expect(page.getByTestId("chat-message-assistant")).toHaveText(
    "Resolution is 19 days."
  );
  await expect(page.getByTestId("chat-thinking")).toBeHidden();
  await expect(page.getByTestId("chat-input")).toBeEnabled();
});

test("a 500 shows the error state and the question can be retried", async ({
  page,
}) => {
  await mockDashboard(page);
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({
        status: 500,
        json: { detail: "cached stats are malformed" },
      });
    }
    return route.fulfill({ json: { answer: "Crime is flat.", npu: "V" } });
  });

  await page.goto("/");
  await expect(page.locator(".npu-polygon")).toHaveCount(25);
  await openChatFor(page, "V");

  await ask(page, "Is crime rising here?");

  await expect(page.getByTestId("chat-error")).toContainText(
    "cached stats are malformed"
  );
  // The drawer and the panel behind it must survive the failure.
  await expect(page.getByTestId("chat-drawer")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "chat-error.png"),
    fullPage: false,
  });

  await page.getByTestId("chat-retry-button").click();

  await expect(page.getByTestId("chat-message-assistant")).toHaveText(
    "Crime is flat."
  );
  await expect(page.getByTestId("chat-error")).toBeHidden();
  await expect(page.getByTestId("chat-message-user")).toHaveCount(1);

  await page.getByTestId("chat-close-button").click();
  await expect(page.getByTestId("chat-drawer")).toBeHidden();
  await expect(page.getByTestId("report-panel")).toBeVisible();
});
