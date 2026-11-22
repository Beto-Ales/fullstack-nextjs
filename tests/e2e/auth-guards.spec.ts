import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { withCreditsAccount } from "./credits-fixtures";

const invalidCredentials = "Credenciales inválidas.";
const rateLimited = "Demasiados intentos. Inténtalo más tarde.";

async function submitLogin(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

type LoginStudent = Parameters<Parameters<typeof withCreditsAccount>[1]>[0];

async function withLoginStudent(run: (student: LoginStudent) => Promise<void>) {
  await withCreditsAccount("STUDENT", async (student) => {
    await student.client.query(`insert into student_profiles (id,user_id,first_name,last_name)
      values ($1,$2,'Alumno','Sintético')`, [randomUUID(), student.userId]);
    await run(student);
  });
}

test("shows login form and no public registration", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  await expect(page.getByText("Registro", { exact: false })).toHaveCount(0);
});

test("redirects anonymous users from protected routes to login", async ({ page }) => {
  await page.goto("/student");
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

test("wrong passwords, unknown emails and disabled accounts show the same login error", async ({ page }) => {
  await withCreditsAccount("STUDENT", async (active) => {
    await withCreditsAccount("STUDENT", async (disabled) => {
      await disabled.client.query("update users set status='DISABLED' where id=$1", [disabled.userId]);
      for (const attempt of [
        { email: active.email, password: randomUUID() },
        { email: `unknown-${randomUUID()}@example.com`, password: active.password },
        disabled,
      ]) {
        await submitLogin(page, attempt.email, attempt.password);
        await expect(page.locator("form").getByRole("alert")).toHaveText(invalidCredentials);
        await expect(page).toHaveURL(/\/login$/);
      }
    });
  });
});

test("limits normalized identities despite changed headers and admits login after expiration", async ({ page }) => {
  await withLoginStudent(async (student) => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      await page.setExtraHTTPHeaders({
        "x-forwarded-for": `192.0.2.${attempt}, 203.0.113.1`,
        "x-real-ip": `198.51.100.${attempt}`,
        "forwarded": `for=192.0.2.${attempt}`,
        "user-agent": `synthetic-browser-${attempt}`,
      });
      const email = attempt % 2 === 0 ? student.email.toUpperCase() : student.email;
      await submitLogin(page, email, attempt === 6 ? student.password : randomUUID());
      await expect(page.locator("form").getByRole("alert")).toHaveText(attempt === 6 ? rateLimited : invalidCredentials);
    }

    const key = createHmac("sha256", Buffer.from(process.env.AUTH_RATE_LIMIT_HMAC_KEY!, "hex"))
      .update(`login:${student.email}`).digest("hex");
    const shortened = await student.client.query(`update login_attempt_budgets
      set expires_at=clock_timestamp()+interval '250 milliseconds' where key=$1 and attempts=5`, [key]);
    expect(shortened.rowCount).toBe(1);
    await expect.poll(async () => {
      const { rows: [row] } = await student.client.query<{ expired: boolean }>(
        "select expires_at <= clock_timestamp() as expired from login_attempt_budgets where key=$1", [key],
      );
      return row.expired;
    }).toBe(true);

    await submitLogin(page, student.email, student.password);
    await expect(page).toHaveURL(/\/student$/);
    await expect(page.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
  });
});

test("supports keyboard login and logout at 360 px and revokes the logged-out session", async ({ page, context, browser, baseURL }) => {
  await withLoginStudent(async (student) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/login");
    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Contraseña", { exact: true });
    const submit = page.getByRole("button", { name: "Iniciar sesión" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await email.focus();
    await page.keyboard.insertText(student.email);
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await page.keyboard.insertText(student.password);
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/student$/);

    const previousSession = await browser.newContext({ baseURL });
    try {
      await previousSession.addCookies(await context.cookies());
      await page.getByRole("button", { name: "Cerrar sesión" }).press("Enter");
      await expect(page).toHaveURL(/\/login$/);
      const revokedPage = await previousSession.newPage();
      await revokedPage.goto("/student");
      await expect(revokedPage).toHaveURL(/\/login/);
    } finally {
      await previousSession.close();
    }
  });
});

