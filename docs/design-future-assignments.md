# Anulación de asignaciones futuras y baja de cuenta

## Estado actual y evidencia

La finalización individual registra el último día incluido y rechaza un fin anterior al inicio desde 10.15. El modelo de asignación admite `ACTIVE`, `ENDED` y `CANCELLED` desde 10.17. Una asignación delimitada puede estar `ENDED` y seguir siendo elegible dentro del rango. La anulación anticipada ya tiene una operación individual auditada. La baja desactiva la cuenta, revoca sus sesiones, anula las asignaciones futuras, cierra las iniciadas con un intervalo válido, cancela reservas futuras, audita y concilia en la misma transacción.

| Ensayo | Resultado observado en PostgreSQL 15 mediante H08 |
| --- | --- |
| A · Una asignación que empieza mañana | La baja se confirmó. Cuenta desactivada, sesión de acceso revocada, asignación `ENDED` con el fin anterior al inicio, reservas futuras canceladas y aforo liberado. Auditoría presente y ledger vacío. |
| B · Una activa y otra futura | La activa terminó el día de la baja. La futura quedó invertida. Un fallo inducido en la escritura de auditoría devolvió SQLSTATE `23514` y revirtió cuenta, asignaciones y reservas, sin auditoría ni movimientos nuevos. |
| C · Dos futuras en distintas plantillas | Una empezaba mañana y la otra el mes siguiente. Ambas quedaron invertidas y se liberaron sus plazas. El orden de las claves se comprobó en código, sin instrumentar las esperas de este escenario. |
| D · Inicio hoy | A las 22:30 UTC del día anterior, la baja usó el día vigente en Copenhague. En la asignación, inicio y fin quedaron iguales. Las reservas aún futuras se cancelaron. |
| E · Reservas y solicitud pendiente | Se liberó la reserva futura. H09 resolvió la solicitud anterior como `GRANTED` y registró un `AUTO_CANCELLATION_GRANT`, conservando fecha de solicitud y versión normativa. El movimiento fue una concesión por una solicitud preexistente. El ensayo no determina por sí solo si el resultado es la política deseada tras una baja. |
| F · Baja y modificación simultáneas | Con conexiones independientes se observó la finalización a la espera del perfil y la baja a la espera de la finalización. Al liberar el bloqueo ambas concluyeron y hubo una única concesión para la solicitud observada. Se verificó ese orden de llegada. |

Pasaron 8 pruebas dirigidas en la última ejecución, incluida la regresión existente que registra una devolución vencida sin restaurar saldo y preserva una recuperación que ya comenzó. Se usaron fixtures sintéticas y un archivo temporal retirado tras el ensayo. H08 retiró ambos contenedores creados durante la investigación. No se ejecutó la suite completa ni se consultaron o migraron bases persistentes. Confianza alta en los resultados de las fixtures y en el defecto de intervalo. El alcance en datos históricos y otros órdenes de concurrencia queda por determinar.

## Implementación 10.17

La migración aditiva `0015_future_assignment_cancellation` añade el valor `CANCELLED` al estado de la asignación y la tabla inmutable `student_template_assignment_cancellations`, con una fila por asignación y origen `ADMIN_INDIVIDUAL` o `STUDENT_WITHDRAWAL`. La asignación conserva su identificador y sus fechas; la auditoría guarda actor, instante, motivo, fechas originales, versión normativa, reservas canceladas y reservas ambiguas.

La anulación individual exige `SUPER_ADMIN`, un motivo de 3 a 300 caracteres y un día local de Copenhague anterior al inicio. Toma cuenta `FOR SHARE`, la clave asesora de la plantilla y el perfil; después escribe el estado y la auditoría. Reintentar devuelve la auditoría original sin duplicarla. Una asignación iniciada se rechaza con `assignment_already_started`. La operación no altera reservas, no crea solicitudes ni mueve el ledger.

La baja comparte la tabla de auditoría: anula las asignaciones futuras sin cambiar su fin y cierra las iniciadas con el día local. Así ningún intervalo nuevo queda invertido. La generación, la capacidad, la habitualidad, la secuencia y el panel del alumno excluyen `CANCELLED`; la ficha administrativa conserva la fila y la etiqueta.

Sigue pendiente registrar la procedencia de nuevas reservas habituales para poder cancelar reservas inequívocamente vinculadas, y el saneamiento o la restricción de intervalos históricos. Las reservas antiguas sin procedencia se conservan e informan para revisión. [Pruebas](testing.md#incremento-1017--anulación-explícita-de-asignaciones-futuras)

## Implementación 10.18

La ficha administrativa del alumno expone «Anular asignación futura» en cada horario habitual que cumple las condiciones orientativas: cuenta activa, asignación `ACTIVE` y un `effective_from` persistido posterior al día local de Copenhague. La validación definitiva de fechas, bloqueos y auditoría sigue en `cancelFutureAssignment`; la interfaz solo evita ofrecer una operación que el contrato rechazaría por fecha o por estado anulado.

La confirmación muestra alumno, curso, fechas originales, el efecto de la anulación y un motivo obligatorio de 3 a 300 caracteres. Incluye la advertencia de que las reservas existentes no se cancelan automáticamente y pueden requerir revisión administrativa. No promete liberar plazas ni identificar todas las reservas afectadas. El motivo no se envía por URL ni se guarda en el navegador.

La Server Action exige `SUPER_ADMIN`, obtiene el actor de la sesión, rechaza campos ajenos y delega la transacción en el servicio de 10.17. Un resultado nuevo informa de la anulación, la conservación del historial y las reservas que requieren revisión. Un reintento devuelve la auditoría existente e informa de que no se registró una nueva operación. Los errores distinguen asignación iniciada, inexistente, cuenta no disponible, validación y fallo inesperado sin exponer SQL ni trazas.

La ficha conserva las fechas originales y muestra en la misma fila la etiqueta «Asignación anulada», el origen `ADMIN_INDIVIDUAL` o `STUDENT_WITHDRAWAL`, el actor, el instante y el motivo. Solo se indica el número de reservas ambiguas, no sus identificadores técnicos. La anulación individual no crea una segunda auditoría ni cancela reservas. Sigue pendiente la procedencia persistida y el inventario histórico.

## Semántica propuesta

| Situación | Operación y efecto propuestos |
| --- | --- |
| Inicia mañana o el próximo mes y aún no hay sesiones | Anulación individual por `SUPER_ADMIN` mientras el día local siga siendo anterior al inicio persistido. Mantener fechas, ID y rastro de auditoría. Excluir la asignación de la generación. |
| Hay sesiones generadas sin reservas | Mantener las sesiones y su capacidad para los demás alumnos. |
| Hay reservas habituales confirmadas | Cancelar administrativamente solo las futuras con procedencia habitual comprobable y sin otra asignación vigente que las sostenga. Conservar las filas canceladas. Liberar las plazas mediante el estado de la reserva. |
| Hay varias asignaciones activas y futuras | La anulación individual afecta solo a la seleccionada. La baja de cuenta termina las activas con un rango válido, anula las futuras y conserva la cancelación general de reservas y las reglas de devolución vigentes. |
| Empieza hoy, ya comenzó o fue creada con inicio retroactivo | Usar la finalización ordinaria. El límite propuesto es la medianoche local al inicio de la vigencia, aunque la primera sesión sea más tarde. |
| Hay asistencia, ausencia u otro resultado incompatible con una anulación anticipada | Conservar el historial y derivar el caso a revisión administrativa antes de modificarlo. |
| Hay solicitudes pendientes | La anulación individual no crea solicitudes ni concede créditos por las reservas que libera. Conservar las solicitudes existentes y las decisiones consolidadas. Para la baja, aprobar expresamente si se mantiene la conciliación actual de solicitudes anteriores. |

**Recomendación.** Incorporar una marca explícita de anulación en la asignación y un registro inmutable por asignación con actor, instante, motivo, origen individual o baja y reservas afectadas. El estado existente `ENDED` no separa estos casos porque su vigencia sigue siendo inclusiva. Un evento como única representación evita duplicar el estado, pero obliga a aplicar la exclusión por evento en todas las consultas de elegibilidad y capacidad. La marca explícita simplifica esas lecturas si se escribe atómicamente con la auditoría. Conservar la fila evita perder la trazabilidad.

**Dependencia principal.** El generador y el alta habitual insertan reservas con origen `ORDINARY`, igual que la inscripción puntual. La reserva carece de FK a la asignación. Alumno, plantilla y fecha permiten detectar coincidencias, pero no prueban procedencia. Registrar procedencia al crear reservas habituales y preservar las reservas ordinarias preexistentes cuya procedencia sea ambigua. Si otra asignación sigue cubriendo una reserva habitual, proponer conservarla sin duplicar plazas y registrar la relación que la sostiene. Se requiere aprobación sobre este tratamiento histórico, la frontera del día local, el comportamiento ante resultados inconsistentes y la política de pendientes en la baja.

La acción del panel debe mostrar confirmación con motivo, fechas y plazas afectadas, permitir revisión por teclado y reflejar el resultado auditado. Un reenvío devuelve la decisión existente sin duplicar auditoría ni efectos. Dos solicitudes distintas se serializan y comprueban de nuevo el estado y la fecha tras los bloqueos. La cuenta dada de baja conserva su auditoría de retirada y la distinción entre asignaciones finalizadas y anuladas.

## Transacción propuesta y riesgos

1. Autorizar al administrador. Revalidar la cuenta del alumno bajo el bloqueo actual del flujo. Tomar las claves asesoras de todas las plantillas afectadas por orden numérico de `hashtext`, igual que el CLI y la baja.
2. Determinar y bloquear sesiones afectadas por ID antes del perfil. Releer vigencia, elegibilidad y reservas protegidas. Usar el reloj de Copenhague después de la espera. Bloquear perfil antes de escrituras de asignación, reservas, auditoría y eventual conciliación, con los modos compatibles ya establecidos.
3. Confirmar marca, liberaciones y auditoría juntas. Si la política aprobada requiere H09 en la baja, ejecutarlo una vez por perfil con todas sus modificaciones aplicadas. Conservar la versión original, prioridad mensual y fecha de concesión efectiva. La anulación individual solo debería conciliar si se aprueba un caso en que cambie legítimamente la secuencia; una asignación genuinamente futura sin resultados no debe producir una concesión por sí misma.

En un diseño que tome primero el perfil, una anulación A podría retenerlo y esperar una sesión mientras una cancelación global B retiene esa sesión y espera el perfil. Evitar ese ciclo tomando sesiones antes que perfiles. El generador toma todas las plantillas antes de sesiones y referencias a perfiles. La reprogramación toma plantilla antes de sesión. Una operación de ajuste vinculada toma sesión antes de perfil conforme a H02. No invocar el flujo público de cancelación desde una transacción que ya haya bloqueado el perfil si ese flujo intenta volver a adquirir sesiones o cuenta. Verificar también referencias implícitas de cualquier FK nueva. El ensayo F cubre un cruce, no descarta todos los interbloqueos.

## Implementación posterior

1. Tras aprobar la política, introducir en una migración aditiva la representación, la auditoría y la procedencia de nuevas reservas habituales. Implementar la anulación y adaptar la baja en el mismo incremento de servidor. Auditar todos los usos de vigencia, incluidos capacidad de asignaciones, generador y CLI, calendario, ficha, habitualidad y secuencia. Probar A–F como regresiones de la semántica aprobada, rollback, reintentos, reservas puntuales y solapadas, cambio de día tras bloqueo, integridad de créditos y cruces con generación, reprogramación, cancelación global, ajustes vinculados y baja en ambos órdenes. Usar H08.
2. El saneamiento de intervalos históricos y la eventual restricción PostgreSQL siguen pendientes. Inventariar con la consulta de solo lectura de [10.15](testing.md#incremento-1015--vigencia-de-asignaciones-habituales), revisar cada fila con el propietario y ensayar el despliegue desde `0014` con H07. Activar y validar la restricción después de que los escritores compatibles estén desplegados y se hayan tratado las excepciones autorizadas. Una restricción `NOT VALID` también se aplica a nuevas escrituras, por lo que adelantarla podría revertir bajas con el código actual.
