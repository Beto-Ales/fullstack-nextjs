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

test("accepts the administratively changed login email and rejects the previous email", async ({ page, browser, baseURL }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withStudentProfile(async (student, id) => {
      await login(page, admin);
      await page.goto(`/admin/alumnos/${id}?editar=1`);
      const updatedEmail = `updated-${id}@example.com`;
      await page.getByLabel("Correo de acceso").fill(updatedEmail.toUpperCase());
      await page.getByRole("button", { name: "Guardar cambios" }).click();
      await expect(page.getByRole("status")).toHaveText("Cambios guardados.");

      const studentContext = await browser.newContext({ baseURL });
      try {
        const studentPage = await studentContext.newPage();
        await studentPage.goto("/login");
        await studentPage.getByLabel("Email", { exact: true }).fill(student.email);
        await studentPage.getByLabel("Contraseña", { exact: true }).fill(student.password);
        await studentPage.getByRole("button", { name: "Iniciar sesión" }).click();
        await expect(studentPage.locator("form").getByRole("alert")).toHaveText("Credenciales inválidas.");
        await login(studentPage, { ...student, email: updatedEmail });
        await expect(studentPage).toHaveURL(/\/student$/);
        await expect(studentPage.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
      } finally {
        await studentContext.close();
      }
    });
  });
});

test("edits, cancels and saves on mobile with keyboard while retaining the academic history", async ({ page }) => {
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
      const edits = page.getByRole("region", { name: "Historial de modificaciones" });
      await expect(edits).toContainText("El alumno no tiene modificaciones registradas.");
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
      await expect(edits.getByRole("listitem")).toHaveCount(1);
      await expect(edits).toContainText(admin.email);
      await expect(edits).toContainText("Anterior · Ana");
      await expect(edits).toContainText("Nuevo · Ana María");
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
        await expect(studentPage.getByRole("heading", { name: "Historial de modificaciones" })).toHaveCount(0);
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

test("pages the audit of a disabled student by keyboard and keeps other audit records private", async ({ page }) => {
  await withCreditsAccount("SUPER_ADMIN", async (admin) => {
    await withStudentProfile(async (student, id) => {
      await withStudentProfile(async (other, otherId) => {
        const ids = Array.from({ length: 21 }, () => randomUUID()).sort().reverse();
        await student.client.query(`insert into student_profile_edits (id, student_profile_id, edited_by_user_id, edited_at, operation, changes)
          select id, $2, $3, '2026-01-15 14:30Z', 'UPDATE_STUDENT_DETAILS', $4::jsonb
          from unnest($1::text[]) as event(id)`, [ids, id, admin.userId, {
          firstName: { before: "", after: "<b>Texto literal</b>" },
          contactEmail: { after: null },
          passwordHash: { before: "private-hash-fixture", after: null },
        }]);
        await other.client.query(`insert into student_profile_edits (id, student_profile_id, edited_by_user_id, operation, changes)
          values ($1, $2, $3, 'UPDATE_STUDENT_DETAILS', '{"email":{"before":null,"after":"exclusivo-otro@example.com"}}')`,
        [randomUUID(), otherId, admin.userId]);
        await student.client.query("update users set status = 'DISABLED' where id = $1", [student.userId]);

        await page.setViewportSize({ width: 360, height: 800 });
        await login(page, admin);
        await page.goto(`/admin/alumnos/${id}?week=2026-11-16&movimientos=2&recuperaciones=3`);
        await page.getByRole("link", { name: "Ver historial de modificaciones" }).press("Enter");
        await expect(page).toHaveURL(/#modificaciones$/);
        await expect(page.getByText("Desactivada", { exact: true })).toBeVisible();
        const audit = page.getByRole("region", { name: "Historial de modificaciones" });
        const event = audit.getByRole("listitem").first();
        await expect(audit.getByRole("listitem")).toHaveCount(20);
        await expect(event).toContainText(admin.email);
        await expect(event.locator("time")).toContainText("15:30");
        await expect(event).toContainText("Actualización del perfil");
        await expect(event).toContainText("Anterior · Campo vacío");
        await expect(event).toContainText("Nuevo · <b>Texto literal</b>");
        await expect(event.locator("b")).toHaveCount(0);
        await expect(event).toContainText("Anterior · Valor histórico no disponible");
        await expect(event).toContainText("Nuevo · Sin informar");
        await expect(audit).not.toContainText("private-hash-fixture");
        await expect(audit).not.toContainText("exclusivo-otro@example.com");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

        const navigation = audit.getByRole("navigation", { name: "Paginación de historial de modificaciones" });
        await navigation.getByRole("link", { name: "Siguiente" }).press("Enter");
        await expect(audit.getByRole("listitem")).toHaveCount(1);
        await expect(navigation).toContainText("Página 2");
        const url = new URL(page.url());
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          week: "2026-11-16", movimientos: "2", recuperaciones: "3", modificaciones: "2",
        });
        await navigation.getByRole("link", { name: "Anterior" }).press("Enter");
        await expect(audit.getByRole("listitem")).toHaveCount(20);
        await expect(navigation).toContainText("Página 1");
      });
    });
  });
});
