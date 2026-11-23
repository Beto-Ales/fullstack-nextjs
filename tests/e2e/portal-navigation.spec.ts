import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { seedHabitualCreditScenario, withCreditsAccount } from "./credits-fixtures";

const widths = [320, 360, 390, 768, 1280];

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(0);
}

async function expectResponsive(page: Page) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize({ width: 320, height: 800 });
}

async function loginWithKeyboard(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Saltar al contenido principal" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Email", { exact: true })).toBeInViewport();
  await page.keyboard.insertText(account.email);
  await page.keyboard.press("Tab");
  await page.keyboard.insertText(account.password);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
}

test("student reaches credits, recoveries and history by keyboard without horizontal page scrolling", async ({ page }) => {
  await withCreditsAccount("STUDENT", async (fixture) => {
    await seedHabitualCreditScenario(fixture);
    await page.setViewportSize({ width: 320, height: 800 });
    await loginWithKeyboard(page, fixture);
    await expect(page).toHaveURL(/\/student$/);
    const navigation = page.getByRole("navigation", { name: "Secciones del portal del alumno" });
    for (const [label, heading] of [
      ["Créditos", "Créditos"], ["Recuperaciones", "Reservas de recuperación"], ["Historial", "Historial de clases"],
    ]) {
      await navigation.getByRole("link", { name: label, exact: true }).press("Enter");
      const target = page.getByRole("heading", { name: heading, exact: true });
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    await expect(page.getByText("Disponibles: 0 créditos", { exact: true })).toBeVisible();
    await expectResponsive(page);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/student$/);
  });
});

test("admin can use long-name lists and return from profiles and sessions at mobile widths", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const { profileId } = await seedHabitualCreditScenario(student);
      const name = "Alejandra".repeat(12);
      await student.client.query("update student_profiles set first_name = $1 where id = $2", [name, profileId]);
      const date = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week").plus({ days: 2, hours: 18 });
      const sessionId = randomUUID();
      student.sessionIds.push(sessionId);
      await student.client.query(
        `insert into class_sessions (id,local_date,starts_at_utc,ends_at_utc,max_capacity)
         values ($1,$2,$3,$4,12)`, [sessionId, date.toISODate(), date.toJSDate(), date.plus({ hours: 1 }).toJSDate()],
      );
      const week = date.startOf("week").toISODate()!;
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(admin.email);
      await page.getByLabel("Contraseña").fill(admin.password);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(`/admin?week=${week}`);
      await expectResponsive(page);
      const navigation = page.getByRole("navigation", { name: "Secciones del panel administrativo" });
      await navigation.getByRole("link", { name: "Alumnos", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { name: "Perfiles de alumnos" })).toBeFocused();
      await page.keyboard.press("Tab");
      const studentLink = page.getByRole("link", { name: new RegExp(name) });
      await expect(studentLink).toBeFocused();
      await expect(studentLink).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
      await expectResponsive(page);
      await page.getByRole("link", { name: "Volver a alumnos" }).press("Enter");
      await expect(page).toHaveURL(new RegExp(`week=${week}#perfiles-de-alumnos$`));
      await navigation.getByRole("link", { name: "Créditos", exact: true }).press("Enter");
      const creditFilter = page.locator("#studentProfileId");
      await page.keyboard.press("Tab");
      await expect(creditFilter).toBeFocused();
      await expect(creditFilter).toBeInViewport();
      await creditFilter.selectOption(profileId);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`week=${week}.*studentProfileId=${profileId}#creditos$`));
      await expect(page.getByText("Disponibles: 0 créditos", { exact: true })).toBeVisible();
      await navigation.getByRole("link", { name: "Calendario", exact: true }).press("Enter");
      await page.locator(`a[href^="/admin/sesiones/${sessionId}?"]`).press("Enter");
      await expect(page.getByRole("heading", { name: "Inscritos en clase única" })).toBeVisible();
      await expectResponsive(page);
      await expect(page.getByText("No hay inscritos en esta sesión.")).toBeVisible();
      await page.getByRole("link", { name: "Volver al calendario" }).press("Enter");
      await expect(page).toHaveURL(new RegExp(`week=${week}#calendario-semanal$`));
    });
  });
});
