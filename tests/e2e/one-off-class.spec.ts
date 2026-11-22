import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

function classForm(page: Page) {
  return page.getByRole("region", { name: "Crear clase única" });
}

async function fillClass(form: Locator, localDate: string, capacity: number) {
  await form.getByLabel("Fecha de la clase").fill(localDate);
  await form.getByLabel("Hora de inicio").fill("18:25");
  await form.getByLabel("Duración (minutos)").fill("75");
  await form.getByLabel("Aforo", { exact: true }).fill(String(capacity));
}

test.describe("administrative one-off class creation", () => {

  test("creates one class in Copenhagen time and rejects an excessive capacity on the server", async ({ page }) => {
    await withCreditsAccount("SUPER_ADMIN", async ({ client, email, password, sessionIds }) => {
      const today = DateTime.now().setZone(CENTER_TIME_ZONE);
      const date = today.plus({ days: 40 });
      const { rows: [rule] } = await client.query<{ id: string }>(
        "select id from academic_regulations where effective_from <= $1 order by effective_from desc limit 1",
        [today.toISODate()],
      );
      const localDate = date.toISODate()!;
      const startsAt = DateTime.fromISO(`${localDate}T18:25`, { zone: CENTER_TIME_ZONE });
      const endsAt = startsAt.plus({ minutes: 75 });
      const form = classForm(page);
      const readSessions = async () => {
        const { rows } = await client.query(
          `select id, template_id, local_date::text, starts_at_utc, ends_at_utc, max_capacity, regulation_version_id
           from class_sessions where local_date = $1 and starts_at_utc = $2 and ends_at_utc = $3`,
          [localDate, startsAt.toJSDate(), endsAt.toJSDate()],
        );
        return rows;
      };

      expect(await readSessions()).toHaveLength(0);
      await login(page, email, password);
      await expect(form.getByLabel("Aforo", { exact: true })).toHaveAttribute("max", "12");
      await fillClass(form, localDate, 13);
      await form.locator("form").evaluate((element: HTMLFormElement) => { element.noValidate = true; });
      await form.getByRole("button", { name: "Guardar clase única" }).click();
      await expect(form.getByRole("alert")).toHaveText("El aforo debe ser un número entero entre 1 y 12.");
      const rejectedRows = await readSessions();
      sessionIds.push(...rejectedRows.map(({ id }) => id));
      expect(rejectedRows).toHaveLength(0);

      await fillClass(form, localDate, 12);
      await form.getByRole("button", { name: "Guardar clase única" }).click();
      const confirmation = `Clase única creada para el ${localDate} de 18:25 a 19:40. Aforo de 12 plazas.`;
      await expect(form.getByRole("status")).toHaveText(confirmation);
      await expect(form.getByRole("alert")).toHaveCount(0);
      await page.reload();
      await expect(form.getByRole("status")).toHaveText(confirmation);
      const createdRows = await readSessions();
      sessionIds.push(...createdRows.map(({ id }) => id));
      expect(createdRows).toEqual([expect.objectContaining({
        template_id: null, local_date: localDate, starts_at_utc: startsAt.toJSDate(),
        ends_at_utc: endsAt.toJSDate(), max_capacity: 12, regulation_version_id: rule.id,
      })]);
    });
  });

  test.describe("administrative authorization", () => {
    test.use({ javaScriptEnabled: false });

    test("rejects submission of an open administrative form after switching to a student session", async ({ page, browser, baseURL }) => {
      await withCreditsAccount("SUPER_ADMIN", async ({ client, email, password, sessionIds }) => {
        const localDate = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 41 }).toISODate()!;
        const startsAt = DateTime.fromISO(`${localDate}T18:25`, { zone: CENTER_TIME_ZONE }).toJSDate();
        const readSessions = () => client.query("select id from class_sessions where local_date=$1 and starts_at_utc=$2", [localDate, startsAt]);
        expect((await readSessions()).rows).toHaveLength(0);
        await login(page, email, password);
        const form = classForm(page);
        await fillClass(form, localDate, 5);

        await withCreditsAccount("STUDENT", async (student) => {
          await student.client.query(
            "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'E2E', 'Student')",
            [randomUUID(), student.userId],
          );
          const studentContext = await browser.newContext({ baseURL });
          try {
            const studentPage = await studentContext.newPage();
            await login(studentPage, student.email, student.password);
            await studentPage.waitForURL("**/student");
            await studentPage.goto("/admin");
            await expect(studentPage).toHaveURL(/\/student$/);
            await expect(studentPage.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
            await expect(classForm(studentPage)).toHaveCount(0);

            await page.context().clearCookies();
            await page.context().addCookies(await studentContext.cookies());
            await form.getByRole("button", { name: "Guardar clase única" }).click();
            await expect(page).toHaveURL(/\/student$/);
            await expect(page.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
            const { rows } = await readSessions();
            sessionIds.push(...rows.map(({ id }) => id));
            expect(rows).toHaveLength(0);
          } finally {
            await studentContext.close();
          }
        });
      });
    });
  });
});
