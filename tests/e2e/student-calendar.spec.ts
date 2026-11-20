import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

test("shows only the student's reservations in Copenhagen weeks and refreshes after cancellation", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await page.setViewportSize({ width: 360, height: 800 });
  await withCreditsAccount("STUDENT", async (student) => {
    await withCreditsAccount("STUDENT", async (other) => {
      const week = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week");
      const sunday = week.plus({ days: 6 });
      const nextWeek = week.plus({ weeks: 1 });
      const studentProfile = randomUUID();
      const otherProfile = randomUUID();
      await student.client.query(
        `insert into student_profiles (id, user_id, first_name, last_name)
         values ($1, $2, 'Calendar', 'Student'), ($3, $4, 'Other', 'Student')`,
        [studentProfile, student.userId, otherProfile, other.userId],
      );

      async function seedReservation(input: {
        name: string; start: DateTime; profileId: string; origin: "ORDINARY" | "MAKEUP";
        status?: "CONFIRMED" | "CANCELLED";
      }) {
        const templateId = randomUUID();
        const sessionId = randomUUID();
        const reservationId = randomUUID();
        const localDate = input.start.toISODate();
        student.templateIds.push(templateId);
        student.sessionIds.push(sessionId);
        await student.client.query(
          `insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
           values ($1, $2, $3, $4, 30, $5)`,
          [templateId, input.name, input.start.weekday, input.start.toFormat("HH:mm"), localDate],
        );
        await student.client.query(
          `insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
           values ($1, $2, $3, $4, $5, 2)`,
          [sessionId, templateId, localDate, input.start.toJSDate(), input.start.plus({ minutes: 30 }).toJSDate()],
        );
        await student.client.query(
          `insert into class_reservations (id, class_session_id, student_profile_id, origin, status)
           values ($1, $2, $3, $4, $5)`,
          [reservationId, sessionId, input.profileId, input.origin, input.status ?? "CONFIRMED"],
        );
        if (input.origin === "ORDINARY") {
          await student.client.query(
            `insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
             values ($1, $2, $3, $4)`,
            [randomUUID(), input.profileId, templateId, localDate],
          );
        }
        return { reservationId, sessionId };
      }

      const habitual = "Taller habitual de dibujo";
      const sundayMakeup = "Recuperación de cerámica";
      const mondayMakeup = "Recuperación de pintura";
      const sundayStart = sunday.set({ hour: 23, minute: 15 });
      const mondayStart = nextWeek.set({ hour: 0, minute: 15 });
      expect(sundayStart.toUTC().toISODate()).toBe(mondayStart.toUTC().toISODate());
      const sundayReservation = await seedReservation({
        name: sundayMakeup, start: sundayStart, profileId: studentProfile, origin: "MAKEUP",
      });
      await seedReservation({ name: habitual, start: sunday.set({ hour: 22, minute: 30 }), profileId: studentProfile, origin: "ORDINARY" });
      const mondayReservation = await seedReservation({
        name: mondayMakeup, start: mondayStart, profileId: studentProfile, origin: "MAKEUP",
      });
      const foreign = "Taller privado de otro alumno";
      await seedReservation({ name: foreign, start: sunday.set({ hour: 20 }), profileId: otherProfile, origin: "ORDINARY" });
      await seedReservation({
        name: "Clase ya cancelada", start: sunday.set({ hour: 19 }), profileId: studentProfile, origin: "ORDINARY", status: "CANCELLED",
      });
      const grant = randomUUID();
      const expiresAt = week.plus({ months: 2 }).toJSDate();
      await student.client.query(
        `insert into credit_ledger_movements
           (id, student_profile_id, movement_type, amount, expires_at, source_grant_movement_id, idempotency_key)
         values ($1, $2, 'MANUAL_GRANT', 2, $3, $1, $1)`,
        [grant, studentProfile, expiresAt],
      );
      for (const { reservationId, sessionId } of [sundayReservation, mondayReservation]) {
        await student.client.query(
          `insert into credit_ledger_movements
             (id, student_profile_id, movement_type, amount, expires_at, source_grant_movement_id,
              related_reservation_id, class_session_id, idempotency_key)
           values ($1, $2, 'RECOVERY_CONSUMPTION', 1, $3, $4, $5, $6, $1)`,
          [randomUUID(), studentProfile, expiresAt, grant, reservationId, sessionId],
        );
      }

      await page.goto("/login");
      await page.getByLabel("Email").fill(student.email);
      await page.getByLabel("Contraseña").fill(student.password);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await expect(page).toHaveURL(/\/student$/);
      const calendar = page.getByRole("region", { name: "Calendario semanal" });
      await expect(calendar).toContainText(`${week.toFormat("dd/MM/yyyy")} – ${sunday.toFormat("dd/MM/yyyy")}`);
      const sundays = calendar.getByRole("region", { name: /^domingo/ });
      await expect(sundays.getByRole("listitem")).toHaveCount(2);
      await expect(sundays.getByRole("listitem").nth(0)).toContainText(habitual);
      await expect(sundays.getByRole("listitem").nth(0)).toContainText("Clase habitual");
      await expect(sundays.getByRole("listitem").nth(0)).toContainText("22:30–23:00");
      await expect(sundays.getByRole("listitem").nth(1)).toContainText(sundayMakeup);
      await expect(sundays.getByRole("listitem").nth(1)).toContainText("23:15–23:45");
      await expect(calendar.getByText(mondayMakeup, { exact: true })).toHaveCount(0);
      await expect(calendar.getByText(foreign, { exact: true })).toHaveCount(0);
      await expect(calendar.getByText("Clase ya cancelada", { exact: true })).toHaveCount(0);
      expect(await calendar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      await calendar.getByRole("link", { name: "Semana anterior" }).click();
      const empty = calendar.getByText("No tienes clases reservadas esta semana.");
      await expect(empty).toBeVisible();
      await calendar.getByRole("link", { name: "Semana actual" }).click();
      await expect(sundays.getByRole("listitem")).toHaveCount(2);

      await calendar.getByRole("link", { name: "Semana siguiente" }).click();
      const mondays = calendar.getByRole("region", { name: /^lunes/ });
      await expect(mondays.getByRole("listitem")).toHaveCount(1);
      await expect(mondays.getByRole("listitem")).toContainText(mondayMakeup);
      await expect(mondays.getByRole("listitem")).toContainText("00:15–00:45");
      await expect(sundays).toHaveCount(0);
      await mondays.getByRole("button", { name: "Cancelar recuperación" }).click();
      await expect(page.getByRole("status")).toHaveText("Recuperación cancelada.");
      await expect(page).toHaveURL((url) => url.searchParams.get("week") === nextWeek.toISODate());
      await expect(empty).toBeVisible();
      const { rows } = await student.client.query(
        "select status from class_reservations where id=$1", [mondayReservation.reservationId],
      );
      expect(rows).toEqual([{ status: "CANCELLED" }]);
    });
  });
});
