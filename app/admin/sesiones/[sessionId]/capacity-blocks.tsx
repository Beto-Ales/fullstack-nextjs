import { randomUUID } from "node:crypto";

import type { getAdminCalendarSessionDetails } from "@/src/application/academic/admin-calendar-service";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";

import { submitCapacityBlockForm } from "./capacity-block-action";
import { CapacityBlockForm } from "./capacity-block-form";

type CapacityBlocks = NonNullable<Awaited<ReturnType<typeof getAdminCalendarSessionDetails>>>["capacityBlocks"];

function BlockDate({ at }: { at: Date }) {
  return <time dateTime={at.toISOString()}>{formatInCenterTimeZone(at, "es-ES", { dateStyle: "short", timeStyle: "short" })}</time>;
}

export function SessionCapacityBlocks({ sessionId, blocks, canBlock }: { sessionId: string; blocks: CapacityBlocks; canBlock: boolean }) {
  return (
    <section aria-labelledby="capacity-blocks" className="space-y-2 border-t pt-3">
      <h3 id="capacity-blocks">Bloqueos de plazas</h3>
      <CapacityBlockForm enabled={canBlock} action={submitCapacityBlockForm.bind(null, sessionId, randomUUID(), "block")} />
      {blocks.length === 0 ? <p>No hay bloqueos registrados.</p> : (
        <ul className="space-y-2">
          {blocks.map((block) => (
            <li key={block.id} className="rounded border p-3 wrap-break-word">
              <p className="font-medium">{block.isActive ? "Activo" : "Desactivado"} · {block.blockedSpots} {block.blockedSpots === 1 ? "plaza" : "plazas"}</p>
              <p>{block.reason ?? "Sin motivo de bloqueo registrado"}</p>
              <p>Bloqueado el <BlockDate at={block.createdAt} />{block.createdBy && <> por {block.createdBy}</>}</p>
              {block.releasedAt && (
                <>
                  <p>Desbloqueado el <BlockDate at={block.releasedAt} />{block.releasedBy && <> por {block.releasedBy}</>}</p>
                  <p>{block.releaseReason}</p>
                </>
              )}
              <CapacityBlockForm enabled={block.isActive} release action={submitCapacityBlockForm.bind(null, sessionId, block.id, "release")} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
