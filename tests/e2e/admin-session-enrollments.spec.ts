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

        const selected = await seedSession(selectedName, selectedStart, 4);
        const emptyStart = selectedStart.plus({ days: 1 });
        const empty = await seedSession(emptyName, emptyStart, 1);
        const other = await seedSession("Otro taller", selectedStart.plus({ days: 2 }), 3);
        await admin.client.query(`insert into session_capacity_blocks (id, class_session_id, blocked_spots, is_active)
          values ($1, $3, 1, true), ($2, $3, 2, false)`, [randomUUID(), randomUUID(), selected.id]);
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
        await expect(selectedCard.locator("dd")).toHaveText(["4", "2", "1", "1", "0"]);
        const calendarTotal = await confirmed.innerText();
        await expect(emptyCard).toContainText(capacityNotice);

        await selectedCard.getByRole("link", { name: "Ver inscritos" }).click();
        await expect(page.getByRole("heading", { name: `Inscritos en ${selectedName}` })).toBeVisible();
        const capacity = page.getByRole("region", { name: "Aforo y disponibilidad" });
        await expect(capacity.locator("dd")).toHaveText(["4", "4", "2", "1", "1", "1", "0"]);
        await expect(capacity.getByText("Hay plazas reservables y plazas bloqueadas por administración.")).toBeVisible();
        await expect(capacity.getByRole("meter", { name: "Aforo físico ocupado y bloqueado" })).toHaveAttribute("value", "3");
        await page.setViewportSize({ width: 360, height: 780 });
        expect(await capacity.evaluate((region) => region.scrollWidth <= region.clientWidth)).toBe(true);
        const blocks = capacity.getByRole("region", { name: "Bloqueos de plazas" });
        await expect(blocks.getByText("Activo · 1 plaza")).toBeVisible();
        await expect(blocks.getByText("Desactivado · 2 plazas")).toBeVisible();
        const stalePage = await page.context().newPage();
        try {
          await stalePage.goto(page.url());
          const staleCapacity = stalePage.getByRole("region", { name: "Aforo y disponibilidad" });
          await staleCapacity.getByLabel("Motivo del bloqueo").fill("Petición desactualizada");

          await page.bringToFront();
          const blockReason = blocks.getByLabel("Motivo del bloqueo");
          await expect(blockReason).toBeVisible();
          const confirmBlock = blocks.getByRole("button", { name: "Confirmar bloqueo" });
          await blockReason.fill("   ");
          await confirmBlock.click();
          await expect(blocks.getByRole("alert")).toContainText("Escribe un motivo de entre 3 y 300 caracteres");
          await expect(blockReason).toBeVisible();
          await blockReason.fill("Reserva para coordinación");
          await blockReason.press("Tab");
          await expect(confirmBlock).toBeFocused();
          await confirmBlock.click();
          await expect(blocks.getByText("Plaza bloqueada.", { exact: true })).toBeVisible();
          await expect(capacity.locator("dd")).toHaveText(["4", "4", "2", "2", "0", "0", "0"]);

          await stalePage.bringToFront();
          await staleCapacity.getByRole("button", { name: "Confirmar bloqueo" }).click();
          await expect(staleCapacity.getByRole("alert")).toContainText("Ya no hay plazas suficientes");
          await expect(staleCapacity.locator("dd")).toHaveText(["4", "4", "2", "2", "0", "0", "0"]);
        } finally {
          await stalePage.close();
        }

        await page.getByRole("link", { name: "Volver al calendario" }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.searchParams.get("week") === week.toISODate());
        await expect(selectedCard.locator("dd")).toHaveText(["4", "2", "2", "0", "0"]);
        await selectedCard.getByRole("link", { name: "Ver inscritos" }).click();
        const loggedBlock = blocks.getByRole("listitem").filter({ hasText: "Reserva para coordinación" });
        await expect(loggedBlock).toContainText("Activo · 1 plaza");
        await expect(loggedBlock).toContainText(admin.email);
        await loggedBlock.getByText("Desbloquear", { exact: true }).click();
        await loggedBlock.getByLabel("Motivo del desbloqueo").fill("Coordinación confirmada");
        await loggedBlock.getByRole("button", { name: "Confirmar desbloqueo" }).click();
        await expect(loggedBlock.getByRole("status")).toHaveText("Bloqueo desactivado.");
        await expect(loggedBlock).toContainText("Desactivado · 1 plaza");
        await expect(loggedBlock).toContainText("Coordinación confirmada");
        await expect(capacity.locator("dd")).toHaveText(["4", "4", "2", "1", "1", "1", "0"]);
        const audit = await admin.client.query(`select is_active, release_reason, released_by_user_id, released_at is not null as released
          from session_capacity_blocks where class_session_id = $1 and reason = $2`, [selected.id, "Reserva para coordinación"]);
        expect(audit.rows).toEqual([{ is_active: false, release_reason: "Coordinación confirmada", released_by_user_id: admin.userId, released: true }]);
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
        await expect(details.getByRole("button", { name: "Registrar asistencia" })).toHaveCount(0);
        await expect(details.getByText("Cancelar inscripción", { exact: true })).toHaveCount(1);

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
        await expect(selectedCard.locator("dd")).toHaveText(["4", "2", "1", "1", "0"]);
        await emptyCard.getByRole("link", { name: "Ver inscritos" }).click();
        await expect(page.getByRole("heading", { name: `Inscritos en ${emptyName}` })).toBeVisible();
        await expect(capacity.locator("dd")).toHaveText(["1", "1", "0", "0", "1", "1", "2"]);
        await expect(capacity.getByText(capacityNotice, { exact: false })).toBeVisible();
        await expect(details.getByText("Total de inscritos: 0")).toBeVisible();
        await expect(details.getByText("No hay inscritos en esta sesión.")).toBeVisible();
        await expect(cancellations.getByText("No hay cancelaciones en esta sesión.")).toBeVisible();

        const studentPage = await studentContext.newPage();
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await studentPage.goto(`/admin/sesiones/${selected.id}`);
        await expect(studentPage).toHaveURL(/\/student$/);
        await expect(studentPage.getByRole("region", { name: "Aforo y disponibilidad" })).toHaveCount(0);
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
        const capacity = page.getByRole("region", { name: "Aforo y disponibilidad" });
        await expect(capacity.getByText("Sesión en curso. La reserva de plazas está cerrada.")).toBeVisible();
        await expect(capacity.locator("dd")).toHaveText(["12", "12", "1", "0", "11", "0"]);
        await expect(attendance.getByText("Lola Habitual")).toBeVisible();
        await expect(attendance.getByText("Sin registrar", { exact: true })).toBeVisible();
        await expect(attendance.getByText(/cuando finalice la clase/)).toBeVisible();
        await expect(attendance.getByRole("combobox")).toHaveCount(0);

        await page.goto(cancelled.path);
        await expect(capacity.getByText("Sesión cancelada. Solo se muestra la ocupación registrada.")).toBeVisible();
        await expect(capacity.locator("dd")).toHaveText(["12", "12", "0", "0", "12", "0"]);
        await expect(attendance.getByText(/La sesión está cancelada/)).toBeVisible();
        await expect(attendance.getByRole("combobox")).toHaveCount(0);
        const history = page.getByRole("region", { name: "Cancelaciones" });
        await expect(history.getByText("Lola Habitual")).toBeVisible();
        await expect(history.getByText("Asistencia histórica: Asistió")).toBeVisible();

        await page.setViewportSize({ width: 360, height: 780 });
        await page.goto(ended.path);
        await expect(capacity.getByText("Sesión finalizada. Solo se muestra la ocupación registrada.")).toBeVisible();
        await expect(capacity.locator("dd")).toHaveText(["12", "12", "2", "0", "10", "0"]);
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

test("rejects both capacity block actions from old admin pages after the session changes to a student", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      await seedAttendanceProfile(student, "Iris", "Prueba");
      const upcoming = await seedAttendanceSession(admin, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 2 }), []);
      const blockId = randomUUID();
      await admin.client.query(`insert into session_capacity_blocks (id, class_session_id, blocked_spots, reason, blocked_by_user_id)
        values ($1, $2, 1, 'Bloqueo original', $3)`, [blockId, upcoming.id, admin.userId]);
      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(upcoming.path);
      const blocks = page.getByRole("region", { name: "Bloqueos de plazas" });
      await blocks.getByLabel("Motivo del bloqueo").fill("Intento sin autorización");

      const releasePage = await page.context().newPage();
      const studentTab = await page.context().newPage();
      try {
        await releasePage.goto(upcoming.path);
        await releasePage.getByText("Desbloquear", { exact: true }).click();
        await releasePage.getByLabel("Motivo del desbloqueo").fill("Intento sin autorización");
        await page.context().clearCookies();
        await login(studentTab, student);
        await expect(studentTab).toHaveURL(/\/student$/);

        await blocks.getByRole("button", { name: "Confirmar bloqueo" }).click();
        await expect(page).toHaveURL(/\/student$/);
        await releasePage.getByRole("button", { name: "Confirmar desbloqueo" }).click();
        await expect(releasePage).toHaveURL(/\/student$/);
        await expect(releasePage.getByRole("region", { name: "Bloqueos de plazas" })).toHaveCount(0);
        const { rows } = await admin.client.query("select id, is_active, release_reason from session_capacity_blocks where class_session_id = $1", [upcoming.id]);
        expect(rows).toEqual([{ id: blockId, is_active: true, release_reason: null }]);
      } finally {
        await releasePage.close();
        await studentTab.close();
      }
    });
  });
});

test("enrolls one student by keyboard on mobile, preserves a block and refreshes both panels", async ({ page, browser }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      await withCreditsAccount("STUDENT", async (other) => {
        const profileId = await seedAttendanceProfile(student, "Inés", "Ordinaria");
        const otherId = await seedAttendanceProfile(other, "Pablo", "Lista");
        const startsAt = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week").plus({ weeks: 1 }).set({ hour: 17 });
        const session = await seedAttendanceSession(admin, startsAt, []);
        await admin.client.query("update class_sessions set max_capacity = 2 where id = $1", [session.id]);
        await admin.client.query(`insert into session_capacity_blocks (id, class_session_id, blocked_spots, reason, blocked_by_user_id)
          values ($1, $2, 1, 'Material de clase', $3)`, [randomUUID(), session.id, admin.userId]);

        const studentContext = await browser.newContext();
        const stalePage = await page.context().newPage();
        try {
          const studentPage = await studentContext.newPage();
          await login(studentPage, student);
          const upcoming = studentPage.getByRole("region", { name: "Mis próximas clases" });
          await expect(upcoming.getByRole("listitem")).toHaveCount(0);

          await page.setViewportSize({ width: 360, height: 780 });
          await login(page, admin);
          const calendar = page.getByRole("region", { name: "Calendario semanal global" });
          await calendar.getByRole("link", { name: "Semana siguiente" }).click();
          const card = calendar.getByRole("listitem").filter({ has: page.locator(`a[href="${session.path}"]`) });
          await expect(card.locator("dd")).toHaveText(["2", "0", "1", "1"]);
          await card.getByRole("link", { name: "Ver inscritos" }).click();
          await expect(page.getByRole("heading", { name: "Inscritos en clase única" })).toBeVisible();

          await stalePage.goto(session.path);
          const staleForm = stalePage.getByRole("region", { name: "Inscribir a un alumno" });
          await staleForm.getByLabel("Nombre, apellido o correo del alumno").fill("Pablo");
          await staleForm.getByRole("button", { name: "Buscar alumnos" }).click();
          await staleForm.getByLabel("Alumno para esta sesión").selectOption(otherId);

          const form = page.getByRole("region", { name: "Inscribir a un alumno" });
          const query = form.getByLabel("Nombre, apellido o correo del alumno");
          const select = form.getByLabel("Alumno para esta sesión");
          const confirm = form.getByRole("button", { name: "Confirmar inscripción ordinaria" });
          await page.bringToFront();
          await query.fill("  ");
          await query.press("Enter");
          await expect(form.getByRole("alert")).toHaveText("Introduce entre 2 y 120 caracteres para buscar.");
          await query.fill("Inés");
          await query.press("Tab");
          const search = form.getByRole("button", { name: "Buscar alumnos" });
          await expect(search).toBeFocused();
          await search.press("Enter");
          await expect(select.getByRole("option", { name: "Inés Ordinaria" })).toHaveCount(1);
          await expect(confirm).toBeDisabled();
          expect(await form.evaluate((region) => region.scrollWidth <= region.clientWidth)).toBe(true);
          await select.focus();
          await select.press("ArrowDown");
          await expect(select).toHaveValue(profileId);
          await select.press("Tab");
          await expect(confirm).toBeFocused();
          await confirm.press("Enter");

          await expect(form.getByText("Inscripción ordinaria confirmada.")).toBeVisible();
          await expect(form.getByLabel("Nombre, apellido o correo del alumno")).toHaveCount(0);
          const capacity = page.getByRole("region", { name: "Aforo y disponibilidad" });
          await expect(capacity.locator("dd")).toHaveText(["2", "2", "1", "1", "0", "0"]);
          const enrolled = page.getByRole("region", { name: "Reservas confirmadas" });
          await expect(enrolled.getByRole("listitem")).toContainText("Inés Ordinaria");
          await expect(enrolled.getByText("Ordinaria", { exact: true })).toBeVisible();
          await expect(page.getByRole("region", { name: "Cancelaciones", exact: true }))
            .toContainText("No hay cancelaciones en esta sesión.");
          await expect(page.getByRole("region", { name: "Control de asistencia" })).toContainText("cuando finalice la clase");

          await staleForm.getByRole("button", { name: "Confirmar inscripción ordinaria" }).click();
          await expect(staleForm.getByRole("alert")).toHaveText("Ya no quedan plazas reservables. Se ha actualizado el aforo.");
          await expect(stalePage.getByRole("region", { name: "Aforo y disponibilidad" }).locator("dd"))
            .toHaveText(["2", "2", "1", "1", "0", "0"]);

          await page.getByRole("link", { name: "Volver al calendario" }).click();
          await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.searchParams.get("week") === session.week);
          await expect(card.locator("dd")).toHaveText(["2", "1", "1", "0"]);
          await studentPage.reload();
          await expect(upcoming.getByRole("listitem")).toContainText(startsAt.toJSDate().toISOString());
          await expect(studentPage.getByText("Disponibles: 0", { exact: true })).toBeVisible();
          const { rows } = await admin.client.query(`select student_profile_id, origin, status, created_by_user_id
            from class_reservations where class_session_id = $1`, [session.id]);
          expect(rows).toEqual([{
            student_profile_id: profileId, origin: "ORDINARY", status: "CONFIRMED", created_by_user_id: admin.userId,
          }]);
        } finally {
          await stalePage.close();
          await studentContext.close();
        }
      });
    });
  });
});

test("validates submitted student data and denies both enrollment actions on stale pages for a student", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedAttendanceProfile(student, "Lina", "Verificación");
      const session = await seedAttendanceSession(admin, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ weeks: 1 }), []);
      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(session.path);
      const form = page.getByRole("region", { name: "Inscribir a un alumno" });
      const search = form.getByLabel("Nombre, apellido o correo del alumno");
      const select = form.getByLabel("Alumno para esta sesión");
      const confirm = form.getByRole("button", { name: "Confirmar inscripción ordinaria" });
      await search.fill("Lina");
      await form.getByRole("button", { name: "Buscar alumnos" }).click();
      await select.selectOption(profileId);
      await form.locator('input[name="reservationId"]').evaluate((input: HTMLInputElement) => { input.value = "invalid"; });
      await confirm.click();
      await expect(form.getByRole("alert")).toHaveText("Selecciona un alumno válido de los resultados de la búsqueda.");
      await form.getByRole("button", { name: "Buscar alumnos" }).click();
      await select.selectOption(profileId);

      const searchPage = await page.context().newPage();
      const studentPage = await page.context().newPage();
      try {
        await searchPage.goto(session.path);
        const staleSearch = searchPage.getByRole("region", { name: "Inscribir a un alumno" });
        await staleSearch.getByLabel("Nombre, apellido o correo del alumno").fill("Lina");
        await page.context().clearCookies();
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await studentPage.goto(session.path);
        await expect(studentPage).toHaveURL(/\/student$/);
        await expect(studentPage.getByRole("region", { name: "Inscribir a un alumno" })).toHaveCount(0);
        await staleSearch.getByRole("button", { name: "Buscar alumnos" }).click();
        await expect(searchPage).toHaveURL(/\/student$/);
        await expect(staleSearch).toHaveCount(0);
        await confirm.click();
        await expect(page).toHaveURL(/\/student$/);
        const { rows } = await admin.client.query("select id from class_reservations where class_session_id = $1", [session.id]);
        expect(rows).toEqual([]);
      } finally {
        await searchPage.close();
        await studentPage.close();
      }
    });
  });
});

test("cancels a single ordinary enrollment by keyboard, preserves capacity blocks and shows both histories", async ({ page, browser }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      await withCreditsAccount("STUDENT", async (other) => {
        const ordinary = await seedAttendanceProfile(student, "Ada", "Ordinaria");
        const makeup = await seedAttendanceProfile(other, "Luz", "Recuperación");
        const startsAt = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("week").plus({ weeks: 1 }).set({ hour: 16 });
        const session = await seedAttendanceSession(admin, startsAt, [{ id: ordinary, origin: "ORDINARY" }, { id: makeup, origin: "MAKEUP" }]);
        await admin.client.query("update class_sessions set max_capacity=3 where id=$1", [session.id]);
        await admin.client.query(`insert into session_capacity_blocks (id,class_session_id,blocked_spots,reason)
          values ($1,$2,1,'Material')`, [randomUUID(), session.id]);
        const stalePage = await page.context().newPage();
        const studentContext = await browser.newContext();
        try {
          await page.setViewportSize({ width: 360, height: 780 });
          await login(page, admin);
          await expect(page).toHaveURL(/\/admin$/);
          const calendar = page.getByRole("region", { name: "Calendario semanal global" });
          await calendar.getByRole("link", { name: "Semana siguiente" }).click();
          const card = calendar.getByRole("listitem").filter({ has: page.locator(`a[href="${session.path}"]`) });
          await expect(card.locator("dd")).toHaveText(["3", "2", "1", "0"]);
          await card.getByRole("link", { name: "Ver inscritos" }).click();
          await stalePage.goto(session.path);
          const stale = stalePage.getByRole("region", { name: "Reservas confirmadas" });
          await stale.getByText("Cancelar inscripción", { exact: true }).click();
          await stale.getByLabel("Motivo de la cancelación").fill("Decisión desactualizada");

          await page.bringToFront();
          const confirmed = page.getByRole("region", { name: "Reservas confirmadas" });
          const row = confirmed.getByRole("listitem").filter({ hasText: "Ada Ordinaria" });
          const trigger = row.getByText("Cancelar inscripción", { exact: true });
          await expect(confirmed.getByRole("listitem").filter({ hasText: "Luz Recuperación" }).getByText("Cancelar inscripción")).toHaveCount(0);
          await trigger.focus();
          await trigger.press("Enter");
          const reason = row.getByLabel("Motivo de la cancelación");
          const confirm = row.getByRole("button", { name: "Confirmar cancelación" });
          await expect(reason).toBeVisible();
          await expect(row).toContainText("Cancelar la reserva ordinaria de Ada Ordinaria");
          await expect(row).toContainText("Hora de Copenhague");
          await expect(row).toContainText("El saldo de créditos y la racha del alumno se conservan");
          expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          await expect(confirmed.getByText("Total de inscritos: 2")).toBeVisible();
          await reason.fill("   ");
          await reason.press("Tab");
          await expect(confirm).toBeFocused();
          await confirm.press("Enter");
          await expect(confirmed.getByRole("alert")).toContainText("Escribe un motivo");
          await reason.fill("Decisión de coordinación");
          await reason.press("Tab");
          await confirm.press("Enter");
          await page.keyboard.press("Enter");
          await expect(confirmed.getByRole("status")).toHaveText("Inscripción cancelada.");
          await expect(confirmed.getByRole("listitem")).toHaveCount(1);
          await expect(confirmed.getByText("Luz Recuperación")).toBeVisible();
          await expect(page.getByRole("region", { name: "Aforo y disponibilidad" }).locator("dd"))
            .toHaveText(["3", "3", "1", "1", "1", "1"]);
          await expect(page.getByRole("region", { name: "Inscribir a un alumno" }).getByRole("button", { name: "Buscar alumnos" })).toBeVisible();
          const history = page.getByRole("region", { name: "Cancelaciones", exact: true });
          await expect(history.getByRole("listitem")).toHaveCount(1);
          await expect(history).toContainText("Decisión administrativa");
          await expect(history).toContainText("Motivo: Decisión de coordinación");

          await stale.getByRole("button", { name: "Confirmar cancelación" }).click();
          await expect(stale.getByRole("alert")).toHaveText("La reserva ya tiene una cancelación registrada.");
          await expect(stale.getByRole("listitem")).toHaveCount(1);
          await page.getByRole("link", { name: "Volver al calendario" }).click();
          await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.searchParams.get("week") === session.week);
          await expect(card.locator("dd")).toHaveText(["3", "1", "1", "1"]);

          const studentPage = await studentContext.newPage();
          await login(studentPage, student);
          await expect(studentPage.getByRole("region", { name: "Mis próximas clases" }).getByRole("listitem")).toHaveCount(0);
          await expect(studentPage.getByRole("region", { name: "Historial de clases" })).toContainText("Cancelación por decisión administrativa");
          await expect(studentPage.getByText("Motivo: Decisión de coordinación")).toHaveCount(0);
          const { rows } = await admin.client.query("select decision_source,administrative_reason,cancelled_by_user_id from reservation_cancellations where class_session_id=$1", [session.id]);
          expect(rows).toEqual([{ decision_source: "ADMIN_DECISION", administrative_reason: "Decisión de coordinación", cancelled_by_user_id: admin.userId }]);
        } finally {
          await stalePage.close();
          await studentContext.close();
        }
      });
    });
  });
});

test("rejects cancellation from an old admin form after authentication switches to a student", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const id = await seedAttendanceProfile(student, "Noa", "Inscrita");
      const session = await seedAttendanceSession(admin, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ weeks: 1 }), [{ id, origin: "ORDINARY" }]);
      await login(page, admin);
      await expect(page).toHaveURL(/\/admin$/);
      await page.goto(session.path);
      await page.getByText("Cancelar inscripción", { exact: true }).click();
      await page.getByLabel("Motivo de la cancelación").fill("Intento fuera del rol");
      await page.context().clearCookies();
      const studentPage = await page.context().newPage();
      try {
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await page.getByRole("button", { name: "Confirmar cancelación" }).click();
        await expect(page).toHaveURL(/\/student$/);
        const { rows } = await admin.client.query("select status from class_reservations where class_session_id=$1", [session.id]);
        expect(rows).toEqual([{ status: "CONFIRMED" }]);
      } finally {
        await studentPage.close();
      }
    });
  });
});
