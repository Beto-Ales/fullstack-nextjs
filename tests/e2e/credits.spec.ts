import { expect, test } from "@playwright/test";

const studentEmail = process.env.E2E_STUDENT_EMAIL;
const studentPassword = process.env.E2E_STUDENT_PASSWORD;
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test.describe("credits flows", () => {
  test.skip(!studentEmail || !studentPassword, "Requires E2E_STUDENT_EMAIL and E2E_STUDENT_PASSWORD");
  test("student can view credits summary and history", async ({ page }) => {
    await login(page, studentEmail!, studentPassword!);
    await expect(page.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Créditos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Historial de movimientos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reservas de recuperación" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Clases futuras disponibles" })).toBeVisible();
  });

  test.skip(!adminEmail || !adminPassword, "Requires E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD");
  test("admin can access credit management section", async ({ page }) => {
    await login(page, adminEmail!, adminPassword!);
    await expect(page.getByRole("heading", { name: "Área de administración" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Créditos" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Consultar créditos" })).toBeVisible();
  });
});

