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

## Implementación 10.19

La auditoría del 10.17 ya persiste los identificadores de las reservas ambiguas en `student_template_assignment_cancellations.ambiguous_reservation_ids`. El 10.19 los reutiliza sin migración ni cambio de esquema: la ficha administrativa deja de mostrar solo un recuento y enumera cada registro señalado con su estado actual y un enlace a la sesión concreta.

La consulta forma parte de la misma transacción de solo lectura y la misma instantánea que el resto de la ficha. Se ejecuta una sola vez para todas las asignaciones anuladas de la página: recoge los identificadores únicos de las auditorías y lee en bloque `class_reservations`, `class_sessions` y `class_templates`, filtrando siempre por el perfil solicitado. No se consulta una sesión por reserva ni se escribe durante la carga. Un identificador que ya no existe, que pertenece a otro alumno o que no puede leerse se presenta como «Registro no localizado» y no se enlaza, sin inventar una sesión alternativa.

El recuento vigente se deriva del estado persistido, no del número almacenado en la auditoría. Una reserva sigue requiriendo revisión si pertenece al alumno, continúa `CONFIRMED`, su sesión sigue `SCHEDULED` y todavía no ha terminado. Una reserva cancelada, una sesión cancelada o una sesión pasada dejan de contarse; el total «Reservas señaladas al anular» conserva el dato histórico. La ficha muestra por separado si la reserva «Sigue confirmada» o está «Cancelada», con la fecha y el origen de cancelación cuando constan, y la fecha actual de la sesión en `Europe/Copenhagen`, que puede diferir de la fecha original si se reprogramó. Los estados se expresan con texto, no solo con color.

Cada fila con sesión legible enlaza a `/admin/sesiones/[sessionId]?week=...` conservando la semana de la sesión para que «Volver al calendario» mantenga el contexto. El enlace y la página de destino exigen `SUPER_ADMIN`. La sección conserva la advertencia de que la procedencia habitual no está demostrada y de que corresponde revisar cada caso antes de cancelar. Una baja de cuenta no presenta reservas pendientes por el mero hecho de conservar identificadores históricos: el flujo de baja cancela las reservas futuras que corresponda y el recuento vigente refleja ese estado. Las reservas antiguas sin procedencia demostrable siguen pendientes de saneamiento. [Pruebas](testing.md#incremento-1019--enlaces-administrativos-para-revisar-reservas-ambiguas)

## Implementación 10.20

La migración aditiva `0016_habitual_reservation_provenance` añade `class_reservations.habitual_assignment_id`, una referencia anulable a `student_template_assignments` con `ON DELETE SET NULL`, y el índice `class_reservations_habitual_assignment_idx`. No hay relleno histórico; en 10.20 no cambian la cancelación, los créditos ni la prioridad FIFO.

El alta de una asignación escribe su propio identificador en las reservas que crea. La generación lo resuelve por alumno, plantilla y fecha local dentro de la misma transacción y solo cuando exactamente una asignación no anulada, vigente y de una cuenta activa cubre la sesión. Con dos o más coincidencias la reserva se crea sin referencia: el origen es ambiguo y no se elige al azar. La inscripción administrativa, el alta ordinaria y las recuperaciones no escriben la columna.

La referencia no altera la elegibilidad ni el aforo: las reservas se crean con las mismas reglas y la cancelación de una reserva conserva la columna. `ON DELETE SET NULL` impide que la procedencia bloquee o elimine reservas. El inventario de reservas históricas sin procedencia continúa pendiente. [Pruebas](testing.md#incremento-1020--procedencia-de-reservas-habituales)

## Implementación 10.21

La anulación individual de una asignación futura usa `class_reservations.habitual_assignment_id` para cancelar únicamente las reservas `CONFIRMED` de sesiones futuras cuya procedencia es exactamente la asignación anulada. La cancelación de la reserva y la auditoría de la asignación se escriben en la misma transacción que el estado `CANCELLED`.

No se cancelan las reservas ya canceladas, las de sesiones iniciadas, las de otro alumno ni las que otra asignación viva de la misma plantilla cubre en la fecha de la sesión. En 10.21 la procedencia explícita prevalecía sobre el origen y una recuperación vinculada también se cancelaba; el 10.22 sustituye esa regla y restringe la cancelación automática a `ORDINARY`. Las reservas `ORDINARY` sin referencia se conservan y se registran en `ambiguous_reservation_ids` para revisión administrativa; las cubiertas por otra asignación viva se conservan sin señalarse. La operación no modifica `max_capacity` ni el ledger, no crea solicitudes ni movimientos de crédito y no elimina filas; las reservas canceladas liberan su plaza mediante su estado.

La ficha administrativa muestra el resultado auditado con dos recuentos: reservas futuras canceladas y reservas no canceladas automáticamente. Un reintento reutiliza los identificadores guardados en la auditoría, sin volver a cancelar ni duplicar el registro. [Pruebas](testing.md#incremento-1021--cancelación-de-reservas-vinculadas-al-anular-asignaciones)

## Implementación 10.22

La anulación individual ya no cancela recuperaciones. `cancelFutureAssignment` restringe la cancelación automática a reservas `ORDINARY` `CONFIRMED`, de sesiones futuras, dentro de la plantilla y la vigencia de la asignación, con `habitual_assignment_id` igual a la asignación y sin otra asignación viva que cubra la fecha. Una reserva `MAKEUP` conserva siempre su estado, su plaza y su consumo de crédito, incluso si una fila anómala la vincula a la asignación anulada.

La revisión administrativa distingue ahora dos clases: reservas `ORDINARY` sin procedencia demostrable y recuperaciones vinculadas de forma excepcional. Ambas se conservan, se escriben en `ambiguous_reservation_ids` y la ficha explica el motivo por fila. La ruta legítima de recuperación sigue creando `origin = MAKEUP` con `habitual_assignment_id` vacío, de modo que una recuperación normal ni siquiera entra en la revisión. La operación no añade migraciones ni modifica créditos, ledger o `max_capacity`. [Pruebas](testing.md#incremento-1022--preservación-de-recuperaciones-en-la-anulación-habitual)

## Semántica aprobada e implementada

| Situación | Operación y efecto |
| --- | --- |
| Inicia mañana o el próximo mes y aún no hay sesiones | Anulación individual por `SUPER_ADMIN` mientras el día local siga siendo anterior al inicio persistido. Mantener fechas, ID y rastro de auditoría. Excluir la asignación de la generación. |
| Hay sesiones generadas sin reservas | Mantener las sesiones y su capacidad para los demás alumnos. |
| Hay reservas habituales confirmadas | Cancelar administrativamente solo las futuras con procedencia habitual comprobable y sin otra asignación vigente que las sostenga. Conservar las filas canceladas. Liberar las plazas mediante el estado de la reserva. |
| Hay varias asignaciones activas y futuras | La anulación individual afecta solo a la seleccionada. La baja de cuenta termina las activas con un rango válido, anula las futuras y conserva la cancelación general de reservas y las reglas de devolución vigentes. |
| Empieza hoy, ya comenzó o fue creada con inicio retroactivo | Usar la finalización ordinaria. El límite propuesto es la medianoche local al inicio de la vigencia, aunque la primera sesión sea más tarde. |
| Hay asistencia, ausencia u otro resultado incompatible con una anulación anticipada | Conservar el historial y derivar el caso a revisión administrativa antes de modificarlo. |
| Hay solicitudes pendientes | La anulación individual no crea solicitudes ni concede créditos por las reservas que libera. Conservar las solicitudes existentes y las decisiones consolidadas. Para la baja, aprobar expresamente si se mantiene la conciliación actual de solicitudes anteriores. |

**Decisión implementada.** La asignación conserva una marca explícita de anulación y un registro inmutable por asignación con actor, instante, motivo, origen individual o baja y reservas afectadas. El estado existente `ENDED` no separa estos casos porque su vigencia sigue siendo inclusiva. La marca explícita evita duplicar la representación en consultas de elegibilidad y capacidad y se escribe atómicamente con la auditoría. Conservar la fila preserva la trazabilidad.

**Dependencia principal.** El generador y el alta habitual registran su asignación en las reservas que crean. La anulación usa esa referencia para cancelar solo las reservas atribuibles; las reservas históricas sin referencia se conservan para revisión y las que otra asignación viva cubre se conservan sin señalarse. No se deduce procedencia a partir de alumno, plantilla y fecha. El tratamiento histórico, la frontera del día local, los resultados inconsistentes y la política de pendientes de la baja conservan las decisiones ya implementadas en 10.17–10.21.

La acción del panel debe mostrar confirmación con motivo, fechas y plazas afectadas, permitir revisión por teclado y reflejar el resultado auditado. Un reenvío devuelve la decisión existente sin duplicar auditoría ni efectos. Dos solicitudes distintas se serializan y comprueban de nuevo el estado y la fecha tras los bloqueos. La cuenta dada de baja conserva su auditoría de retirada y la distinción entre asignaciones finalizadas y anuladas.

## Transacción propuesta y riesgos

1. Autorizar al administrador. Revalidar la cuenta del alumno bajo el bloqueo actual del flujo. Tomar las claves asesoras de todas las plantillas afectadas por orden numérico de `hashtext`, igual que el CLI y la baja.
2. Determinar y bloquear sesiones afectadas por ID antes del perfil. Releer vigencia, elegibilidad y reservas protegidas. Usar el reloj de Copenhague después de la espera. Bloquear perfil antes de escrituras de asignación, reservas, auditoría y eventual conciliación, con los modos compatibles ya establecidos.
3. Confirmar marca, liberaciones y auditoría juntas. Si la política aprobada requiere H09 en la baja, ejecutarlo una vez por perfil con todas sus modificaciones aplicadas. Conservar la versión original, prioridad mensual y fecha de concesión efectiva. La anulación individual solo debería conciliar si se aprueba un caso en que cambie legítimamente la secuencia; una asignación genuinamente futura sin resultados no debe producir una concesión por sí misma.

En un diseño que tome primero el perfil, una anulación A podría retenerlo y esperar una sesión mientras una cancelación global B retiene esa sesión y espera el perfil. Evitar ese ciclo tomando sesiones antes que perfiles. El generador toma todas las plantillas antes de sesiones y referencias a perfiles. La reprogramación toma plantilla antes de sesión. Una operación de ajuste vinculada toma sesión antes de perfil conforme a H02. No invocar el flujo público de cancelación desde una transacción que ya haya bloqueado el perfil si ese flujo intenta volver a adquirir sesiones o cuenta. Verificar también referencias implícitas de cualquier FK nueva. El ensayo F cubre un cruce, no descarta todos los interbloqueos.

## Implementación posterior

1. Tras aprobar la política, introducir en una migración aditiva la representación, la auditoría y la procedencia de nuevas reservas habituales. Implementar la anulación y adaptar la baja en el mismo incremento de servidor. Auditar todos los usos de vigencia, incluidos capacidad de asignaciones, generador y CLI, calendario, ficha, habitualidad y secuencia. Probar A–F como regresiones de la semántica aprobada, rollback, reintentos, reservas puntuales y solapadas, cambio de día tras bloqueo, integridad de créditos y cruces con generación, reprogramación, cancelación global, ajustes vinculados y baja en ambos órdenes. Usar H08.
2. El saneamiento de intervalos históricos y la eventual restricción PostgreSQL siguen pendientes. Inventariar con la consulta de solo lectura de [10.15](testing.md#incremento-1015--vigencia-de-asignaciones-habituales), revisar cada fila con el propietario y ensayar el despliegue desde `0014` con H07. Activar y validar la restricción después de que los escritores compatibles estén desplegados y se hayan tratado las excepciones autorizadas. Una restricción `NOT VALID` también se aplica a nuevas escrituras, por lo que adelantarla podría revertir bajas con el código actual.
