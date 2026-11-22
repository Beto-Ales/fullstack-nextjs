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

Los flujos de H02, H04 y H06 adquieren estos bloqueos en orden. El bloqueo del perfil es `FOR UPDATE` salvo donde se indica `FOR KEY SHARE`.

| Flujo | Orden de bloqueo y escritura |
| --- | --- |
| Concesión y retirada manual nuevas | Cuenta administrativa `FOR SHARE` → clave única de solicitud → sesión `FOR KEY SHARE` si se indicó → perfil → movimientos del ledger. Una retirada distribuida mantiene los bloqueos hasta confirmar todos los movimientos. |
| Reenvío manual | Cuenta administrativa `FOR SHARE` → comprobación de la clave única. Si la solicitud se confirmó, se leen los movimientos iniciales sin bloquear sesión ni perfil. Si la primera transacción se revierte, la clave vuelve a estar disponible. |
| Cancelación global | Sesión `FOR UPDATE` → perfiles ordenados por ID → reservas → movimiento de consumo y devolución si hay recuperaciones. |
| Reprogramación | Sesión `FOR UPDATE` → perfiles ordenados por ID si cambia el horario → actualización y auditoría de sesión → reevaluación de cancelaciones pendientes. |
| Alta ordinaria individual | Cuenta del alumno `FOR SHARE` → cuenta del autor `FOR KEY SHARE` si se registra → sesión `FOR UPDATE` → perfil `FOR KEY SHARE` → comprobación temporal → inserción. |
| Alta de recuperación | Cuenta del alumno `FOR SHARE` → sesión `FOR UPDATE` → perfil → comprobación temporal → inserción de reserva y consumo. |
| Cancelación individual ordinaria o de recuperación | Si el actor es `STUDENT`, cuenta propia `FOR SHARE` y validación de cuenta activa → sesión `FOR NO KEY UPDATE` → reserva `FOR UPDATE` → perfil → actualización y auditoría o devolución, según corresponda. La cancelación administrativa comienza en la sesión. |
| Baja lógica | Cuenta del alumno `FOR NO KEY UPDATE` → plantillas y sesiones en orden estable → perfil → baja, revocación de sesiones de acceso y actualización académica. |

Antes de 10.3, el ajuste tomaba el perfil y su inserción en el ledger solicitaba `FOR KEY SHARE` sobre la sesión al comprobar la clave foránea. Si una operación académica ya tenía `FOR UPDATE` sobre la sesión y esperaba el mismo perfil, ambas transacciones esperaban entre sí. PostgreSQL 15 devolvió `40P01` en la prueba con la cancelación global. Tomar `FOR KEY SHARE` antes del perfil protege la referencia frente a borrados o cambios de clave y es compatible con `FOR NO KEY UPDATE`. La comprobación posterior de la clave foránea usa el mismo modo.

La clave primaria de solicitud sigue coordinando los reenvíos. Los índices únicos por clave de movimiento, consumo, devolución y reserva activa siguen respaldando los flujos académicos. [Pruebas de H02](testing.md#incremento-103--orden-de-bloqueos-en-ajustes-de-créditos)

Antes de 10.4, una cancelación autenticada podía continuar tras la baja porque la comprobación de titularidad leía el perfil sin proteger el estado de la cuenta. `FOR SHARE` de la cancelación y `FOR NO KEY UPDATE` de la baja compiten sobre la misma fila de cuenta. Si la baja gana, PostgreSQL vuelve a evaluar el filtro de rol y estado al terminar la espera y se devuelve `student_inactive` antes de bloquear sesión, reserva o perfil. Si la cancelación gana, la baja espera y procesa el estado ya confirmado. Los bloqueos referenciales `FOR KEY SHARE` son compatibles con el bloqueo compartido de la cuenta. El orden de sesión y perfil establecido para los ajustes vinculados en H02 se conserva. [Pruebas de H04](testing.md#incremento-104--revalidación-de-cuentas-en-cancelaciones)

En H06, el alta ordinaria adelanta los bloqueos referenciales del perfil y del autor, si hay autor, que antes se adquirían implícitamente al insertar. En particular, el perfil puede estar bloqueado por el ledger y la reserva puede quedar esperando. La recuperación ya bloqueaba el perfil, pero comprobaba la hora antes de hacerlo, y la entrada ordinaria genérica solo comprobaba el estado. La guarda compartida consulta `clock_timestamp()` sobre la fila de sesión protegida inmediatamente antes de insertar. Una reprogramación que se confirma primero determina la hora vigente. La admisión se define en esa consulta y el commit puede ocurrir después del inicio. [Pruebas de H06](testing.md#incremento-105--validación-del-inicio-de-sesión-al-reservar)
