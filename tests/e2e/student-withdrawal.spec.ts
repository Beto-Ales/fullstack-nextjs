import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, credentials: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test("the admin withdraws a student and the student loses access", async ({ page, browser, baseURL }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "PostgreSQL TEST is required.");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withCreditsAccount("STUDENT", async (student) => {
      const profileId = randomUUID();
      await student.client.query(
        "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Baja', 'Sintética')",
        [profileId, student.userId],
      );
      const studentContext = await browser.newContext({ baseURL });
      try {
        const studentPage = await studentContext.newPage();
        await login(studentPage, student);
        await expect(studentPage).toHaveURL(/\/student$/);
        await login(page, admin);
        const withdrawal = page.getByRole("region", { name: "Dar de baja a un alumno" });
        const selector = withdrawal.getByLabel("Alumno que causa baja");
        await selector.selectOption(profileId);
        await withdrawal.getByRole("button", { name: "Confirmar baja" }).click();
        await expect(withdrawal.getByRole("status")).toHaveText("Baja registrada. Reservas ordinarias liberadas: 0. Recuperaciones canceladas: 0.");
        await expect(withdrawal.getByRole("option", { name: new RegExp(student.email, "i") })).toHaveCount(0);
        await studentPage.reload();
        await expect(studentPage).toHaveURL(/\/login$/);
        await login(studentPage, student);
        await expect(studentPage.locator("form").getByRole("alert")).toHaveText("Credenciales inválidas.");
      } finally {
        await studentContext.close();
        await student.client.query("delete from student_withdrawals where student_user_id=$1", [student.userId]);
      }
    });
  });
});
