import { expect, test } from "@playwright/test";

test("loads home page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText("notes app");
});

