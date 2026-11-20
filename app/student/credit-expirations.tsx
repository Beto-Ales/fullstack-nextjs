import { formatInCenterTimeZone } from "@/src/domain/time/timezone";

type CreditExpiration = { amount: number; expiresAt: Date | null };

export function CreditExpirations({ expirations }: { expirations: CreditExpiration[] }) {
  return (
    <section aria-labelledby="credit-expirations-heading" className="my-4 space-y-2">
      <h3 id="credit-expirations-heading">Vencimientos de créditos</h3>
      {expirations.length === 0 ? <p>No tienes créditos disponibles.</p> : (
        <>
          <p>Hora de Copenhague</p>
          <ul className="space-y-1">
            {expirations.map(({ amount, expiresAt }) => (
              <li key={expiresAt?.toISOString() ?? "without-expiration"} className="wrap-break-word">
                {amount} {amount === 1 ? "crédito" : "créditos"} ·{" "}
                {expiresAt ? (
                  <time dateTime={expiresAt.toISOString()}>
                    {formatInCenterTimeZone(expiresAt, "es-ES", {
                      day: "2-digit", month: "2-digit", year: "numeric",
                      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
                    })}
                  </time>
                ) : "Sin vencimiento"}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
