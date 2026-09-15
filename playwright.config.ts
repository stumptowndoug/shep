import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/terminal-input",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5176" },
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5176 --strictPort",
    url: "http://127.0.0.1:5176/tests/terminal-input/",
    reuseExistingServer: false,
  },
});
