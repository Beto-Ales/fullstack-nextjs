import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

type AccountFixture = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function login(page: Page, { email, password }: AccountFixture) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

async function seedProfile({ client, userId }: AccountFixture, firstName: string) {
  const id = randomUUID();
  await client.query(
    "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, $3, 'Perfil')",
    [id, userId, firstName],
  );
  return id;
}

async function seedBooking(
  { client, sessionIds }: AccountFixture, profileId: string, start: DateTime,
  { templateId = null, origin = "ORDINARY", status = "CONFIRMED" }: {
    templateId?: string | null; origin?: "ORDINARY" | "MAKEUP"; status?: "CONFIRMED" | "CANCELLED";
  } = {},
) {
  const sessionId = randomUUID();
  const reservationId = randomUUID();
  sessionIds.push(sessionId);
  await client.query(`insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
    values ($1, $2, $3, $4, $5, 12)`, [sessionId, templateId, start.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate()]);
  await client.query(`insert into class_reservations (id, class_session_id, student_profile_id, origin, status)
    values ($1, $2, $3, $4, $5)`, [reservationId, sessionId, profileId, origin, status]);
  return { sessionId, reservationId };
}

test("admin reads the full profile at 360 px and returns to the list and session using the keyboard", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student, "Marina");
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      const start = today.plus({ days: 8 }).set({ hour: 17, minute: 15 });
      const templateId = randomUUID();
      student.templateIds.push(templateId);
      await student.client.query(`insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
        values ($1, 'Acuarela de perfil', $2, '17:15', 60, $3)`, [templateId, start.weekday, today.minus({ days: 14 }).toISODate()]);
      await student.client.query(`insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
        values ($1, $2, $3, $4)`, [randomUUID(), profileId, templateId, today.minus({ days: 14 }).toISODate()]);
      const upcoming = await seedBooking(student, profileId, start, { templateId });
      const attended = await seedBooking(student, profileId, start.minus({ days: 10 }), { origin: "MAKEUP" });
      const absent = await seedBooking(student, profileId, start.minus({ days: 11 }));
      const futureRecovery = await seedBooking(student, profileId, start.plus({ days: 1 }), { origin: "MAKEUP" });
      const cancelled = await seedBooking(student, profileId, start.plus({ days: 2 }), { status: "CANCELLED" });
      const legacy = await seedBooking(student, profileId, start.minus({ days: 12 }), { status: "CANCELLED" });
      await student.client.query(`insert into reservation_attendance_records
        (id, reservation_id, student_profile_id, class_session_id, outcome, source, recorded_at, recorded_by_user_id)
        values ($1, $2, $3, $4, 'ATTENDED', 'MANUAL', now(), $5), ($6, $7, $3, $8, 'ABSENT', 'AUTO', now(), null)`,
      [randomUUID(), attended.reservationId, profileId, attended.sessionId, admin.userId, randomUUID(), absent.reservationId, absent.sessionId]);
      await student.client.query(`insert into reservation_cancellations
        (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at, cancellation_type,
          hours_before_start, meets_seven_day_rule, is_habitual_reservation, decision_source, administrative_reason)
        values ($1, $2, $3, $4, $5, now(), 'ON_TIME', 240, true, false, 'ADMIN_DECISION', 'Cambio de sala')`,
      [randomUUID(), cancelled.reservationId, profileId, cancelled.sessionId, admin.userId]);
      await student.client.query(`update class_reservations set cancelled_at = now() where id = $1`, [legacy.reservationId]);
      const grantId = randomUUID();
      await student.client.query(`insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, expires_at, source_grant_movement_id, idempotency_key, related_reservation_id, reason)
        values ($1, $2, 'MANUAL_GRANT', 3, $3, $4, $1, $1, null, 'Ajuste de perfil'),
          ($5, $2, 'RECOVERY_CONSUMPTION', 1, $6, $4, $1, $5, $7, null),
          ($8, $2, 'RECOVERY_CONSUMPTION', 1, $6, $4, $1, $8, $9, null)`,
      [grantId, profileId, today.minus({ days: 10 }).toJSDate(), start.plus({ months: 1 }).toJSDate(),
        randomUUID(), today.minus({ days: 7 }).toJSDate(), attended.reservationId, randomUUID(), futureRecovery.reservationId]);
      const older = start.minus({ days: 20 });
      const olderSessions = Array.from({ length: 20 }, () => randomUUID());
      student.sessionIds.push(...olderSessions);
      await student.client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        select id, $2, $3::timestamptz, $3::timestamptz + interval '1 hour', 12 from unnest($1::text[]) as s(id)`,
      [olderSessions, older.toISODate(), older.toJSDate()]);
      await student.client.query(`insert into class_reservations (id, class_session_id, student_profile_id)
        select reservation, session, $3 from unnest($1::text[], $2::text[]) as r(reservation, session)`,
      [olderSessions.map(() => randomUUID()), olderSessions, profileId]);

      await page.setViewportSize({ width: 360, height: 800 });
      await login(page, admin);
      const directory = page.getByRole("region", { name: "Perfiles de alumnos" });
      await directory.getByRole("link", { name: `Marina Perfil · ${student.email}` }).press("Enter");
      await expect(page).toHaveURL(new RegExp(`/admin/alumnos/${profileId}`));
      await expect(page.getByRole("heading", { name: "Marina Perfil" })).toBeVisible();
      await expect(page.getByText(student.email, { exact: true })).toBeVisible();
      await expect(page.getByText("Activa", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Horarios habituales" })).toContainText("Acuarela de perfil");
      const upcomingRegion = page.getByRole("region", { name: "Próximas clases" });
      await expect(upcomingRegion.getByRole("listitem")).toHaveCount(2);
      await expect(upcomingRegion.locator(`time[datetime="${start.toJSDate().toISOString()}"] [aria-hidden=true]`))
        .toHaveText(start.toFormat("dd/MM/yyyy, HH:mm 'GMT'ZZ"));
      await expect(upcomingRegion).toContainText("Clase habitual");
      const history = page.getByRole("region", { name: "Historial académico" });
      await expect(history.getByText("Asistió", { exact: true })).toBeVisible();
      await expect(history.getByText("Ausente", { exact: true })).toBeVisible();
      await expect(history.getByText("Cancelación por decisión administrativa", { exact: true })).toBeVisible();
      await expect(history).toContainText("Cambio de sala");
      await expect(history).toContainText("Origen no determinado");
      const credits = page.getByRole("region", { name: "Créditos" });
      await expect(credits).toContainText("Concesión manual · +3 créditos");
      await expect(credits).toContainText("Ajuste de perfil");
      const recoveries = page.getByRole("region", { name: "Recuperaciones" });
      await expect(recoveries).toContainText("Realizada · Asistió");
      await expect(recoveries).toContainText("Futura confirmada");
      await expect(recoveries.getByText("Consumo por recuperación · −1 crédito", { exact: true })).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await expect(page.getByRole("main").locator("form")).toHaveCount(0);

      const pagination = history.getByRole("navigation", { name: "Paginación de historial académico" });
      await pagination.getByRole("link", { name: "Siguiente" }).press("Enter");
      await expect(pagination).toContainText("Página 2");
      await expect(history.getByRole("listitem")).toHaveCount(4);
      await pagination.getByRole("link", { name: "Anterior" }).press("Enter");
      await expect(pagination).toContainText("Página 1");
      const back = page.getByRole("link", { name: "Volver a alumnos" });
      await back.focus();
      await expect(back).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#perfiles-de-alumnos$/);

      const week = start.startOf("week").toISODate();
      await page.goto(`/admin/sesiones/${upcoming.sessionId}?week=${week}`);
      await page.getByRole("link", { name: "Marina Perfil", exact: true }).press("Enter");
      await page.getByRole("link", { name: "Volver a la sesión" }).press("Enter");
      await expect(page).toHaveURL(`/admin/sesiones/${upcoming.sessionId}?week=${week}#confirmed-enrollments`);
    });
  });
});

test("direct profile URLs enforce the role and return a generic 404 to the administrator", async ({ page, browser, baseURL }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (target) => {
      await withCreditsAccount("STUDENT", async (visitor) => {
        const profileId = await seedProfile(target, "Privada");
        await seedProfile(visitor, "Visitante");
        const url = `/admin/alumnos/${profileId}`;
        await page.goto(url);
        await expect(page).toHaveURL(/\/login$/);
        await login(page, visitor);
        await expect(page).toHaveURL(/\/student$/);
        await page.goto(url);
        await expect(page).toHaveURL(/\/student$/);
        await expect(page.getByText(target.email, { exact: true })).toHaveCount(0);

        const context = await browser.newContext({ baseURL });
        try {
          const adminPage = await context.newPage();
          await login(adminPage, admin);
          await expect(adminPage).toHaveURL(/\/admin$/);
          const missing = await adminPage.goto(`/admin/alumnos/${randomUUID()}`);
          expect(missing?.status()).toBe(404);
          const invalid = await adminPage.goto("/admin/alumnos/invalido");
          expect(invalid?.status()).toBe(404);
        } finally {
          await context.close();
        }
      });
    });
  });
});

test("the admin can open a withdrawn student's history and sees empty sections", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student, "Baja");
      const start = DateTime.now().setZone(CENTER_TIME_ZONE).minus({ days: 3 });
      const booking = await seedBooking(student, profileId, start);
      try {
        await login(page, admin);
        const withdrawal = page.getByRole("region", { name: "Dar de baja a un alumno" });
        await withdrawal.getByLabel("Alumno que causa baja").selectOption(profileId);
        await withdrawal.getByRole("button", { name: "Confirmar baja" }).click();
        await expect(withdrawal.getByRole("status")).toContainText("Baja registrada");
        const directory = page.getByRole("region", { name: "Perfiles de alumnos" });
        await expect(directory.getByRole("listitem").filter({ hasText: student.email })).toContainText("Cuenta desactivada");
        await directory.getByRole("link", { name: `Baja Perfil · ${student.email}` }).click();
        await expect(page.getByText("Desactivada", { exact: true })).toBeVisible();
        const history = page.getByRole("region", { name: "Historial académico" });
        await expect(history).toContainText("Clase única");
        await expect(history).toContainText("Sin asistencia registrada");
        await expect(page.getByText("El alumno no tiene horarios habituales asignados.")).toBeVisible();
        await expect(page.getByText("El alumno no tiene próximas clases confirmadas.")).toBeVisible();
        await expect(page.getByText("No hay movimientos de créditos.")).toBeVisible();
        await expect(page.getByText("El alumno no tiene reservas de recuperación.")).toBeVisible();
        const { rowCount } = await student.client.query("select id from class_reservations where id = $1", [booking.reservationId]);
        expect(rowCount).toBe(1);
      } finally {
        await student.client.query("delete from student_withdrawals where student_user_id = $1", [student.userId]);
      }
    });
  });
});
