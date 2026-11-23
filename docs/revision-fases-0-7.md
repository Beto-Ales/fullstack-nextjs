# Revisión retrospectiva de las fases 0 a 7

## Resumen ejecutivo

La muestra revisada conserva las garantías principales de autenticación, aforo y créditos. H04, H06 y H09 están integrados en los caminos de cancelación, reserva y conciliación examinados. Se encontraron dos inconsistencias estáticas en operaciones antiguas. La revisión no confirmó hallazgos críticos o altos.

Se contrastaron la [planificación](../planificacion_general.md), la [arquitectura](architecture.md), el [modelo académico](academic-model.md), el esquema Drizzle hasta `0014` y las [convenciones de pruebas](testing.md) con el código vigente en `cb9e36d`. Se revisaron entradas representativas y sus pruebas existentes. La línea base histórica de 10.12 es de 344 pruebas Vitest, 46 casos Chromium y un caso adicional con normativa sintética. Este incremento ejecutó comprobaciones estáticas y de Git. Las suites, las bases persistentes, los entornos desplegados y la revisión operativa H03 quedaron fuera del alcance.

## Evaluación por fase

| Fase | Resultado | Evidencia principal | Confianza |
| --- | --- | --- | --- |
| 0. Preparación | Sin hallazgos relevantes | App Router, dominio, servicios y adaptadores mantienen la separación descrita en [arquitectura](architecture.md). H08 sustituyó el acceso de las suites a PostgreSQL persistente. | Media |
| 1. Datos | Sin hallazgos relevantes en la muestra | Los [esquemas](../src/infrastructure/db/schema) mantienen FK entre cuenta, perfil, asignaciones y reservas, unicidad de sesión por plantilla y fecha, unicidad parcial de reserva activa e idempotencia del ledger. El [ensayo H07](postgres-upgrade-recovery.md) cubre los puntos de partida históricos. | Media |
| 2. Autenticación | Sin hallazgos relevantes | [Sesión y rol](../src/interfaces/auth/session.ts) protegen paneles y acciones. [auth-service](../src/application/auth/auth-service.ts) valida sesión, revoca y aprovisiona alumnos bajo rol administrativo. E2E cubre rutas anónimas, ausencia de registro y revocación. | Alta en las entradas revisadas |
| 3. Alumnos | Sin hallazgos relevantes | El alta crea cuenta y perfil en una transacción, el correo normalizado es único, la [edición](../src/application/academic/student-edit-service.ts) registra cambios y la [baja](../src/application/academic/student-withdrawal.ts) revoca sesiones y procesa reservas sin eliminar el historial. | Alta |
| 4. Horarios y sesiones | Hallazgo R14-01 | El alta y la edición de vigencia aplican criterios distintos. [Generación](../src/application/academic/session-generation.integration.test.ts) cubre CLI, conflictos de aforo y coordinación con cambios de asignación. La prioridad automática ante aforo insuficiente sigue siendo una decisión explícita. | Alta |
| 5. Asistencia y cancelaciones | Sin hallazgos relevantes | [Servicio académico](../src/application/academic/academic-service.ts) valida sesión y reserva para asistencia, comprueba titularidad y cuenta activa en cancelaciones del alumno y distingue la normativa aplicable. La conciliación conserva la decisión original de habitualidad. | Alta en los caminos revisados |
| 6. Créditos | Sin hallazgos relevantes | [Servicio de créditos](../src/application/credits/credit-service.ts) proyecta saldo FIFO y caducidad en lectura. Los ajustes y el consumo coordinan cambios mediante bloqueo, idempotencia y referencias del ledger. H01, H02 y H09 tienen cobertura documentada. | Alta en los caminos revisados |
| 7. Recuperaciones | Hallazgo R14-02 | [Servicio de recuperación](../src/application/recovery/recovery-service.ts) comprueba aforo, límite mensual, saldo y tiempo antes de insertar. La [integración](../src/application/recovery/recovery.integration.test.ts) cubre última plaza, último crédito, reintentos y devoluciones. | Alta |

## Hallazgos

### R14-01 · Fase 4 · Medio · Confirmado por inspección

El incremento 10.15 reprodujo y corrigió la finalización con rango invertido. [Reproducción y pruebas](testing.md#incremento-1015--vigencia-de-asignaciones-habituales)

[`academic-service.ts`](../src/application/academic/academic-service.ts), función `endStudentTemplateAssignment`. El alta rechaza un fin anterior al inicio. La finalización escribe el fin sin compararlo con el inicio, incluso cuando usa la fecha actual por omisión para una asignación futura. La acción comprueba el formato y la tabla permite guardar el intervalo invertido. La asignación puede quedar almacenada con un rango vacío y el conciliador H09 reevaluar la secuencia a partir de ese cambio.

Las pruebas existentes en [`regulation.integration.test.ts`](../src/application/academic/regulation.integration.test.ts) cubren fin, ampliación y rollback de conciliación. No se localizó cobertura para el intervalo invertido. Validar el rango tras resolver la fecha de fin y acordar cómo anular explícitamente una asignación futura antes de su inicio, preservando el contrato de baja. Confianza alta en la falta de validación y media en el impacto sobre casos existentes. Sin reproducción dinámica.

### R14-02 · Fases 4 y 7 · Bajo · Confirmado por inspección

[`getClassSessionAvailability`](../src/application/academic/academic-service.ts#L855) y [`getRecoveryAvailabilityForSession`](../src/application/recovery/recovery-service.ts#L619) calculan plazas libres para sesiones canceladas o ya iniciadas. La primera lee el estado pero devuelve solo cantidades. La segunda devuelve el estado y el inicio junto con una cifra que puede seguir siendo positiva. El listado de recuperaciones y el detalle administrativo aplican el filtro temporal y de estado. Las dos acciones antiguas de consulta carecen de consumidores en la UI inspeccionada. La discrepancia puede inducir a error si se reutilizan; la mutación sigue comprobando admisión.

Hay pruebas de conteo de plazas y de rechazo al reservar tras el inicio. No se localizó una prueba del contrato de estas consultas para sesiones cerradas con capacidad sobrante. Aclarar si representan aforo físico o disponibilidad reservable. Si son consultas reservables, alinear ambas con los filtros vigentes o retirar las acciones sin consumidores. Confianza alta en la discrepancia. Sin reproducción dinámica.

## Integración y orden propuesto

Se siguieron los enlaces cuenta → perfil → asignación → sesión → asistencia o cancelación → crédito → recuperación, además de la baja y sus efectos sobre reservas y devoluciones. El principal cruce a revisar es vigencia de asignación → conciliación de solicitudes pendientes. Las pruebas existentes cubren la atomicidad de ese cruce con rangos válidos y el rechazo de reservas tardías. Queda por cubrir el caso de rangos invertidos.

1. Definir el contrato de anulación antes del inicio, validar rangos normalizados y añadir una prueba de integración focalizada con H08.
2. Aclarar o retirar las consultas antiguas de aforo en un incremento posterior de alcance reducido.
