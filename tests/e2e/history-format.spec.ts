import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { seedHabitualCreditScenario, withCreditsAccount } from "./credits-fixtures";

test.use({ timezoneId: "Pacific/Honolulu" });

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Contraseña").fill(account.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).press("Enter");
}

test("shows the two Copenhagen autumn offsets and an unchanged ledger on both panels", async ({ page }) => {
  await withCreditsAccount("STUDENT", async (student) => {
    await withCreditsAccount("SUPER_ADMIN", async (admin) => {
      const { profileId } = await seedHabitualCreditScenario(student);
      const grantId = randomUUID();
      const granted = "2020-10-25T00:30:00.000Z";
      const expires = "2020-10-25T01:30:00.000Z";
      await student.client.query(`insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, expires_at, source_grant_movement_id, idempotency_key)
        values ($1, $2, 'AUTO_CANCELLATION_GRANT', 1, $3, $4, $1, $1)`, [grantId, profileId, granted, expires]);
      const sessionId = randomUUID();
      student.sessionIds.push(sessionId);
      const start = "2099-05-31T22:00:00.000Z";
      await student.client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, '2099-06-01', $2::timestamptz, $2::timestamptz + interval '1 hour', 1)`, [sessionId, start]);
      const readLedger = () => student.client.query(
        "select * from credit_ledger_movements where student_profile_id = $1 order by id", [profileId],
      );
      const before = (await readLedger()).rows;

      await page.setViewportSize({ width: 320, height: 800 });
      await login(page, student);
      await expect(page).toHaveURL(/\/student$/);
      await page.getByRole("navigation", { name: "Secciones del portal del alumno" })
        .getByRole("link", { name: "Créditos", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { name: "Créditos", exact: true })).toBeFocused();
      const option = page.getByRole("region", { name: "Clases futuras disponibles" }).locator(`time[datetime="${start}"]`);
      await expect(option.locator("[aria-hidden=true]")).toHaveText("01/06/2099, 00:00 GMT+02:00");
      const html = await (await page.request.get("/student")).text();
      const serverText = await page.evaluate(({ html, start }) => new DOMParser()
        .parseFromString(html, "text/html").querySelector(`time[datetime="${start}"]`)?.textContent, { html, start });
      expect(serverText).toBe(await option.textContent());

      async function checkMovement() {
        const history = page.getByRole("region", { name: "Historial de movimientos" });
        await expect(history.getByRole("heading", { level: 3 })).toHaveText("Historial de movimientos");
        const entry = history.getByRole("list").getByRole("listitem").filter({ hasText: "Concesión por cancelación · +1 crédito" });
        for (const [timestamp, visible, speech] of [
          [granted, "25/10/2020, 02:30 GMT+02:00", "25 de octubre de 2020 a las 2:30, GMT más 2 horas"],
          [expires, "25/10/2020, 02:30 GMT+01:00", "25 de octubre de 2020 a las 2:30, GMT más 1 hora"],
        ]) {
          const time = entry.locator(`time[datetime="${timestamp}"]`);
          await expect(time.locator("[aria-hidden=true]")).toHaveText(visible);
          const tree = await time.ariaSnapshot();
          expect(tree).toContain(speech);
          expect(tree).not.toContain(visible);
        }
        const tree = await entry.ariaSnapshot();
        expect(tree.split("Concesión por cancelación, más 1 crédito")).toHaveLength(2);
        expect(tree).not.toContain("Concesión por cancelación · +1 crédito");
        await expect(page.getByText("Disponibles: 0 créditos", { exact: true })).toBeVisible();
        await expect(page.getByText("Caducados: 1 crédito", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      }

      await checkMovement();
      await page.getByRole("button", { name: "Cerrar sesión" }).press("Enter");
      await expect(page).toHaveURL(/\/login$/);
      await page.setViewportSize({ width: 360, height: 800 });
      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(`/admin?studentProfileId=${profileId}`);
      await checkMovement();
      expect((await readLedger()).rows).toEqual(before);
    });
  });
});
