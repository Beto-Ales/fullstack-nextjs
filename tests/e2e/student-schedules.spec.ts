import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { seedHabitualCreditScenario, withCreditsAccount } from "./credits-fixtures";

test("keeps the student's habitual schedule after cancellation and excludes foreign and expired assignments", async ({ page }) => {
  await withCreditsAccount("STUDENT", async (student) => {
    await withCreditsAccount("STUDENT", async (other) => {
      const scenario = await seedHabitualCreditScenario(student);
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      const classDate = DateTime.fromISO(scenario.habitualDate, { zone: CENTER_TIME_ZONE });
      const assignmentStart = today.minus({ days: 2 });
      const courseEnd = classDate.plus({ weeks: 1 });
      const ownCourse = "Curso semanal de dibujo";
      const futureCourse = "Curso futuro de acuarela";
      const endedCourse = "Curso con inscripción terminada";
      const foreignCourse = "Curso privado de otro alumno";
      await student.client.query(
        "update class_templates set name=$1, effective_from=$2, effective_to=$3 where id=$4",
        [ownCourse, today.minus({ weeks: 1 }).toISODate(), courseEnd.toISODate(), student.templateIds[0]],
      );
      // A finite enrollment uses ENDED even while its dates still apply.
      await student.client.query(
        `update student_template_assignments set effective_from=$1, effective_to=$2, status='ENDED'
         where student_profile_id=$3 and template_id=$4`,
        [assignmentStart.toISODate(), courseEnd.plus({ weeks: 1 }).toISODate(), scenario.profileId, student.templateIds[0]],
      );

      const otherProfile = randomUUID();
      await student.client.query(
        "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Other', 'Student')",
        [otherProfile, other.userId],
      );
      async function seedSchedule(name: string, profileId: string, starts: DateTime, ends?: DateTime) {
        const id = randomUUID();
        student.templateIds.push(id);
        await student.client.query(
          `insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
           values ($1, $2, 2, '16:30', 60, $3)`,
          [id, name, starts.toISODate()],
        );
        await student.client.query(
          `insert into student_template_assignments (id, student_profile_id, template_id, effective_from, effective_to, status)
           values ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), profileId, id, starts.toISODate(), ends?.toISODate() ?? null, ends ? "ENDED" : "ACTIVE"],
        );
      }
      await seedSchedule(futureCourse, scenario.profileId, today.plus({ weeks: 2 }));
      await seedSchedule(endedCourse, scenario.profileId, today.minus({ weeks: 2 }), today.minus({ days: 1 }));
      await seedSchedule(foreignCourse, otherProfile, today.minus({ days: 1 }));

      await page.goto("/login");
      await page.getByLabel("Email").fill(student.email);
      await page.getByLabel("Contraseña").fill(student.password);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await expect(page).toHaveURL(/\/student$/);
      await page.goto(`/student?week=${classDate.startOf("week").toISODate()}&studentProfileId=${otherProfile}`);

      const schedules = page.getByRole("region", { name: "Horarios habituales" });
      const ownSchedule = schedules.getByRole("listitem").filter({ hasText: ownCourse });
      const from = ownSchedule.locator(`time[datetime="${assignmentStart.toISODate()}"]`);
      const until = ownSchedule.locator(`time[datetime="${courseEnd.toISODate()}"]`);
      await expect(schedules).toContainText("Hora de Copenhague");
      await expect(ownSchedule).toContainText("Vigente");
      await expect(from.locator("[aria-hidden=true]")).toHaveText(assignmentStart.toFormat("dd/MM/yyyy"));
      await expect(until.locator("[aria-hidden=true]")).toHaveText(courseEnd.toFormat("dd/MM/yyyy"));
      const dateTree = await from.ariaSnapshot();
      expect(dateTree).toContain(assignmentStart.setLocale("es").toFormat("d 'de' MMMM 'de' yyyy"));
      expect(dateTree).not.toContain("GMT");
      await expect(ownSchedule).toContainText(`${classDate.setLocale("es").toFormat("cccc")} · 18:00–19:00`);
      await expect(schedules.getByRole("listitem").filter({ hasText: futureCourse })).toContainText("Próximo");
      await expect(schedules.getByText(endedCourse, { exact: true })).toHaveCount(0);
      await expect(schedules.getByText(foreignCourse, { exact: true })).toHaveCount(0);

      const calendar = page.getByRole("region", { name: "Calendario semanal" });
      const occurrence = calendar.getByRole("listitem").filter({ hasText: ownCourse });
      await occurrence.getByRole("button", { name: "Cancelar clase" }).click();
      await expect(page.getByRole("status")).toHaveText("Clase cancelada.");
      await expect(occurrence).toHaveCount(0);
      await expect(from).toBeVisible();
      await expect(until).toBeVisible();
      const { rows: [assignment] } = await student.client.query(
        `select effective_from::text, effective_to::text from student_template_assignments
         where student_profile_id=$1 and template_id=$2`,
        [scenario.profileId, student.templateIds[0]],
      );
      expect(assignment).toEqual({ effective_from: assignmentStart.toISODate(), effective_to: courseEnd.plus({ weeks: 1 }).toISODate() });

      await student.client.query(
        "update student_template_assignments set effective_to=$1, status='ENDED' where student_profile_id=$2",
        [today.minus({ days: 1 }).toISODate(), scenario.profileId],
      );
      await page.reload();
      await expect(schedules.getByText("No tienes horarios habituales vigentes ni próximos.")).toBeVisible();
    });
  });
});
