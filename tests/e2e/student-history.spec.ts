import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

test("shows only recorded class outcomes and keeps pending recoveries separate", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await withCreditsAccount("STUDENT", async (student) => {
    await withCreditsAccount("STUDENT", async (other) => {
      const profile = randomUUID();
      const otherProfile = randomUUID();
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      await student.client.query(
        `insert into student_profiles (id, user_id, first_name, last_name)
         values ($1, $2, 'History', 'Student'), ($3, $4, 'Other', 'Student')`,
        [profile, student.userId, otherProfile, other.userId],
      );

      async function seedClass(name: string, days: number, options: {
        profileId?: string; origin?: "ORDINARY" | "MAKEUP"; cancelled?: boolean;
      } = {}) {
        const template = randomUUID();
        const session = randomUUID();
        const reservation = randomUUID();
        const start = today.plus({ days }).set({ hour: 0, minute: 15 });
        const date = start.toISODate();
        const profileId = options.profileId ?? profile;
        student.templateIds.push(template);
        student.sessionIds.push(session);
        await student.client.query(
          `insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
           values ($1, $2, $3, '00:15', 60, $4)`,
          [template, name, start.weekday, date],
        );
        await student.client.query(
          `insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
           values ($1, $2, $3, $4, $5, 2)`,
          [session, template, date, start.toJSDate(), start.plus({ hours: 1 }).toJSDate()],
        );
        await student.client.query(
          `insert into class_reservations (id, class_session_id, student_profile_id, status, origin, cancelled_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [reservation, session, profileId, options.cancelled ? "CANCELLED" : "CONFIRMED", options.origin ?? "ORDINARY",
            options.cancelled ? start.minus({ hours: 1 }).toJSDate() : null],
        );
        if (!options.origin) {
          await student.client.query(
            `insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
             values ($1, $2, $3, $4)`,
            [randomUUID(), profileId, template, date],
          );
        }
        return { reservation, session, start, profileId };
      }

      await page.goto("/login");
      await page.getByLabel("Email").fill(student.email);
      await page.getByLabel("Contraseña").fill(student.password);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await expect(page).toHaveURL(/\/student$/);
      const history = page.getByRole("region", { name: "Historial de clases" });
      await expect(history.getByText("Aún no tienes clases en el historial.")).toBeVisible();

      const cancelled = await seedClass("Grabado cancelado", -2, { cancelled: true });
      const attended = await seedClass("Dibujo asistido", -3);
      const absent = await seedClass("Cerámica recuperada", -4, { origin: "MAKEUP" });
      await seedClass("Pintura sin registro", -5);
      const foreign = await seedClass("Taller reservado por otra persona", -1, { profileId: otherProfile });
      const pending = await seedClass("Recuperación pendiente", 2, { origin: "MAKEUP" });

      await student.client.query(
        `insert into reservation_cancellations
           (id, reservation_id, student_profile_id, class_session_id, cancelled_at, cancellation_type,
            hours_before_start, meets_seven_day_rule, is_habitual_reservation)
         values ($1, $2, $3, $4, $5, 'LATE', 1, false, true)`,
        [randomUUID(), cancelled.reservation, profile, cancelled.session, cancelled.start.minus({ hours: 1 }).toJSDate()],
      );
      async function seedAttendance(record: typeof attended, outcome: "ATTENDED" | "ABSENT", superseded: boolean) {
        const recordedAt = record.start.plus({ hours: 2 });
        await student.client.query(
          `insert into reservation_attendance_records
             (id, reservation_id, student_profile_id, class_session_id, outcome, source, recorded_at, superseded_at)
           values ($1, $2, $3, $4, $5, 'MANUAL', $6, $7)`,
          [randomUUID(), record.reservation, record.profileId, record.session, outcome, recordedAt.toJSDate(),
            superseded ? recordedAt.plus({ hours: 1 }).toJSDate() : null],
        );
      }
      await seedAttendance(attended, "ABSENT", true);
      await seedAttendance(attended, "ATTENDED", false);
      await seedAttendance(absent, "ABSENT", false);
      await seedAttendance(foreign, "ATTENDED", false);

      await page.goto(`/student?studentProfileId=${otherProfile}`);
      const entries = history.getByRole("listitem");
      await expect(entries).toHaveCount(4);
      await expect(entries.nth(0)).toContainText("Grabado cancelado");
      await expect(entries.nth(0)).toContainText("Cancelación tardía");
      await expect(entries.nth(1)).toContainText("Dibujo asistido");
      await expect(entries.nth(1)).toContainText("Clase habitual");
      await expect(entries.nth(1)).toContainText("Asistencia registrada");
      await expect(entries.nth(1)).toContainText(attended.start.toFormat("dd/MM/yyyy"));
      await expect(entries.nth(1)).toContainText("00:15");
      await expect(entries.nth(2)).toContainText("Cerámica recuperada");
      await expect(entries.nth(2)).toContainText("Recuperación");
      await expect(entries.nth(2)).toContainText("Falta registrada");
      await expect(entries.nth(3)).toContainText("Pintura sin registro");
      await expect(entries.nth(3)).toContainText("Sin asistencia registrada");
      await expect(history.getByText("Falta registrada", { exact: true })).toHaveCount(1);
      await expect(history.getByText("Taller reservado por otra persona")).toHaveCount(0);
      await expect(history.getByText("Recuperación pendiente")).toHaveCount(0);
      const pendingRegion = page.getByRole("region", { name: "Mis recuperaciones" });
      await expect(pendingRegion.getByRole("listitem")).toHaveCount(1);
      await expect(pendingRegion.locator("time")).toHaveAttribute("datetime", pending.start.toUTC().toISO()!);
      await expect(pendingRegion.locator("time [aria-hidden=true]")).toHaveText(pending.start.toFormat("dd/MM/yyyy, HH:mm 'GMT'ZZ"));
      await expect(pendingRegion.getByRole("button", { name: "Cancelar recuperación" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Calendario semanal" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Clases futuras disponibles" })).toBeVisible();
      expect(await history.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    });
  });
});
