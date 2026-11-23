import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

type Account = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function login(page: Page, { email, password }: Account) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/(admin|student)$/);
}

async function seedProfile({ client, userId }: Account) {
  const id = randomUUID();
  await client.query(
    "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Nora', 'Futura')",
    [id, userId],
  );
  return id;
}

async function seedAssignment(account: Account, profileId: string, input: {
  name: string;
  start: DateTime;
  status?: "ACTIVE" | "ENDED";
  effectiveTo?: string | null;
  session?: boolean;
  reservation?: boolean;
}) {
  const { client, sessionIds, templateIds } = account;
  const templateId = randomUUID();
  const assignmentId = randomUUID();
  templateIds.push(templateId);
  await client.query(`insert into class_templates
    (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from, max_capacity)
    values ($1, $2, $3, $4, 60, $5, 1)`,
  [templateId, input.name, input.start.weekday, input.start.toFormat("HH:mm"), input.start.minus({ days: 30 }).toISODate()]);
  await client.query(`insert into student_template_assignments
    (id, student_profile_id, template_id, effective_from, effective_to, status)
    values ($1, $2, $3, $4, $5, $6)`,
  [assignmentId, profileId, templateId, input.start.toISODate(), input.effectiveTo ?? null, input.status ?? "ACTIVE"]);

  let sessionId: string | null = null;
  let reservationId: string | null = null;
  if (input.session) {
    sessionId = randomUUID();
    sessionIds.push(sessionId);
    await client.query(`insert into class_sessions
      (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, $2, $3, $4, $5, 1)`,
    [sessionId, templateId, input.start.toISODate(), input.start.toJSDate(), input.start.plus({ hours: 1 }).toJSDate()]);
    if (input.reservation) {
      reservationId = randomUUID();
      await client.query(`insert into class_reservations
        (id, class_session_id, student_profile_id, origin, status)
        values ($1, $2, $3, 'ORDINARY', 'CONFIRMED')`, [reservationId, sessionId, profileId]);
    }
  }
  return { assignmentId, templateId, sessionId, reservationId };
}

function card(page: Page, name: string) {
  return page.getByRole("region", { name: "Horarios habituales" })
    .locator(":scope > ul > li").filter({ hasText: name });
}

test("SUPER_ADMIN cancels a future assignment with a reason and keeps its dates, audit and reservations", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student);
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      const futureStart = today.plus({ days: 21 }).set({ hour: 18 });
      const future = await seedAssignment(student, profileId, {
        name: "Acuarela futura", start: futureStart, session: true, reservation: true,
      });
      const todayAssignment = await seedAssignment(student, profileId, {
        name: "Acuarela de hoy", start: today.set({ hour: 19 }),
      });
      const endedAssignment = await seedAssignment(student, profileId, {
        name: "Acuarela cerrada", start: today.plus({ days: 28 }).set({ hour: 20 }),
        status: "ENDED", effectiveTo: today.plus({ days: 35 }).toISODate(),
      });
      const followUpId = randomUUID();
      student.sessionIds.push(followUpId);
      await student.client.query(`insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, $2, $3, $4, $5, 1)`,
      [followUpId, future.templateId, futureStart.plus({ days: 7 }).toISODate(),
        futureStart.plus({ days: 7 }).toJSDate(), futureStart.plus({ days: 7, hours: 1 }).toJSDate()]);

      const stale = await page.context().newPage();
      try {
        await page.setViewportSize({ width: 360, height: 800 });
        await login(page, admin);
        await page.goto(`/admin/alumnos/${profileId}`);

        const futureCard = card(page, "Acuarela futura");
        const trigger = futureCard.getByRole("button", { name: "Anular asignación futura" });
        await expect(trigger).toBeVisible();
        await expect(futureCard.locator(`time[datetime="${futureStart.toISODate()}"]`)).toHaveCount(1);
        await expect(card(page, "Acuarela de hoy").getByRole("button", { name: "Anular asignación futura" })).toHaveCount(0);
        const closedCard = card(page, "Acuarela cerrada");
        await expect(closedCard).toContainText("Asignación cerrada");
        await expect(closedCard.getByRole("button", { name: "Anular asignación futura" })).toHaveCount(0);

        await trigger.focus();
        await page.keyboard.press("Enter");
        const group = futureCard.getByRole("group", { name: "Anulación de Acuarela futura" });
        const reason = group.getByLabel("Motivo de anulación");
        await expect(reason).toBeFocused();
        await expect(group).toContainText("Nora Futura");
        await expect(group).toContainText("Acuarela futura");
        await expect(group).toContainText(
          "Las reservas futuras confirmadas vinculadas a esta asignación se cancelarán automáticamente y dejarán de ocupar plaza. Las reservas sin procedencia demostrable se conservarán y quedarán señaladas para revisión administrativa.",
        );
        await expect(group).toContainText(
          "Esta anulación no modifica el aforo de las sesiones ni crea movimientos de crédito.",
        );
        const confirm = group.getByRole("button", { name: "Confirmar anulación" });
        const back = group.getByRole("button", { name: "Cancelar y volver" });
        await page.keyboard.press("Tab");
        await expect(confirm).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(back).toBeFocused();
        await back.click();
        await expect(trigger).toBeFocused();
        await trigger.press("Enter");
        await expect(reason).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
        await page.setViewportSize({ width: 360, height: 800 });

        await reason.fill("ab");
        await confirm.click();
        await expect(reason).toHaveAttribute("aria-invalid", "true");
        await expect(reason).toBeFocused();
        await expect(group.getByText(
          "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios de los extremos.",
        )).toBeVisible();

        await reason.fill("");
        await confirm.click();
        await expect(reason).toHaveAttribute("aria-invalid", "true");
        await expect(reason).toBeFocused();
        await expect(group.getByText(
          "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios de los extremos.",
        )).toBeVisible();

        await reason.fill("Cambio de horario");
        await group.locator("form").evaluate((form, id) => {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "assignmentId";
          input.value = id;
          form.append(input);
        }, randomUUID());
        await confirm.click();
        await expect(group.getByRole("alert")).toContainText("La solicitud de anulación no es válida.");
        expect((await student.client.query(
          "select status from student_template_assignments where id=$1", [future.assignmentId],
        )).rows).toEqual([{ status: "ACTIVE" }]);
        await group.locator('input[name="assignmentId"]').evaluate((input) => input.remove());

        await stale.goto(`/admin/alumnos/${profileId}`);
        const staleGroup = card(stale, "Acuarela futura").getByRole("group", { name: "Anulación de Acuarela futura" });

        await reason.fill("El alumno cambia de horario");
        await confirm.click();
        const status = group.getByRole("status");
        await expect(status).toContainText("Asignación anulada. No generará nuevas reservas habituales.");
        await expect(status).toContainText("No había reservas futuras vinculadas que cancelar.");
        await expect(status).toContainText(
          "Una reserva existente no se pudo atribuir con certeza, no se canceló y queda para revisión administrativa.",
        );
        const counts = status.locator("dd");
        await expect(counts.nth(0)).toHaveText("0");
        await expect(counts.nth(1)).toHaveText("1");
        await expect(status).toBeFocused();
        await expect(futureCard).toContainText("Asignación anulada");
        await expect(futureCard).toContainText("Anulación administrativa individual");
        await expect(futureCard).toContainText("Motivo registrado · El alumno cambia de horario");
        await expect(futureCard).toContainText("Reservas que requieren revisión administrativa: 1");
        await expect(futureCard).toContainText(admin.email);
        await expect(futureCard.locator(`time[datetime="${futureStart.toISODate()}"]`)).toHaveCount(1);
        await expect(futureCard.getByRole("button", { name: "Anular asignación futura" })).toHaveCount(0);
        const review = futureCard.getByRole("region", { name: "Reservas para revisión administrativa" });
        await expect(review.getByRole("heading", { name: "Reservas para revisión administrativa" })).toBeVisible();
        await expect(review).toContainText(
          "Estas reservas se señalaron como posiblemente relacionadas al anular la asignación. Su procedencia habitual no está demostrada.",
        );
        await expect(futureCard).toContainText("Reservas señaladas al anular: 1");
        await expect(futureCard).toContainText("Fecha actual de la sesión");
        await expect(review).toContainText("Acuarela futura");
        await expect(review).toContainText("Reserva: Sigue confirmada");
        await expect(review).toContainText("Sesión programada");
        const sessionLink = review.getByRole("link", { name: /Abrir sesión de Acuarela futura/ });
        await expect(sessionLink).toHaveAttribute(
          "href", `/admin/sesiones/${future.sessionId}?week=${futureStart.startOf("week").toISODate()}`,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
        await page.setViewportSize({ width: 360, height: 800 });

        const { rows: [assignment] } = await student.client.query(
          "select status,effective_from::text,effective_to::text from student_template_assignments where id=$1",
          [future.assignmentId],
        );
        expect(assignment).toEqual({ status: "CANCELLED", effective_from: futureStart.toISODate(), effective_to: null });
        const { rows: audit } = await student.client.query(
          `select source,reason,effective_from::text,effective_to::text,ambiguous_reservation_ids
           from student_template_assignment_cancellations where assignment_id=$1`, [future.assignmentId],
        );
        expect(audit).toEqual([{
          source: "ADMIN_INDIVIDUAL", reason: "El alumno cambia de horario",
          effective_from: futureStart.toISODate(), effective_to: null,
          ambiguous_reservation_ids: [future.reservationId],
        }]);
        expect((await student.client.query(
          "select status from class_reservations where id=$1", [future.reservationId],
        )).rows).toEqual([{ status: "CONFIRMED" }]);
        expect((await student.client.query(
          "select max_capacity from class_sessions where id=$1", [future.sessionId],
        )).rows).toEqual([{ max_capacity: 1 }]);
        expect((await student.client.query(
          "select id from class_reservations where class_session_id=$1", [followUpId],
        )).rows).toEqual([]);
        expect((await student.client.query(
          "select status from student_template_assignments where id=$1", [todayAssignment.assignmentId],
        )).rows).toEqual([{ status: "ACTIVE" }]);
        expect((await student.client.query(
          "select status from student_template_assignments where id=$1", [endedAssignment.assignmentId],
        )).rows).toEqual([{ status: "ENDED" }]);

        await staleGroup.getByRole("button", { name: "Anular asignación futura" }).click();
        await staleGroup.getByLabel("Motivo de anulación").fill("Segunda solicitud");
        await staleGroup.getByRole("button", { name: "Confirmar anulación" }).click();
        const replay = staleGroup.getByRole("status");
        await expect(replay).toContainText("La asignación ya estaba anulada. No se registró una nueva operación.");
        await expect(replay).toContainText("No había reservas futuras vinculadas que cancelar.");
        await expect(replay).toContainText("Una reserva existente no se pudo atribuir con certeza");
        await expect(replay.locator("dd").nth(0)).toHaveText("0");
        await expect(replay.locator("dd").nth(1)).toHaveText("1");
        await expect(staleGroup.getByRole("button", { name: "Anular asignación futura" })).toHaveCount(0);
        expect((await student.client.query(
          "select id from student_template_assignment_cancellations where assignment_id=$1", [future.assignmentId],
        )).rows).toHaveLength(1);
      } finally {
        await stale.close();
      }
    });
  });
});

test("SUPER_ADMIN cancels only linked future reservations and replay keeps the audited counts", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student);
      const start = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day").plus({ days: 21 }).set({ hour: 18 });
      const future = await seedAssignment(student, profileId, {
        name: "Acuarela vinculada", start, session: true, reservation: true,
      });
      await student.client.query(
        "update class_reservations set habitual_assignment_id = $2 where id = $1",
        [future.reservationId, future.assignmentId],
      );
      await student.client.query("update class_templates set max_capacity = 3 where id = $1", [future.templateId]);
      await student.client.query("update class_sessions set max_capacity = 3 where id = $1", [future.sessionId]);

      const laterStart = start.plus({ days: 7 });
      const laterSessionId = randomUUID();
      const laterReservationId = randomUUID();
      student.sessionIds.push(laterSessionId);
      await student.client.query(`insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, $2, $3, $4, $5, 3)`,
      [laterSessionId, future.templateId, laterStart.toISODate(), laterStart.toJSDate(), laterStart.plus({ hours: 1 }).toJSDate()]);
      await student.client.query(`insert into class_reservations
        (id, class_session_id, student_profile_id, origin, status, habitual_assignment_id)
        values ($1, $2, $3, 'ORDINARY', 'CONFIRMED', $4)`,
      [laterReservationId, laterSessionId, profileId, future.assignmentId]);

      const reviewStart = start.plus({ days: 8 });
      const reviewSessionId = randomUUID();
      const reviewReservationId = randomUUID();
      student.sessionIds.push(reviewSessionId);
      await student.client.query(`insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, $2, $3, $4, $5, 3)`,
      [reviewSessionId, future.templateId, reviewStart.toISODate(), reviewStart.toJSDate(), reviewStart.plus({ hours: 1 }).toJSDate()]);
      await student.client.query(`insert into class_reservations
        (id, class_session_id, student_profile_id, origin, status)
        values ($1, $2, $3, 'ORDINARY', 'CONFIRMED')`, [reviewReservationId, reviewSessionId, profileId]);

      await login(page, admin);
      await page.goto(`/admin/alumnos/${profileId}`);
      const stale = await page.context().newPage();
      try {
        await stale.goto(`/admin/alumnos/${profileId}`);
        await page.setViewportSize({ width: 360, height: 800 });
        const futureCard = card(page, "Acuarela vinculada");
        const trigger = futureCard.getByRole("button", { name: "Anular asignación futura" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const group = futureCard.getByRole("group", { name: "Anulación de Acuarela vinculada" });
        const reason = group.getByLabel("Motivo de anulación");
        await expect(reason).toBeFocused();
        await expect(group).toContainText(
          "Las reservas futuras confirmadas vinculadas a esta asignación se cancelarán automáticamente",
        );
        await reason.fill("El alumno cambia de horario");
        await group.getByRole("button", { name: "Confirmar anulación" }).click();

        const status = group.getByRole("status");
        await expect(status).toContainText("Se cancelaron 2 reservas futuras vinculadas.");
        await expect(status).toContainText(
          "Una reserva existente no se pudo atribuir con certeza, no se canceló y queda para revisión administrativa.",
        );
        await expect(status.locator("dd").nth(0)).toHaveText("2");
        await expect(status.locator("dd").nth(1)).toHaveText("1");
        await expect(status).toBeFocused();
        await expect(futureCard).toContainText("Reservas futuras canceladas al anular: 2");
        await expect(futureCard).toContainText("Reservas señaladas al anular: 1");
        await expect(futureCard).toContainText("Reservas que requieren revisión administrativa: 1");
        const review = futureCard.getByRole("region", { name: "Reservas para revisión administrativa" });
        await expect(review.getByRole("listitem")).toHaveCount(1);
        await expect(review).toContainText("Reserva: Sigue confirmada");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

        const { rows: [assignment] } = await student.client.query(
          "select status,effective_from::text,effective_to::text from student_template_assignments where id=$1",
          [future.assignmentId],
        );
        expect(assignment).toEqual({ status: "CANCELLED", effective_from: start.toISODate(), effective_to: null });
        const { rows: reservations } = await student.client.query(
          `select id,status,cancelled_by_user_id from class_reservations
           where id = any($1::text[]) order by id`,
          [[future.reservationId, laterReservationId, reviewReservationId]],
        );
        const byId = new Map(reservations.map((row) => [row.id, row]));
        for (const id of [future.reservationId, laterReservationId]) {
          expect(byId.get(id)).toMatchObject({ status: "CANCELLED", cancelled_by_user_id: admin.userId });
        }
        expect(byId.get(reviewReservationId)).toMatchObject({ status: "CONFIRMED", cancelled_by_user_id: null });
        const { rows: audit } = await student.client.query(
          `select reason,cancelled_reservation_ids,ambiguous_reservation_ids
           from student_template_assignment_cancellations where assignment_id=$1`, [future.assignmentId],
        );
        expect(audit).toEqual([{
          reason: "El alumno cambia de horario",
          cancelled_reservation_ids: [future.reservationId, laterReservationId].sort(),
          ambiguous_reservation_ids: [reviewReservationId],
        }]);
        expect((await student.client.query(
          "select id from class_sessions where template_id=$1 and max_capacity<>3", [future.templateId],
        )).rows).toEqual([]);
        expect((await student.client.query("select id from reservation_cancellations")).rows).toEqual([]);

        const staleCard = card(stale, "Acuarela vinculada");
        await staleCard.getByRole("button", { name: "Anular asignación futura" }).click();
        await staleCard.getByLabel("Motivo de anulación").fill("Segunda solicitud");
        await staleCard.getByRole("button", { name: "Confirmar anulación" }).click();
        const replay = staleCard.getByRole("status");
        await expect(replay).toContainText("La asignación ya estaba anulada. No se registró una nueva operación.");
        await expect(replay).toContainText("La anulación registrada canceló 2 reservas futuras vinculadas.");
        await expect(replay.locator("dd").nth(0)).toHaveText("2");
        await expect(replay.locator("dd").nth(1)).toHaveText("1");
        expect((await student.client.query(
          "select id from student_template_assignment_cancellations where assignment_id=$1", [future.assignmentId],
        )).rows).toHaveLength(1);
      } finally {
        await stale.close();
      }
    });
  });
});

test("SUPER_ADMIN opens flagged reservations and sees their current status without rewriting the audit", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student);
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      const start = today.plus({ days: 21 }).set({ hour: 18 });
      const laterStart = start.plus({ days: 7 });
      const future = await seedAssignment(student, profileId, {
        name: "Acuarela enlazada", start, session: true, reservation: true,
      });
      const laterSessionId = randomUUID();
      const laterReservationId = randomUUID();
      student.sessionIds.push(laterSessionId);
      await student.client.query(`insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, $2, $3, $4, $5, 1)`,
      [laterSessionId, future.templateId, laterStart.toISODate(), laterStart.toJSDate(), laterStart.plus({ hours: 1 }).toJSDate()]);
      await student.client.query(`insert into class_reservations
        (id, class_session_id, student_profile_id, origin, status)
        values ($1, $2, $3, 'ORDINARY', 'CONFIRMED')`, [laterReservationId, laterSessionId, profileId]);

      await login(page, admin);
      await page.goto(`/admin/alumnos/${profileId}`);
      const futureCard = card(page, "Acuarela enlazada");
      await futureCard.getByRole("button", { name: "Anular asignación futura" }).click();
      await futureCard.getByLabel("Motivo de anulación").fill("Revisar cada reserva");
      await futureCard.getByRole("button", { name: "Confirmar anulación" }).click();

      const review = futureCard.getByRole("region", { name: "Reservas para revisión administrativa" });
      await expect(review.getByRole("listitem")).toHaveCount(2);
      await expect(futureCard).toContainText("Reservas señaladas al anular: 2");
      await expect(futureCard).toContainText("Reservas que requieren revisión administrativa: 2");
      const links = review.getByRole("link", { name: /Abrir sesión de Acuarela enlazada/ });
      await expect(links).toHaveCount(2);

      await links.first().focus();
      await expect(links.first()).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/admin/sesiones/${future.sessionId}\\?week=${start.startOf("week").toISODate()}$`));
      await expect(page.getByRole("heading", { name: "Inscritos en Acuarela enlazada" })).toBeVisible();
      await expect(page.locator(`time[datetime="${start.toUTC().toISO()}"]`)).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Volver al calendario" })).toHaveAttribute(
        "href", `/admin?week=${start.startOf("week").toISODate()}#calendario-semanal`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

      await page.goBack();
      await page.setViewportSize({ width: 320, height: 800 });
      await student.client.query(
        "update class_reservations set status = 'CANCELLED', cancelled_at = now() where id = $1",
        [laterReservationId],
      );
      await page.reload();
      const refreshedCard = card(page, "Acuarela enlazada");
      const refreshed = refreshedCard
        .getByRole("region", { name: "Reservas para revisión administrativa" });
      await expect(refreshedCard).toContainText("Reservas señaladas al anular: 2");
      await expect(refreshedCard).toContainText("Reservas que requieren revisión administrativa: 1");
      await expect(refreshed).toContainText("Reserva: Cancelada");
      await expect(refreshed).toContainText("Cancelación registrada");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.setViewportSize({ width: 360, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

      const { rows: [audit] } = await student.client.query(
        `select ambiguous_reservation_ids from student_template_assignment_cancellations
         where assignment_id = $1`, [future.assignmentId],
      );
      expect(audit.ambiguous_reservation_ids.sort()).toEqual([future.reservationId, laterReservationId].sort());
      expect((await student.client.query(
        "select status from class_reservations where id = $1", [future.reservationId],
      )).rows).toEqual([{ status: "CONFIRMED" }]);
    });
  });
});

test("students and anonymous visitors cannot use the administrative cancellation", async ({ page, browser, baseURL }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = await seedProfile(student);
      const start = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day").plus({ days: 14 }).set({ hour: 18 });
      const future = await seedAssignment(student, profileId, { name: "Acuarela protegida", start });
      const url = `/admin/alumnos/${profileId}`;

      await page.goto(url);
      await expect(page).toHaveURL(/\/login$/);
      await login(page, student);
      await expect(page).toHaveURL(/\/student$/);
      await page.goto(url);
      await expect(page).toHaveURL(/\/student$/);
      await expect(page.getByRole("button", { name: "Anular asignación futura" })).toHaveCount(0);
      await expect(page.getByLabel("Motivo de anulación")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Reservas para revisión administrativa" })).toHaveCount(0);
      expect((await student.client.query(
        "select status from student_template_assignments where id=$1", [future.assignmentId],
      )).rows).toEqual([{ status: "ACTIVE" }]);
      expect((await student.client.query(
        "select id from student_template_assignment_cancellations where assignment_id=$1", [future.assignmentId],
      )).rows).toEqual([]);

      const context = await browser.newContext({ baseURL });
      try {
        const adminPage = await context.newPage();
        await login(adminPage, admin);
        await adminPage.goto(url);
        await expect(card(adminPage, "Acuarela protegida")
          .getByRole("button", { name: "Anular asignación futura" })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
});
