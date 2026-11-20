import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Contraseña").fill(account.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

type Account = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function seedStudentProfile({ client, userId }: Account) {
  const id = randomUUID();
  await client.query("insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Course','Student')", [id, userId]);
  return id;
}

async function fillWeeklyCourse(page: Page, name: string, date: string) {
  const form = page.getByRole("region", { name: "Crear curso semanal" });
  await form.getByLabel("Nombre del curso").fill(name);
  await form.getByLabel("Fecha de la primera clase").fill(date);
  await form.getByLabel("Hora de inicio").fill("18:35");
  return form.getByRole("button", { name: "Guardar curso semanal" });
}

test.describe("administrative course enrollments", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");

  test("creates a fixed three-month course and enrolls a student in the course and a one-off class", async ({ page }) => {
    await withCreditsAccount("SUPER_ADMIN", async (admin) => {
      await withCreditsAccount("STUDENT", async (student) => {
        const profileId = await seedStudentProfile(student);
        const today = DateTime.now().setZone(CENTER_TIME_ZONE);
        const first = today.plus({ months: 4 }).endOf("month").startOf("day");
        const endExclusive = first.plus({ months: 3 });
        const firstDate = first.toISODate()!;
        const endDate = endExclusive.minus({ days: 1 }).toISODate()!;
        const name = `Cerámica ${randomUUID().slice(0, 8)}`;
        await login(page, admin);
        await (await fillWeeklyCourse(page, name, firstDate)).click();
        await expect(page.getByRole("region", { name: "Crear curso semanal" }).getByRole("status"))
          .toHaveText(`Curso ${name} creado. Vigencia del ${firstDate} al ${endDate}.`);
        const { rows: [template] } = await admin.client.query(
          "select id, effective_from::text, effective_to::text from class_templates where name=$1", [name],
        );
        admin.templateIds.push(template.id);
        expect(template).toMatchObject({ effective_from: firstDate, effective_to: endDate });
        const { rows: sessions } = await admin.client.query(
          "select id, local_date::text, starts_at_utc from class_sessions where template_id=$1 order by local_date", [template.id],
        );
        admin.sessionIds.push(...sessions.map(({ id }) => id));
        const dates = [];
        for (let date = first; date < endExclusive; date = date.plus({ weeks: 1 })) {
          dates.push({ local_date: date.toISODate(), starts_at_utc: date.set({ hour: 18, minute: 35 }).toJSDate() });
        }
        expect(sessions.map(({ local_date, starts_at_utc }) => ({ local_date, starts_at_utc }))).toEqual(dates);

        const enrollment = page.getByRole("region", { name: "Inscribir alumno" });
        await enrollment.getByLabel("Alumno", { exact: true }).selectOption(profileId);
        await enrollment.getByLabel("Curso o clase única").selectOption(`weekly:${template.id}`);
        await enrollment.getByRole("button", { name: "Confirmar inscripción" }).click();
        await expect(enrollment.getByRole("status")).toHaveText(`Alumno inscrito. Sesiones reservadas: ${dates.length}.`);
        const { rows: assignments } = await admin.client.query(
          "select effective_from::text from student_template_assignments where template_id=$1 and student_profile_id=$2",
          [template.id, profileId],
        );
        expect(assignments).toEqual([{ effective_from: firstDate }]);

        const oneOff = page.getByRole("region", { name: "Crear clase única" });
        await oneOff.getByLabel("Fecha de la clase").fill(today.plus({ days: 11 }).toISODate()!);
        await oneOff.getByLabel("Hora de inicio").fill("19:15");
        await oneOff.getByRole("button", { name: "Guardar clase única" }).click();
        await expect(oneOff.getByRole("status")).toContainText("Clase única creada");
        const id = new URL(page.url()).searchParams.get("createdClassSession")!;
        admin.sessionIds.push(id);
        await enrollment.getByLabel("Alumno", { exact: true }).selectOption(profileId);
        await enrollment.getByLabel("Curso o clase única").selectOption(`one-off:${id}`);
        await enrollment.getByRole("button", { name: "Confirmar inscripción" }).click();
        await expect(enrollment.getByRole("status")).toHaveText("Alumno inscrito. Sesiones reservadas: 1.");
        const { rows: bookings } = await admin.client.query(
          "select origin, status from class_reservations where class_session_id=$1 and student_profile_id=$2",
          [id, profileId],
        );
        expect(bookings).toEqual([{ origin: "ORDINARY", status: "CONFIRMED" }]);
      });
    });
  });

  test.describe("server authorization", () => {
    test.use({ javaScriptEnabled: false });

    test("rejects both administrative forms when the session becomes a student session", async ({ page, browser, baseURL }) => {
      await withCreditsAccount("SUPER_ADMIN", async (admin) => {
        await withCreditsAccount("STUDENT", async (student) => {
          const profileId = await seedStudentProfile(student);
          const date = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 10 });
          const sessionId = randomUUID();
          admin.sessionIds.push(sessionId);
          await admin.client.query(
            "insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity) values ($1,$2,$3,$4,12)",
            [sessionId, date.toISODate(), date.toJSDate(), date.plus({ hours: 1 }).toJSDate()],
          );
          await login(page, admin);
          const enrollmentPage = await page.context().newPage();
          await enrollmentPage.goto("/admin");
          const name = `Blocked ${randomUUID()}`;
          const submitCourse = await fillWeeklyCourse(page, name, date.toISODate()!);
          const enrollment = enrollmentPage.getByRole("region", { name: "Inscribir alumno" });
          await enrollment.getByLabel("Alumno", { exact: true }).selectOption(profileId);
          await enrollment.getByLabel("Curso o clase única").selectOption(`one-off:${sessionId}`);
          const studentContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
          try {
            const studentPage = await studentContext.newPage();
            await login(studentPage, student);
            await studentPage.waitForURL("**/student");
            await page.context().clearCookies();
            await page.context().addCookies(await studentContext.cookies());
            await submitCourse.click();
            await expect(page).toHaveURL(/\/student$/);
            await enrollment.getByRole("button", { name: "Confirmar inscripción" }).click();
            await expect(enrollmentPage).toHaveURL(/\/student$/);
            const { rows: templates } = await admin.client.query("select id from class_templates where name=$1", [name]);
            admin.templateIds.push(...templates.map(({ id }) => id));
            expect(templates).toHaveLength(0);
            const { rows: bookings } = await admin.client.query("select id from class_reservations where class_session_id=$1", [sessionId]);
            expect(bookings).toHaveLength(0);
          } finally {
            await studentContext.close();
          }
        });
      });
    });
  });
});
