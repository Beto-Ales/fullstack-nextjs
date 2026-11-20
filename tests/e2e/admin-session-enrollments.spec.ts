import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test("shows the confirmed enrollments for one session and protects the direct URL", async ({ page, browser, baseURL }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const week = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week").plus({ weeks: 1 });
      const selectedStart = week.set({ hour: 18 });
      const users = Array.from({ length: 3 }, () => randomUUID());
      const [ordinary, makeup, cancelled, foreign] = Array.from({ length: 4 }, () => randomUUID());
      const selectedName = "Taller de ilustración";
      const emptyName = "Taller sin inscritos";
      const ordinaryName = "Ana Ordinaria";
      const makeupName = "Bea Recuperación";
      const cancelledName = "Carla Cancelada";
      const foreignName = "Diana Otra sesión";
      const capacityNotice = "Los habituales pendientes superan las plazas libres.";
      const studentContext = await browser.newContext({ baseURL });

      try {
        await admin.client.query(
          `insert into users (id, email, email_normalized, password_hash, role)
           select id, id || '@example.com', id || '@example.com', 'synthetic', 'STUDENT'
           from unnest($1::text[]) as fixture(id)`,
          [users],
        );
        await admin.client.query(
          `insert into student_profiles (id, user_id, first_name, last_name)
           values ($1, $2, 'Ana', 'Ordinaria'), ($3, $4, 'Bea', 'Recuperación'),
                  ($5, $6, 'Carla', 'Cancelada'), ($7, $8, 'Diana', 'Otra sesión')`,
          [ordinary, student.userId, makeup, users[0], cancelled, users[1], foreign, users[2]],
        );

        async function seedSession(name: string, start: DateTime, capacity: number) {
          const template = randomUUID();
          const id = randomUUID();
          admin.templateIds.push(template);
          admin.sessionIds.push(id);
          await admin.client.query(
            `insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
             values ($1, $2, $3, '18:00', 60, $4)`,
            [template, name, start.weekday, start.toISODate()],
          );
          await admin.client.query(
            `insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
             values ($1, $2, $3, $4, $5, $6)`,
            [id, template, start.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate(), capacity],
          );
          return { id, template };
        }

        const selected = await seedSession(selectedName, selectedStart, 3);
        const emptyStart = selectedStart.plus({ days: 1 });
        const empty = await seedSession(emptyName, emptyStart, 1);
        const other = await seedSession("Otro taller", selectedStart.plus({ days: 2 }), 3);
        await admin.client.query(
          `insert into class_reservations (id, class_session_id, student_profile_id, status, origin)
           values ($1, $5, $6, 'CONFIRMED', 'ORDINARY'), ($2, $5, $7, 'CONFIRMED', 'MAKEUP'),
                  ($3, $5, $8, 'CANCELLED', 'ORDINARY'), ($4, $9, $10, 'CONFIRMED', 'ORDINARY')`,
          [randomUUID(), randomUUID(), randomUUID(), randomUUID(), selected.id, ordinary, makeup,
            cancelled, other.id, foreign],
        );
        await admin.client.query(
          `insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
           values ($1, $3, $5, $6), ($2, $4, $5, $6)`,
          [randomUUID(), randomUUID(), ordinary, makeup, empty.template, emptyStart.toISODate()],
        );

        await login(page, admin);
        const calendar = page.getByRole("region", { name: "Calendario semanal global" });
        await calendar.getByRole("link", { name: "Semana siguiente" }).click();
        const selectedCard = calendar.getByRole("listitem").filter({ hasText: selectedName });
        const emptyCard = calendar.getByRole("listitem").filter({ hasText: emptyName });
        const confirmed = selectedCard.getByText("Reservas confirmadas", { exact: true })
          .locator("xpath=following-sibling::dd[1]");
        await expect(confirmed).toHaveText("2");
        const calendarTotal = await confirmed.innerText();
        await expect(emptyCard).toContainText(capacityNotice);

        await selectedCard.getByRole("link", { name: "Ver inscritos" }).click();
        await expect(page.getByRole("heading", { name: `Inscritos en ${selectedName}` })).toBeVisible();
        const details = page.getByRole("region", { name: "Reservas confirmadas" });
        await expect(details.getByText(`Total de inscritos: ${calendarTotal}`)).toBeVisible();
        await expect(details.getByRole("listitem")).toHaveCount(2);
        await expect(details.getByRole("listitem").filter({ hasText: ordinaryName })).toContainText("Ordinaria");
        await expect(details.getByRole("listitem").filter({ hasText: makeupName })).toContainText("Recuperación");
        await expect(details.getByText(cancelledName)).toHaveCount(0);
        await expect(details.getByText(foreignName)).toHaveCount(0);
        await expect(details.getByRole("button")).toHaveCount(0);

        await page.getByRole("link", { name: "Volver al calendario" }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.searchParams.get("week") === week.toISODate());
        await expect(emptyCard).toContainText(capacityNotice);
        await emptyCard.getByRole("link", { name: "Ver inscritos" }).click();
        await expect(page.getByRole("heading", { name: `Inscritos en ${emptyName}` })).toBeVisible();
        await expect(details.getByText("Total de inscritos: 0")).toBeVisible();
        await expect(details.getByText("No hay inscritos en esta sesión.")).toBeVisible();

        const studentPage = await studentContext.newPage();
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await studentPage.goto(`/admin/sesiones/${selected.id}`);
        await expect(studentPage).toHaveURL(/\/student$/);
        await expect(studentPage.getByRole("region", { name: "Reservas confirmadas" })).toHaveCount(0);
        await expect(studentPage.getByText(makeupName)).toHaveCount(0);
      } finally {
        await studentContext.close();
        await admin.client.query("delete from users where id=any($1::text[])", [users]);
      }
    });
  });
});
