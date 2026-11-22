# Modelo académico (Prompt 06)

## Modelo de cursos confirmado

- `SUPER_ADMIN` puede crear un curso con una sesión semanal durante tres meses o un curso de una sola sesión en una fecha concreta. Cada curso admite como máximo 12 alumnos inscritos.
- Anular la reserva habitual de un alumno libera la plaza de esa fecha. Las reservas de las demás fechas y la asignación al curso se conservan.
- Un alumno elegible puede reservar una recuperación en otra clase futura programada. Al confirmar se cuentan las reservas confirmadas y los bloqueos activos y se comprueba el aforo antes de consumir el crédito en la misma transacción.

### Estado funcional

- El panel de administración permite crear cursos semanales y clases únicas, e inscribir alumnos de forma ordinaria en ambos. La clase única se guarda como sesión independiente con `template_id` vacío. En el curso semanal se crea una asignación a la plantilla y se reservan las sesiones futuras elegibles con plazas libres.
- La reserva de una sesión aplica el menor de su capacidad y el límite de la normativa vigente bajo bloqueo de fila. La asignación a la plantilla limita a 12 alumnos distintos simultáneos durante la vigencia. La comprobación y el alta comparten el bloqueo por plantilla que usa el generador. Se comprueba también la coincidencia con altas futuras.
- El alta, la baja lógica y el cambio de contraseña propia están disponibles en los paneles correspondientes. El límite de 12 alumnos simultáneos se aplica al inscribir en cursos nuevos, también ante altas concurrentes. [Permisos de fase 06](authentication.md#permisos-confirmados-de-fase-06).

### Baja definitiva y plazas

- La baja es lógica y conserva la cuenta, el historial y las relaciones académicas. Desde que se hace efectiva termina la inscripción y se liberan tanto las plazas ordinarias como las de recuperaciones confirmadas de clases que aún no han empezado. Las reservas de los demás alumnos y los bloqueos se conservan.
- El administrador decide si incorpora un sustituto para las fechas restantes o deja las plazas disponibles para recuperaciones.
- El flujo de `/admin` termina las inscripciones abiertas y las programadas que aún no han vencido. Conserva la fecha local de baja como límite de las inscripciones. La hora de baja decide qué reservas son futuras, incluidas las de más tarde ese día. Desde la baja el alumno deja de computar para nuevas inscripciones y el generador no le reserva plazas. La liberación conserva los registros de reserva y de créditos. [Baja de alumnos](authentication.md#baja-de-alumnos).
- `student_withdrawals` registra el administrador, el alumno, la fecha y hora, las inscripciones terminadas, las reservas ordinarias liberadas y cada recuperación cancelada, con el resultado de devolución y restauración de saldo. La baja, las devoluciones y la auditoría comparten transacción. Un reintento conserva el registro original.
- Para cada recuperación se aplica la antelación de la versión vigente al dar de baja. Si la cancelación es tardía, se libera la plaza y se conserva el consumo. Si se cancela a tiempo, se registra la devolución vinculada al consumo y a la concesión. El saldo solo se restaura si el crédito de origen sigue vigente. [Reglas de recuperación](#recuperaciones-fase-06).

## Creación de cursos semanales e inscripción

El formulario **Crear curso semanal** toma la fecha de la primera clase, deduce el día de la semana y calcula el fin en `Europe/Copenhagen`. La vigencia fija empieza en esa fecha y termina el día anterior al aniversario de tres meses. Al guardar se materializan las fechas de ese curso desde el día actual y dentro de la vigencia. El horizonte móvil de tres meses sigue siendo el límite por defecto de cada ejecución periódica y respeta el fin de la plantilla. El formulario **Inscribir alumno** confirma cuántas sesiones quedaron reservadas. Una cancelación de reserva modifica únicamente la fecha cancelada y conserva la inscripción.

## Creación de clases únicas desde administración

En `/admin`, el formulario **Crear clase única** solicita fecha, hora de inicio, duración y aforo. La acción de servidor comprueba el rol y el menor límite entre la normativa vigente y 12 plazas. Tras guardar, el panel muestra la fecha y las horas de la sesión guardada en la zona de Copenhague. La confirmación puede volver a consultarse al recargar la página.

## Alcance implementado

- Perfiles de alumno (`student_profiles`) vinculados a usuarios `STUDENT`.
- Plantillas semanales recurrentes (`class_templates`).
- Sesiones concretas materializadas (`class_sessions`).
- Asignaciones de horarios habituales (`student_template_assignments`).
- Reservas de sesiones (`class_reservations`).
- Bloqueos administrativos de plazas (`session_capacity_blocks`).
- Servicio de disponibilidad y reserva transaccional.
- Comando técnico para generar sesiones recurrentes.
- Cancelaciones versionadas de reservas (`reservation_cancellations`) con clasificación temporal y evaluación de secuencia.
- Registro/corrección de asistencia (`reservation_attendance_records`) con trazabilidad por supersesión.
- Detección idempotente de ausencias para sesiones finalizadas.
- Ledger de créditos (`credit_ledger_movements`) con generación automática, concesión/retiro manual y caducidad.
- Reservas de recuperación (`origin = MAKEUP`) con consumo FIFO y devoluciones según política de cancelación.
- Normativa académica configurable, versionada y auditable, visible en `/normativa`.

## Tablas y relaciones

### `student_profiles`

- Relación 1:1 con `users` vía `user_id` único.
- Solo usuarios `STUDENT` deben tener perfil (validado en aplicación).

### `class_templates`

- Define recurrencia semanal:
  - día ISO (`iso_weekday`, 1..7),
  - hora local (`starts_at_local_time`),
  - duración (`duration_minutes`),
  - vigencia (`effective_from` / `effective_to`),
  - estado (`ACTIVE` / `INACTIVE`),
  - capacidad máxima configurable.

### `class_sessions`

- Ocurrencias concretas con:
  - fecha local,
  - inicio/fin UTC,
  - estado (`SCHEDULED`, `CANCELLED`, `COMPLETED`),
  - capacidad aplicada.
- Pueden tener `template_id` nulo para clases puntuales.
- Índice único parcial por (`template_id`, `local_date`) para evitar duplicados de recurrencia.

### `student_template_assignments`

- Asigna alumnos a plantillas habituales con vigencia temporal.
- Índice único parcial para evitar duplicados activos del mismo alumno+plantilla.

### `class_reservations`

- Reserva de alumno en sesión.
- Estado (`CONFIRMED`, `CANCELLED`) y origen (`ORDINARY`, `MAKEUP`).
- Incluye trazabilidad de cancelación (`cancelled_at`, `cancelled_by_user_id`).
- Las inscripciones desde el detalle administrativo registran el responsable en `created_by_user_id` y el instante en `created_at`.
- Índice único parcial para impedir reservas activas duplicadas por alumno+sesión.

### `session_capacity_blocks`

- Bloqueo administrativo de plazas por sesión.
- `blocked_spots` consumen capacidad.
- Se conserva historial con `is_active`.

### `reservation_cancellations`

- Snapshot de cada cancelación aplicada sobre una reserva.
- Incluye:
  - tipo temporal (`ON_TIME` / `LATE`),
  - cumplimiento de regla de 7 días,
  - posición en secuencia de cancelaciones habituales,
  - elegibilidad candidata a recuperación (`can_generate_credit_candidate`) y causa de no elegibilidad.
- Se mantiene histórico completo para futuras fases de ledger/créditos.

### `reservation_attendance_records`

- Registro auditable de asistencia por reserva:
  - `ATTENDED`, `ABSENT`.
- Soporta corrección administrativa sin borrar historial:
  - el registro anterior queda superseded (`superseded_by` + `superseded_at`),
  - el nuevo registro queda como vigente.

### `credit_ledger_movements`

- Ledger inmutable de movimientos de créditos.
- Tipos actuales:
  - `AUTO_CANCELLATION_GRANT`,
  - `MANUAL_GRANT`,
  - `MANUAL_WITHDRAWAL`,
  - `EXPIRATION`.
- Se reservaron tipos para próximas fases:
  - `RECOVERY_CONSUMPTION`,
  - `RECOVERY_REFUND`.
- Cada movimiento guarda trazabilidad de:
  - alumno,
  - cantidad,
  - motivo,
  - administrador (si aplica),
  - referencia de sesión (si aplica),
  - evento origen (cancelación o movimiento fuente),
  - clave de idempotencia.
- Para recuperaciones:
  - `related_reservation_id` (reserva asociada),
  - `source_grant_movement_id` (crédito origen consumido),
  - `source_movement_id` (consumo origen de una devolución),
  - `refund_restored_credit` (si la devolución restaura saldo o solo deja auditoría).

### Solicitudes de ajustes manuales de créditos

Un `SUPER_ADMIN` activo puede conceder y retirar créditos de alumnos activos. Los nuevos ajustes requieren un UUID de solicitud. La identidad de la solicitud vincula el administrador con el tipo de ajuste, el perfil, la cantidad, el motivo normalizado en NFC y sin espacios en los extremos, y la sesión opcional. Una repetición idéntica devuelve el ajuste confirmado. Reutilizar la clave con otros datos o como otro administrador genera un conflicto sin devolver movimientos ajenos.

La migración `0013_manual_credit_adjustment_requests` añade una tabla con la clave de solicitud y un enlace opcional desde el ledger. Una concesión genera un movimiento. Una retirada puede generar varios, uno por crédito de origen consumido. La solicitud, sus movimientos y las caducidades que corresponda materializar en una retirada se confirman juntos. Los movimientos anteriores conservan sus datos y carecen de enlace a una solicitud nueva.

## Generación de sesiones recurrentes

Servicio en `src/application/academic/academic-service.ts`:

- Genera horizonte de 3 meses (configurado en dominio).
- Ignora plantillas inactivas.
- Respeta vigencia de plantilla.
- Inserta con `on conflict do nothing` para idempotencia.
- No altera sesiones existentes (incluidas editadas/canceladas).
- Si omite una sesión futura programada que ya existe, vuelve a comprobar el aforo y reporta el mismo identificador mientras queden más alumnos habituales sin reserva que plazas libres.
- Para cada sesión futura nueva, reserva en la misma transacción a los alumnos cuya asignación cubre la fecha local. Los intervalos incluyen ambos extremos y las asignaciones solapadas del mismo alumno cuentan una vez.
- La sesión y las nuevas reservas guardan la versión de normativa aplicada. La transacción usa el aforo vigente, las reservas confirmadas y los bloqueos activos. Si el grupo no cabe, la sesión se conserva sin reservar a ningún alumno del grupo y el generador informa del conflicto.

Comando CLI:

```bash
npm run academic:generate-sessions
```

El CLI interpreta las fechas PostgreSQL `DATE` y las cadenas ISO como fechas de calendario. Los valores `Date` del driver representan medianoche en la zona del proceso. El CLI conserva ese día y calcula el inicio de la clase en Copenhague.

## Zona horaria y DST

- Zona oficial: `Europe/Copenhagen`.
- Recurrencia calculada en hora local y luego convertida a UTC.
- Estrategia en horas inexistentes por salto DST:
  - avanzar al siguiente minuto local válido (determinista).
- Las horas ambiguas mantienen la resolución determinista de Luxon en la zona del centro.

## Disponibilidad

Fórmula:

`disponibles = max(0, min(capacidad_de_sesión, aforo_vigente) - reservas_confirmadas - plazas_bloqueadas)`

- nunca negativa,
- calculada en servidor con datos de PostgreSQL,
- sin confiar en datos del cliente.
- El aforo máximo inicial es de 12 plazas. Una reducción entra en vigor para nuevas reservas y bloqueos y conserva los compromisos existentes.

### Resumen semanal administrativo

En `/admin`, solo `SUPER_ADMIN` consulta el resumen y el calendario en la misma instantánea PostgreSQL de solo lectura. La semana incluye sesiones cuyo inicio cae desde el lunes a medianoche hasta el lunes siguiente en Copenhague, incluidos los cambios de hora. El total de programadas sin cancelar reúne futuras, en curso y finalizadas. Los límites entre esos estados se basan en las horas de inicio y fin. Una sesión cancelada se cuenta por separado.

- **Asistencia.** Solo reservas confirmadas sin auditoría de cancelación y en sesiones finalizadas sin cancelar. Se usa el resultado vigente por reserva. El porcentaje divide asistencias entre asistencias más ausencias registradas. Las reservas pendientes quedan visibles y hacen provisional el porcentaje. Sin resultados registrados aparece «Sin datos suficientes».
- **Cancelaciones.** Una fila por reserva cancelada o con auditoría, en la semana de la sesión afectada. Se cuentan las solicitudes del alumno con su antelación persistida cuando existe. Las decisiones individuales administrativas se identifican mediante su origen explícito. La baja y la cancelación de sesión se reconocen cuando su auditoría identifica la reserva. Los casos sin evidencia suficiente figuran como de origen indeterminado.
- **Capacidad.** El total suma únicamente sesiones futuras abiertas según el cálculo vigente del calendario y detalle. Las incidencias se cuentan para toda la semana con ese mismo cálculo. Reservas y bloqueos reflejan lo persistido al consultar. El modelo carece de una fotografía de ocupación al inicio de cada clase. Las reservas que reemplazan a una cancelada cuentan como ocupación y la cancelación sigue en su historial. Los créditos y sus solicitudes pendientes se consultan en sus propios flujos.

### Aforo en el detalle administrativo

- **Capacidad física** es la guardada en la sesión. Las plazas físicamente libres se calculan restando las reservas confirmadas y los bloqueos activos, con mínimo cero. Las cancelaciones y los bloqueos históricos quedan fuera del cálculo. Si una plaza liberada se vuelve a reservar, la nueva confirmación ocupa esa capacidad.
- **Aforo efectivo** es el menor valor entre la capacidad física y el límite de la normativa vigente al consultar. Calendario y detalle comparten el cálculo y los agregados de PostgreSQL, que también usa la gestión de reservas ordinarias. **Plazas reservables** aplica el aforo efectivo y se muestra en cero cuando la sesión empezó, terminó o se canceló, como en la búsqueda de recuperaciones. El número expresa capacidad de la sesión. Reservar una recuperación también requiere que el alumno cumpla las condiciones de créditos y cupo mensual.
- Los habituales pendientes se muestran por separado. Si superan la disponibilidad efectiva se indica la incidencia. El flujo de reservas actual cuenta compromisos confirmados y bloqueos activos, y no descuenta los habituales pendientes. Si esos compromisos ya superan el aforo efectivo, el detalle muestra el exceso y mantiene las plazas reservables en cero.
- Si un dato histórico tiene una cancelación registrada y la reserva sigue confirmada, el detalle lo señala y conserva el recuento de capacidad que aplican el calendario y las reservas.

### Bloqueo y desbloqueo administrativo de plazas

- `SUPER_ADMIN` puede bloquear plazas de una sesión futura y programada. El formulario bloquea una unidad por envío y admite operaciones independientes consecutivas. El servicio conserva el soporte de varias unidades en un mismo bloqueo. Cada alta exige un motivo de 3 a 300 caracteres tras recortar los espacios y registra actor, fecha y normativa aplicada.
- El alta y la desactivación adquieren el bloqueo de fila de la sesión con `FOR UPDATE`, igual que las reservas. El alta lee la hora, la normativa y el uso de plazas después de tomar el bloqueo. Los habituales pendientes se muestran como incidencia y las reservas confirmadas y los bloqueos activos son los compromisos que consumen el aforo. Si los compromisos ocupan o superan el límite efectivo, se rechazan nuevos bloqueos.
- El UUID del bloqueo identifica la solicitud de alta. Reenviarla con el mismo actor, sesión, cantidad y motivo devuelve el resultado original. Un UUID reutilizado con datos diferentes se rechaza. La desactivación de un bloqueo activo conserva la fila y anota el motivo, el actor y la fecha de desbloqueo. Repetirla conserva la primera desactivación.
- Se puede desactivar un bloqueo activo en exceso de aforo o en una sesión cerrada. La disponibilidad permanece en cero si la sesión está en curso, finalizada o cancelada. La operación solo modifica el bloqueo y el cálculo posterior de disponibilidad.
- La migración `0008_session_capacity_block_release` añade los tres campos de auditoría de desbloqueo. Los bloqueos históricos anteriores conservan sus datos y muestran los datos de auditoría que consten. La lectura del detalle consulta aforo y bloqueos en la misma instantánea de PostgreSQL.

### Inscripción administrativa en una sesión

- `SUPER_ADMIN` busca por nombre, apellido o correo exacto en el detalle de una sesión futura con plazas reservables. La búsqueda devuelve hasta 15 alumnos activos con rol `STUDENT` y perfil, sin reserva confirmada para esa sesión. El resultado muestra el nombre y, para distinguir homónimos, el correo de cuenta. La baja lógica se representa con el estado `DISABLED`.
- `enrollStudentInSession` reutiliza la transacción de reserva ordinaria. Mantiene el bloqueo compartido de la cuenta activa antes del `FOR UPDATE` de la sesión. Tras adquirir ambos comprueba la hora del servidor, el estado de sesión, los duplicados, la normativa de Copenhague y el uso de plazas. La regla de aforo comparte cálculo y recuentos con el detalle y el calendario. Los bloqueos activos consumen capacidad al igual que las reservas confirmadas. Cuando se alcanza o supera el aforo efectivo, se rechaza el alta y se conservan los compromisos existentes.
- La inscripción puede realizarse en una clase puntual o en una sola fecha de una plantilla. Persiste una fila `ORDINARY` y conserva las asignaciones habituales y las demás fechas. Los habituales pendientes siguen visibles como incidencia y no se deducen del aforo reservable conforme a la regla vigente. Sigue pendiente definir la prioridad para una futura asignación automática. El alta no crea movimientos de crédito ni consume cupo de recuperación.
- La reserva guarda alumno, sesión, origen, normativa, administrador, fecha y hora. Su UUID identifica también la solicitud. El reintento con el mismo administrador, alumno y sesión devuelve la reserva confirmada original. Un UUID usado para otros datos se rechaza. Una solicitud cancelada conserva su historial y una nueva inscripción requiere una nueva solicitud y una plaza disponible.
- La migración `0009_admin_session_enrollment` añade la referencia nullable al usuario creador. Las reservas anteriores conservan sus datos y quedan con creador desconocido. La baja lógica conserva la referencia. Si se elimina físicamente el usuario creador, PostgreSQL pone la referencia a nulo, como en los bloqueos.
- Al confirmar se revalidan el detalle, el calendario administrativo y el panel del estudiante. Se conserva la semana en la navegación. Ante una solicitud desactualizada, el detalle vuelve a consultar el aforo y muestra el motivo del rechazo.

## Concurrencia en reservas

Las nuevas reservas ordinarias individuales y de recuperación usan una transacción con bloqueo de fila (`FOR UPDATE`) sobre `class_sessions`:

1. Bloquea sesión.
2. Verifica el estado reservable y cuenta las reservas confirmadas y plazas bloqueadas.
3. Comprueba bajo los bloqueos de la reserva que la sesión sigue programada y que su inicio es estrictamente posterior al reloj de PostgreSQL en ese instante.
4. Inserta la reserva si cumple las condiciones aplicables. En recuperaciones, el consumo y la reserva se confirman juntos.

La igualdad con el inicio cierra la admisión. Una sesión que sigue `SCHEDULED` también queda cerrada al comenzar. Los reintentos de una inscripción de detalle o recuperación que recuperen un resultado confirmado siguen sujetos a autorización, titularidad y al contrato de idempotencia, y no crean reservas ni consumos adicionales. La generación habitual conserva su flujo. [Orden de bloqueos](architecture.md#orden-global-de-bloqueo-concurrencia)

## Cancelaciones y secuencias

- El alumno autorizado cancela su reserva confirmada y la plaza se libera en la misma transacción. La antelación se clasifica con el inicio real de la sesión y el instante de solicitud. La normativa inicial exige siete días naturales en Copenhague.
- La cancelación ordinaria o de recuperación iniciada por el alumno revalida su cuenta activa y su rol bajo bloqueo, y verifica la titularidad. Si la baja se confirma primero, la solicitud del alumno se rechaza antes de modificar la reserva, la auditoría o el ledger. Si la cancelación se confirma primero, la baja continúa con ese resultado y conserva la devolución o la decisión de crédito que corresponda. El reintento del alumno también requiere cuenta activa. Las decisiones administrativas mantienen su autorización y reglas propias. [Orden de bloqueos](architecture.md#orden-global-de-bloqueo-concurrencia)
- Con la regla del 9.10, el máximo inicial de posiciones elegibles es tres. Las cancelaciones tardías cuentan y quedan sin crédito. El resultado vigente `ATTENDED` o `ABSENT` de una habitual reinicia la racha. Las recuperaciones, las ordinarias individuales y las cancelaciones administrativas son neutrales.
- La cronología usa el inicio de sesión y desempata por identificador de sesión. Una sesión habitual cuenta una vez incluso con reinscripciones. Una reserva habitual anterior confirmada sin resultado deja pendiente la posición desde el último reinicio pertinente. La ausencia requiere un registro académico vigente. Los datos históricos de cancelación se reconocen si consta solicitud del alumno o si el responsable registrado coincide con él.
- La cancelación conserva su instante, clasificación y versión de solicitud. `sequence_pending` distingue una evaluación pendiente. Las operaciones que resuelven clases anteriores vuelven a evaluar la secuencia. Dentro del mes natural de la solicitud, una solicitud posterior con posibilidad de crédito espera a las solicitudes anteriores pendientes de ese mes. El orden de asignación usa instante de solicitud e identificador de cancelación. `credit_resolution` registra una concesión, un cupo mensual agotado o la falta de elegibilidad.
- El cupo mensual se calcula por el mes de solicitud. Un crédito existe y queda disponible cuando se inserta su movimiento. Su caducidad individual se cuenta desde la concesión efectiva con el plazo de la versión de solicitud. El bloqueo por perfil y la clave única de la cancelación garantizan un solo movimiento. Los créditos del 9.10 referencian la sesión a través de la cancelación, por lo que resolver otro crédito del mismo alumno evita bloquear una sesión ajena mediante una referencia redundante.
- El panel del alumno muestra el máximo normativo, la racha cuando se conoce y las solicitudes pendientes. La cronología puede cambiar al reprogramar una sesión para decisiones futuras. Las decisiones consolidadas y el ledger conservan sus datos originales. [Cobertura del 9.10](testing.md#incremento-910--racha-y-créditos-pendientes)

### Vigencia de la regla corregida

La migración aditiva `0012` conserva las versiones existentes con el máximo nuevo vacío. Esas versiones mantienen la tercera posición y el reinicio por asistencia. Para activar el 9.10, `SUPER_ADMIN` publica en `/normativa` una versión con fecha futura, posterior a las versiones programadas con la regla anterior. El formulario ofrece tres como valor inicial. La versión activa al cancelar fija el máximo, la antelación, el cupo mensual y la caducidad de esa solicitud, incluso si la resolución ocurre bajo una versión posterior.

### Cancelación individual por decisión administrativa

- `SUPER_ADMIN` puede cancelar desde el detalle una reserva ordinaria confirmada de una sesión programada y futura, con un motivo de 3 a 300 caracteres tras recortar espacios. La acción verifica permisos y pertenencia a la sesión. Una asistencia vigente impide la cancelación. La operación conserva la reserva, su origen, su historial y el horario habitual, y libera su ocupación.
- La decisión administrativa queda fuera de la racha y del cupo. Cuando despeja una clase anterior pendiente, el sistema reevalúa las solicitudes existentes del alumno. El crédito, si corresponde, se vincula a la solicitud del alumno. Una compensación por la decisión administrativa se tramita mediante la concesión manual auditada.
- La migración `0010_admin_reservation_cancellation` añade el origen explícito de la decisión y el motivo administrativo a `reservation_cancellations`. Las nuevas filas ordinarias distinguen `ADMIN_DECISION` de `STUDENT_REQUEST`. La auditoría registra reserva, alumno, sesión, ejecutor, fecha y versión normativa. La fila administrativa registra la transición de confirmada a cancelada. Los registros anteriores conservan origen y motivo desconocidos, incluso si se conoce el ejecutor.
- La cancelación usa los bloqueos de sesión, reserva y perfil del alumno del flujo ordinario. Comprueba el estado después de bloquear y guarda la transición y la auditoría en la misma transacción. Un reintento con el mismo UUID, sesión, reserva, actor y motivo normalizado devuelve la auditoría original. Una solicitud diferente sobre una reserva cancelada se rechaza.
- Calendario y detalle actualizan el aforo. La cancelación administrativa de un habitual se reconoce para esa fecha en el indicador de habituales pendientes. El historial del alumno distingue la decisión administrativa y el motivo queda en el historial de administración. Se revalidan el detalle, el calendario administrativo y el panel del alumno.

## Registro y corrección de asistencia

- `SUPER_ADMIN` puede registrar asistencia o ausencia desde el instante exacto de `ends_at_utc`, incluida la hora de fin de una sesión reprogramada. El servidor compara ese instante con su propio reloj. Las fechas de la sesión siguen las convenciones de `Europe/Copenhagen` del modelo académico.
- El alta y la corrección exigen `classSessionId` y `reservationId`. Bajo bloqueo se comprueba que la reserva pertenece a esa sesión, está confirmada y carece de cancelación, y que la sesión sigue sin cancelar. La API acepta `PRESENT` y su equivalente existente `ATTENDED`. PostgreSQL conserva `ATTENDED` y `ABSENT`.
- Repetir el alta con el mismo resultado vigente devuelve el identificador original. Cambiarlo requiere una corrección con motivo de 3 a 300 caracteres después de recortar espacios. La corrección exige un resultado anterior y rechaza repetir el vigente. Cada versión guarda resultado, reserva, actor, hora, normativa aplicada, motivo y referencia a la versión sustituida cuando corresponda.
- Las escrituras manuales bloquean sesión, reserva y perfil en ese orden. La corrección marca la versión anterior como sustituida e inserta la nueva dentro de la misma transacción. El índice parcial asegura un único resultado vigente por reserva.
- Si la cancelación de la sesión o de la reserva se confirma primero, el alta y la corrección se rechazan. Si hay un resultado vigente, se rechazan la cancelación de esa reserva, la cancelación de su sesión y los cambios del horario de esa sesión. Las cancelaciones tardías siguen siendo cancelaciones. Ante datos históricos que combinan ambos estados, el historial de clases muestra la cancelación y los registros originales quedan disponibles para auditoría.
- Registrar o corregir asistencia conserva los movimientos consolidados. Con la regla del 9.10, ambos resultados reinician la racha y pueden desbloquear solicitudes de cancelación anteriores. Si se concede un crédito, el movimiento se vincula a la solicitud del alumno. [Cancelaciones y secuencias](#cancelaciones-y-secuencias)
- El detalle administrativo incluye **Control de asistencia**. La consulta trae el resultado vigente junto con cada reserva y conserva las cancelaciones en su historial. El formulario aparece al consultar una sesión elegible y vuelve a cargar sus resultados tras guardar. La corrección ofrece el resultado alternativo y usa las mismas garantías del servicio. [Cobertura y pruebas](testing.md#incremento-92--control-de-asistencia-en-el-detalle-de-sesión)

## Detección de ausencias

- Para reservas confirmadas sin cancelación ni resultado vigente de sesiones finalizadas, la operación existente inserta `ABSENT`. La acción de servidor usa su propio reloj. El servicio admite un corte anterior y limita los cortes futuros al instante actual.
- La detección bloquea en orden de identificador las sesiones con candidatas y vuelve a leer las reservas después de adquirir los bloqueos. Así comparte la exclusión con las cancelaciones y el registro manual. Su activación automática queda pendiente.
- La operación es idempotente por reserva y evita duplicados bajo reintentos.
- La generación de identificadores de asistencia automática se hace en aplicación (sin dependencia de extensiones PostgreSQL como `pgcrypto`).

## Créditos

- Integración automática:
  - al cancelar, si la cancelación queda como candidata elegible, se intenta generar crédito automático en la misma transacción.
- Reglas aplicadas:
  - límite inicial de 2 créditos automáticos por alumno y mes natural de cancelación en `Europe/Copenhagen`,
  - la concesión manual no consume ese límite,
  - idempotencia por cancelación para evitar duplicados.
- Caducidad:
  - cada `AUTO_CANCELLATION_GRANT` guarda la caducidad calculada con la versión de la cancelación, inicialmente 6 meses,
  - `EXPIRATION` descuenta solo el remanente de la concesión al vencer. Los créditos ya consumidos quedan registrados en su movimiento de consumo,
  - la disponibilidad se calcula por concesión desde el ledger. Una caducidad histórica se aplica al crédito de origen sin afectar otras concesiones.
- Gestión manual (`SUPER_ADMIN`):
  - concesión de créditos (`MANUAL_GRANT`) con motivo obligatorio,
  - retirada de créditos (`MANUAL_WITHDRAWAL`) con motivo obligatorio,
  - rechazo de retirada por encima del saldo disponible.

## Recuperaciones (Fase 06)

- Una recuperación es una reserva con `origin = MAKEUP`.
- Requisitos de reserva:
  - sesión futura en estado `SCHEDULED`,
  - capacidad disponible real (reservas + bloqueos),
  - sin reserva activa duplicada del alumno en la sesión,
  - límite inicial de 2 recuperaciones confirmadas por mes natural de la sesión (`Europe/Copenhagen`), evaluado con la versión vigente al reservar,
  - crédito FIFO disponible.
- Consumo:
  - al confirmar se crea `RECOVERY_CONSUMPTION` en la misma transacción que la reserva.
  - selección FIFO: menor caducidad, luego menor fecha de generación, luego identificador estable.
  - una reserva ordinaria activa produce un conflicto al solicitar una recuperación para la misma sesión. Un reintento recupera la reserva y su consumo. Si envía una clave de idempotencia, debe ser la clave original.
- Cancelación de recuperación:
  - con la antelación de la versión vigente al cancelar, inicialmente 7 días naturales, se crea `RECOVERY_REFUND`.
    - restaura saldo solo si el crédito origen seguía vigente;
    - si ya caducó, se registra devolución auditable sin restaurar saldo.
  - con una antelación inferior se libera la plaza y el consumo permanece.
- Cancelación administrativa de sesión:
  - el cambio a `CANCELLED` se solicita mediante la operación específica de cancelación administrativa y queda registrado con la versión aplicada.
  - se cancelan recuperaciones confirmadas y se aplica devolución auditable bajo la misma regla de vigencia.
  - la operación es transaccional: si falla una devolución, no se confirma la cancelación de sesión.
  - cada devolución mantiene referencia al consumo origen y al crédito origen (`source_movement_id`, `source_grant_movement_id`).
  - no se duplican devoluciones ante reintentos.
- Ausencia:
  - no devuelve crédito ni genera crédito automático.

## Reprogramación de sesiones y recuperaciones

- Al editar una sesión se recalcula `local_date` desde `starts_at_utc` en `Europe/Copenhagen`.
- El cómputo mensual de recuperaciones usa siempre el mes de la fecha actual de la sesión (`class_sessions.local_date`).
- Si una reprogramación mueve una sesión con reservas `MAKEUP` a otro mes y provoca que algún alumno supere el límite mensual vigente, la reprogramación se rechaza con un error de conflicto.
- No se alteran movimientos históricos del ledger durante reprogramaciones.

## Actualización operativa (fase 06.3.2.13+)

- La asignación habitual (`student_template_assignments`) ahora integra reserva automática de sesiones ya materializadas cuando:
  - la sesión está `SCHEDULED`,
  - pertenece a la misma plantilla,
  - cae dentro de la vigencia de la asignación,
  - es futura (`starts_at_utc >= now()`),
  - existe capacidad disponible real.
- Se evita crear duplicados de reserva activa para el mismo alumno y sesión.
- La operación mantiene control administrativo (`SUPER_ADMIN`) y se ejecuta en transacción.

## Perfil administrativo del alumno

- `/admin/alumnos/[studentId]` usa el UUID de `student_profiles`. El listado incluye cuentas activas y desactivadas. Desde el detalle de una sesión se conserva la semana de origen al volver. La página y el servicio exigen `SUPER_ADMIN` y devuelven el mismo resultado de recurso no encontrado para UUID inválido, inexistente o ajeno al rol alumno.
- La ficha consulta nombre, correo de la cuenta, contacto disponible, estado y fechas de alta y baja. Los horarios comparten el cálculo de vigencia de asignaciones del panel del alumno y muestran también los rangos cerrados. Las fechas y horas se presentan en `Europe/Copenhagen`.
- Las próximas clases requieren reserva confirmada, sesión programada y comienzo futuro. Para el historial se conserva una fila por reserva, incluidas las cancelaciones ya registradas de sesiones futuras. El indicador de asistencia cuenta los resultados vigentes de reservas confirmadas en sesiones válidas y excluye registros sustituidos.
- El origen de cancelación procede de la auditoría del 9.6 o del actor de la reserva si consta que el propio alumno la canceló. La ficha identifica las cancelaciones por baja mediante sus referencias a la reserva y las cancelaciones de sesión mediante la coincidencia de sesión, fecha y actor en la auditoría. Cuando falta evidencia suficiente, se conserva el tipo, la fecha y el responsable que consten y se muestra «Origen no determinado». El total de decisiones administrativas cuenta las cancelaciones individuales documentadas.
- Los créditos comparten el saldo FIFO, las fechas de vencimiento y el cálculo de caducidad del servicio de créditos. La consulta proyecta los vencimientos pendientes y muestra los movimientos persistidos del ledger. El total de utilizados representa el consumo bruto en recuperaciones. Las devoluciones se leen del ledger y muestran si hubo abono.
- Las recuperaciones comparten el criterio de reserva `MAKEUP` y la consulta de movimientos de consumo y devolución. Una recuperación figura como realizada si tiene asistencia vigente. Las sesiones pasadas sin registro y las ausencias se identifican por separado.
- El servicio usa una transacción PostgreSQL de solo lectura con una instantánea consistente para todos los datos de la ficha. Los totales académicos se calculan en PostgreSQL sobre el historial completo. Horarios, próximas clases, historial, movimientos y recuperaciones tienen paginación independiente de 20 filas y orden estable con el identificador como desempate. Créditos muestra hasta cinco fechas de vencimiento próximas.
- Las estadísticas avanzadas quedan pendientes. El indicador de racha del 9.10 está disponible en el panel del alumno con la regla corregida vigente. [Cobertura de pruebas de consulta](testing.md#incremento-97--perfil-administrativo-del-alumno)

### Edición auditada de datos

`SUPER_ADMIN` puede editar nombre, apellidos, correo de acceso, correo de contacto y teléfono en la ficha de un alumno activo. Los nombres se recortan y sus espacios consecutivos se reducen a uno. Admiten entre 1 y 120 caracteres. Los correos se normalizan como en autenticación y admiten hasta 255 caracteres. El teléfono admite de 7 a 15 dígitos y un prefijo internacional opcional. Se eliminan espacios y separadores de formato. El correo de contacto y el teléfono se pueden vaciar. La ficha de una cuenta desactivada sigue disponible para consulta.

El servidor verifica el rol y el estado de ambas cuentas dentro de la transacción. Bloquea el alumno y el perfil, y comprueba la versión del formulario antes de escribir. Un conflicto invita a recargar. Un reenvío cuyos datos ya coinciden con los actuales devuelve una confirmación sin generar otro evento.

La migración `0011` añade `student_profile_edits`. Cada modificación efectiva y su auditoría se confirman juntas. El evento conserva el administrador, el perfil, el instante, el tipo de operación y los valores anteriores y nuevos de los campos modificados. La identidad del alumno y sus referencias académicas se conservan. [Pruebas de edición](testing.md#incremento-98--edición-auditada-del-alumno)

### Historial de modificaciones

La sección de solo lectura de `/admin/alumnos/[studentId]` usa los eventos de `student_profile_edits` del alumno solicitado, incluidas las cuentas desactivadas. La página y el servicio exigen `SUPER_ADMIN`. La consulta forma parte de la instantánea de solo lectura de la ficha y se ejecuta por solicitud.

Cada operación muestra el instante en hora de Copenhague, el correo actual del administrador responsable y los valores anterior y nuevo de los campos autorizados en el 9.8. Si falta el correo del responsable, se muestra el identificador persistido. Un valor nulo figura como «Sin informar», una cadena vacía como «Campo vacío» y un lado ausente o inválido como «Valor histórico no disponible». La ficha muestra los valores como texto y omite los campos desconocidos o con valores iguales.

PostgreSQL devuelve páginas independientes de 20 eventos, en orden descendente por fecha e identificador. Los parámetros inválidos o las páginas sin registros muestran la primera página. Los cambios recién guardados aparecen al actualizar la primera página. La vista reutiliza el esquema y el formulario existentes. [Pruebas del historial](testing.md#incremento-99--historial-de-modificaciones-del-alumno)

## Siguiente tarea de generación de sesiones

Durante la generación y sus reintentos, el servicio devuelve las sesiones afectadas dentro del horizonte en `habitualCapacityConflicts` y el CLI imprime sus identificadores. La prioridad entre alumnos elegibles sigue pendiente para una futura asignación automática.

Para localizar sesiones concretas fuera de ese informe, consultar `class_sessions` y cruzar plantilla y fecha local con las asignaciones vigentes de alumnos activos. Contar alumnos distintos sin reserva confirmada y comparar con el aforo efectivo menos las reservas confirmadas y los bloqueos activos.

La revisión en solo lectura encontró un único conflicto entre las cinco sesiones de TEST. La sesión del 13 de enero de 2099 coincide con la fixture de `habitual-assignment.integration.test.ts` en plantilla, fechas asociadas, aforo y reservas. Hay una reserva confirmada, cero bloqueos y un alumno habitual pendiente para una capacidad de una plaza. Ninguna sesión excede el aforo contando solo reservas confirmadas y bloqueos. DEV local no contiene sesiones.

`SUPER_ADMIN` dispone de las acciones de servidor `createReservationAction` para asignar una plaza ordinaria disponible y `updateClassSessionAction` para ampliar el aforo si procede dentro del máximo vigente. La edición queda registrada. El panel actual permite inscribir en un curso o clase única. La vista de incidencias y la resolución manual de sesiones recurrentes desde el panel quedan para la fase 9 del [plan general](../planificacion_general.md). El desempate automático requiere una decisión propia. El generador conserva las reservas existentes.
