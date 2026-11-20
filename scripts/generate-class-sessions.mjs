import nextEnv from "@next/env";
import { DateTime } from "luxon";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const CENTER_TIME_ZONE = "Europe/Copenhagen";
const HORIZON_MONTHS = 3;
const ADVISORY_LOCK_KEY = 903_000_001;

function parseLocalTime(localTime) {
  const [hour, minute, second] = localTime.split(":").map((part) => Number(part));
  return {
    hour,
    minute,
    second: Number.isFinite(second) ? second : 0,
  };
}

function resolveLocalDateTime(localDate, localTime) {
  const { hour, minute, second } = parseLocalTime(localTime);
  const baseDate = DateTime.fromISO(localDate, { zone: CENTER_TIME_ZONE });
  let localDateTime = baseDate.set({ hour, minute, second, millisecond: 0 });

  if (!localDateTime.isValid) {
    for (let step = 1; step <= 120; step += 1) {
      const candidate = baseDate
        .plus({ minutes: hour * 60 + minute + step })
        .set({ second, millisecond: 0 });
      if (candidate.isValid) {
        localDateTime = candidate;
        break;
      }
    }
  }

  if (!localDateTime.isValid) {
    throw new Error("Unable to resolve local datetime.");
  }

  return localDateTime;
}

function buildCandidates(template, now, horizonEnd) {
  const templateStart = DateTime.fromISO(template.effective_from, { zone: CENTER_TIME_ZONE }).startOf("day");
  const templateEnd = template.effective_to
    ? DateTime.fromISO(template.effective_to, { zone: CENTER_TIME_ZONE }).endOf("day")
    : horizonEnd;

  const rangeStart = now.startOf("day") > templateStart ? now.startOf("day") : templateStart;
  const rangeEnd = horizonEnd < templateEnd ? horizonEnd : templateEnd;

  const candidates = [];
  for (
    let dayCursor = rangeStart.startOf("day");
    dayCursor <= rangeEnd.startOf("day");
    dayCursor = dayCursor.plus({ days: 1 })
  ) {
    if (dayCursor.weekday !== template.iso_weekday) {
      continue;
    }
    const localDate = dayCursor.toISODate();
    const start = resolveLocalDateTime(localDate, template.starts_at_local_time);
    const end = start.plus({ minutes: template.duration_minutes });

    candidates.push({
      templateId: template.id,
      localDate,
      startsAtUtc: start.toUTC().toISO(),
      endsAtUtc: end.toUTC().toISO(),
      maxCapacity: template.max_capacity,
    });
  }

  return candidates;
}

async function main() {
  const { loadEnvConfig } = nextEnv;
  loadEnvConfig(process.cwd());

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const horizonEnd = now.plus({ months: HORIZON_MONTHS }).endOf("day");

  try {
    await client.query("begin");
    await client.query("set transaction isolation level read committed");
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);

    const { rows: [regulation] } = await client.query(
      "select id, max_class_capacity from academic_regulations where effective_from <= $1 order by effective_from desc limit 1",
      [now.toISODate()],
    );
    if (!regulation) {
      throw new Error("Missing initial academic regulation.");
    }

    const { rows: templates } = await client.query(`
      select id, iso_weekday, starts_at_local_time, duration_minutes, effective_from, effective_to, max_capacity
      from class_templates
      where status = 'ACTIVE'
    `);

    let inserted = 0;
    let skipped = 0;

    for (const template of templates) {
      const candidates = buildCandidates(template, now, horizonEnd);
      for (const candidate of candidates) {
        const result = await client.query(
          `
            insert into class_sessions (
              id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity,
              is_manually_edited, regulation_version_id, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, 'SCHEDULED', $6, false, $7, now(), now())
            on conflict do nothing
          `,
          [
            randomUUID(), candidate.templateId, candidate.localDate, candidate.startsAtUtc, candidate.endsAtUtc,
            Math.min(candidate.maxCapacity, regulation.max_class_capacity), regulation.id,
          ],
        );
        if (result.rowCount > 0) {
          inserted += 1;
        } else {
          skipped += 1;
        }
      }
    }

    await client.query("commit");
    console.log(`Class sessions generation complete. Inserted=${inserted}, skipped=${skipped}, horizonEnd=${horizonEnd.toISO()}`);
  } catch (error) {
    await client.query("rollback");
    console.error("Failed to generate class sessions.");
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Unexpected failure while generating class sessions.");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
