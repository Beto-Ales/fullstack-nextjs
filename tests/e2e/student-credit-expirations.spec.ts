import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { seedHabitualCreditScenario, withCreditsAccount } from "./credits-fixtures";

test("shows only available credit expirations and updates them on recovery and refund", async ({ page }) => {
  await withCreditsAccount("STUDENT", async (student) => {
    await withCreditsAccount("STUDENT", async (other) => {
      const scenario = await seedHabitualCreditScenario(student);
      const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
      const soon = today.plus({ days: 3 }).set({ hour: 0, minute: 15 });
      const later = today.plus({ days: 12 }).set({ hour: 0, minute: 15 });
      const expired = today.minus({ days: 2 });
      const foreignProfile = randomUUID();
      await student.client.query(
        "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Other', 'Student')",
        [foreignProfile, other.userId],
      );

      async function seedGrant(profileId: string, amount: number, expiresAt: DateTime | null) {
        const id = randomUUID();
        await student.client.query(
          `insert into credit_ledger_movements
            (id, student_profile_id, movement_type, amount, created_at, expires_at, source_grant_movement_id, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $1, $1)`,
          [id, profileId, expiresAt ? "AUTO_CANCELLATION_GRANT" : "MANUAL_GRANT", amount,
            today.minus({ months: 2 }).toJSDate(), expiresAt?.toJSDate() ?? null],
        );
        return id;
      }

      async function withdrawUnit(grantId: string) {
        await student.client.query(
          `insert into credit_ledger_movements
            (id, student_profile_id, movement_type, amount, source_grant_movement_id, idempotency_key)
           values ($1, $2, 'MANUAL_WITHDRAWAL', 1, $3, $1)`,
          [randomUUID(), scenario.profileId, grantId],
        );
      }

      await seedGrant(foreignProfile, 9, today.plus({ days: 1 }));
      await page.goto("/login");
      await page.getByLabel("Email").fill(student.email);
      await page.getByLabel("Contraseña").fill(student.password);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await expect(page).toHaveURL(/\/student$/);
      await page.goto(`/student?studentProfileId=${foreignProfile}`);
      const expirations = page.getByRole("region", { name: "Vencimientos de créditos" });
      await expect(expirations.getByText("No tienes créditos disponibles.")).toBeVisible();
      await expect(page.getByText("Disponibles: 0", { exact: true })).toBeVisible();

      const earliestGrant = await seedGrant(scenario.profileId, 1, soon);
      await withdrawUnit(await seedGrant(scenario.profileId, 2, later));
      await seedGrant(scenario.profileId, 1, later);
      await seedGrant(scenario.profileId, 1, null);
      await withdrawUnit(await seedGrant(scenario.profileId, 1, today.plus({ days: 1 })));
      await seedGrant(scenario.profileId, 1, expired);

      const expiredSession = randomUUID();
      const expiredReservation = randomUUID();
      const expiredRecoveryDate = DateTime.fromISO(scenario.recoveryDate, { zone: CENTER_TIME_ZONE }).plus({ days: 2 }).set({ hour: 18 });
      student.sessionIds.push(expiredSession);
      await student.client.query(
        `insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity, regulation_version_id)
         values ($1, $2, $3, $4, 1, $5)`,
        [expiredSession, expiredRecoveryDate.toISODate(), expiredRecoveryDate.toJSDate(),
          expiredRecoveryDate.plus({ hours: 1 }).toJSDate(), scenario.regulationVersionId],
      );
      const expiredGrant = await seedGrant(scenario.profileId, 1, expired);
      await student.client.query(
        `insert into class_reservations (id, class_session_id, student_profile_id, origin)
         values ($1, $2, $3, 'MAKEUP')`,
        [expiredReservation, expiredSession, scenario.profileId],
      );
      await student.client.query(
        `insert into credit_ledger_movements
          (id, student_profile_id, movement_type, amount, created_at, expires_at, class_session_id, related_reservation_id,
           source_grant_movement_id, idempotency_key)
         values ($1, $2, 'RECOVERY_CONSUMPTION', 1, $3, $4, $5, $6, $7, $1)`,
        [randomUUID(), scenario.profileId, expired.minus({ days: 1 }).toJSDate(), expired.toJSDate(),
          expiredSession, expiredReservation, expiredGrant],
      );

      const readLedger = async () => (await student.client.query(
        "select * from credit_ledger_movements where student_profile_id = $1 order by id", [scenario.profileId],
      )).rows;
      const originalLedger = await readLedger();
      await page.reload();
      const items = expirations.getByRole("listitem");
      const expirationInstants = () => expirations.locator("time")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
      const initialDates = [soon.toJSDate().toISOString(), later.toJSDate().toISOString()];
      await expect(items).toHaveCount(3);
      expect(await expirationInstants()).toEqual(initialDates);
      await expect(items.nth(0)).toContainText(`1 crédito · ${soon.toFormat("dd/MM/yyyy")}`);
      await expect(items.nth(0)).toContainText("00:15");
      await expect(items.nth(1)).toContainText("2 créditos");
      await expect(items.nth(2)).toHaveText("1 crédito · Sin vencimiento");
      await expect(page.getByText("Disponibles: 4", { exact: true })).toBeVisible();
      await expect(page.getByText("Caducados: 1", { exact: true })).toBeVisible();
      expect(await readLedger()).toEqual(originalLedger);
      await withCreditsAccount("SUPER_ADMIN", async (admin) => {
        const adminPage = await page.context().browser()!.newPage();
        try {
          await adminPage.goto(new URL("/login", page.url()).href);
          await adminPage.getByLabel("Email").fill(admin.email);
          await adminPage.getByLabel("Contraseña").fill(admin.password);
          await adminPage.getByRole("button", { name: "Iniciar sesión" }).click();
          await expect(adminPage).toHaveURL(/\/admin$/);
          await adminPage.goto(new URL(`/admin?studentProfileId=${scenario.profileId}`, page.url()).href);
          await expect(adminPage.getByText("Caducados: 1", { exact: true })).toBeVisible();
          expect(await readLedger()).toEqual(originalLedger);
        } finally {
          await adminPage.close();
        }
      });

      const options = page.getByRole("region", { name: "Clases futuras disponibles" });
      await options.getByRole("listitem").filter({ hasText: scenario.recoveryDate })
        .getByRole("button", { name: "Reservar recuperación (consume 1 crédito)" }).click();
      await expect(page.getByRole("status")).toHaveText("Recuperación reservada.");
      await expect(items).toHaveCount(2);
      expect(await expirationInstants()).toEqual(initialDates.slice(1));
      await expect(items.nth(0)).toContainText("2 créditos");
      await expect(items.nth(1)).toHaveText("1 crédito · Sin vencimiento");
      await expect(page.getByText("Disponibles: 3", { exact: true })).toBeVisible();

      const recoveries = page.getByRole("region", { name: "Mis recuperaciones" });
      const newRecovery = recoveries.getByRole("listitem").filter({ hasText: scenario.recoveryDate });
      await newRecovery.getByRole("button", { name: "Cancelar recuperación" }).click();
      await expect(newRecovery).toHaveCount(0);
      await expect(items).toHaveCount(3);
      expect(await expirationInstants()).toEqual(initialDates);
      await expect(items.nth(0)).toContainText("1 crédito");
      await expect(items.nth(1)).toContainText("2 créditos");
      await expect(page.getByText("Disponibles: 4", { exact: true })).toBeVisible();

      const expiredRecovery = recoveries.getByRole("listitem").filter({ hasText: expiredRecoveryDate.toISODate()! });
      await expiredRecovery.getByRole("button", { name: "Cancelar recuperación" }).click();
      await expect(expiredRecovery).toHaveCount(0);
      await expect(items).toHaveCount(3);
      expect(await expirationInstants()).toEqual(initialDates);
      await expect(page.getByText("Disponibles: 4", { exact: true })).toBeVisible();
      const { rows: refunds } = await student.client.query(
        `select source_grant_movement_id, refund_restored_credit from credit_ledger_movements
         where student_profile_id=$1 and movement_type='RECOVERY_REFUND'`, [scenario.profileId],
      );
      expect(refunds).toHaveLength(2);
      expect(refunds).toContainEqual({ source_grant_movement_id: earliestGrant, refund_restored_credit: true });
      expect(refunds).toContainEqual({ source_grant_movement_id: expiredGrant, refund_restored_credit: false });
    });
  });
});
