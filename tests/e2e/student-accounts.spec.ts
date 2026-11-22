import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

async function fillStudentAccount(page: Page, email: string, password: string) {
  const form = page.getByRole("region", { name: "Dar de alta a un alumno" });
  await form.getByLabel("Nombre", { exact: true }).fill("Cuenta");
  await form.getByLabel("Apellido", { exact: true }).fill("Sintética");
  await form.getByLabel("Email del alumno").fill(email);
  await form.getByLabel("Contraseña inicial").fill(password);
  return form.getByRole("button", { name: "Crear cuenta de alumno" });
}

test.describe("student accounts", () => {

  test("creates an enrollable student and revokes all sessions after the student changes password", async ({ page, browser, baseURL }) => {
    await withCreditsAccount("SUPER_ADMIN", async (admin) => {
      const email = `e2e-account-${randomUUID()}@example.com`;
      const initialPassword = randomUUID();
      const newPassword = randomUUID();
      const studentContext = await browser.newContext({ baseURL });
      const otherContext = await browser.newContext({ baseURL });
      try {
        await login(page, admin.email, admin.password);
        await expect(page).toHaveURL(/\/admin$/);
        await (await fillStudentAccount(page, email, initialPassword)).click();
        await expect(page.getByRole("status")).toHaveText("Cuenta de alumno creada.");
        const { rows } = await admin.client.query(
          "select u.id, u.role, p.first_name, p.last_name from users u join student_profiles p on p.user_id=u.id where u.email_normalized=$1",
          [email],
        );
        expect(rows).toEqual([{ id: expect.any(String), role: "STUDENT", first_name: "Cuenta", last_name: "Sintética" }]);
        await (await fillStudentAccount(page, email.toUpperCase(), randomUUID())).click();
        const accountForm = page.getByRole("region", { name: "Dar de alta a un alumno" });
        await expect(accountForm.getByRole("alert")).toHaveText("Ya existe una cuenta con ese email.");
        const studentPage = await studentContext.newPage();
        const otherPage = await otherContext.newPage();
        await login(studentPage, email, initialPassword);
        await expect(studentPage).toHaveURL(/\/student$/);
        await login(otherPage, email, initialPassword);
        await expect(otherPage).toHaveURL(/\/student$/);

        const change = studentPage.getByRole("region", { name: "Cambiar contraseña" });
        await change.getByLabel("Contraseña actual").fill(randomUUID());
        await change.getByLabel("Contraseña nueva").fill(newPassword);
        await change.getByRole("button", { name: "Guardar contraseña nueva" }).click();
        await expect(change.getByRole("alert")).toHaveText("La contraseña actual no es correcta.");

        await change.getByLabel("Contraseña actual").fill(initialPassword);
        await change.getByLabel("Contraseña nueva").fill(newPassword);
        await change.getByRole("button", { name: "Guardar contraseña nueva" }).click();
        await expect(studentPage.getByRole("status")).toHaveText("Contraseña actualizada. Inicia sesión con la nueva contraseña.");
        const { rows: sessions } = await admin.client.query("select id from sessions where user_id=$1", [rows[0].id]);
        expect(sessions).toHaveLength(0);
        await otherPage.reload();
        await expect(otherPage).toHaveURL(/\/login$/);

        await login(studentPage, email, initialPassword);
        await expect(studentPage.locator("form").getByRole("alert")).toHaveText("Credenciales inválidas.");
        await login(studentPage, email, newPassword);
        await expect(studentPage).toHaveURL(/\/student$/);
      } finally {
        await Promise.all([studentContext.close(), otherContext.close()]);
        await admin.client.query("delete from users where email_normalized=$1", [email]);
      }
    });
  });

  test.describe("server authorization", () => {
    test.use({ javaScriptEnabled: false });

    test("rejects a student submitting the open administrative account form", async ({ page, browser, baseURL }) => {
      await withCreditsAccount("SUPER_ADMIN", async (admin) => {
        await withCreditsAccount("STUDENT", async (student) => {
          const email = `e2e-forbidden-${randomUUID()}@example.com`;
          const studentContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
          try {
            await student.client.query(
              "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Cuenta', 'Sintética')",
              [randomUUID(), student.userId],
            );
            await login(page, admin.email, admin.password);
            await expect(page).toHaveURL(/\/admin$/);
            const submit = await fillStudentAccount(page, email, randomUUID());
            const studentPage = await studentContext.newPage();
            await login(studentPage, student.email, student.password);
            await expect(studentPage).toHaveURL(/\/student$/);
            await page.context().clearCookies();
            await page.context().addCookies(await studentContext.cookies());
            await submit.click();
            await expect(page).toHaveURL(/\/student$/);
            await expect(page.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
            const { rows } = await admin.client.query("select id from users where email_normalized=$1", [email]);
            expect(rows).toHaveLength(0);
          } finally {
            await studentContext.close();
            await admin.client.query("delete from users where email_normalized=$1", [email]);
          }
        });
      });
    });
  });
});
