import { test, expect } from "@playwright/test";

test("dashboard loads and shows the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pulse ATL" })).toBeVisible();
});

test("healthz endpoint responds ok", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});
