import { expect, test } from "@playwright/test";

test("shows login form and no public registration", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  await expect(page.getByText("Registro", { exact: false })).toHaveCount(0);
});

test("redirects anonymous users from protected routes to login", async ({ page }) => {
  await page.goto("/student");
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

