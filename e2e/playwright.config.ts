import { defineConfig } from "@playwright/test";
import path from "path";
import fs from "fs";

const preinstalledChromium = "/opt/pw-browsers/chromium";
const launchOptions = fs.existsSync(preinstalledChromium)
  ? { executablePath: preinstalledChromium }
  : {};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { outputFolder: "test-results/report", open: "never" }]],
  outputDir: "test-results/artifacts",
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions,
  },
  webServer: {
    command: "node ../backend/dist/server.js",
    cwd: path.join(__dirname),
    url: "http://localhost:3000/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
