import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { withCreditsAccount } from "./credits-fixtures";

type Account = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function login(page: Page, account: Account) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/(admin|student)$/);
}

async function withStudentProfile(run: (account: Account, profileId: string) => Promise<void>) {
  await withCreditsAccount("STUDENT", async (account) => {
    const profileId = randomUUID();
    await account.client.query("insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Ana', 'Soler')",
      [profileId, account.userId]);
    try {
      await run(account, profileId);
    } finally {
      await account.client.query("delete from student_profile_edits where student_profile_id = $1", [profileId]);
    }
  });
}

test("edits, cancels and saves on mobile with keyboard while retaining the academic history", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires an isolated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withStudentProfile(async (student, id) => {
      const session = randomUUID();
      student.sessionIds.push(session);
      await student.client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
        values ($1, '2020-01-15', '2020-01-15 15:00Z', '2020-01-15 16:00Z', 12)`, [session]);
      await student.client.query("insert into class_reservations (id, class_session_id, student_profile_id) values ($1, $2, $3)",
        [randomUUID(), session, id]);

      await page.setViewportSize({ width: 360, height: 800 });
      await login(page, admin);
      await page.goto(`/admin/alumnos/${id}?week=2026-11-16&movimientos=2`);
      const edit = page.getByRole("link", { name: "Editar datos" });
      await edit.press("Enter");
      await expect(page.getByLabel("Correo de acceso")).toHaveValue(student.email);
      await page.getByLabel("Nombre", { exact: true }).fill("Sin guardar");
      await page.getByRole("link", { name: "Cancelar", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { name: "Ana Soler" })).toBeVisible();
      await edit.press("Enter");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await page.getByLabel("Nombre", { exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Apellidos")).toBeFocused();
      await page.getByLabel("Nombre", { exact: true }).fill(" Ana   María ");
      await page.getByLabel("Apellidos").fill("Soler Díaz");
      await page.getByLabel("Teléfono de contacto (opcional)").fill("+45 12 34 56 78");
      await page.getByLabel("Correo de acceso").fill(` ${id.toUpperCase()}@EXAMPLE.COM `);
      await page.getByRole("button", { name: "Guardar cambios" }).press("Enter");
      await expect(page.getByRole("status")).toHaveText("Cambios guardados.");
      await expect(page.getByRole("heading", { name: "Ana María Soler Díaz" })).toBeVisible();
      const history = page.getByRole("region", { name: "Historial académico" });
      await expect(history).toContainText("Clase única");
      await expect(page).toHaveURL(/movimientos=2/);
      await page.getByRole("link", { name: "Cerrar edición" }).press("Enter");
      await page.reload();
      await expect(page.getByText(`${id}@example.com`, { exact: true })).toBeVisible();
      await expect(history).toContainText("Clase única");
      expect((await student.client.query("select id from student_profile_edits where student_profile_id = $1", [id])).rowCount).toBe(1);
    });
  });
});

test("reports validation, duplicate emails and stale edits without losing a newer change", async ({ page, context }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires an isolated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withStudentProfile(async (student, id) => {
      await login(page, admin);
      const url = `/admin/alumnos/${id}?editar=1`;
      await page.goto(url);
      const email = page.getByLabel("Correo de acceso");
      const save = page.getByRole("button", { name: "Guardar cambios" });
      await email.fill("invalido");
      await save.click();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("Escribe un correo de acceso válido de hasta 255 caracteres.")).toBeVisible();
      await email.fill(admin.email.toUpperCase());
      await save.click();
      await expect(page.getByText("Este correo de acceso ya está en uso.")).toBeVisible();
      await email.fill(student.email);
      await page.locator("form").evaluate((form) => {
        const extra = document.createElement("input");
        extra.type = "hidden";
        extra.name = "role";
        extra.value = "SUPER_ADMIN";
        form.append(extra);
      });
      await save.click();
      await expect(page.getByRole("alert").filter({ hasText: "La solicitud de edición no es válida." })).toBeVisible();
      await page.locator('input[name="role"]').evaluate((input) => input.remove());

      const newer = await context.newPage();
      await newer.goto(url);
      await newer.getByLabel("Nombre", { exact: true }).fill("Primera");
      await newer.getByRole("button", { name: "Guardar cambios" }).click();
      await expect(newer.getByRole("status")).toHaveText("Cambios guardados.");
      await page.getByLabel("Nombre", { exact: true }).fill("Desactualizada");
      await save.click();
      await expect(page.getByText("Los datos cambiaron desde que abriste el formulario.")).toBeVisible();
      await expect(save).toBeDisabled();
      await page.getByRole("button", { name: "Recargar datos" }).click();
      await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Primera");
      expect((await student.client.query("select id from student_profile_edits where student_profile_id = $1", [id])).rowCount).toBe(1);
    });
  });
});

test("protects an open edit action after switching to a student session and hides editing after deactivation", async ({ page, context, browser, baseURL }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires an isolated PostgreSQL TEST database");
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withStudentProfile(async (student, id) => {
      await login(page, admin);
      const url = `/admin/alumnos/${id}?editar=1`;
      await page.goto(url);
      await page.getByLabel("Nombre", { exact: true }).fill("Intrusión");
      const studentContext = await browser.newContext({ baseURL });
      try {
        const studentPage = await studentContext.newPage();
        await login(studentPage, student);
        await studentPage.goto(url);
        await expect(studentPage).toHaveURL(/\/student$/);
        const adminCookies = await context.cookies();
        await context.addCookies(await studentContext.cookies());
        await page.getByRole("button", { name: "Guardar cambios" }).click();
        await expect(page).toHaveURL(/\/student$/);
        const { rows: [row] } = await student.client.query("select first_name from student_profiles where id = $1", [id]);
        expect(row.first_name).toBe("Ana");
        await context.addCookies(adminCookies);
      } finally {
        await studentContext.close();
      }
      await student.client.query("update users set status = 'DISABLED' where id = $1", [student.userId]);
      await page.goto(url);
      await expect(page.getByText("Desactivada", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Editar datos" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);
    });
  });
});
