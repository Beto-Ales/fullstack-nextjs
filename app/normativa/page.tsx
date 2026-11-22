import Link from "next/link";
import { redirect } from "next/navigation";

import {
  getAcademicRegulationHistory,
  getCurrentAcademicRegulation,
  publishAcademicRegulation,
} from "@/src/application/academic/regulation-service";
import { INITIAL_CONSECUTIVE_CANCELLATIONS_LIMIT, REGULATION_RULES, type RegulationRule, type RegulationRules } from "@/src/domain/academic/regulation";
import { getRoleHomePath } from "@/src/domain/auth/roles";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { requireRole, requireUser } from "@/src/interfaces/auth/session";

const fieldLabels: Record<RegulationRule, string> = {
  cancellationNoticeDays: "Antelación para cancelar (días naturales)",
  monthlyCancellationCredits: "Créditos automáticos por cancelación al mes",
  monthlyRecoveries: "Recuperaciones por mes de celebración",
  creditExpirationMonths: "Caducidad de créditos automáticos (meses)",
  maxClassCapacity: "Aforo máximo (incluye plazas bloqueadas)",
  maxEligibleConsecutiveCancellations: "Máximo de cancelaciones consecutivas elegibles",
};

const publicationTime = new Intl.DateTimeFormat("es", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: CENTER_TIME_ZONE,
});

function RegulationValues({ rules }: { rules: RegulationRules }) {
  return (
    <dl>
      {REGULATION_RULES.map((field) => (
        <div key={field}>
          <dt>{fieldLabels[field]}</dt>
          <dd>{rules[field] ?? "Regla anterior"}</dd>
        </div>
      ))}
    </dl>
  );
}

async function publishFormAction(formData: FormData) {
  "use server";

  const actor = await requireRole("SUPER_ADMIN");
  const values = Object.fromEntries(REGULATION_RULES.map((field) => {
    const value = formData.get(field);
    return [field, typeof value === "string" && value.trim() !== "" ? Number(value) : undefined];
  }));

  try {
    await publishAcademicRegulation(actor, { effectiveFrom: formData.get("effectiveFrom"), ...values });
  } catch (error) {
    redirect(`/normativa?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
  redirect("/normativa?publicada=1");
}

export default async function AcademicRegulationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; publicada?: string }>;
}) {
  const actor = await requireUser();
  const current = await getCurrentAcademicRegulation(actor);
  const isAdmin = actor.role === "SUPER_ADMIN";
  const history = isAdmin ? await getAcademicRegulationHistory(actor) : [];
  const feedback = isAdmin ? await searchParams : {};

  return (
    <main>
      <Link href={getRoleHomePath(actor.role)}>Volver a mi área</Link>
      <h1>Normativa de clases y recuperaciones</h1>
      <h2>Versión vigente</h2>
      <p>{current.id === "initial" ? "Versión inicial" : `En vigor desde ${current.effectiveFrom}`}</p>
      <RegulationValues rules={current} />
      {current.maxEligibleConsecutiveCancellations === null ? (
        <p>La tercera cancelación habitual consecutiva puede generar crédito si se hace a tiempo.
          Las tardías liberan la plaza y cuentan en la racha. La asistencia efectiva reinicia la racha.</p>
      ) : (
        <p>Las primeras cancelaciones de una racha habitual pueden generar crédito hasta el máximo indicado,
          si cumplen la antelación y el cupo mensual. Las tardías liberan la plaza y cuentan en la racha.
          La asistencia o la ausencia registrada reinicia la racha. Si falta un resultado anterior necesario,
          la plaza se libera y la evaluación espera ese resultado.</p>
      )}
      <p>
        Cancelar una recuperación a tiempo devuelve el crédito si sigue vigente.
        Los plazos y los meses naturales se calculan en la zona horaria de Copenhague.
      </p>

      {isAdmin && (
        <>
          <h2>Publicar una versión</h2>
          {typeof feedback.error === "string" && <p role="alert">{feedback.error}</p>}
          {feedback.publicada === "1" && <p role="status">Versión publicada.</p>}
          <form action={publishFormAction}>
            <div>
              <label htmlFor="effectiveFrom">Fecha futura de entrada en vigor</label>{" "}
              <input id="effectiveFrom" name="effectiveFrom" type="date" required />
            </div>
            {REGULATION_RULES.map((field) => (
              <div key={field}>
                <label htmlFor={field}>{fieldLabels[field]}</label>{" "}
                <input id={field} name={field} type="number"
                  defaultValue={current[field] ?? INITIAL_CONSECUTIVE_CANCELLATIONS_LIMIT} required />
              </div>
            ))}
            <button type="submit">Publicar</button>
          </form>

          <h2>Historial de versiones</h2>
          {history.map(({ version, publisherEmail }) => (
            <section key={version.id} id={`version-${version.id}`}>
              <h3>{version.id === "initial" ? "Versión inicial" : `Vigencia desde ${version.effectiveFrom}`}</h3>
              <p>
                Publicada por {publisherEmail ?? version.publishedByUserId ?? "Migración inicial"} el{" "}
                <time dateTime={version.publishedAt.toISOString()}>{publicationTime.format(version.publishedAt)}</time>
                {version.id === current.id && " · Vigente"}
                {version.effectiveFrom > current.effectiveFrom && " · Programada"}
              </p>
              <RegulationValues rules={version} />
              {version.previousVersionId && (
                <ul aria-label="Valores cambiados">
                  {REGULATION_RULES.flatMap((field) => {
                    const change = version.changes[field];
                    return change ? [
                      <li key={field}>{fieldLabels[field]} · {change.previous ?? "Sin valor anterior"} → {change.next}</li>,
                    ] : [];
                  })}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </main>
  );
}
