import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";

import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";
import { REGULATION_RULES, type RegulationChanges } from "@/src/domain/academic/regulation";
import type { UserRole } from "@/src/domain/auth/roles";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { db } from "@/src/infrastructure/db/client";
import { academicRegulations, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Actor = { userId: string; role: UserRole };
type RegulationReader = Pick<typeof db, "select">;

const publishSchema = z.object({
  effectiveFrom: z.iso.date(),
  cancellationNoticeDays: z.number().int().min(0).max(365),
  monthlyCancellationCredits: z.number().int().min(0).max(31),
  monthlyRecoveries: z.number().int().min(0).max(31),
  creditExpirationMonths: z.number().int().min(1).max(120),
  maxClassCapacity: z.number().int().min(1).max(DEFAULT_CLASS_CAPACITY),
  maxEligibleConsecutiveCancellations: z.number().int().min(0).max(2_147_483_647).optional(),
});

function requireAdmin(actor: Actor | null): asserts actor is Actor {
  if (actor?.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Acceso restringido a la administración.", "forbidden", 403, true);
  }
}

export async function resolveAcademicRegulation(reader: RegulationReader, localDate: string) {
  const [version] = await reader.select().from(academicRegulations)
    .where(lte(academicRegulations.effectiveFrom, localDate))
    .orderBy(desc(academicRegulations.effectiveFrom))
    .limit(1);
  if (!version) {
    throw new ApplicationError("Falta la normativa inicial.", "missing_academic_regulation", 500, false);
  }
  return version;
}

export function regulationDate(at: Date): string {
  return DateTime.fromJSDate(at, { zone: CENTER_TIME_ZONE }).toISODate()!;
}

export function resolveCurrentAcademicRegulation(reader: RegulationReader, at = new Date()) {
  return resolveAcademicRegulation(reader, regulationDate(at));
}

export async function getCurrentAcademicRegulation(actor: Actor | null) {
  if (actor?.role !== "STUDENT" && actor?.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Inicia sesión para consultar la normativa.", "unauthenticated", 401, true);
  }

  const version = await resolveCurrentAcademicRegulation(db);
  const { id, effectiveFrom, cancellationNoticeDays, monthlyCancellationCredits, monthlyRecoveries,
    creditExpirationMonths, maxClassCapacity, maxEligibleConsecutiveCancellations } = version;
  return { id, effectiveFrom, cancellationNoticeDays, monthlyCancellationCredits, monthlyRecoveries,
    creditExpirationMonths, maxClassCapacity, maxEligibleConsecutiveCancellations };
}

export async function getAcademicRegulationHistory(actor: Actor | null) {
  requireAdmin(actor);
  return db.select({ version: academicRegulations, publisherEmail: users.email })
    .from(academicRegulations)
    .leftJoin(users, eq(users.id, academicRegulations.publishedByUserId))
    .orderBy(desc(academicRegulations.effectiveFrom));
}

export async function publishAcademicRegulation(actor: Actor | null, input: unknown) {
  requireAdmin(actor);
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApplicationError("Revisa la fecha de vigencia y los valores de la normativa.", "invalid_regulation", 400, true);
  }

  return db.transaction(async (tx) => {
    const input = parsed.data;
    await tx.execute(sql`select pg_advisory_xact_lock(903000043)`);
    const publishedAt = new Date();
    if (input.effectiveFrom <= regulationDate(publishedAt)) {
      throw new ApplicationError("La vigencia debe empezar en una fecha futura.", "regulation_date_in_past", 400, true);
    }

    const previous = await resolveAcademicRegulation(tx, input.effectiveFrom);
    if (previous.effectiveFrom === input.effectiveFrom) {
      throw new ApplicationError("Ya hay una versión para esa fecha.", "regulation_date_conflict", 409, true);
    }
    const payload = {
      ...input,
      maxEligibleConsecutiveCancellations: input.maxEligibleConsecutiveCancellations ?? previous.maxEligibleConsecutiveCancellations,
    };
    if (payload.maxEligibleConsecutiveCancellations !== null && previous.maxEligibleConsecutiveCancellations === null) {
      const [laterLegacy] = await tx.select({ id: academicRegulations.id }).from(academicRegulations).where(and(
        gt(academicRegulations.effectiveFrom, payload.effectiveFrom),
        isNull(academicRegulations.maxEligibleConsecutiveCancellations),
      )).limit(1);
      if (laterLegacy) {
        throw new ApplicationError("Elige una fecha posterior a las versiones programadas con la regla anterior.", "regulation_sequence_date_conflict", 409, true);
      }
    }

    const changes: RegulationChanges = {};
    for (const rule of REGULATION_RULES) {
      const next = payload[rule];
      if (next !== null && previous[rule] !== next) {
        changes[rule] = { previous: previous[rule], next };
      }
    }
    if (Object.keys(changes).length === 0) {
      throw new ApplicationError("Cambia al menos un valor para publicar.", "regulation_unchanged", 400, true);
    }

    const [version] = await tx.insert(academicRegulations).values({
      ...payload,
      id: randomUUID(),
      previousVersionId: previous.id,
      publishedByUserId: actor.userId,
      publishedAt,
      changes,
    }).returning();
    return version;
  });
}
