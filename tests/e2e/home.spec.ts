import { expect, test } from "@playwright/test";

test("shows the workshop homepage and links to sign in", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Art Workshop Copenhagen");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Art Workshop Copenhagen");
  const signIn = page.getByRole("link", { name: "Iniciar sesión" });
  await expect(signIn).toHaveAttribute("href", "/login");
  await signIn.click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Iniciar sesión");
});
