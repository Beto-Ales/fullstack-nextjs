import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test("shows weekly capacity and excludes a voluntary cancellation from pending habitual reservations", async ({ page, browser, baseURL }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      await withCreditsAccount("STUDENT", async (other) => {
        const week = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week");
        const sunday = week.plus({ days: 6 }).set({ hour: 23, minute: 15 });
        const nextWeek = week.plus({ weeks: 1 });
        const monday = nextWeek.set({ hour: 0, minute: 15 });
        expect(sunday.toUTC().toISODate()).toBe(monday.toUTC().toISODate());
        const studentProfile = randomUUID();
        const otherProfile = randomUUID();
        await admin.client.query(
          `insert into student_profiles (id, user_id, first_name, last_name)
           values ($1, $2, 'Calendar', 'Student'), ($3, $4, 'Other', 'Student')`,
          [studentProfile, student.userId, otherProfile, other.userId],
        );

        async function seedSession(name: string | null, start: DateTime, capacity: number, profiles: string[] = []) {
          const date = start.toISODate();
          const template = name ? randomUUID() : null;
          if (template) {
            admin.templateIds.push(template);
            await admin.client.query(
              `insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
               values ($1, $2, $3, $4, 30, $5)`,
              [template, name, start.weekday, start.toFormat("HH:mm"), date],
            );
            for (const profile of profiles) {
              await admin.client.query(
                `insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
                 values ($1, $2, $3, $4)`,
                [randomUUID(), profile, template, date],
              );
            }
          }
          const id = randomUUID();
          admin.sessionIds.push(id);
          await admin.client.query(
            `insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
             values ($1, $2, $3, $4, $5, $6)`,
            [id, template, date, start.toJSDate(), start.plus({ minutes: 30 }).toJSDate(), capacity],
          );
          return id;
        }

        await seedSession("Taller del domingo", sunday, 2);
        const freeName = "Taller con plaza libre";
        const free = await seedSession(freeName, monday, 2, [studentProfile]);
        const blocked = await seedSession(null, nextWeek.plus({ days: 1 }).set({ hour: 17 }), 13);
        const conflictName = "Taller con habituales pendientes";
        await seedSession(conflictName, nextWeek.plus({ days: 2 }).set({ hour: 18 }), 1, [studentProfile, otherProfile]);
        const voluntaryReservation = randomUUID();
        await admin.client.query(
          "insert into class_reservations (id, class_session_id, student_profile_id) values ($1, $2, $3)",
          [voluntaryReservation, free, studentProfile],
        );
        await admin.client.query(
          `insert into session_capacity_blocks (id, class_session_id, blocked_spots, is_active)
           values ($1, $2, 12, true), ($3, $4, 1, false)`,
          [randomUUID(), blocked, randomUUID(), free],
        );

        await login(page, admin);
        await expect(page).toHaveURL(/\/admin$/);
        const calendar = page.getByRole("region", { name: "Calendario semanal global" });
        await expect(calendar).toContainText(`${week.toFormat("dd/MM/yyyy")} – ${sunday.toFormat("dd/MM/yyyy")}`);
        await expect(calendar.getByRole("region", { name: /^domingo/ })).toContainText("Taller del domingo");
        await expect(calendar.getByText(freeName, { exact: true })).toHaveCount(0);
        await calendar.getByRole("link", { name: "Semana anterior" }).click();
        await expect(calendar.getByText("No hay sesiones en esta semana.")).toBeVisible();
        await calendar.getByRole("link", { name: "Semana actual" }).click();
        await expect(calendar.getByText("Taller del domingo")).toBeVisible();
        await calendar.getByRole("link", { name: "Semana siguiente" }).click();
        await expect(calendar.getByText("Taller del domingo")).toHaveCount(0);

        const freeCard = calendar.getByRole("listitem").filter({ hasText: freeName });
        const blockedCard = calendar.getByRole("listitem").filter({ hasText: "Clase única" });
        const conflictCard = calendar.getByRole("listitem").filter({ hasText: conflictName });
        const notice = "Los habituales pendientes superan las plazas libres.";
        await expect(calendar.getByRole("region", { name: /^lunes/ })).toContainText(freeName);
        await expect(freeCard).toContainText("00:15–00:45");
        await expect(freeCard.locator("dd")).toHaveText(["2", "1", "0", "1", "0"]);
        await expect(blockedCard.locator("dd")).toHaveText(["12", "0", "12", "0"]);
        await expect(conflictCard.locator("dd")).toHaveText(["1", "0", "0", "1", "2"]);
        await expect(conflictCard).toContainText(notice);
        await expect(freeCard).not.toContainText(notice);
        await expect(calendar.getByRole("button")).toHaveCount(0);

        const studentContext = await browser.newContext({ baseURL });
        try {
          const studentPage = await studentContext.newPage();
          await login(studentPage, student);
          await expect(studentPage).toHaveURL(/\/student$/);
          await expect(studentPage.getByRole("region", { name: "Calendario semanal", exact: true })).toBeVisible();
          const directPage = await studentContext.newPage();
          await directPage.goto(`/admin?week=${nextWeek.toISODate()}`, { waitUntil: "commit" });
          await expect(directPage).toHaveURL(/\/student$/);
          await expect(directPage.getByRole("region", { name: "Calendario semanal global" })).toHaveCount(0);
          await directPage.close();
          await studentPage.bringToFront();
          await studentPage.getByRole("region", { name: "Calendario semanal" }).getByRole("link", { name: "Semana siguiente" }).click();
          await studentPage.getByRole("region", { name: "Calendario semanal" }).getByRole("listitem")
            .filter({ hasText: freeName }).getByRole("button", { name: "Cancelar clase" }).click();
          await expect(studentPage.getByRole("status")).toHaveText("Clase cancelada.");
        } finally {
          await studentContext.close();
        }

        await page.reload();
        await expect(freeCard.locator("dd")).toHaveText(["2", "0", "0", "2", "0"]);
        await expect(freeCard).not.toContainText(notice);
        await expect(conflictCard).toContainText(notice);
        const { rows } = await admin.client.query(
          "select status, cancelled_by_user_id from class_reservations where id=$1", [voluntaryReservation],
        );
        expect(rows).toEqual([{ status: "CANCELLED", cancelled_by_user_id: student.userId }]);
      });
    });
  });
});
