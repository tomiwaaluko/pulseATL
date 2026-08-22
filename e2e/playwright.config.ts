import { defineConfig } from "@playwright/test";
import path from "path";
import fs from "fs";

const preinstalledChromium = "/opt/pw-browsers/chromium";
const launchOptions = fs.existsSync(preinstalledChromium)
  ? { executablePath: preinstalledChromium }
  : {};

/**
 * Set E2E_BASE_URL to run the suite against an already-running deployment
 * (e.g. https://pulse-atl.onrender.com). When it is set, no local server is
 * started: the remote target *is* the system under test, and a local backend
 * on :3000 would silently shadow it and turn a deployment check into a
 * localhost check.
 */
const remoteBaseUrl = process.env.E2E_BASE_URL;
const isRemote = remoteBaseUrl !== undefined && remoteBaseUrl !== "";

/**
 * Render's free plan cold-starts: the first request after an idle period spins
 * the instance back up and can take ~50s before any byte comes back, and a live
 * Gemini answer on /api/chat adds more on top. Local runs keep Playwright's
 * defaults untouched.
 */
const remoteTimeouts = {
  timeout: 240_000,
  expect: { timeout: 120_000 },
  navigationTimeout: 180_000,
  actionTimeout: 60_000,
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  // The remote run's evidence is the console output of the tests themselves
  // (health body, report length, chat latency), so `list` is added there to
  // guarantee it reaches stdout and the workflow log.
  reporter: isRemote
    ? [["list"], ["html", { outputFolder: "test-results/report", open: "never" }]]
    : [["html", { outputFolder: "test-results/report", open: "never" }]],
  outputDir: "test-results/artifacts",
  ...(isRemote
    ? { timeout: remoteTimeouts.timeout, expect: remoteTimeouts.expect }
    : {}),
  use: {
    baseURL: remoteBaseUrl ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions,
    ...(isRemote
      ? {
          navigationTimeout: remoteTimeouts.navigationTimeout,
          actionTimeout: remoteTimeouts.actionTimeout,
        }
      : {}),
  },
  // undefined when E2E_BASE_URL is set — Playwright then starts nothing.
  webServer: isRemote
    ? undefined
    : {
        command: "node ../backend/dist/server.js",
        cwd: path.join(__dirname),
        url: "http://localhost:3000/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
