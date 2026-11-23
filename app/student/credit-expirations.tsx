import { HistoryTime } from "@/app/components/history-time";
import { formatCreditQuantity } from "@/src/interfaces/presentation/history-format";

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
              <li key={expiresAt?.getTime() ?? "without-expiration"} className="wrap-break-word">
                {formatCreditQuantity(amount)} · {expiresAt ? <HistoryTime value={expiresAt} /> : "Sin vencimiento"}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
