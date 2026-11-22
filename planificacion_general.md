Fase 0 — Auditoría del proyecto

Inspeccionar el proyecto Next.js existente, dependencias, estructura, convenciones, configuración y funcionalidades ya implementadas.

Sin modificar código innecesariamente
Fase 1 — Arquitectura y modelo de datos

Diseñar entidades, relaciones, restricciones y esquemas Drizzle. Definir migraciones PostgreSQL.

Fase 2 — Autenticación y autorización

Login, bcrypt, sesiones seguras, cookies HTTP-only, protección de rutas y roles.

Fase 3 — Gestión de alumnos

Perfiles, alta administrativa de usuarios si corresponde, edición y consulta de historial.

Fase 4 — Sistema de clases

Creación de clases semanales, horarios, capacidad máxima, alumnos inscritos y calendario.

Fase 5 — Asistencia y cancelaciones

Registro de asistencia, cancelaciones y validación de las condiciones temporales.

Fase 6 — Sistema de créditos

Ledger de créditos, límites mensuales, caducidad, movimientos y ajustes administrativos.

Fase 7 — Recuperación de clases

Búsqueda de plazas, validación de créditos, reservas y protección contra concurrencia.

Fase cerrada. La búsqueda paginada, la reserva, el consumo de créditos y la protección contra concurrencia se validaron en TEST. [Cierre y pruebas](docs/testing.md#fase-07--disponibilidad-y-concurrencia-de-recuperaciones).

Fase 8 — Panel del estudiante

Calendario semanal, próximas clases, historial, créditos y recuperación.

Fase cerrada. El panel del estudiante incluye calendario semanal, próximas clases, horarios habituales, historiales, saldo y vencimientos, cancelaciones, búsqueda de recuperaciones y normativa vigente. [Cierre y pruebas](docs/testing.md#fase-08--calendario-semanal-del-alumno).

Fase 9 — Panel administrativo

Calendario global, perfiles, estadísticas, bloqueos de plazas y gestión de créditos.

El calendario global muestra las incidencias de aforo. El detalle de sesión permite consultar inscritos y cancelaciones, gestionar asistencia, bloquear y desbloquear plazas, inscribir a un alumno y cancelar con auditoría una reserva ordinaria futura. Una decisión administrativa libera la plaza y deja intactos el saldo y la racha del alumno. [Avance y pruebas](docs/testing.md#incremento-96--cancelación-individual-auditada)

El incremento 9.7 incorporó la consulta en `/admin/alumnos/[studentId]` para cuentas activas y desactivadas, con horarios, próximas clases, historial, créditos y recuperaciones. [Modelo y reglas](docs/academic-model.md#perfil-administrativo-del-alumno) · [Pruebas del 9.7](docs/testing.md#incremento-97--perfil-administrativo-del-alumno)

El incremento 9.8 permite editar los datos personales y de contacto de alumnos activos con control de concurrencia y auditoría transaccional. [Edición auditada](docs/academic-model.md#edición-auditada-de-datos) · [Pruebas del 9.8](docs/testing.md#incremento-98--edición-auditada-del-alumno)

El incremento 9.9 añade a la ficha el historial paginado y de solo lectura de las modificaciones administrativas, disponible para `SUPER_ADMIN` en cuentas activas y desactivadas. [Modelo y reglas](docs/academic-model.md#historial-de-modificaciones) · [Pruebas del 9.9](docs/testing.md#incremento-99--historial-de-modificaciones-del-alumno)

El incremento 9.10 corrige la racha habitual y difiere los créditos cuando falta un resultado anterior necesario. El cupo corresponde al mes de solicitud y la caducidad empieza en la concesión efectiva. La regla se activa al entrar en vigor una nueva versión de normativa con el máximo configurable. [Semántica y vigencia](docs/academic-model.md#cancelaciones-y-secuencias) · [Pruebas del 9.10](docs/testing.md#incremento-910--racha-y-créditos-pendientes)

El incremento 9.11 incorpora en el calendario administrativo los indicadores semanales de sesiones, asistencia, cancelaciones y aforo. [Definiciones](docs/academic-model.md#resumen-semanal-administrativo) · [Pruebas del 9.11](docs/testing.md#incremento-911--resumen-semanal-administrativo)

Fase 10 — Seguridad y pruebas

Tests unitarios, integración, E2E, autorización, concurrencia y revisión de posibles vulnerabilidades.

El incremento 10.2 corrige H01. La redirección de éxito de los ajustes quedaba atrapada después de confirmar la transacción. Los formularios ahora muestran un resultado estructurado y actualizan el panel tras la confirmación. Conservan el UUID cuando se pierde la respuesta y PostgreSQL registra el ajuste completo de forma idempotente. [Modelo](docs/academic-model.md#solicitudes-de-ajustes-manuales-de-créditos) · [Pruebas](docs/testing.md#incremento-102--ajustes-manuales-de-créditos)

El incremento 10.3 corrige H02. PostgreSQL reprodujo el interbloqueo entre un ajuste vinculado a sesión y la cancelación global. El ajuste adquiere ahora `FOR KEY SHARE` sobre la sesión antes del perfil. Las peticiones sin sesión y los reenvíos confirmados conservan su camino anterior. [Orden de bloqueos](docs/architecture.md#orden-global-de-bloqueo-concurrencia) · [Pruebas](docs/testing.md#incremento-103--orden-de-bloqueos-en-ajustes-de-créditos)

El incremento 10.4 corrige H04. La cancelación del alumno bloquea y revalida su cuenta antes de la sesión. Si la baja se confirmó primero, la cancelación se rechaza. Si la cancelación obtiene primero la cuenta activa, la baja espera y continúa con el estado académico resultante. [Modelo](docs/academic-model.md#cancelaciones-y-secuencias) · [Pruebas](docs/testing.md#incremento-104--revalidación-de-cuentas-en-cancelaciones)

Fase 11 — Preparación para producción

Variables de entorno, migraciones, configuración de despliegue, backups y documentación.









# PROJECT SPEC — Sistema de gestión de clases y recuperaciones

## 1. Objetivo

Desarrollar una aplicación web para gestionar alumnos, clases semanales, asistencia, cancelaciones, créditos y recuperación de clases.

La aplicación tendrá dos roles:

- STUDENT: alumno que consulta sus clases y gestiona sus cancelaciones y recuperaciones.
- SUPER_ADMIN: administrador con control completo del sistema.

No existirá registro público de usuarios. El administrador será responsable de crear las cuentas de los alumnos.

## 2. Stack tecnológico previsto

- Next.js con App Router.
- React Server Components.
- TypeScript.
- PostgreSQL.
- Drizzle ORM.
- bcrypt para hashing de contraseñas.
- Tailwind CSS.
- shadcn/ui.
- Lucide Icons.
- Zod para validación.
- date-fns para operaciones con fechas.
- Vitest para pruebas unitarias e integración.
- Playwright para pruebas E2E.

Antes de introducir estas dependencias se deberá comprobar qué tecnologías y versiones existen en el proyecto.

## 3. Usuarios y autenticación

### Estudiantes

Los alumnos podrán:

- Iniciar sesión mediante email y contraseña.
- Consultar sus próximas clases.
- Consultar su calendario semanal.
- Cancelar sus clases habituales.
- Consultar sus créditos.
- Consultar sus cancelaciones y asistencias.
- Buscar clases futuras disponibles.
- Solicitar recuperaciones.
- Consultar la normativa vigente.

### Superadministrador

El administrador podrá:

- Iniciar sesión.
- Crear alumnos y establecer sus contraseñas.
- Editar alumnos.
- Desactivar alumnos mediante eliminación lógica.
- Consultar perfiles e historiales.
- Gestionar clases y horarios.
- Gestionar inscripciones.
- Registrar asistencia.
- Gestionar créditos.
- Bloquear y desbloquear plazas.
- Consultar estadísticas.
- Configurar la normativa.

### Seguridad

- Contraseñas almacenadas exclusivamente mediante hashing bcrypt.
- Nunca almacenar contraseñas en texto plano.
- Sesiones seguras almacenadas en PostgreSQL.
- Cookies HTTP-only, Secure en producción y SameSite apropiado.
- Protección de rutas y operaciones en el servidor.
- Validación de permisos en cada operación sensible.
- Ningún estudiante puede acceder a información privada de otros estudiantes.
- No confiar en comprobaciones de permisos realizadas exclusivamente en el cliente.
- No permitir registro público.

## 4. Organización de clases

Existirán dos conceptos:

### Plantillas semanales

Definen los horarios recurrentes, por ejemplo:

- Martes 18:00.
- Jueves 19:00.

### Clases individuales

Representan cada sesión concreta del calendario.

El administrador podrá:

- Crear plantillas semanales.
- Modificar horarios recurrentes.
- Crear clases individuales.
- Modificar clases concretas sin alterar necesariamente la plantilla.
- Cancelar o eliminar sesiones futuras.
- Gestionar alumnos inscritos.

Los alumnos tendrán horarios habituales asignados.

Las recuperaciones podrán realizarse en cualquier clase futura, sin exigir que coincida con el horario habitual del alumno.

Cada clase tendrá una capacidad física máxima de 12 alumnos.

Las plazas bloqueadas por administración también consumirán capacidad.

## 5. Cancelaciones

El alumno podrá cancelar una clase en cualquier momento.

### Cancelación anticipada

Si cancela con al menos 7 días naturales de antelación:

- Se libera la plaza.
- Puede generar un crédito.
- La generación está sujeta a los límites establecidos.
- Se registra la fecha y hora de cancelación.

### Cancelación tardía

Si cancela con menos de 7 días:

- Puede cancelar igualmente.
- Se libera la plaza.
- No recibe crédito.
- No se considera falta de asistencia.
- Se registra como cancelación tardía.

La aplicación debe calcular el plazo utilizando la hora real de la clase y la hora de cancelación.

### Cancelaciones consecutivas

- Se consideran las clases habituales asignadas al alumno, independientemente del día de la semana.
- Las tres primeras cancelaciones consecutivas pueden generar créditos, si cumplen los demás límites.
- La cuarta y las posteriores de esa misma secuencia no generan créditos.
- Una asistencia real interrumpe y reinicia la secuencia.
- Las cancelaciones tardías también cuentan como cancelaciones para esta secuencia.
- Una falta de asistencia sin cancelación no genera créditos y rompe la secuencia de cancelaciones consecutivas.

El sistema deberá mostrar al alumno su situación de cancelaciones consecutivas y el impacto que puede tener en la generación de créditos.

## 6. Ausencias

Cuando el alumno no cancela y no asiste:

- Se registra una falta de asistencia.
- No recibe crédito.
- No se descuentan créditos.
- La falta queda reflejada en su historial.
- El administrador puede consultar el total de faltas y tomar medidas.

No se deben confundir cancelaciones tardías con ausencias.

La asistencia y las ausencias deberán poder registrarse y corregirse por el administrador, dejando constancia de las modificaciones.

## 7. Sistema de créditos

Se implementará un sistema de movimientos de créditos (Credit Ledger).

Cada movimiento deberá registrar:

- Alumno.
- Tipo de movimiento.
- Cantidad de créditos.
- Fecha.
- Motivo.
- Clase relacionada cuando corresponda.
- Administrador responsable cuando sea una modificación manual.

### Reglas

- Máximo de 2 créditos generados por alumno y mes natural.
- Los créditos caducan individualmente a los 6 meses de su generación.
- Los créditos válidos se pueden acumular.
- No existe límite general de saldo acumulado.
- El administrador puede conceder créditos manualmente.
- El administrador puede retirar créditos manualmente.
- Cada modificación debe quedar auditada.

Los límites de generación y consumo son independientes.

## 8. Recuperación de clases

- El alumno necesita al menos un crédito válido.
- Puede recuperar en cualquier clase futura.
- La clase debe tener plazas disponibles.
- El máximo es de 2 recuperaciones por mes natural.
- El límite corresponde al mes en que se realiza la recuperación, no al mes en que se canceló la clase original.
- El crédito se consume al confirmar la reserva de recuperación.
- La reserva y el consumo deben ser atómicos.
- No se puede utilizar dos veces el mismo crédito.

La aplicación debe impedir que dos alumnos reserven simultáneamente la última plaza disponible.

## 9. Disponibilidad y bloqueo de plazas

Se distinguirán:

- Plazas ocupadas.
- Plazas libres.
- Plazas bloqueadas por administración.

El estudiante solamente verá plazas realmente disponibles para recuperación.

El administrador podrá:

- Bloquear plazas individuales.
- Desbloquear plazas.
- Consultar el motivo del bloqueo.
- Consultar la capacidad real de cada clase.
- Consultar las cancelaciones que han liberado plazas.

La disponibilidad se calculará en el servidor.

## 10. Panel del estudiante

Debe incluir:

- Próximas clases.
- Calendario semanal.
- Horarios habituales.
- Cancelación de clases.
- Créditos disponibles.
- Créditos próximos a caducar.
- Historial de clases.
- Historial de cancelaciones.
- Historial de recuperaciones.
- Buscador de clases futuras disponibles.
- Normativa vigente.

## 11. Panel administrativo

Debe incluir:

- Calendario semanal global.
- Alumnos inscritos en cada clase.
- Capacidad total.
- Plazas ocupadas.
- Plazas bloqueadas.
- Plazas disponibles.
- Cancelaciones.
- Asistencia.
- Gestión de reservas.
- Gestión de créditos.
- Bloqueos de plazas.
- Creación y edición de clases.
- Creación y gestión de usuarios.
- Perfiles individuales.
- Estadísticas de cada alumno.
- Configuración de normativa.

## 12. Perfil del alumno

El administrador podrá consultar:

- Datos personales.
- Estado de la cuenta.
- Horarios habituales.
- Clases asignadas.
- Clases asistidas.
- Cancelaciones anticipadas.
- Cancelaciones tardías.
- Ausencias.
- Recuperaciones realizadas.
- Recuperaciones pendientes.
- Créditos disponibles.
- Créditos utilizados.
- Créditos caducados.
- Secuencia de cancelaciones consecutivas.

Las estadísticas deberán derivarse de registros persistentes y fiables.

## 13. Eliminación de alumnos

Se implementará eliminación lógica (soft delete).

Al eliminar un alumno:

- Su cuenta queda desactivada.
- Pierde inmediatamente el acceso.
- Se conserva su historial.
- No se eliminan movimientos de créditos.
- No se eliminan registros de asistencia.
- No se eliminan registros de auditoría.

La regla acordada e implementada para las reservas futuras y el crédito asociado se documenta en [Baja definitiva y plazas](docs/academic-model.md#baja-definitiva-y-plazas).

## 14. Normativa configurable y visible

Existirá una sección de normativa accesible para estudiantes y administradores.

Los valores iniciales serán:

- Anticipación mínima: 7 días naturales.
- Máximo de créditos generados: 2 por mes natural.
- Máximo de recuperaciones: 2 por mes natural.
- Caducidad de créditos: 6 meses.
- Máximo de cancelaciones consecutivas que pueden generar crédito: 3.
- Capacidad máxima por clase: 12 alumnos.

La normativa deberá ser configurable desde el panel administrativo.

Se implementará un historial de versiones de normativa que registre:

- Versión.
- Fecha de entrada en vigor.
- Valores anteriores y nuevos.
- Administrador responsable.
- Fecha de modificación.

Las operaciones históricas conservarán información suficiente para conocer qué reglas se aplicaron cuando se realizaron.

## 15. Auditoría

Las operaciones administrativas importantes deberán registrar:

- Usuario responsable.
- Acción.
- Entidad afectada.
- Identificador de la entidad.
- Fecha y hora.
- Valores anteriores cuando corresponda.
- Valores nuevos cuando corresponda.
- Motivo cuando sea necesario.

Los registros de auditoría no deben poder ser modificados por estudiantes.

## 16. Modelo de datos preliminar

Entidades candidatas:

- users
- student_profiles
- weekly_schedules
- classes
- class_enrollments
- attendance_records
- credit_accounts
- credit_transactions
- makeup_bookings
- blocked_class_slots
- system_settings
- policy_versions
- audit_logs

El modelo definitivo se establecerá después de auditar el proyecto y diseñar las relaciones, restricciones e índices.

## 17. Requisitos técnicos críticos

- PostgreSQL será la fuente de verdad.
- Drizzle ORM gestionará esquemas y migraciones.
- Las operaciones críticas deberán utilizar transacciones.
- Las reservas deberán estar protegidas contra concurrencia.
- No se permitirá superar la capacidad de 12 alumnos.
- Los créditos no podrán duplicarse ni consumirse dos veces.
- Las operaciones sensibles deberán validarse en el servidor.
- Se aplicará validación de entradas.
- Se evitarán consultas N+1.
- Se aplicarán índices adecuados.
- Se utilizarán restricciones de integridad referencial.

## 18. Documentación y continuidad del proyecto

Antes de ejecutar cualquier fase:

1. Inspeccionar los archivos Markdown existentes.
2. Leer la documentación técnica relevante.
3. Consultar el estado real del código.
4. Comprobar dependencias, configuración, migraciones y pruebas.
5. Detectar contradicciones entre documentación y código.
6. No asumir que el historial de conversación representa el estado real.

Después de cada fase:

1. Actualizar la documentación existente.
2. Registrar decisiones técnicas.
3. Registrar pruebas ejecutadas.
4. Registrar funcionalidades terminadas y pendientes.
5. Preparar el contexto para la siguiente fase.

No crear documentación duplicada innecesariamente.

## 19. Criterios generales de calidad

- Código TypeScript mantenible.
- Separación de responsabilidades.
- Componentes reutilizables.
- Server Components por defecto.
- Client Components solamente cuando sean necesarios.
- Server Actions o Route Handlers según corresponda.
- Seguridad por defecto.
- Pruebas automatizadas.
- Diseño responsive.
- Interfaz accesible.
- Documentación actualizada.

**Propuesta pendiente de planificación.** Realizar una revisión visual transversal de los paneles y páginas compartidas. Comprobar la consistencia de navegación y estados, el diseño en móvil y escritorio y el uso con teclado. Quedan por acordar su alcance y el momento de ejecución.

Este documento define los requisitos funcionales de referencia. Las decisiones técnicas definitivas deberán respetar el estado real del repositorio y quedar documentadas antes de implementar cambios importantes.
