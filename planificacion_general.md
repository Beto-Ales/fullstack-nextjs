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

El incremento 10.5 corrige H06. Las nuevas reservas individuales aplican el mismo corte temporal con el reloj real de PostgreSQL tras los bloqueos y antes de insertar. Las recuperaciones conservan su consumo atómico y las operaciones ya confirmadas conservan el resultado de sus reintentos. [Modelo](docs/academic-model.md#concurrencia-en-reservas) · [Pruebas](docs/testing.md#incremento-105--validación-del-inicio-de-sesión-al-reservar)

El incremento 10.6 corrige H08. Cada proceso de pruebas con escritura verifica un PostgreSQL desechable propio antes de migrar, iniciar Next.js o manipular fixtures. Vitest falla explícitamente sin esa verificación y Playwright rechaza servidores HTTP ajenos. [Comandos](docs/testing.md#comandos-vigentes-desde-106) · [Diseño](docs/architecture.md#aislamiento-de-pruebas-postgresql)

El incremento 10.7 corrige H05. PostgreSQL reserva en una sola transacción las oportunidades de login del correo normalizado y del presupuesto general. El correo se deriva con HMAC y las cabeceras quedan fuera del cálculo. El login compara con bcrypt también cuando el correo no existe o la cuenta está desactivada. El despliegue necesita la migración 0014 y el secreto compartido entre instancias. [Política](docs/authentication.md#limitación-de-intentos-de-login) · [Pruebas](docs/testing.md#incremento-107--presupuesto-compartido-de-login)

El incremento 10.8 prepara H07. El ensayo lleva los esquemas 0005 y 0006 hasta 0014 con datos sintéticos y comprueba la recuperación de una copia en un contenedor nuevo. La inspección de los entornos persistentes fue de solo lectura. La actualización real y la publicación de normativa requieren decisiones y autorizaciones independientes. [Inventario y procedimiento](docs/postgres-upgrade-recovery.md)

El incremento 10.9 aborda H09. La generación y las asignaciones habituales ordenan los bloqueos por plantilla, sesión y perfil. Las asignaciones concilian sus solicitudes pendientes en la misma transacción. Los paneles y las consultas de recuperación usan el ledger y su proyección FIFO en modo de solo lectura. La regularización de candidatos históricos requiere una autorización independiente. [Orden de bloqueos](docs/architecture.md#orden-global-de-bloqueo-concurrencia) · [Inventario de pendientes](docs/academic-model.md#inventario-de-solicitudes-anteriores-a-h09)

La fase 10 queda **cerrada como desarrollo** el 23 de noviembre de 2026, con riesgos operativos y requisitos de producción documentados por separado. [Cierre técnico](#cierre-de-la-fase-de-desarrollo-10)

Fase 11 — Preparación para producción

Variables de entorno, migraciones, configuración de despliegue, backups y documentación.

El incremento 11.1 ensaya el despliegue completo sin tocar entornos persistentes. `npm run staging:rehearse` aprovisiona dos instancias PostgreSQL 15 desechables, aplica el prefijo `0000`–`0004` y después el journal hasta `0016`, siembra datos sintéticos, verifica un respaldo lógico y su restauración equivalente, compila con un entorno inerte y arranca `next start` para comprobar sesiones administrativas y de alumno. La ejecución del 23 de noviembre de 2026 terminó con **66 comprobaciones** y conservó la línea base de pruebas; DEV, TEST y producción no se modificaron. El ensayo valida el procedimiento de despliegue, no un staging alojado ni el cierre de H03. [Procedimiento, aislamiento y límites](docs/staging-deployment.md)








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

El incremento 10.10 revisa la navegación y el teclado en los paneles existentes. Añade accesos a las secciones, conserva la semana al consultar créditos, mejora el foco en formularios y paginación de recuperaciones y corrige el desbordamiento móvil. El calendario y el bloque de perfiles del panel administrativo siguen siendo los puntos de entrada a sesiones y alumnos. [Cobertura y mejoras menores pendientes](docs/testing.md#incremento-1010--navegación-móvil-y-teclado)

El incremento 10.11 unifica los formatos visibles de los historiales de ambos roles. Las fechas de calendario conservan su día. Los instantes se presentan en español en la hora de Copenhague y muestran el desplazamiento horario. Las cantidades distinguen los movimientos del saldo, los vencimientos y las solicitudes pendientes. [Convenciones y pruebas](docs/testing.md#incremento-1011--fechas-horas-y-créditos-en-los-historiales)

El incremento 10.12 expresa los desplazamientos horarios y los signos de créditos en palabras para las tecnologías de asistencia. El historial del alumno identifica la fecha original de las solicitudes pendientes y su exclusión del saldo. La pronunciación con NVDA queda pendiente de comprobación manual. [Pruebas y recorrido manual](docs/testing.md#incremento-1012--accesibilidad-de-fechas-movimientos-y-solicitudes-pendientes)

El incremento 10.13 completa el diagnóstico local de H03 y protege los informes de staging accidental. H03 queda pendiente de que el propietario confirme el alcance y la vigencia de las credenciales históricas y autorice las medidas operativas que correspondan. [Diagnóstico y procedimiento de contención](docs/secret-exposure-response.md)

El incremento 10.15 corrige R14-01: la finalización de asignaciones habituales rechaza intervalos invertidos antes de conciliar créditos pendientes. La anulación de una asignación futura requiere un flujo propio. [Modelo académico](docs/academic-model.md)

El incremento 10.16 confirma que la baja de cuenta aún puede invertir el intervalo de una asignación futura. La propuesta de anulación explícita y auditada queda pendiente de aprobación funcional. [Evidencia y diseño](docs/design-future-assignments.md)

El incremento 10.17 implementa la anulación explícita y auditada de asignaciones futuras con `SUPER_ADMIN`, motivo e idempotencia por asignación. La baja deja de invertir intervalos: anula las futuras conservando sus fechas y cierra las iniciadas con el día local. La generación y las lecturas de habitualidad excluyen las anuladas; las reservas sin procedencia demostrable se conservan e informan para revisión. La migración aditiva `0015_future_assignment_cancellation` añade el estado y la auditoría. El inventario histórico queda pendiente. [Modelo académico](docs/academic-model.md#anulación-de-asignaciones-futuras)

El incremento 10.18 expone la anulación en la ficha administrativa del alumno. La acción aparece solo para cuentas activas, asignaciones `ACTIVE` e inicios posteriores al día local; la confirmación exige motivo, advierte de que las reservas existentes no se cancelan ni liberan plazas y delega la transacción en el servicio de 10.17. La ficha muestra el origen `ADMIN_INDIVIDUAL` o `STUDENT_WITHDRAWAL`, el actor, el instante y el motivo, y distingue una anulación nueva de un reintento idempotente. La procedencia de reservas y el saneamiento histórico siguen pendientes. [Pruebas](docs/testing.md#incremento-1018--interfaz-administrativa-para-anular-asignaciones-futuras)

El incremento 10.19 convierte el recuento de reservas ambiguas en una lista de solo lectura. La ficha lee los identificadores persistidos en la auditoría en bloque, dentro de la misma instantánea y filtrando por el perfil, y enlaza cada reserva con su sesión conservando la semana. El recuento vigente se deriva del estado actual: solo cuenta reservas confirmadas en sesiones programadas que aún no han terminado; una reserva cancelada o una sesión pasada deja de requerir revisión sin alterar la auditoría. No se añadió migración, no se modifican reservas y no se afirma la procedencia de las reservas históricas. [Diseño](docs/design-future-assignments.md#implementación-1019)

El incremento 10.20 registra la procedencia de las reservas habituales. La migración aditiva `0016_habitual_reservation_provenance` añade `class_reservations.habitual_assignment_id`, una referencia anulable a la asignación con `ON DELETE SET NULL`, y su índice, sin relleno histórico. El alta escribe su propia asignación y la generación la conserva solo cuando una única asignación vigente y no anulada cubre la sesión; las coincidencias múltiples quedan sin referencia. En 10.20 no cambian la cancelación, los créditos ni la prioridad FIFO, y el inventario histórico sigue pendiente. [Pruebas](docs/testing.md#incremento-1020--procedencia-de-reservas-habituales)

El incremento 10.21 completa la anulación de asignaciones futuras con la cancelación atómica de las reservas futuras confirmadas cuya procedencia es exactamente la asignación anulada. La selección conserva sin cancelarlas las reservas de otro alumno o plantilla, las ya canceladas, las de sesiones iniciadas, las fuera de vigencia y las que otra asignación viva del mismo curso cubre en la fecha. Las candidatas sin referencia quedan en revisión administrativa; las cubiertas por otra asignación viva se conservan sin señalarse. La operación mantiene `max_capacity`, no toca el ledger, no crea solicitudes ni movimientos de crédito y registra recuentos auditados reutilizados en los reintentos. La ficha muestra ambos recuentos y la advertencia se actualiza. [Pruebas](docs/testing.md#incremento-1021--cancelación-de-reservas-vinculadas-al-anular-asignaciones)

El incremento 10.22 corrige la anulación individual para que nunca cancele recuperaciones. La cancelación automática se limita a reservas `ORDINARY` futuras, confirmadas, vinculadas a la asignación y sin otra asignación viva que cubra la fecha. Las reservas `MAKEUP` conservan su estado, su plaza y su consumo de crédito; una recuperación vinculada de forma anómala se conserva y se señala para revisión junto con las `ORDINARY` sin procedencia demostrable. La ficha distingue reservas habituales canceladas de reservas conservadas para revisión y explica el motivo por fila. Sin migraciones ni cambios de ledger o aforo. [Modelo académico](docs/academic-model.md#anulación-de-asignaciones-futuras)

El incremento 10.23 corrige R14-02: las dos consultas de solo lectura de aforo separan la capacidad física de las plazas reservables. La capacidad física y las plazas físicamente libres describen la sesión aunque ya haya empezado, terminado o esté cancelada; las plazas reservables aplican el aforo efectivo de la normativa y valen cero fuera de las sesiones futuras. Calendario, detalle administrativo y consultas comparten el predicado y devuelven estado y horas de la sesión. La admisión y su revalidación conservan la autoridad y no se añadió migración. [Modelo académico](docs/academic-model.md#disponibilidad) · [Pruebas](docs/testing.md#incremento-1023--aforo-físico-y-plazas-reservables-en-las-consultas-de-disponibilidad)

El incremento 10.24 evalúa el cierre operativo de H03 sin repetir la auditoría de 10.13. Confirma que DEV y TEST persistentes siguen siendo entornos Docker independientes con volúmenes propios y credenciales locales distintas, identifica los consumidores conocidos y comprueba que las exclusiones locales y los archivos de entorno siguen vigentes. Los 15 informes continúan fuera del índice y de las ramas, pero su contenido también es alcanzable desde 21 referencias locales de checkpoint de los agentes; el alcance de terceros y del remoto queda sin confirmar. La vigencia de las credenciales históricas, su posible reutilización y la autorización de la rotación dependen del propietario, por lo que H03 sigue pendiente de acción operativa. [Evidencia y procedimiento](docs/secret-exposure-response.md)

El incremento 10.25 prepara, sin ejecutarla, la rotación de la credencial PostgreSQL TEST persistente. Las comprobaciones de solo lectura identificaron el contenedor `fullstack_nextjs_postgres_test` con su volumen propio, la publicación en `127.0.0.1:5433`, el rol `app_test_user` como único acceso (con privilegio de superusuario), la base `fullstack_nextjs_test` con 14 tablas y 7 de 17 migraciones aplicadas, una base residual de demostración, cifrado `scram-sha-256` y ausencia de sesiones de cliente. La credencial de TEST solo la consumen dos archivos locales ignorados por Git; las suites y `db:migrate:test` usan contenedores desechables y `db:inspect -- test` entra por el socket administrativo. No existe respaldo previo, por lo que el plan exige un volcado verificado y un ensayo de restauración antes del cambio, actualización del rol y de ambos archivos, validación desde el host y evidencia de revocación por el identificador de transacción de la fila del rol, sin probar la contraseña anterior. No se cambió ninguna contraseña, no se escribieron datos y DEV no se tocó. [Procedimiento de rotación](docs/secret-exposure-response.md#incremento-1025--preparación-de-la-rotación-de-postgresql-test-persistente)

El incremento 10.26 ejecuta la parte no secreta de la rotación autorizada de la credencial PostgreSQL TEST persistente: respaldo lógico verificado y ensayo de restauración. Se generaron tres volcados en formato personalizado (base principal, base residual de demostración y base de mantenimiento), se copiaron fuera del repositorio a un directorio con permisos restringidos, se comprobó su índice con `pg_restore -l` y se cifraron con la protección de datos del perfil de Windows tras verificar el descifrado mediante resumen SHA-256. El ensayo restauró ambas bases en un contenedor `postgres:15` desechable, con datos en tmpfs y sin puertos publicados: 14 de 14 tablas con recuentos idénticos, 15 de 15 en la base residual y 7 migraciones, sin errores. El cambio de contraseña no se ejecutó: `\password` exige una terminal interactiva que el asistente no tiene, y cualquier vía automatizada habría hecho transitar el secreto por sentencias o archivos registrables, así que se detuvo el incremento y se dejó preparada una utilidad local, probada con datos ficticios, que valida desde el host y actualiza solo las dos líneas de configuración. La contraseña, los privilegios, el esquema y los datos de TEST siguen intactos; DEV no se tocó y H03 sigue pendiente de acción operativa. [Evidencia y paso manual](docs/secret-exposure-response.md#incremento-1026--respaldo-verificado-y-restauración-ensayada-de-postgresql-test)

El incremento 10.27 verifica por medios independientes la rotación de la credencial PostgreSQL TEST persistente que el propietario completó manualmente. Un único verificador `SCRAM-SHA-256` sustituye al de la línea base, con huella distinta comparada en memoria, y la fila del rol pasó del identificador de transacción 742 a 38941; el rol conserva inicio de sesión, superusuario, ausencia de caducidad y la condición de único acceso, sin cambios de privilegios. La validación desde Windows usó una conexión nueva al puerto publicado limitado al loopback con la cadena de configuración, observó como cliente la dirección de la puerta de enlace del host y por tanto la regla estricta de autenticación, y confirmó rol, base, 14 tablas públicas, 7 migraciones, 3 usuarios y 5 sesiones de clase con solo consultas de lectura. Ambos archivos locales comparten el mismo valor nuevo, no tienen claves duplicadas, siguen ignorados por Git y DEV permanece intacto; el contenedor mantiene identificador, hora de arranque, volumen, salud y cero reinicios, con la base residual en 15 tablas y sin migraciones nuevas. Los tres volcados cifrados del perfil de Windows y el ensayo de restauración de 10.26 se conservan sin descifrar. Persisten riesgos residuales: el rol es superusuario, el contenedor guarda en su configuración de arranque el valor anterior ya inoperante, los respaldos dependen del perfil del propietario y no se han confirmado copias externas ni reutilización histórica; DEV sigue sin rotar y H03 continúa pendiente de acción operativa. [Evidencia](docs/secret-exposure-response.md#incremento-1027--rotación-de-postgresql-test-verificada)

El incremento 10.28 prepara, sin ejecutarla y sin autorización, la rotación de la credencial PostgreSQL DEV persistente. Las comprobaciones de solo lectura identificaron el contenedor `fullstack_nextjs_postgres_dev` sobre PostgreSQL 15.20, con su volumen propio, publicación limitada a `127.0.0.1:5432`, saludable y sin reinicios, el rol `app_dev_user` como único acceso y con privilegio de superusuario, y dos bases: la principal con 12 tablas y 6 de 17 migraciones aplicadas, sin usuarios ni sesiones de clase, y la base de mantenimiento sin tablas. No había aplicación de desarrollo en ejecución, ni conexiones establecidas, ni transacciones abiertas. La credencial vive en dos campos locales ignorados por Git —la cadena de la aplicación y la variable de contraseña de Compose— y en los metadatos del contenedor, que hoy coinciden; el pool de la aplicación se memoiza al arrancar, por lo que exige reinicio del proceso, mientras la inspección local entra por el socket de confianza y la inspección explícita y el cliente del host permiten validar `scram-sha-256` por TCP. El plan exige respaldo de ambas bases y de los roles, cifrado con la protección del perfil de Windows, ensayo de restauración en un contenedor desechable, cambio interactivo mediante `\\password`, actualización acotada de los dos campos, validación desde el host, conservación íntegra de TEST y recuperación administrativa por el socket local. La copia de la contraseña en los metadatos de Docker se documenta como riesgo separado que solo se eliminaría recreando el contenedor, y una interpolación defectuosa en una comprobación booleana expuso una vez el valor de DEV en la salida de la sesión, sin tocar archivos ni Git, lo que convierte la rotación en la acción prioritaria. No se cambió ninguna contraseña, no se crearon respaldos, no se aplicaron migraciones y DEV y TEST permanecen intactos. [Plan y riesgos](docs/secret-exposure-response.md#incremento-1028--preparación-de-la-rotación-de-postgresql-dev)

El incremento 10.29 se detiene en la puerta de autorización de H03: la rotación efectiva de la credencial PostgreSQL DEV exige una aprobación nueva, expresa y específica del propietario que todavía no existe, de modo que no se ejecutó el respaldo, ni el ensayo de restauración, ni el cambio de contraseña, ni ninguna escritura en DEV. El preflight de solo lectura confirma que el contenedor, el volumen, el rol `app_dev_user`, la línea base del identificador de transacción 755, las dos bases, las 12 tablas, las 6 migraciones del diario, los recuentos vacíos y la ausencia de sesiones y transacciones coinciden con 10.28, y que TEST y los dos archivos de configuración locales siguen intactos. Se preparó además, fuera del repositorio, una utilidad local con orquestador y validador `.cjs`: escribe únicamente la contraseña de `DATABASE_URL` y `POSTGRES_DEV_PASSWORD`, valida desde el host antes de escribir, rechaza credenciales de TEST y cambios fuera de alcance, conserva el BOM y los saltos CRLF, y se detiene sin escribir si la validación falla. Sus autopruebas con datos ficticios superan 9 de 9 casos, el cableado real 18 de 18 comprobaciones y el validador rechaza una contraseña sintética sin emitir datos sensibles; el modo de escritura no se ejecutó. DEV sigue sin respaldo conocido y sin rotar, y H03 continúa pendiente de acción operativa. [Preflight y utilidad preparada](docs/secret-exposure-response.md#incremento-1029--preflight-de-dev-y-utilidad-local-preparada-sin-respaldo-ni-rotación)

El incremento 10.30 ejecuta la rotación autorizada de la credencial PostgreSQL DEV persistente y su verificación independiente. Primero se respaldaron la base principal, la base de mantenimiento y los metadatos de roles con `pg_dump` 15.20 en formato personalizado, se cifraron con la protección del perfil de Windows tras comprobar el descifrado por resumen SHA-256 y se guardaron fuera del repositorio en un directorio con ACL restringida, sin dejar texto claro en el disco ni temporales en el contenedor. El ensayo de restauración se repitió sobre esa copia en un contenedor desechable con datos en memoria temporal, sin volúmenes ni puertos publicados, y reprodujo 12 tablas con sus 12 propietarios, 50 índices, 12 tipos enumerados, 6 migraciones y recuentos idénticos al manifiesto, sin errores. La rotación se ejecutó con la utilidad local en modo determinista: contraseña fijada por entrada estándar, atributos del rol comparados antes y después para abortar si cambian, validación desde el host antes de escribir y actualización acotada de `DATABASE_URL` y `POSTGRES_DEV_PASSWORD`; una comprobación previa detuvo un intento sin escribir nada y la captura se corrigió con hasta tres intentos y avisos por causa. La verificación de solo lectura superó 25 comprobaciones: identificador de transacción del rol de 755 a 760, valor nuevo de 37 caracteres idéntico en ambos consumidores y distinto del de TEST, autenticación `scram-sha-256` por TCP desde el host con cliente en la puerta de enlace, rechazo `28P01` de una contraseña incorrecta, regla general de autenticación estricta, esquema y datos intactos, TEST sin reinicios y ausencia de contenedores, volúmenes o volcados residuales. Persisten como deudas declaradas la copia del valor anterior de 32 caracteres en la configuración de arranque del contenedor —solo eliminable recreándolo—, la confianza del loopback interno heredada de la imagen —inalcanzable desde el host—, el privilegio de superusuario del rol, los respaldos dependientes del perfil del propietario y la revisión pendiente de credenciales históricas; DEV queda rotado y H03 sigue pendiente de acción operativa. [Evidencia](docs/secret-exposure-response.md#incremento-1030--respaldo-rotación-y-verificación-de-la-credencial-postgresql-dev)

El incremento 10.31 evalúa el riesgo residual de H03 sin repetir las rotaciones ya verificadas y sin abrir informes ni transcripciones. Confirma DEV y TEST como mitigados con evidencia —verificador SCRAM sustituido, autenticación desde el host y rechazo de una contraseña incorrecta en DEV— y clasifica las credenciales históricas, las copias y los respaldos mediante metadatos. Los checkpoints locales suman 83 referencias —60 de agentes, 5 de Codex y 18 de la extensión del IDE—, de las cuales 37 contienen copias de los 15 informes, ninguna contiene los archivos de entorno locales y solo 8 son posteriores al inventario de 10.24, sin commits nuevos con contenido sensible; los informes siguen fuera del índice, de las ramas y de sus historiales, con las 15 exclusiones vigentes, y no hay refspec de publicación configurado. Los dos contenedores conservan el valor anterior de la variable de contraseña en su configuración de arranque, inerte para autenticarse pero sensible si se reutilizó. Quedan pendientes de comprobar la localización de los respaldos de TEST, la reutilización histórica en otros servicios y la posible sincronización externa de informes y transcripciones, y pendiente de decisión la conservación o el saneamiento de los checkpoints. Se documentan además ocho tareas de endurecimiento independientes —superusuario, confianza del loopback, dependencia de DPAPI, acceso a Docker, migraciones atrasadas y base residual de TEST— con prioridad propuesta, junto con la matriz de riesgo, el estado de los ocho criterios de cierre y cuatro decisiones concretas del propietario. No se modificó ninguna base, contenedor ni referencia y no se borró evidencia. H03 sigue **pendiente de cierre operativo**. [Riesgo residual y cierre](docs/secret-exposure-response.md#incremento-1031--evaluación-final-de-copias-históricas-reutilización-y-riesgo-residual)

El incremento 10.32 recoge las cuatro decisiones que 10.31 dejó abiertas y evalúa el cierre de H03 sin repetir la auditoría. El propietario declaró que las contraseñas históricas de DEV y TEST no se reutilizaron en otros sistemas, según su conocimiento; confirmó que los informes o transcripciones salieron del equipo hacia un repositorio remoto de código o espejo de Git, cuyo destino concreto, visibilidad y rutas no se han identificado; eligió preparar un saneamiento controlado de las copias locales en un incremento independiente, sin ejecutarlo ahora; y aceptó expresamente el riesgo residual documentado. La rotación verificada de 10.27 y 10.30 no se repite y sigue siendo la evidencia de que los valores antiguos ya no autentican en DEV ni en TEST, de modo que la difusión no reabre una exposición activa en esos servidores, aunque persiste una copia en un sistema ajeno con controles propios. El criterio de cierre que exige ausencia de exposición activa conocida sin mitigación no se cumple porque ese destino remoto sigue sin evaluar, de manera que H03 pasa a **pendiente de acción operativa** y no se declara cerrado pese a la aceptación del riesgo. Durante la redacción, la extensión del IDE creó una referencia nueva de checkpoint —84 en total frente a las 83 de 10.31—, cuyo árbol, revisado solo por nombres, no contiene los informes ni archivos de entorno reales, y ninguna cifra de este tipo debe tratarse como viva. Quedan como acciones pendientes con responsable la identificación del destino y su visibilidad, la decisión sobre la retirada de esas copias, la preparación del saneamiento local, la limpieza de los almacenes de las herramientas, la confirmación de la ubicación y retención de los respaldos y las tareas de endurecimiento independiente. No se modificó ningún contenedor, base, secreto ni respaldo, no se retiró ni alteró ninguna referencia existente y no se ejecutaron operaciones destructivas. [Decisiones y estado de H03](docs/secret-exposure-response.md#incremento-1032--decisiones-del-propietario-y-evaluación-de-cierre-de-h03)

El incremento 10.33 contrasta la publicación pública del repositorio con metadatos de solo lectura y cierra el desarrollo de la fase 10 sin repetir auditorías ni verificaciones de credenciales. `git ls-remote` anuncia una sola rama, `master`, en `edce2aa`, sin etiquetas, sin referencias de revisión y sin ninguna referencia de checkpoint. El árbol público de esa rama tiene 250 archivos: ninguna de las 15 rutas históricas, ningún `.env` real, ninguna clave, volcado ni respaldo; el único nombre con patrón de entorno es la plantilla `.env.compose.example`, cuyos marcadores son ficticios, y la carpeta `docs` publicada contiene 10 archivos, entre ellos un diagnóstico anterior a 10.31 sin valores de contraseñas. La hipótesis de filtración en esas referencias queda descartada con ese alcance: no se descargó ningún objeto, no se abrió ningún contenido y no se consultaron el historial de objetos, las réplicas del proveedor ni otros destinos, de modo que la ausencia en `master` no se presenta como ausencia universal. La rama publicada está 17 commits por detrás del desarrollo local y sus migraciones llegan a `0014` frente a `0016`, así que describe un estado anterior. H03 queda clasificado como **riesgo de credenciales activas mitigado, con saneamiento histórico pendiente**: las rotaciones verificadas de 10.27 y 10.30 siguen siendo la prueba de que los valores antiguos no autentican, y persisten copias conocidas —los 15 informes, las 84 referencias de checkpoint del último recuento y el valor anterior en la configuración de arranque de ambos contenedores— a la espera del saneamiento autorizado, por lo que el criterio 8 solo se cumple para las referencias publicadas revisadas. La verificación final repitió la batería completa sobre PostgreSQL 15 desechable —385 pruebas Vitest en 41 archivos, 50 escenarios Chromium y la regresión de créditos pendientes, todas aprobadas— junto con `typecheck`, `lint` y `drizzle-kit check` sin errores. No se modificó DEV, TEST ni producción, no se aplicaron migraciones persistentes, no se retiró ninguna referencia y no se ejecutó ninguna operación destructiva ni de publicación. [Verificación pública y clasificación](docs/secret-exposure-response.md#incremento-1033--verificación-pública-acotada-y-clasificación-de-h03) · [Pruebas finales](docs/testing.md#verificación-final-de-la-fase-10-23-de-noviembre-de-2026)

### Cierre de la fase de desarrollo 10

El desarrollo de la fase 10 queda cerrado el 23 de noviembre de 2026 con el commit local de este incremento. Cerrar la fase de desarrollo **no autoriza un despliegue** ni cierra H03: son tres estados distintos y se documentan por separado.

**Desarrollo terminado.** Los hallazgos con corrección verificada son H01 (10.2), H02 (10.3), H04 (10.4), H06 (10.5), H08 (10.6) y H05 (10.7). H09 se abordó en 10.9 con un orden global de bloqueo y la conciliación de solicitudes pendientes. R14-01 se corrigió en 10.15 y 10.17, y R14-02 en 10.23. Quedaron verificados la anulación explícita y auditada de asignaciones futuras con su interfaz y su lista de reservas ambiguas (10.17 a 10.19), la procedencia de las reservas habituales y la cancelación atómica de las vinculadas, con preservación de las recuperaciones (10.20 a 10.22), la separación entre aforo físico y plazas reservables (10.23), la rotación y verificación de las credenciales PostgreSQL de TEST (10.26 a 10.27) y DEV (10.28 a 10.30), y el diagnóstico y las decisiones de H03 (10.13, 10.24, 10.31 y 10.32).

**Seguridad mitigada con riesgos residuales.** Las credenciales DEV y TEST fueron sustituidas y verificadas; los valores anteriores no autentican. Persisten los 15 informes locales, las referencias de checkpoint de los agentes, el valor anterior en la configuración de arranque de ambos contenedores, una copia histórica en un remoto de Git sin inspeccionar y la dependencia de los respaldos del perfil de Windows. H03 sigue **abierto como deuda operativa**, clasificado como riesgo de credenciales activas mitigado con saneamiento histórico pendiente.

**Requisitos obligatorios antes de producción.**

- Aplicar el journal hasta `0016` en la base persistente del entorno de despliegue, con respaldo verificado y ensayo de restauración previo. Las bases persistentes locales conservan 6 y 7 de 17 migraciones.
- Confirmar el origen del despliegue y publicar el estado actual de la rama principal, hoy 17 commits por detrás, o acreditar que el despliegue no depende de ella.
- Desplegar con la migración `0014` aplicada y el secreto compartido de limitación de login configurado entre instancias (H05).
- Disponer de respaldo y recuperación independientes del perfil de Windows, con retención y restauración probadas.
- Reducir los privilegios de superusuario de los roles de aplicación y endurecer la autenticación interna de PostgreSQL, incluida la confianza del loopback interno.
- Recrear los contenedores persistentes para eliminar el valor anterior de la variable de contraseña de su configuración de arranque.
- Ejecutar el saneamiento autorizado de informes, checkpoints, utilidades y transcripciones, y decidir sobre los almacenes de las herramientas.
- Inventariar y resolver, con autorización propia, las asignaciones históricas sin procedencia y las solicitudes de crédito anteriores a H09.
- Completar la validación manual con lector de pantalla (NVDA) y la revisión de autorización de las consultas administrativas.

**Endurecimiento posterior, no bloqueante.** Restringir el acceso al socket de Docker, ampliar la cobertura de accesibilidad más allá de los recorridos manuales y automatizar la verificación de dependencias. El repositorio sigue sin pipeline de CI, de modo que estas comprobaciones dependen de ejecuciones manuales reproducibles.

**Verificación final.** El 23 de noviembre de 2026 pasaron 385 pruebas Vitest en 41 archivos, 50 escenarios Chromium y la regresión de créditos pendientes con normativa sintética, cada etapa sobre su propio PostgreSQL 15 desechable; `typecheck`, `lint` y `drizzle-kit check` terminaron sin errores y el esquema llega a `0016`. No se aplicaron migraciones en DEV, TEST persistentes ni producción. [Resultados](docs/testing.md#verificación-final-de-la-fase-10-23-de-noviembre-de-2026)

La fase 11 comenzó con el incremento 11.1, que ensaya el despliegue completo sobre PostgreSQL 15 desechable: journal hasta `0016`, datos sintéticos, respaldo y restauración equivalentes, compilación de producción, arranque y humo HTTP, con retirada automática de todos los recursos y sin escribir en DEV ni en TEST. [Ensayo y límites](docs/staging-deployment.md) La publicación, la configuración alojada, los respaldos operativos y el resto de la fase siguen dependiendo de los requisitos anteriores y de las autorizaciones que el propietario todavía no ha dado.

El incremento 11.2 prepara el despliegue en Vercel desde GitHub sin ejecutarlo: no hay `push`, ni proyecto creado, ni base aprovisionada. La auditoría comprobó que `next build` termina con `DATABASE_URL` vacía —dos rutas estáticas y seis bajo demanda—, que no hay middleware ni configuración de rutas que imponga el runtime Edge, que `pg` y `bcrypt` están cubiertos por `serverExternalPackages` y que el proyecto solo usa bloqueos de transacción, `SET LOCAL` y sentencias sin nombre, así que es compatible con agrupadores en modo transacción. El documento fija las seis variables que lee el código, las decisiones que el propietario debe tomar antes de desplegar —cuenta y plan, proveedor de PostgreSQL, base de Preview, dominio, protección de despliegues, migraciones y respaldo— y el procedimiento con su verificación, su rollback y sus riesgos, entre ellos Node.js 26 como valor predeterminado de la plataforma, PostgreSQL 16 o 17 sin probar, el pool de diez conexiones por instancia, el presupuesto global de intentos de login y la portada heredada de la plantilla. No se aplicó ninguna migración, no se modificó DEV, TEST ni producción y H03 sigue abierto como deuda operativa. [Procedimiento de despliegue](docs/vercel-deployment.md) [Resultados](docs/testing.md#incremento-112--preparación-del-despliegue-en-vercel-24-de-noviembre-de-2026)

El incremento 11.3 convierte en ejecución la compatibilidad del agrupador que 11.2 solo argumentaba por código, y **no llega a desplegar** porque el entorno no tiene cuenta de Vercel, credenciales de proveedor PostgreSQL ni CLI autenticada: no se creó ningún proyecto, ninguna base alojada, ningún secreto ni ninguna publicación. Lo aportado es `npm run pooler:check`, que reutiliza el aprovisionador desechable con el tipo `pooler`, migra hasta `0016` por conexión directa y ejecuta **27 comprobaciones** a través de un PgBouncer 1.26.1 en modo transacción con `DEFAULT_POOL_SIZE=5`: journal y huella de catálogo idénticos por ambas conexiones, serialización del bloqueo global 903000042, bloqueos de fila, rollback y commit, claves foráneas, `SET LOCAL statement_timeout` sin filtración, sentencias sin nombre, 20 transacciones concurrentes con idempotencia y liberación de conexiones sin `idle in transaction`. El hallazgo a registrar es que un `SET` de sesión persiste en el backend agrupado con la configuración por defecto de PgBouncer, de modo que la regla «solo `SET LOCAL` y bloqueos `_xact_`» es un requisito y no una preferencia. Queda pendiente el humo contra el endpoint alojado real, que junto con las decisiones del propietario bloquea el primer Preview. No se repitieron las suites ni el ensayo de staging, no se tocó DEV, TEST ni producción y H03 sigue abierto. [Verificación del agrupador](docs/vercel-deployment.md#verificación-real-del-agrupador-incremento-113) [Resultados](docs/testing.md#incremento-113--verificación-real-del-agrupador-24-de-noviembre-de-2026)

El incremento 11.4 fija la plataforma y se detiene ante el primer paso que exige una cuenta. El propietario eligió **Vercel Hobby con repositorio público de GitHub y PostgreSQL Neon Free** para un proyecto personal, educativo y no comercial, y el incremento contrasta esa elección con la documentación oficial: el primer despliegue de un proyecto nuevo **siempre** se clasifica como Production y compila con las variables de Production, los proyectos nuevos arrancan con Standard Protection —que protege los Preview pero deja pública la URL de producción—, Vercel Authentication con alcance *All Deployments* no requiere complemento de pago, Password Protection no existe en Hobby y proteger solo Production exige Enterprise; Neon Free ofrece 100 CU-horas por proyecto, 1 GB por proyecto y 20 GB por cuenta, 10 ramas y suspensión del compute a los cinco minutos. Con esa base se escribió la secuencia de inicialización protegida, el procedimiento de la base de ensayo con sus dos cadenas y `sslmode`, las dos únicas variables de Preview, la migración controlada hasta `0016` con verificación de 17 filas y huella de catálogo, y el humo pendiente del endpoint agrupado real. La verificación local se repitió completa: `npm run staging:verify` con **66 comprobaciones** y `npm run pooler:check` con **27 de 27**. La rama `preview/vercel-11-4` existe en local, sobre `36aeafc` y el commit de documentación de este incremento, auditada sin secretos; no se publicó, no se creó ninguna cuenta ni proyecto, no se aprovisionó ninguna base y no se aplicó ninguna migración fuera de las bases desechables. El estado es **bloqueado**, no completado: faltan la cuenta de Vercel, la protección *All Deployments* fijada antes de importar, la base de Neon autorizada y la autorización expresa del único `push` permitido. [Procedimiento, límites y bloqueo](docs/vercel-deployment.md#16-vercel-hobby-y-neon-free-incremento-114) [Resultados](docs/testing.md#incremento-114--vercel-hobby-y-neon-free-24-de-noviembre-de-2026)
