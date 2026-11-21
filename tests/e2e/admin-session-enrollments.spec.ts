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

test("shows confirmed enrollments and cancellation history for one session and protects the direct URL", async ({ page, browser, baseURL }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const week = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week").plus({ weeks: 1 });
      const selectedStart = week.set({ hour: 18 });
      const users = Array.from({ length: 4 }, () => randomUUID());
      const [ordinary, makeup, cancelled, foreign, cancelledMakeup] = Array.from({ length: 5 }, () => randomUUID());
      const selectedName = "Taller de ilustración";
      const emptyName = "Taller sin inscritos";
      const ordinaryName = "Ana Ordinaria";
      const makeupName = "Bea Recuperación";
      const cancelledName = "Carla Cancelada";
      const foreignName = "Diana Otra sesión";
      const cancelledMakeupName = "Eva Recuperación cancelada";
      const latestCancellation = selectedStart.minus({ days: 2 }).set({ hour: 0, minute: 30 });
      const earlierCancellation = latestCancellation.minus({ hours: 2 });
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
                  ($5, $6, 'Carla', 'Cancelada'), ($7, $8, 'Diana', 'Otra sesión'),
                  ($9, $10, 'Eva', 'Recuperación cancelada')`,
          [ordinary, student.userId, makeup, users[0], cancelled, users[1], foreign, users[2], cancelledMakeup, users[3]],
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

        const selected = await seedSession(selectedName, selectedStart, 2);
        const emptyStart = selectedStart.plus({ days: 1 });
        const empty = await seedSession(emptyName, emptyStart, 1);
        const other = await seedSession("Otro taller", selectedStart.plus({ days: 2 }), 3);
        await admin.client.query(
          `insert into class_reservations (id, class_session_id, student_profile_id, status, origin)
           values ($1, $4, $5, 'CONFIRMED', 'ORDINARY'), ($2, $4, $6, 'CONFIRMED', 'MAKEUP'),
                  ($3, $7, $8, 'CONFIRMED', 'ORDINARY')`,
          [randomUUID(), randomUUID(), randomUUID(), selected.id, ordinary, makeup, other.id, foreign],
        );
        const ordinaryCancellationId = randomUUID();
        await admin.client.query(
          `insert into class_reservations
             (id, class_session_id, student_profile_id, status, origin, cancelled_at, cancelled_by_user_id)
           values ($1, $4, $5, 'CANCELLED', 'ORDINARY', $9, $11),
                  ($2, $4, $6, 'CANCELLED', 'MAKEUP', $10, $12),
                  ($3, $7, $8, 'CANCELLED', 'ORDINARY', $9, $13)`,
          [ordinaryCancellationId, randomUUID(), randomUUID(), selected.id, cancelled, cancelledMakeup, other.id,
            foreign, earlierCancellation.toJSDate(), latestCancellation.toJSDate(), users[1], admin.userId, users[2]],
        );
        await admin.client.query(
          `insert into reservation_cancellations
             (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at,
              cancellation_type, hours_before_start, meets_seven_day_rule, is_habitual_reservation, non_eligibility_reason)
           values ($1, $2, $3, $4, $5, $6, 'LATE', $7, false, true, 'TIMING')`,
          [randomUUID(), ordinaryCancellationId, cancelled, selected.id, users[1], earlierCancellation.toJSDate(),
            Math.floor(selectedStart.diff(earlierCancellation, "hours").hours)],
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
        const attendance = page.getByRole("region", { name: "Control de asistencia" });
        await expect(attendance.getByText("El registro y la corrección estarán disponibles cuando finalice la clase.")).toBeVisible();
        await expect(attendance.getByText("Sin registrar", { exact: true })).toHaveCount(2);
        await expect(attendance.getByRole("combobox")).toHaveCount(0);
        const details = page.getByRole("region", { name: "Reservas confirmadas" });
        await expect(details.getByText(`Total de inscritos: ${calendarTotal}`)).toBeVisible();
        await expect(details.getByRole("listitem")).toHaveCount(2);
        await expect(details.getByRole("listitem").filter({ hasText: ordinaryName })).toContainText("Ordinaria");
        await expect(details.getByRole("listitem").filter({ hasText: makeupName })).toContainText("Recuperación");
        await expect(details.getByText(cancelledName)).toHaveCount(0);
        await expect(details.getByText(foreignName)).toHaveCount(0);
        await expect(details.getByRole("button")).toHaveCount(0);

        const cancellations = page.getByRole("region", { name: "Cancelaciones", exact: true });
        const entries = cancellations.getByRole("listitem");
        await expect(entries).toHaveCount(2);
        await expect(entries.nth(0)).toContainText(cancelledMakeupName);
        await expect(entries.nth(0).getByText("Recuperación", { exact: true })).toBeVisible();
        await expect(entries.nth(0)).toContainText("Por administración");
        const latestTime = entries.nth(0).locator("time");
        await expect(latestTime).toHaveAttribute("datetime", latestCancellation.toJSDate().toISOString());
        await expect(latestTime).toHaveText(new Intl.DateTimeFormat("es-ES", {
          timeZone: CENTER_TIME_ZONE, dateStyle: "short", timeStyle: "short",
        }).format(latestCancellation.toJSDate()));
        await expect(entries.nth(1)).toContainText(cancelledName);
        await expect(entries.nth(1)).toContainText("Ordinaria");
        await expect(entries.nth(1)).toContainText("Por el alumno");
        await expect(entries.nth(1)).toContainText("Cancelación tardía");
        await expect(entries.nth(1)).toContainText("Antelación insuficiente");
        await expect(cancellations.getByText(foreignName)).toHaveCount(0);
        await expect(cancellations.getByRole("button")).toHaveCount(0);

        await page.getByRole("link", { name: "Volver al calendario" }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.searchParams.get("week") === week.toISODate());
        await expect(emptyCard).toContainText(capacityNotice);
        await emptyCard.getByRole("link", { name: "Ver inscritos" }).click();
        await expect(page.getByRole("heading", { name: `Inscritos en ${emptyName}` })).toBeVisible();
        await expect(details.getByText("Total de inscritos: 0")).toBeVisible();
        await expect(details.getByText("No hay inscritos en esta sesión.")).toBeVisible();
        await expect(cancellations.getByText("No hay cancelaciones en esta sesión.")).toBeVisible();

        const studentPage = await studentContext.newPage();
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await studentPage.goto(`/admin/sesiones/${selected.id}`);
        await expect(studentPage).toHaveURL(/\/student$/);
        await expect(studentPage.getByRole("region", { name: "Reservas confirmadas" })).toHaveCount(0);
        await expect(studentPage.getByRole("region", { name: "Cancelaciones", exact: true })).toHaveCount(0);
        await expect(studentPage.getByText(makeupName)).toHaveCount(0);
        await expect(studentPage.getByText(cancelledName)).toHaveCount(0);
      } finally {
        await studentContext.close();
        await admin.client.query("delete from users where id=any($1::text[])", [users]);
      }
    });
  });
});

type AccountFixture = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function seedAttendanceProfile({ client, userId }: AccountFixture, firstName: string, lastName: string) {
  const id = randomUUID();
  await client.query(`insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, $3, $4)`,
    [id, userId, firstName, lastName]);
  return id;
}

async function seedAttendanceSession(
  admin: AccountFixture,
  startsAt: DateTime,
  profiles: { id: string; origin: "ORDINARY" | "MAKEUP" }[],
  cancelled = false,
) {
  const id = randomUUID();
  admin.sessionIds.push(id);
  const endsAt = startsAt.plus({ hours: 1 });
  await admin.client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, status, max_capacity)
    values ($1, $2, $3, $4, $5, 12)`, [id, startsAt.toISODate(), startsAt.toJSDate(), endsAt.toJSDate(),
    cancelled ? "CANCELLED" : "SCHEDULED"]);
  const reservations = [];
  for (const profile of profiles) {
    const reservationId = randomUUID();
    await admin.client.query(`insert into class_reservations (id, class_session_id, student_profile_id, origin, status, cancelled_at)
      values ($1, $2, $3, $4, $5, $6)`, [reservationId, id, profile.id, profile.origin,
      cancelled ? "CANCELLED" : "CONFIRMED", cancelled ? startsAt.toJSDate() : null]);
    reservations.push(reservationId);
  }
  const week = startsAt.startOf("week").toISODate();
  return { id, reservations, week, path: `/admin/sesiones/${id}?week=${week}` };
}

test("registers and corrects attendance on mobile and keeps historical and in-progress sessions read-only", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (first) => {
      await withCreditsAccount("STUDENT", async (second) => {
        const ordinaryId = await seedAttendanceProfile(first, "Lola", "Habitual");
        const makeupId = await seedAttendanceProfile(second, "Mara", "Recuperación");
        const ordinary = { id: ordinaryId, origin: "ORDINARY" } as const;
        const makeup = { id: makeupId, origin: "MAKEUP" } as const;
        const now = DateTime.now().setZone(CENTER_TIME_ZONE);
        const active = await seedAttendanceSession(admin, now.minus({ minutes: 15 }), [ordinary]);
        const ended = await seedAttendanceSession(admin, now.minus({ days: 2 }), [ordinary, makeup]);
        const cancelled = await seedAttendanceSession(admin, now.minus({ days: 3 }), [ordinary], true);
        await admin.client.query(`insert into reservation_attendance_records
          (id, reservation_id, student_profile_id, class_session_id, outcome, source, recorded_at)
          values ($1, $2, $3, $4, 'ATTENDED', 'MANUAL', $5)`,
        [randomUUID(), cancelled.reservations[0], ordinaryId, cancelled.id, now.minus({ days: 3 }).plus({ hours: 1 }).toJSDate()]);

        await login(page, admin);
        await expect(page).toHaveURL(/\/admin$/);
        await page.goto(active.path);
        const attendance = page.getByRole("region", { name: "Control de asistencia" });
        await expect(attendance.getByText("Lola Habitual")).toBeVisible();
        await expect(attendance.getByText("Sin registrar", { exact: true })).toBeVisible();
        await expect(attendance.getByText(/cuando finalice la clase/)).toBeVisible();
        await expect(attendance.getByRole("combobox")).toHaveCount(0);

        await page.goto(cancelled.path);
        await expect(attendance.getByText(/La sesión está cancelada/)).toBeVisible();
        await expect(attendance.getByRole("combobox")).toHaveCount(0);
        const history = page.getByRole("region", { name: "Cancelaciones" });
        await expect(history.getByText("Lola Habitual")).toBeVisible();
        await expect(history.getByText("Asistencia histórica: Asistió")).toBeVisible();

        await page.setViewportSize({ width: 360, height: 780 });
        await page.goto(ended.path);
        const habitualRow = attendance.getByRole("listitem").filter({ hasText: "Lola Habitual" });
        const makeupRow = attendance.getByRole("listitem").filter({ hasText: "Mara Recuperación" });
        await expect(habitualRow.getByText("Ordinaria", { exact: true })).toBeVisible();
        await expect(makeupRow.getByText("Recuperación", { exact: true })).toBeVisible();
        await expect(attendance.getByText("Sin registrar", { exact: true })).toHaveCount(2);
        expect(await attendance.evaluate((region) => region.scrollWidth <= region.clientWidth)).toBe(true);

        const firstOutcome = habitualRow.getByLabel("Resultado", { exact: true });
        await firstOutcome.focus();
        await firstOutcome.press("ArrowDown");
        await expect(firstOutcome).toHaveValue("ATTENDED");
        const register = habitualRow.getByRole("button", { name: "Registrar asistencia" });
        await register.focus();
        await register.press("Enter");
        await expect(habitualRow.getByText("Asistió", { exact: true })).toBeVisible();
        await expect(habitualRow.getByRole("status")).toHaveText("Asistencia registrada.");
        await expect(habitualRow.getByRole("button", { name: "Registrar asistencia" })).toHaveCount(0);

        await makeupRow.getByLabel("Resultado", { exact: true }).selectOption("ABSENT");
        await makeupRow.getByRole("button", { name: "Registrar asistencia" }).click();
        await expect(makeupRow.getByText("Ausente", { exact: true })).toBeVisible();
        await expect(makeupRow.getByRole("status")).toHaveText("Asistencia registrada.");

        const correction = habitualRow.getByText("Corregir asistencia", { exact: true });
        await correction.focus();
        await correction.press("Enter");
        const newOutcome = habitualRow.getByLabel("Nuevo resultado");
        await expect(newOutcome.locator("option")).toHaveCount(1);
        await expect(newOutcome).toHaveValue("ABSENT");
        const reason = habitualRow.getByLabel("Motivo de la corrección");
        const save = habitualRow.getByRole("button", { name: "Guardar corrección" });
        await save.click();
        expect(await reason.evaluate((field: HTMLTextAreaElement) => field.validity.valueMissing)).toBe(true);
        await reason.fill("   ");
        await save.click();
        await expect(habitualRow.getByRole("alert")).toContainText("Escribe un motivo de entre 3 y 300 caracteres");
        await expect(habitualRow.locator("strong")).toHaveText("Asistió");

        const stalePage = await page.context().newPage();
        try {
          await stalePage.goto(ended.path);
          const staleRow = stalePage.getByRole("region", { name: "Control de asistencia" }).getByRole("listitem")
            .filter({ hasText: "Lola Habitual" });
          await expect(staleRow.locator("strong")).toHaveText("Asistió");
          await staleRow.getByText("Corregir asistencia", { exact: true }).click();
          await staleRow.getByLabel("Motivo de la corrección").fill("Motivo de la vista anterior");

          await reason.fill("Se verificó la lista de asistencia");
          await save.click();
          await expect(habitualRow.getByRole("status")).toHaveText("Corrección guardada.");
          await expect(habitualRow.locator("strong")).toHaveText("Ausente");

          await staleRow.getByRole("button", { name: "Guardar corrección" }).click();
          await expect(staleRow.getByRole("alert")).toContainText("El resultado guardado ya coincide");
          await expect(staleRow.locator("strong")).toHaveText("Ausente");
        } finally {
          await stalePage.close();
        }

        await makeupRow.getByText("Corregir asistencia", { exact: true }).click();
        await expect(makeupRow.getByLabel("Nuevo resultado")).toHaveValue("ATTENDED");
        await makeupRow.getByLabel("Motivo de la corrección").fill("Confirmado por la profesora");
        await makeupRow.getByRole("button", { name: "Guardar corrección" }).click();
        await expect(makeupRow.getByRole("status")).toHaveText("Corrección guardada.");
        await expect(makeupRow.locator("strong")).toHaveText("Asistió");

        const { rows } = await admin.client.query(`select r.origin, r.status, a.outcome, a.correction_reason,
          a.recorded_by_user_id, a.corrected_from_record_id is not null as corrected
          from class_reservations r join reservation_attendance_records a on a.reservation_id = r.id
          where r.class_session_id = $1 and a.superseded_at is null order by r.origin`, [ended.id]);
        expect(rows).toEqual([
          { origin: "ORDINARY", status: "CONFIRMED", outcome: "ABSENT", correction_reason: "Se verificó la lista de asistencia",
            recorded_by_user_id: admin.userId, corrected: true },
          { origin: "MAKEUP", status: "CONFIRMED", outcome: "ATTENDED", correction_reason: "Confirmado por la profesora",
            recorded_by_user_id: admin.userId, corrected: true },
        ]);
        const movements = await admin.client.query("select id from credit_ledger_movements where class_session_id = $1", [ended.id]);
        expect(movements.rows).toEqual([]);
        await expect(page).toHaveURL(new RegExp(`${ended.id}\\?week=${ended.week}$`));
        const back = page.getByRole("link", { name: "Volver al calendario" });
        await expect(back).toHaveAttribute("href", `/admin?week=${ended.week}#calendario-semanal`);
        await back.click();
        await expect(page.getByRole("region", { name: "Calendario semanal global" })).toBeVisible();
      });
    });
  });
});

test("rejects attendance submissions from a stale admin page after role change or session expiry", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const id = await seedAttendanceProfile(student, "Nerea", "Asistente");
      const ended = await seedAttendanceSession(admin, DateTime.now().setZone(CENTER_TIME_ZONE).minus({ days: 1 }),
        [{ id, origin: "ORDINARY" }]);
      const attendance = page.getByRole("region", { name: "Control de asistencia" });

      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(ended.path);
      await attendance.getByLabel("Resultado", { exact: true }).selectOption("ATTENDED");

      await page.context().clearCookies();
      const studentTab = await page.context().newPage();
      try {
        await login(studentTab, student);
        await expect(studentTab).toHaveURL(/\/student$/);
        await attendance.getByRole("button", { name: "Registrar asistencia" }).click();
        await expect(page).toHaveURL(/\/student$/);
        await expect(attendance).toHaveCount(0);
      } finally {
        await studentTab.close();
      }

      await page.context().clearCookies();
      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(ended.path);
      await attendance.getByLabel("Resultado", { exact: true }).selectOption("ABSENT");
      await admin.client.query("update sessions set expires_at = now() - interval '1 minute' where user_id = $1", [admin.userId]);
      await attendance.getByRole("button", { name: "Registrar asistencia" }).click();
      await expect(page).toHaveURL(/\/login$/);
      const records = await admin.client.query("select id from reservation_attendance_records where class_session_id = $1", [ended.id]);
      expect(records.rows).toEqual([]);
    });
  });
});
