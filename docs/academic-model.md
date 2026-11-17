# Modelo académico (Prompt 04)

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
  - `ATTENDED`, `ABSENT`, `EXCUSED`.
- Soporta corrección administrativa sin borrar historial:
  - el registro anterior queda superseded (`superseded_by` + `superseded_at`),
  - el nuevo registro queda como vigente.

## Generación de sesiones recurrentes

Servicio en `src/application/academic/academic-service.ts`:

- Genera horizonte de 3 meses (configurado en dominio).
- Ignora plantillas inactivas.
- Respeta vigencia de plantilla.
- Inserta con `on conflict do nothing` para idempotencia.
- No altera sesiones existentes (incluidas editadas/canceladas).

Comando CLI:

```bash
npm run academic:generate-sessions
```

## Zona horaria y DST

- Zona oficial: `Europe/Copenhagen`.
- Recurrencia calculada en hora local y luego convertida a UTC.
- Estrategia en horas inexistentes por salto DST:
  - avanzar al siguiente minuto local válido (determinista).
- Las horas ambiguas mantienen la resolución determinista de Luxon en la zona del centro.

## Disponibilidad

Fórmula:

`disponibles = capacidad - reservas_confirmadas - plazas_bloqueadas`

- nunca negativa,
- calculada en servidor con datos de PostgreSQL,
- sin confiar en datos del cliente.

## Concurrencia en reservas

La creación de reserva usa transacción con bloqueo de fila (`FOR UPDATE`) sobre `class_sessions`:

1. Bloquea sesión.
2. Verifica estado reservable.
3. Cuenta reservas confirmadas + plazas bloqueadas.
4. Inserta reserva si hay capacidad.

Esto evita sobreventa de la última plaza por carreras concurrentes.

## Cancelaciones y secuencias

- La cancelación de reserva solo aplica sobre reservas confirmadas y actor autorizado.
- Clasificación temporal:
  - `ON_TIME`: cancelación con al menos 7 días exactos de antelación al inicio.
  - `LATE`: menos de 7 días.
- Secuencia habitual:
  - solo considera reservas de origen `ORDINARY`,
  - se resetea con `ATTENDED` o `ABSENT`,
  - la 3.ª cancelación `ON_TIME` queda candidata a recuperación,
  - desde la 4.ª cancelación consecutiva ya no genera candidato.
- La evaluación se recalcula transaccionalmente para mantener consistencia histórica.

## Detección de ausencias

- Para sesiones finalizadas sin registro vigente de asistencia/corrección, se inserta `ABSENT`.
- La operación es idempotente por reserva y evita duplicados bajo reintentos.

## Limitaciones conocidas de esta fase

- No se implementó el ledger de créditos (solo persistencia de candidatos para fase posterior).
- No se implementó reserva automática por horario habitual.
- No se implementó la normativa versionada completa.
