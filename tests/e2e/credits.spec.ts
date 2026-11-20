import { expect, test, type Page } from "@playwright/test";
import { seedHabitualCreditScenario, withCreditsAccount } from "./credits-fixtures";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test.describe("credits flows", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires a migrated PostgreSQL TEST database");

  test("student cancels a habitual class, earns one credit and spends it on a recovery", async ({ page }) => {
    await withCreditsAccount("STUDENT", async (fixture) => {
      const scenario = await seedHabitualCreditScenario(fixture);
      const { client, userId } = fixture;
      await login(page, fixture.email, fixture.password);
      await expect(page).toHaveURL(/\/student$/, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Área de alumno" })).toBeVisible();
      await expect(page.getByText("Disponibles: 0", { exact: true })).toBeVisible();

      const classes = page.getByRole("region", { name: "Mis próximas clases" });
      const habitualClass = classes.getByRole("listitem").filter({ hasText: scenario.habitualDate });
      const options = page.getByRole("region", { name: "Clases futuras disponibles" });
      const releasedClass = options.getByRole("listitem").filter({ hasText: scenario.habitualDate });
      await expect(releasedClass).toHaveCount(0);
      await habitualClass.getByRole("button", { name: "Cancelar clase" }).click();
      await expect(page.getByRole("status")).toHaveText("Clase cancelada.");
      await expect(habitualClass).toHaveCount(0);
      await expect(releasedClass).toContainText("plazas: 1");
      await expect(page.getByText("Disponibles: 1", { exact: true })).toBeVisible();
      const { rows: [cancellation] } = await client.query(
        `select r.status, r.cancelled_by_user_id, c.cancellation_type, c.sequence_position
         from class_reservations r join reservation_cancellations c on c.reservation_id = r.id where r.id = $1`,
        [scenario.habitualReservationId],
      );
      expect(cancellation).toEqual({
        status: "CANCELLED", cancelled_by_user_id: userId, cancellation_type: "ON_TIME", sequence_position: 3,
      });

      const recoveryOption = options.getByRole("listitem").filter({ hasText: scenario.recoveryDate });
      await expect(recoveryOption).toContainText("plazas: 1");
      await recoveryOption.getByRole("button", { name: "Reservar recuperación (consume 1 crédito)" }).click();
      await expect(page.getByRole("status")).toHaveText("Recuperación reservada.");
      await page.goto("/student");

      const recoveries = page.getByRole("region", { name: "Mis recuperaciones" });
      await expect(recoveries.getByRole("listitem").filter({ hasText: scenario.recoveryDate })).toContainText("estado: CONFIRMED");
      await expect(page.getByText("Disponibles: 0", { exact: true })).toBeVisible();
      await expect(page.getByText(/AUTO_CANCELLATION_GRANT/)).toHaveCount(1);
      await expect(page.getByText(/RECOVERY_CONSUMPTION/)).toHaveCount(1);
      const { rows: ledger } = await client.query(
        `select m.movement_type, m.amount, m.id, m.source_grant_movement_id, r.status
         from credit_ledger_movements m left join class_reservations r on r.id = m.related_reservation_id
         where m.student_profile_id = $1 order by m.created_at, m.movement_type`,
        [scenario.profileId],
      );
      const grant = ledger.find((movement) => movement.movement_type === "AUTO_CANCELLATION_GRANT");
      expect(ledger).toHaveLength(2);
      expect(grant).toMatchObject({ amount: 1 });
      expect(ledger).toContainEqual(expect.objectContaining({
        movement_type: "RECOVERY_CONSUMPTION", amount: 1, source_grant_movement_id: grant.id, status: "CONFIRMED",
      }));
    });
  });

  test("student sees confirmation and a single refund after cancelling a recovery on time", async ({ page }) => {
    await withCreditsAccount("STUDENT", async (fixture) => {
      const { habitualDate, recoveryDate, recoverySessionId, profileId, regulationVersionId } = await seedHabitualCreditScenario(fixture);
      await login(page, fixture.email, fixture.password);
      const upcoming = page.getByRole("region", { name: "Mis próximas clases" });
      await upcoming.getByRole("listitem").filter({ hasText: habitualDate })
        .getByRole("button", { name: "Cancelar clase" }).click();
      await expect(page.getByText("Disponibles: 1", { exact: true })).toBeVisible();
      const options = page.getByRole("region", { name: "Clases futuras disponibles" });
      await options.getByRole("listitem").filter({ hasText: recoveryDate })
        .getByRole("button", { name: "Reservar recuperación (consume 1 crédito)" }).click();
      await expect(page.getByRole("status")).toHaveText("Recuperación reservada.");

      const recovery = page.getByRole("region", { name: "Mis recuperaciones" })
        .getByRole("listitem").filter({ hasText: recoveryDate });
      await recovery.getByRole("button", { name: "Cancelar recuperación" }).click();
      await expect(page).toHaveURL(/\/student\?recovery=cancelled$/);
      await expect(page.getByRole("status")).toHaveText("Recuperación cancelada.");
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      await expect(recovery).toContainText("estado: CANCELLED");
      await expect(page.getByText("Disponibles: 1", { exact: true })).toBeVisible();
      await expect(options.getByRole("listitem").filter({ hasText: recoveryDate })).toContainText("plazas: 1");

      const { rows: records } = await fixture.client.query(
        `select r.status, r.cancelled_by_user_id, r.cancellation_regulation_version_id,
                consumption.id as consumption_id, consumption.source_grant_movement_id,
                refund.amount, refund.refund_restored_credit, refund.source_movement_id,
                refund.source_grant_movement_id as refunded_grant_id, refund.regulation_version_id
         from class_reservations r
         join credit_ledger_movements consumption on consumption.related_reservation_id = r.id
           and consumption.movement_type = 'RECOVERY_CONSUMPTION'
         join credit_ledger_movements refund on refund.related_reservation_id = r.id
           and refund.movement_type = 'RECOVERY_REFUND'
         where r.class_session_id = $1 and r.student_profile_id = $2 and r.origin = 'MAKEUP'`,
        [recoverySessionId, profileId],
      );
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record).toMatchObject({
        status: "CANCELLED", cancelled_by_user_id: fixture.userId, cancellation_regulation_version_id: regulationVersionId,
        amount: 1, refund_restored_credit: true, source_movement_id: record.consumption_id,
        refunded_grant_id: record.source_grant_movement_id, regulation_version_id: regulationVersionId,
      });
      await page.reload();
      await expect(page.getByText(/RECOVERY_REFUND/)).toHaveCount(1);
      await expect(page.getByText("Disponibles: 1", { exact: true })).toBeVisible();
    });
  });

  test("admin can access credit management section", async ({ page }) => {
    await withCreditsAccount("SUPER_ADMIN", async ({ email, password }) => {
      await login(page, email, password);
      await expect(page.getByRole("heading", { name: "Área de administración" })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Créditos" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Consultar créditos" })).toBeVisible();
    });
  });
});
