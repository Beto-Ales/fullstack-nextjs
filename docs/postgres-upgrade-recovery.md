# Actualización y recuperación de PostgreSQL 15

## Estado verificado el 22 de noviembre de 2026

La inspección local verificó los servicios, volúmenes y puertos publicados de Compose. Consultó identidad, versión, journal y catálogo dentro de transacciones `REPEATABLE READ READ ONLY`. Los hashes y fechas de ambos journals coinciden con prefijos exactos del repositorio. Las huellas de `public` y `drizzle` coinciden con el esquema reconstruido para cada prefijo.

| Entorno | PostgreSQL | Última aplicada | Pendientes |
| --- | --- | --- | --- |
| DEV local | 15.20 | `0005_odd_rachel_grey` | `0006` a `0014` · 9 |
| TEST persistente local | 15.20 | `0006_academic_regulations` | `0007` a `0014` · 8 |
| Producción | Inspección pendiente de autorización independiente | Desconocida | Por determinar |

Las bases persistentes se consultaron en solo lectura. Las pruebas de escritura y el archivo de copia utilizaron datos sintéticos en contenedores desechables. La inspección compara la estructura del catálogo y el journal. Los privilegios efectivos, extensiones, otros esquemas, capacidad, bloqueos bajo tráfico e integridad de los datos reales requieren sus propias comprobaciones antes de operar.

## Inventario del journal

Cada fila parte del prefijo anterior confirmado. Las referencias abreviadas en la tabla conservan los nombres físicos de las tablas en los SQL enlazados. Las sentencias de índice son ordinarias y pueden bloquear escrituras durante su construcción. Los `ALTER TABLE` con columnas o restricciones pueden retener bloqueos hasta el commit de las migraciones pendientes. Evalúa duración y espacio en función del tamaño real de las tablas, en particular reservas, cancelaciones y ledger.

| Migración | Tablas y objetos | Compatibilidad, dependencias y bloqueo |
| --- | --- | --- |
| [0000_smiling_hobgoblin](../drizzle/0000_smiling_hobgoblin.sql) | Crea `app_metadata` con PK `key`, JSONB obligatorio y fechas obligatorias con `now()`. | Base de la aplicación. Crea objetos y deja la tabla vacía. Requiere acceso de creación al esquema. |
| [0001_melted_christian_walker](../drizzle/0001_melted_christian_walker.sql) | Crea enums de rol y estado, `users` y `sessions`. Usuario con estado `ACTIVE` por defecto. Sesión con FK al usuario en cascada. Índices únicos de correo normalizado y hash de token e índices de rol, estado, usuario y vencimiento. | Crea tablas vacías. Comprueba que los objetos de identidad estén ausentes si el journal está en 0000. |
| [0002_soft_toad](../drizzle/0002_soft_toad.sql) | Crea plantillas, sesiones de clase, perfiles, asignaciones, reservas y bloqueos de aforo. Cinco enums de estado y origen. Defaults `ACTIVE`, `SCHEDULED`, `CONFIRMED`, `ORDINARY`, aforo 12 en plantillas e indicadores booleanos. FK a usuarios y entre tablas académicas. Únicos de perfil por usuario, reserva confirmada, sesión por plantilla y día y asignación activa. | Requiere identidad de 0001. Crea tablas e índices nuevos y toma bloqueos referenciales. Los únicos parciales permiten conservar reservas canceladas y asignaciones históricas. |
| [0003_orange_microbe](../drizzle/0003_orange_microbe.sql) | Crea `reservation_attendance_records`, `reservation_cancellations` y cuatro enums. Campos obligatorios de relación, fecha y resultado. Defaults falsos para indicadores de tercera cancelación y candidatura a crédito. FK a reserva, perfil, sesión y usuario. Únicos de asistencia vigente y cancelación por reserva, con índices de consulta. | Requiere las relaciones de 0002. La asistencia supersedida conserva su historial. Crea auditorías vacías y toma bloqueos para las FK. |
| [0004_mean_lifeguard](../drizzle/0004_mean_lifeguard.sql) | Crea `credit_ledger_movements` y enum de movimientos. Importe y clave idempotente obligatorios. FK a perfil, sesión, administrador y cancelación. Únicos de idempotencia, concesión automática por cancelación y caducidad por movimiento de origen. | Requiere perfiles y cancelaciones. Crea un ledger vacío. Las FK a sesión, administrador y cancelación permiten nulos por diseño. |
| [0005_odd_rachel_grey](../drizzle/0005_odd_rachel_grey.sql) | Añade fecha y actor de cancelación a reservas. Añade reserva relacionada, concesión de origen y resultado de devolución al ledger, todos anulables. FK de actor y reserva relacionada. Índices únicos parciales de consumo por recuperación y devolución por consumo. | Requiere reservas y ledger. Los nuevos campos históricos quedan nulos. Evalúa bloqueos de FK y construcción de índices sobre el ledger. |
| [0006_academic_regulations](../drizzle/0006_academic_regulations.sql) | Crea `academic_regulations` y `class_session_edits`, fecha de vigencia única, historial de cambios, FK de versiones y auditoría, índice de edición e inmutabilidad mediante función y trigger. Añade referencias anulables a normativa en reservas, clases, plantillas, ledger, asistencia, cancelaciones y bloqueos. | Requiere identidad y tablas académicas completas de 0005. Inserta la versión `initial`. Los registros históricos conservan referencias vacías. Es el mayor conjunto de tablas modificadas y FK validadas en estos recorridos. |
| [0007_student_withdrawals](../drizzle/0007_student_withdrawals.sql) | Crea auditoría de bajas con usuario alumno como PK, actor y fecha obligatorios, IDs afectados y recuperaciones en JSONB obligatorio. Ambas FK apuntan a usuarios. | La auditoría comienza vacía. Requiere usuarios y toma bloqueos referenciales. |
| [0008_session_capacity_block_release](../drizzle/0008_session_capacity_block_release.sql) | Añade actor, fecha y motivo de liberación a bloqueos de aforo. Todos anulables. FK al usuario con `SET NULL`. | Los bloqueos existentes conservan su estado y los tres campos quedan nulos. Prevé bloqueo y validación de la FK. |
| [0009_admin_session_enrollment](../drizzle/0009_admin_session_enrollment.sql) | Añade `created_by_user_id` anulable a reservas y FK a usuarios con `SET NULL`. | Las reservas históricas conservan autor nulo. Prevé bloqueo de reservas y validación de la FK. |
| [0010_admin_reservation_cancellation](../drizzle/0010_admin_reservation_cancellation.sql) | Añade enum de fuente de decisión y columnas anulables `decision_source` y `administrative_reason`. | Las cancelaciones existentes conservan esos campos nulos. El `ALTER TABLE` bloquea temporalmente la tabla de cancelaciones. |
| [0011_student_profile_edit_audit](../drizzle/0011_student_profile_edit_audit.sql) | Crea `student_profile_edits` con PK, FK a perfil y actor, fecha con `now()`, operación y cambios JSONB obligatorios. Índice de perfil y fecha. | Requiere usuarios y perfiles. La auditoría empieza vacía. Las FK toman bloqueos referenciales. |
| [0012_consecutive_cancellation_eligibility](../drizzle/0012_consecutive_cancellation_eligibility.sql) | Añade `max_eligible_consecutive_cancellations` anulable a normativa. Añade `sequence_pending NOT NULL DEFAULT false`, `credit_resolution` anulable y su enum en cancelaciones. Índice parcial de pendientes por perfil. | Los campos históricos quedan `NULL`, `false` y `NULL` respectivamente. La construcción del índice y los `ALTER TABLE` requieren una ventana de mantenimiento. |
| [0013_manual_credit_adjustment_requests](../drizzle/0013_manual_credit_adjustment_requests.sql) | Crea `manual_credit_adjustment_requests` con UUID único por PK, administrador y hash del contenido obligatorios. Añade `manual_request_id` anulable al ledger, con FK a solicitud, índice parcial y comprobación de tipo manual. | Los movimientos existentes mantienen sus valores y claves de idempotencia. La solicitud queda nula para esos movimientos. Prevé bloqueos de ledger para FK, comprobación e índice. |
| [0014_login_attempt_budgets](../drizzle/0014_login_attempt_budgets.sql) | Crea `login_attempt_budgets` con clave PK, contador obligatorio de 1 a 600 y vencimiento obligatorio indexado. | Tabla nueva e independiente de cuentas y sesiones. Debe existir antes de dirigir tráfico a una versión que usa el limitador. Las instancias comparten PostgreSQL, `AUTH_RATE_LIMIT_HMAC_KEY` y la política de ventanas. |

La revisión incluyó tipos, nulabilidad, defaults, definiciones de índices, restricciones, FK, funciones y triggers. El journal de este incremento carece de conversiones de tipo en columnas históricas. La inserción de normativa inicial en 0006 y los valores previstos en las nuevas columnas se comprueban por separado de la conservación de datos.

## Separación de esquema y normativa

El ensayo desde 0005 creó `initial` en 0006. El ensayo desde 0006 conservó sus valores y la auditoría ya existente. En ambos, después de 0012 y hasta 0014 siguió vigente `initial`, con máximo de cancelaciones consecutivas nulo. Las cancelaciones históricas conservaron sus decisiones, con `sequence_pending=false` y resolución nueva nula. El despliegue real debe conservar toda versión ya publicada y cotejar su vigencia mediante `effective_from`.

La publicación posterior es una operación académica independiente. Un `SUPER_ADMIN` autorizado usa **Publicar una versión** en `/normativa`, revisa los valores y elige una fecha futura según `Europe/Copenhagen`. La versión aplicable es la última con `effective_from` igual o anterior a la fecha local de la operación. Comprueba en el historial la fecha, el autor y los cambios. La clave única evita dos versiones el mismo día y el trigger conserva las publicaciones previas. Las operaciones históricas mantienen sus referencias y resoluciones, incluidas las referencias nulas anteriores a 0006. [Normativa versionada](architecture.md#normativa-académica-versionada)

## Procedimiento para una actualización autorizada

### 1. Confirmar destino y preparar el mantenimiento

1. Registra autorización de escritura independiente, responsable, ventana, versión exacta de aplicación, journal esperado, destino y estrategia de recuperación. Inspecciona DEV y TEST Compose con `npm run db:inspect -- dev` y `npm run db:inspect -- test` respectivamente.
2. Para otro destino autorizado, suministra `DATABASE_INSPECTION_URL` de forma privada y fija `DB_EXPECTED_NAME` y `DB_EXPECTED_SYSTEM_ID` a partir del inventario operativo del clúster. Usa un rol con acceso a catálogo, journal y `pg_catalog.pg_control_system()`. Ejecuta `npm run db:inspect -- connection`. La herramienta requiere el destino explícito y solo devuelve el informe de compatibilidad. Confirma en el gestor de secretos que las credenciales de copia y migración resuelven al mismo destino. Conserva el informe sin credenciales.
3. Verifica versión PostgreSQL 15, conectividad y permisos de aplicación y migración. En la conexión autorizada mide el tamaño con `SELECT pg_database_size(current_database());` y comprueba el espacio libre en cada volumen de datos, WAL, archivo y recuperación con la herramienta del sistema, como `df -h` o `Get-Volume`. Reserva espacio para índices, crecimiento de WAL y una restauración completa. Coteja extensiones, collation, roles y tablas ajenas al journal por separado. Ensaya cargas y bloqueos de magnitud representativa cuando el volumen real lo requiera.
4. Detén el despliegue si difiere la identidad, el journal o el catálogo, existe una FK o índice inválido, falta espacio, hay escritores que no se pueden detener o no se dispone de recuperación comprobada. El comando `db:inspect` sale con error ante incompatibilidad y el informe enumera el sufijo pendiente. Evita modificar el journal para forzar una coincidencia.

### 2. Suspender escrituras, copiar y probar recuperación

1. Activa mantenimiento y detén o drena procesos web, trabajos programados y otros escritores. Confirma que las transacciones activas terminaron. Mantén el bloqueo de escrituras hasta la aceptación operativa o la recuperación.
2. Usa `pg_dump` y `pg_restore` 15. Verifica sus versiones y espacio libre tanto para origen como para destino. Usa un directorio dedicado fuera del repositorio, con ACL limitada al operador y almacenamiento protegido. Carga los parámetros en perfiles libpq previamente verificados y las credenciales mediante `PGPASSFILE` protegido. Conserva el archivo y su metadato con fecha UTC, versión de servidor y herramientas, último tag y SHA-256 según la política de retención. [pg_dump](https://www.postgresql.org/docs/15/app-pgdump.html) · [Archivo de contraseñas libpq](https://www.postgresql.org/docs/15/libpq-pgpass.html)
3. Con el perfil `h07-source` aprobado y `$archive` como ruta nueva en el directorio protegido, crea el archivo en formato personalizado. Comprueba el código de salida de cada programa y coteja en el TOC que estén `public`, `drizzle.__drizzle_migrations` y los objetos y datos esperados. Registra aparte los roles y tablespaces necesarios para reconstruir el entorno. El archivo de base incluye objetos de esa base, y los objetos globales se gestionan por separado.

```powershell
pg_dump --version
pg_restore --version
pg_dump --no-password --format=custom --file $archive --dbname 'service=h07-source'
if ($LASTEXITCODE -ne 0) { throw 'Falló pg_dump' }
pg_restore --list $archive
if ($LASTEXITCODE -ne 0) { throw 'El archivo no se puede listar' }
Get-FileHash -Algorithm SHA256 -LiteralPath $archive
```

4. Valida el SHA-256 registrado y restaura una copia en un destino nuevo, vacío, verificado e independiente. Si el backup contiene datos personales, el destino de recuperación requiere autorización y las mismas garantías de acceso y almacenamiento que el origen. Prepara los roles, permisos y extensiones esperados. El ensayo sintético restaura con los roles nuevos del contenedor y usa `--no-owner --no-acl`. En un entorno operativo preserva o reconstruye propietarios y ACL según el plan aprobado. Verifica todo el contenido mediante restauración, además del listado. [pg_restore](https://www.postgresql.org/docs/15/app-pgrestore.html)

```powershell
pg_restore --no-password --single-transaction --exit-on-error --dbname 'service=h07-recovery' $archive
if ($LASTEXITCODE -ne 0) { throw 'Falló la restauración' }
```

5. Inspecciona el journal y el catálogo restaurados y compáralos con el estado previo. Verifica las consultas de integridad aprobadas y registra el tiempo de recuperación. Si se va a ensayar la aplicación actualizada con esa copia, crea otro destino aislado, aplica el sufijo y ejecuta el control de arranque antes de iniciar la aplicación.

### 3. Aplicar el sufijo pendiente y comprobar

1. Repite la verificación del destino y el preflight tras suspender escrituras. Desde el artefacto de la versión autorizada, el migrador Drizzle debe aplicar exclusivamente el sufijo pendiente en el orden del journal, con el destino explícito y un rol de migración aprobado. El comando existente para DEV es `npm run db:migrate:dev` con `DATABASE_URL` asignada privadamente al destino autorizado. Para TEST persistente o producción, la ejecución de escritura corresponde al despliegue autorizado por entorno. Los comandos de pruebas aprovisionan contenedores propios y conservan su rechazo de destinos persistentes.
2. Detén la ejecución en el primer error, conserva el diagnóstico sin secretos y vuelve a inspeccionar. En los ensayos, Drizzle revierte el lote pendiente y sus entradas del journal cuando falla una sentencia. Los objetos del journal pueden crearse antes del lote en una instalación vacía y una secuencia puede dejar huecos tras un rollback. La inspección coteja los hashes y fechas en orden. Ante una conexión interrumpida, vuelve a comprobar el estado antes de decidir si reintentar.
3. Ejecuta `npm run db:inspect -- ready` con la configuración de despliegue. Comprueba la identidad explícita, que `DATABASE_URL` apunte al mismo destino, que el journal y la huella sean los esperados y que la clave HMAC tenga el formato requerido. La igualdad del secreto entre instancias se verifica en el gestor de secretos sin mostrar su valor. Compáralo con la versión de aplicación aprobada antes de arrancar o enrutar tráfico.
4. Contrasta conteos y valores representativos autorizados, FK e índices, relación de usuarios y perfiles, reservas, cancelaciones, asistencias y ledger con el estado previo. En la copia ya actualizada comprueba login, logout, panel administrativo, panel de alumno, normativa vigente y consultas de créditos. Usa cuentas sintéticas en el ensayo. En el destino real, las pruebas que emitan sesiones, consuman presupuestos o puedan reconciliar créditos requieren autorización como escrituras. Mantén el tráfico general suspendido mientras decides.

### 4. Aceptar o recuperar

Acepta la actualización cuando identidad, esquema, journal completo, comprobaciones de integridad, normativa y pruebas de aplicación sean conformes y el respaldo se haya restaurado correctamente. Si alguna comprobación falla, conserva el estado para diagnóstico. Restaura el backup verificado en un destino vacío y dirige el servicio a ese destino con una versión de aplicación compatible con el journal recuperado. Verifica esquema, permisos, datos, versión y arranque antes de reanudar escrituras. En particular, la versión que depende de 0014 requiere un destino compatible.

Una restauración a la hora de la copia pierde las escrituras posteriores. La ventana de mantenimiento evita ese desfase. Si alguien escribió durante la ventana, conserva el origen, cuantifica el intervalo y obtén aprobación de recuperación antes de cambiar el servicio. Los mecanismos de recuperación a un punto en el tiempo requieren una política de WAL y un ensayo propio.

## Qué se ensayó

`npm run db:rehearse` instala el journal limpio, verifica los quince prefijos y compara el catálogo final con los recorridos desde 0005 y 0006. Captura valores de cuentas activas y desactivadas, perfiles, sesiones de acceso, asignaciones, reservas, cancelaciones, asistencias, recuperaciones, movimientos y auditoría. Comprueba las transformaciones esperadas, saldo y consumo sintéticos, FK e índices únicos con inserciones representativas, ausencia de publicaciones nuevas y repetición idempotente del journal. Dos conexiones comparten los presupuestos de 0014 y la verificación completa cubre también procesos de aplicación independientes.

Desde 0005, genera un archivo personalizado en memoria a partir del contenedor verificado. Provoca un conflicto único después de iniciar el lote, comprueba la reversión del catálogo, journal y valores, completa el recorrido y restaura la copia original en otro contenedor verificado. Rechaza el archivo truncado y el intento de restaurar en un destino que ya contiene objetos. La restauración devuelve el catálogo, el prefijo y todos los valores originales. El marcador del aprovisionador pertenece al destino y queda fuera del archivo.

Se ensayaron la deriva de esquema, el destino incorrecto y la configuración de login ausente o inválida. Ante desconexión o interrupción operativa, revalida el estado antes de reintentar. Ante falta de espacio, detén el procedimiento y revalida capacidad e integridad de la copia. Ante error de la aplicación, conserva mantenimiento y verifica versión, esquema y configuración antes de decidir recuperación. Esos fallos de infraestructura y los tiempos a escala real quedan como comprobaciones operativas. Los ensayos se ejecutan en recursos de vida corta bajo las guardas del 10.6. [Pruebas e aislamiento](testing.md)
