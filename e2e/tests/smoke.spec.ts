import { test, expect } from "@playwright/test";

test("dashboard loads and shows the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse ATL" })).toBeVisible();
});

test("health endpoint responds ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("ok");
  expect(body).toHaveProperty("last_ingest");
  expect(body).toHaveProperty("row_count");
});
