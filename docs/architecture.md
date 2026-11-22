# Arquitectura técnica (Prompt 01)

## Objetivo

Separar responsabilidades desde el inicio para mantener reglas de negocio fuera de la UI y preparar transacciones seguras en servidor.

## Estructura adoptada

- `app/`
  - Rutas de Next.js App Router y composición de interfaz.
  - Server Components por defecto.
- `src/domain/`
  - Elementos de dominio puros (sin dependencias de infraestructura).
  - En esta fase: estrategia de zona horaria + identidad + reglas académicas de recurrencia/capacidad + utilidades de ledger de créditos.
- `src/application/`
  - Casos de uso/coordinación de operaciones.
  - En esta fase: autenticación, servicios académicos (plantillas, sesiones, asignaciones, reservas/cancelaciones/asistencia), normativa versionada, créditos y recuperaciones.
- `src/infrastructure/`
  - Implementaciones técnicas: entorno, logging, errores, base de datos, esquemas, hashing, rate limiting y persistencia académica.
  - Incluye ledger transaccional de créditos con claves de idempotencia e índices de concurrencia.
- `src/interfaces/`
  - Integración con Next.js para sesión/cookies, auth y acciones académicas de servidor.

## Principios aplicados

1. **Server-first**: módulos de infraestructura protegidos con `server-only`.
2. **Sin lógica de negocio en componentes visuales**.
3. **Sin acceso directo a DB desde UI**.
4. **Configuración centralizada**: entorno, DB, fechas y logging.
5. **Preparado para crecer por fases** sin introducir abstracciones vacías.

## Normativa académica versionada

- `/normativa` exige sesión y muestra los valores vigentes a alumnos y administradores. El servidor verifica el rol `SUPER_ADMIN` para publicar y consultar el historial.
- La versión aplicable es la última con fecha de entrada en vigor igual o anterior a la fecha de la operación en `Europe/Copenhagen`. La entrada en vigor comienza a medianoche local. La publicación exige una fecha futura para preservar lo que estaba vigente en días previos.
- Cada publicación registra el usuario, la fecha y hora, la versión con la que se comparó y los valores que cambiaron. Una fecha admite una sola versión. PostgreSQL impide editar o borrar las versiones publicadas.
- Las operaciones guardan la referencia aplicada y los créditos conservan su fecha original de caducidad. Las reservas guardan por separado la versión de alta y la de cancelación. Las ediciones de sesiones guardan un registro por operación en `class_session_edits`.
- Los registros anteriores a la migración conservan sus resultados y la referencia queda vacía cuando falta una versión verificable. La publicación solo añade una versión.

La aplicación y el CLI comparten la reserva habitual y se coordinan por plantilla con las altas y bajas de asignaciones. La [siguiente tarea de generación de sesiones](academic-model.md#siguiente-tarea-generación-de-sesiones) recoge la decisión pendiente sobre el aforo insuficiente.

## Orden global de bloqueo (concurrencia)

Para operaciones que combinan reservas, sesiones y ledger se sigue este orden para minimizar interbloqueos:

1. `class_sessions` (fila de sesión, `FOR UPDATE`) cuando la operación depende de capacidad/estado de sesión.
2. `student_profiles` (fila de alumno, `FOR UPDATE`) cuando la operación consume/devuelve/retira créditos.
3. `class_reservations` (fila de reserva, `FOR UPDATE`) cuando se cancela o muta una reserva concreta.
4. `credit_ledger_movements` (filas de consumo/refund, `FOR UPDATE`) para idempotencia y trazabilidad de consumo/devolución.

Notas:

- `reserveRecovery` comprueba y bloquea la cuenta activa antes de sesión→perfil del alumno→reserva→consumo.
- `cancelRecoveryReservation` usa sesión→reserva→perfil del alumno→consumo/devolución.
- `cancelClassSession` usa sesión→reservas→alumno→consumo/devolución.
- La baja bloquea la cuenta, las plantillas y las sesiones afectadas en orden estable antes de modificar reservas. Las sesiones se bloquean con `FOR NO KEY UPDATE`, que permite las comprobaciones referenciales de movimientos de crédito concurrentes. La baja usa la misma lógica de cancelación y devolución de una recuperación individual, con el instante y la normativa de la baja.
- Los ajustes manuales bloquean en modo compartido la cuenta administrativa activa y reclaman la clave única de solicitud antes de bloquear el perfil. Un reintento espera la resolución de la clave sin bloquear el perfil ni la sesión. Si la primera transacción se confirma, el reintento recupera sus movimientos. Si se revierte, la clave vuelve a estar disponible. Las nuevas concesiones y retiradas se serializan por perfil con los demás movimientos del ledger.
- H02 sigue pendiente para los ajustes con una sesión asociada. La clave foránea del movimiento puede esperar por la sesión mientras otra operación de esa sesión espera por el perfil. El reclamo de solicitud del 10.2 carece de referencias a sesión y perfil, por lo que no incorpora esos bloqueos al camino de reintento.
