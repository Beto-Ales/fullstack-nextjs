# H03 — Diagnóstico y respuesta ante exposición de credenciales

## Resultado del incremento 10.13

Se revisaron la copia de trabajo, `master`, la referencia local `origin/master`, los reflogs y los checkpoints locales de Codex. La inspección heurística procesó 798 versiones de archivos de texto del historial y comprobó que sus salidas omitían los valores con entradas sintéticas. Se revisaron archivos de entorno, documentación de autenticación y PostgreSQL, scripts y fixtures, los 15 informes locales identificados y el log de desarrollo disponible en el workspace. El ejecutor de pruebas y la configuración de Playwright revisados no recopilan esos informes. No había herramientas especializadas de detección disponibles localmente.

| Categoría | Evidencia y estado | Prioridad |
| --- | --- | --- |
| PostgreSQL DEV y TEST persistentes | Hay configuración local para ambos en archivos de entorno ignorados. Las contraseñas presentes en esos archivos no coincidieron literalmente ni con la codificación URL comprobada en los informes, los logs disponibles, los archivos versionados ni los objetos de texto revisados de ramas y checkpoints. Los informes conservan referencias a credenciales históricas de DEV y TEST. Se desconoce si alguna sigue vigente o se reutiliza. | Alta si el propietario confirma vigencia, reutilización o acceso a copias compartidas. |
| Credenciales de ejemplo, fixtures y demostración | Se identificaron URLs genéricas de ejemplo, marcadores interpolados en informes y valores en fixtures de prueba. H08 genera credenciales efímeras para la base desechable. La inspección no comprobó la vigencia de cuentas de demostración. | Baja para valores confirmados como sintéticos y aislados. |
| HMAC de limitación de inicio de sesión | `AUTH_RATE_LIMIT_HMAC_KEY` se obtiene del entorno y se valida. La ruta de producción revisada carece de un valor fijo de respaldo. No se detectó su valor en Git ni en el log revisado. Las instancias de un entorno deben compartir la misma clave. La configuración y el efecto del cambio sobre los contadores se describen en [Configuración](../README.md#variables-de-entorno). | Coordinar sustitución si aparece evidencia de exposición. |
| Sesión, contraseña de administrador, claves privadas, correo y servicios externos | La revisión identificó referencias de configuración, incluidos los nombres de las variables para aprovisionar el administrador. La búsqueda por patrones y la revisión de contexto quedaron sin evidencia de exposición de una credencial real de estas categorías. | Investigar con prioridad si aparece evidencia asociada a producción o a un proveedor. |

Los 15 informes están fuera del índice y de los historiales de `master` y de la referencia local `origin/master`. Hay copias de los 15 en checkpoints locales. Se añadió una exclusión exacta por informe en `.git/info/exclude` para prevenir el staging accidental en esta copia. Las exclusiones no eliminan copias anteriores ni se propagan a otros clones. La plantilla `.env.compose.example` sigue versionada y los archivos de entorno locales siguen ignorados.

La revisión fue local y por patrones. Su alcance no cubre servicios remotos, copias fuera del repositorio ni valores transformados de formas no contempladas. No se comprobó vigencia contra ninguna base de datos o servicio. El **diagnóstico está completado** y **H03 sigue pendiente de acción operativa** para confirmar el alcance de las copias históricas, la vigencia y la posible reutilización.

## Procedimiento para el operador autorizado

1. Identificar el servicio, el entorno, el propietario y los consumidores de la credencial. Determinar quién tuvo acceso a los informes, checkpoints, copias y repositorios relevantes. Registrar categoría, ubicación, alcance y estado, sin copiar valores ni sus hashes.
2. Confirmar la vigencia y reutilización mediante el inventario de secretos, el proveedor y los registros de acceso autorizados. Si se confirma una exposición, acordar la prioridad y la ventana de contención con el propietario. Una coincidencia en Git acredita presencia en esa copia, sin determinar vigencia.
3. Preparar la credencial nueva en el mecanismo de secretos del entorno. Pactar despliegue, verificación y reversión con los responsables de la aplicación y del servicio. Si hay indicios de uso indebido, acordar con el propietario si procede revocar de inmediato.
4. Actualizar los consumidores de la credencial. Verificar el servicio con las comprobaciones operativas habituales, revocar la credencial anterior y comprobar el servicio de nuevo. Confirmar mediante el inventario y los registros que todos los consumidores cambiaron y que la credencial anterior figura revocada.
5. Documentar fecha, servicio, entorno, responsables, verificación y revocación. Si se confirma una copia en Git, decidir con el propietario el tratamiento de checkpoints y el eventual saneamiento de commits, clones y copias compartidas después de contener la credencial.

| Servicio | Preparación y comprobación específicas |
| --- | --- |
| PostgreSQL DEV o TEST persistente | Hacer inventario por entorno de los roles, aplicaciones, configuración de Compose, scripts y tareas que se conectan. Coordinar el cambio de contraseña del rol y la actualización de los consumidores. Verificar conexiones nuevas y revisar las sesiones antiguas con el operador. Gestionar cada entorno por separado. |
| HMAC | Distribuir la misma clave nueva a todas las instancias del entorno. Coordinar el cambio para reducir la coexistencia de claves. Verificar el inicio de sesión y la limitación después del despliegue, teniendo en cuenta que cambian los identificadores de los contadores. Retirar la versión anterior del mecanismo de secretos y comprobar que todas las instancias cargaron la nueva. |
| Cuenta administrativa o sesión, si se confirma exposición | Usar el procedimiento autorizado de cambio de contraseña y revocar las sesiones afectadas. Verificar el acceso autorizado y la invalidación de sesiones antiguas. |
| Token de proveedor, correo o clave privada, si se confirma exposición | Revisar permisos y uso con el propietario del servicio. Emitir y desplegar el sustituto con los permisos necesarios, verificar cada integración y revocar el anterior con el proveedor o en los sistemas que confían en la clave. |
| Demostración o fixture confirmado como aislado | Confirmar que no se reutilizó en otro entorno. Retirar las credenciales al desechar el recurso, con autorización de su propietario si sigue en uso. |

La comprobación de vigencia, la rotación, la revocación y el tratamiento de copias históricas requieren decisión del propietario. Este diagnóstico se realizó sin conexiones a bases persistentes ni cambios de secretos, servicios o historial.

## Staging y verificación

Usar `git check-ignore` para comprobar rutas concretas en la copia de trabajo. Preparar solo los archivos propios mediante staging selectivo. Revisar los nombres en el índice, ejecutar `git diff --cached --check` y revisar el diff con un detector local que devuelva únicamente metadatos si pudiera contener un secreto. Evitar volcar diffs sensibles al terminal o a herramientas externas.

Se verificaron las 15 exclusiones locales, la exclusión de archivos de entorno, la inclusión normal de documentación legítima y el diff de los dos documentos del incremento. El detector produjo únicamente categorías y metadatos con entradas sintéticas. Pasaron 17 pruebas unitarias de configuración, HMAC y PostgreSQL sin conexión a bases de datos. El alcance documental y de exclusión local no requirió `npm run test:verify`.

## Resultado del incremento 10.24 — Evaluación de cierre operativo

Este incremento no repitió la auditoría de 10.13 ni abrió el contenido de los informes. Trabajó con metadatos, configuración local y estado de los contenedores. No se conectó con credenciales históricas, no se validó ninguna contraseña, no se consultaron servicios externos y no se modificó DEV, TEST persistente ni producción.

### Entornos

- **PostgreSQL DEV.** El servicio declarado en `compose.yaml` usa un volumen Docker nominado y una política de reinicio persistente. El contenedor correspondiente estaba en ejecución y saludable al revisar. La configuración versionada de ejemplo mantiene nombres de variables, no valores. Los archivos de entorno locales siguen ignorados por Git.
- **PostgreSQL TEST persistente.** Está definido como un servicio independiente, con volumen propio, puerto propio, base propia y política de reinicio persistente. El contenedor correspondiente estaba en ejecución y saludable al revisar. No comparte servicio ni volumen con DEV.
- La configuración local actual usa credenciales distintas para DEV y TEST. La cadena de conexión de la aplicación apunta al servicio de DEV. Esta comparación fue en memoria y solo produjo resultados booleanos; no se mostraron, registraron ni transformaron los valores.
- Las suites automatizadas no dependen de estos contenedores: H08 aprovisiona instancias desechables con credenciales efímeras. Los consumidores conocidos de las credenciales persistentes son la aplicación en desarrollo, la configuración de Drizzle, los scripts operativos y las tareas manuales de los responsables del entorno.

### Vigencia y reutilización

- No existe evidencia administrativa disponible en el repositorio que demuestre que la contraseña del rol se haya cambiado o revocado después de la fecha de los informes. Que la configuración local actual contenga otro valor no demuestra por sí solo que el rol de PostgreSQL haya cambiado: son dos hechos distintos y la diferencia de configuración no se puede usar como prueba de revocación.
- La comprobación de vigencia requiere autenticación contra el entorno o registros del administrador del servicio. Este incremento no la ejecutó y no debe ejecutarse sin autorización expresa. Tampoco se intentó reutilizar las credenciales en otros servicios.
- No hay constancia en el repositorio de quién administra DEV o TEST, ni de los registros de cambio de rol. Es información que solo el propietario puede aportar.

### Copias y accesos

- Los 15 informes siguen presentes en la copia de trabajo (última modificación anterior a este incremento) y fuera del índice. No aparecen en `master` ni en la referencia local `origin/master`.
- Los 15 informes también están contenidos en **21 referencias locales de checkpoint de los agentes** dentro de este repositorio, bajo espacios de nombres propios que no forman parte de las ramas. Es una copia en objetos Git local: la exclusión de staging no la elimina. Las referencias de seguimiento remotas solo incluyen `origin/master` y la configuración de publicación no añade referencias adicionales, pero no se consultó el remoto por red, por lo que la ausencia de copia remota no está demostrada.
- El directorio de estado del agente no contiene archivos con esos nombres; sí conserva sesiones y registros cuyo contenido no se inspeccionó. Su alcance queda como desconocido.
- La copia de trabajo no está en una carpeta sincronizada con la nube y no se identificaron otros clones locales en su directorio padre. No hay evidencia de acceso de terceros, ni de sincronización externa, ni de lo contrario: el alcance de acceso a las copias no está confirmado.
- No se borraron informes, checkpoints ni copias de seguridad.

### Medidas locales comprobadas

- Las 15 exclusiones exactas de `.git/info/exclude` siguen vigentes y se verificaron una por una con `git check-ignore`.
- Los archivos de entorno locales siguen ignorados; la plantilla versionada no contiene credenciales reales.
- Un `git add --dry-run` sobre `docs` solo propone documentación versionada legítima: los informes no entrarían en el índice.
- No había nada preparado en el índice durante el incremento.
- Una revisión por patrones de los 12 documentos Markdown versionados no encontró cadenas de conexión con contraseña ni asignaciones de secretos. Solo se registraron recuentos y ubicaciones.
- No se ejecutaron pruebas académicas, E2E ni migraciones: el incremento es operativo y documental.

### Matriz de evidencia

| Entorno o categoría | Exposición histórica identificada | ¿Sigue activa la credencial? | ¿Evidencia de revocación o rotación? | ¿Reutilización descartada? | ¿Alcance de acceso a copias conocido? | Riesgo residual | Acción pendiente | Responsable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL DEV persistente | Referencias a una credencial histórica en los informes; la configuración local actual contiene otro valor | No comprobado | No comprobado | No comprobado | No | Alto hasta confirmar vigencia | Verificar en el servicio y documentar el cambio de rol; rotar si sigue activa | Administración del entorno y propietario |
| PostgreSQL TEST persistente | Referencias a una credencial histórica en los informes; valor actual distinto del de DEV | No comprobado | No comprobado | No comprobado | No | Alto hasta confirmar vigencia | Verificación y rotación independientes de DEV | Administración del entorno y propietario |
| Copias en checkpoints locales de Git | Los 15 informes alcanzables desde 21 referencias locales de agentes | No aplica | No aplica | No aplica | No | Medio mientras la credencial siga vigente | Decidir con el propietario el tratamiento de las referencias y objetos después de contener las credenciales | Propietario y administración del repositorio |
| Estado y registros del agente | Sesiones y registros con alcance no inspeccionado | No aplica | No aplica | No aplica | No | Medio | Confirmar si se compartieron o sincronizaron | Propietario |
| HMAC de limitación de inicio de sesión | Sin exposición detectada en 10.13 | No aplica | No aplica | No aplica | No aplica | Bajo | Ninguna mientras no aparezca evidencia | Propietario |
| Fixtures y credenciales de ejemplo | Valores sintéticos y credenciales efímeras de H08 | No aplica | No aplica | No aplica | No aplica | Bajo | Ninguna | Equipo de desarrollo |

### Criterios de cierre

1. Categorías y entornos identificados: **cumplido** para PostgreSQL DEV, PostgreSQL TEST, HMAC, fixtures y cuentas administrativas.
2. Credenciales antiguas sin acceso: **pendiente**. Requiere evidencia administrativa del cambio de rol o la rotación autorizada.
3. Reutilización revisada: **pendiente** del propietario.
4. Consumidores identificados: **cumplido** para la configuración y los scripts del repositorio; falta confirmar consumidores fuera del repositorio.
5. Acceso a copias evaluado: **parcial**. Se conocen las copias locales; el alcance de terceros y del remoto es desconocido.
6. Sin exposiciones activas conocidas: **no cumplido** mientras la vigencia de las credenciales históricas sea desconocida.
7. Aprobación del riesgo residual: **pendiente** del propietario.
8. Documentación auditable sin secretos: **cumplido** con este documento.

**Estado: H03 — PENDIENTE DE ACCIÓN OPERATIVA.**

### Procedimiento autorizado de cierre

Se prepara un procedimiento por entorno. Ninguno se ejecutó en este incremento.

1. **Operador responsable.** El propietario designa a quien administra el servicio y a quien puede cambiar el rol de PostgreSQL. Se registran funciones, no personas.
2. **Respaldo y recuperación.** Confirmar el respaldo vigente del volumen y una restauración verificada antes de tocar credenciales. No se requiere cambio de esquema.
3. **Consumidores.** Inventariar aplicación, Drizzle, scripts, tareas manuales y cualquier cliente externo. Confirmar si existen consumidores fuera del repositorio.
4. **Credencial nueva.** Generarla en el mecanismo de secretos del entorno, fuera del chat y de los registros. No reutilizar la anterior ni la de otro entorno.
5. **Actualización coordinada.** Cambiar la contraseña del rol y actualizar la configuración de los consumidores en una ventana acordada.
6. **Revocación.** Confirmar que la contraseña anterior deja de autenticar. Si el rol se recrea, revisar privilegios y pertenencia a roles.
7. **Verificación.** Comprobar conexión autorizada, migraciones pendientes y salud del servicio con las comprobaciones habituales.
8. **Consumidores tras el cambio.** Repetir la verificación en cada consumidor y revisar sesiones abiertas con el operador.
9. **Reversión.** Mantener la credencial anterior solo durante la ventana de verificación y documentar cómo volver atrás si falla un consumidor. Cerrar la ventana revocándola.
10. **Evidencia de cierre.** Registrar fecha, entorno, funciones responsables, verificaciones y revocación, sin valores ni hashes. Añadir el resultado a este documento.

### Preguntas para el propietario

1. ¿Quién pudo acceder a los informes, a los checkpoints locales o al equipo donde están?
2. ¿Se copiaron los informes fuera del equipo, a otra cuenta o a un repositorio compartido?
3. ¿Las contraseñas históricas de DEV o TEST se usaron en otros servicios o proyectos?
4. ¿Existe constancia de cuándo se cambió la contraseña del rol en cada entorno y quién lo hizo?
5. ¿Quién puede autorizar la rotación de DEV y de TEST, y en qué ventana?
6. ¿Se aprueba el riesgo residual de mantener los informes y los checkpoints locales mientras se confirma la vigencia?

Las respuestas 4 y 5 pueden documentarse con el inventario de secretos o los registros del proveedor; no es necesario compartir valores. Si una comprobación exige autenticarse en el servicio, debe realizarla un operador autorizado.

## Incremento 10.25 — Preparación de la rotación de PostgreSQL TEST persistente

Este incremento se limita a PostgreSQL TEST persistente y ejecutó únicamente comprobaciones de solo lectura. **No se cambió ninguna contraseña, no se crearon respaldos, no se reiniciaron contenedores, no se escribieron datos y no se tocó DEV ni producción.** La rotación queda preparada y pendiente de autorización específica.

### Identidad del entorno

| Recurso | Dato |
| --- | --- |
| Contenedor | `fullstack_nextjs_postgres_test`, imagen `postgres:15`, en ejecución y saludable, reinicios acumulados 0, política `unless-stopped` |
| Volumen | `fullstack-nextjs_postgres_test_data` montado en `/var/lib/postgresql/data` en lectura y escritura; unos 105 MB |
| Publicación | `127.0.0.1:5433` hacia `5432/tcp` |
| Rol de acceso | `app_test_user`: inicio de sesión, superusuario, sin caducidad; es el único rol con acceso |
| Base principal | `fullstack_nextjs_test`: 14 tablas públicas y 7 de las 17 migraciones aplicadas; el diario `drizzle.__drizzle_migrations` existe |
| Base adicional | Una base residual de demostración del mismo clúster, de tamaño similar; comparte el rol y por tanto el cambio de contraseña la afecta igual |
| Cifrado de contraseñas | `scram-sha-256`, una sola verificación almacenada por rol |
| Sesiones de cliente | Ninguna activa; solo procesos internos del servidor |
| Separación de DEV | Contenedor, volumen, puerto y credencial distintos (`postgres_dev`, 5432) |

### Hallazgos relevantes

- El rol de aplicación es **superusuario** en TEST. No se modifica en este incremento: corregirlo exige un cambio de privilegios y de configuración con autorización propia. Mientras siga así, la credencial protege todo el clúster de TEST.
- La regla de autenticación del contenedor confía en el socket local y en las direcciones de loopback internas, y exige `scram-sha-256` al resto de conexiones. Por eso la validación de la contraseña nueva debe hacerse **desde el host** a través del puerto publicado: una prueba dentro del contenedor no comprobaría la contraseña.
- La base TEST persistente está en la migración 7 de 17. Este incremento no aplica ninguna migración ni altera el esquema.
- La base residual de demostración convive en el mismo clúster. Su conservación o retirada es una decisión del propietario y no forma parte de la rotación.

### Consumidores de la credencial de TEST

| Consumidor | Uso de la credencial |
| --- | --- |
| `.env` local (ignorado) | `TEST_DATABASE_URL` apunta a `127.0.0.1:5433/fullstack_nextjs_test` con el rol de TEST |
| `.env.compose.local` (ignorado) | `POSTGRES_TEST_PASSWORD` contiene el mismo valor que la cadena anterior; se comprobó en memoria y solo se registró el resultado booleano |
| `compose.yaml` | Usa esa variable solo al inicializar el volumen; cambiarla no altera un volumen existente |
| Suites de Vitest y E2E, `db:migrate:test` | No usan la credencial persistente: aprovisionan contenedores desechables en tmpfs con credenciales efímeras y roles no privilegiados |
| `npm run db:inspect -- test` | Entra por el socket local del contenedor y no necesita contraseña |
| Aplicación en desarrollo | `DATABASE_URL` apunta a DEV; no depende de TEST |
| Clientes externos | Ningún consumidor conocido dentro del repositorio; su existencia fuera de él solo puede confirmarla el propietario |

### Respaldo y recuperación

- **No existe respaldo previo**: no hay directorio de respaldos ni volcados en el proyecto; los archivos `.sql` del repositorio son migraciones de Drizzle.
- Respaldo propuesto, previo a la rotación y sujeto a autorización: volcado lógico comprimido de la base principal al sistema de archivos temporal del contenedor, copia al host **fuera del repositorio**, verificación del índice del volcado y borrado del temporal. Los volcados de roles contienen verificadores de contraseña y deben tratarse como material sensible; este procedimiento no genera ese tipo de volcado.
- Prohibido en este procedimiento: `docker compose down -v`, `docker volume prune`, `DROP DATABASE`, `DROP ROLE`, recrear el contenedor o vaciar el volumen.
- Recuperación administrativa: el socket local del contenedor confía en el sistema, de modo que un operador dentro del contenedor puede fijar otra contraseña sin conocer la anterior. Es el mecanismo de reversión si la credencial nueva no funciona.
- Ensayo de restauración propuesto: restaurar el volcado en un contenedor `postgres:15` desechable con datos en tmpfs y sin contraseña de arranque, comprobar el recuento de tablas y retirarlo al terminar. No escribe en TEST ni en DEV.

### Procedimiento de rotación preparado (no ejecutado)

Todos los pasos requieren autorización previa. Ningún valor de secreto se escribe en el repositorio, en argumentos de comandos, en el historial de PowerShell ni en los mensajes enviados al asistente.

1. **Confirmar identidad y estado.** Contenedor `fullstack_nextjs_postgres_test` saludable, volumen `fullstack-nextjs_postgres_test_data` presente, puerto `127.0.0.1:5433`, rol `app_test_user`, base `fullstack_nextjs_test` y cero sesiones de cliente.
2. **Respaldo verificado.** Volcar la base principal con `pg_dump -Fc` hacia `/tmp` del contenedor, copiarla al host fuera del repositorio, comprobar el índice del volcado y borrar el temporal. Sin respaldo verificado no se continúa.
3. **Ensayo de restauración.** Restaurar el volcado en un contenedor desechable `postgres:15` con tmpfs y sin contraseña de arranque; comprobar recuento de tablas y retirarlo.
4. **Credencial nueva.** Generarla en el gestor de secretos, no en el chat ni en la terminal visible. Debe ser única, distinta de DEV y no reutilizada.
5. **Cambio efectivo del rol.** Aplicarlo sobre PostgreSQL, no solo en los archivos de configuración. Vía recomendada: sesión interactiva dentro del contenedor y la orden `\password app_test_user`, que pide el valor sin mostrarlo y no deja rastro en argumentos. Alternativa automatizada aceptable: archivo SQL temporal fuera del repositorio con permisos restringidos, enviado por la entrada estándar de `psql` y destruido al terminar; nunca como argumento de comando.
6. **Configuración de consumidores.** Actualizar `TEST_DATABASE_URL` en `.env` y `POSTGRES_TEST_PASSWORD` en `.env.compose.local`. Ambos archivos están ignorados por Git y no deben mostrarse en claro. Cambiar la variable de Compose no altera el volumen existente; no se recrea el contenedor.
7. **Validación desde el host.** Abrir una conexión nueva por `127.0.0.1:5433` con la credencial nueva, sin imprimirla: el operador la introduce con una lectura de contraseña sin eco en la misma sesión, la comprobación informa solo si la conexión tuvo éxito y los datos de identidad del servidor, y después se retira la variable del proceso. Una prueba dentro del contenedor no valida la contraseña porque la autenticación local es de confianza.
8. **Evidencia de revocación sin probar la anterior.** Registrar antes y después el identificador de transacción de la fila del rol en `pg_authid` (línea base actual: 742), que debe cambiar, y confirmar que el rol conserva una sola verificación cifrada con `scram-sha-256`. PostgreSQL 15 almacena un único verificador por rol, así que al sustituirlo la contraseña anterior deja de existir en el servidor. No se intenta autenticar con la contraseña anterior.
9. **Integridad del servicio.** Comprobar que el identificador del contenedor, su hora de arranque y el recuento de reinicios no cambian, que el volumen es el mismo, que siguen existiendo 14 tablas públicas y 7 migraciones aplicadas, y que no hay sesiones de cliente inesperadas.
10. **Cierre y reversión.** Si la validación falla, fijar otra contraseña por el socket local de confianza del contenedor y detenerse; no se restaura el volumen ni se reinicia el servicio. Al terminar con éxito, destruir la credencial anterior de cualquier almacén temporal y registrar evidencias sin valores.

### Condiciones de parada

- Respaldo no generado o no verificado.
- Restauración de ensayo fallida.
- Contenedor no saludable, reinicios inesperados o volumen distinto.
- Aparición de sesiones de cliente que pudieran quedar autenticadas con la credencial anterior.
- Cualquier indicación de que la ventana afectaría a DEV o a producción.
- Cualquier discrepancia entre la configuración esperada y la real.

### Acción que requiere autorización

Autorizar, en una ventana acordada, el respaldo verificado y la rotación de la contraseña del rol `app_test_user` del PostgreSQL **TEST** persistente, junto con la actualización de las dos ubicaciones de configuración locales, la validación desde el host y el registro de la evidencia de revocación. La autorización no incluye DEV, producción, claves HMAC, secretos de sesión, cambios de esquema, eliminación de la base residual de demostración, cambio de privilegios del rol ni retirada de checkpoints o informes históricos.

### Estado de H03 respecto a TEST

Preparación completada y verificada en solo lectura. **Rotación pendiente de autorización explícita del propietario; H03 sigue pendiente de acción operativa.**

### Limitaciones de este incremento

- No se comprobó la contraseña vigente ni histórica; la identidad se verificó por metadatos del contenedor y por el socket administrativo local.
- La existencia de copias de la credencial fuera de esta máquina no puede demostrarse desde el repositorio.
- El estado del rol como superusuario se documenta, pero no se corrige en este incremento.

## Incremento 10.26 — Respaldo verificado y restauración ensayada de PostgreSQL TEST

El propietario autorizó la rotación completa de la credencial **TEST** persistente. Este incremento ejecutó el respaldo y el ensayo de restauración, y se detuvo antes del cambio de contraseña porque ese paso exige una entrada interactiva sin eco que solo el propietario puede realizar. **No se modificó la contraseña, no se cambiaron privilegios, no se migró el esquema, no se escribió en las bases, no se recreó el contenedor y no se tocó DEV ni producción.** Los dos archivos de configuración locales siguen con el valor anterior.

### Alcance ejecutado

| Fase | Estado |
| --- | --- |
| A · Respaldo lógico verificado | Ejecutada y verificada |
| B · Ensayo de restauración aislado | Ejecutada y superada |
| C · Cambio de contraseña del rol | Pendiente del paso manual del propietario |
| D · Actualización de consumidores | Pendiente; la utilidad quedó preparada y probada con datos ficticios |
| E · Validación desde el host | Pendiente de la credencial nueva |
| F · Evidencia de sustitución | Línea base capturada; comparación pendiente |
| G · Integridad final | Verificada: sin cambios respecto a 10.25 |

### Respaldo (Fase A)

- Tres volcados lógicos en formato personalizado: base principal (155 entradas de índice, unos 63 KB), base residual de demostración (160 entradas, unos 69 KB) y base de mantenimiento `postgres` (15 entradas, unos 1 KB).
- Copiados al host **fuera del repositorio**, en un directorio con la herencia de permisos retirada y acceso limitado a la cuenta del propietario, al sistema y a los administradores locales.
- Índice comprobado con `pg_restore -l` en los tres archivos y temporales del contenedor eliminados.
- Cifrado en reposo: el cifrado de archivos del sistema no admite esa ubicación y no hay herramientas de archivo cifrado instaladas, así que se aplicó protección de datos del perfil de Windows a cada volcado. Se verificó el descifrado comparando el resumen SHA-256 con el original antes de borrar el texto claro. Los volcados solo se pueden abrir con la cuenta de Windows del propietario y el resumen SHA-256 queda junto a ellos para verificar extracciones futuras.
- No se exportaron roles ni verificadores de contraseña: los metadatos no sensibles del rol ya estaban documentados en 10.25.
- Los respaldos se conservan; su periodo de retención y su destrucción segura son una decisión posterior del propietario.

### Ensayo de restauración (Fase B)

- Contenedor `postgres:15` desechable, con datos en tmpfs, **sin puertos publicados**, arrancado con autenticación de confianza y retirado al terminar el ensayo.
- Restauración de ambas bases con `pg_restore --no-owner --exit-on-error`: sin errores en ninguna de las dos.
- Comparación automática contra el origen: **14 de 14 tablas** de la base principal con recuentos idénticos, **15 de 15** en la base residual y **7** migraciones en el diario restaurado. No hubo advertencias que ocultaran pérdida de objetos.

### Línea base para la evidencia de sustitución (Fase F)

- Identificador de transacción de la fila del rol: **742**; debe cambiar tras el cambio de contraseña.
- Un único verificador `SCRAM-SHA-256` en el rol.
- Huella SHA-256 del verificador almacenada localmente fuera del repositorio solo para comparar antes y después. Ni el verificador ni su huella se registran en este documento.

### Motivo técnico de la parada antes de la Fase C

El cambio debe hacerse con `\password app_test_user` dentro de una sesión interactiva, que pide el valor dos veces sin mostrarlo y envía al servidor el verificador ya calculado. Este asistente no dispone de terminal interactiva. Las alternativas automatizadas obligarían a que el secreto pasara por una sentencia SQL o por un archivo, es decir, por procesos y texto de consulta registrables en `pg_stat_activity` y en el historial de la terminal. Aunque `log_statement` está en `none` y la extensión de estadísticas de consultas no está instalada, el procedimiento no asume ese riesgo: se detuvo el incremento en lugar de degradar la confidencialidad. No se generó, propuso ni reutilizó ninguna contraseña.

### Paso manual pendiente del propietario

1. Abrir la sesión interactiva del contenedor de TEST con `psql` sobre la base principal y ejecutar `\password app_test_user`, introduciendo el valor del gestor de secretos dos veces. El valor no se muestra en pantalla ni queda en el historial.
2. Ejecutar la utilidad preparada en este incremento, guardada fuera del repositorio: solicita el valor con lectura sin eco, valida la conexión nueva por `127.0.0.1:5433` con `scram-sha-256`, escribe únicamente la línea `TEST_DATABASE_URL` de `.env` y la línea `POSTGRES_TEST_PASSWORD` de `.env.compose.local`, y confirma el resultado con indicadores booleanos. La utilidad se validó con archivos ficticios: doce comprobaciones correctas, incluidas la codificación por ciento de caracteres especiales, la conservación del resto de líneas y la invariabilidad de `DATABASE_URL` de DEV. Si la validación falla, no escribe nada.
3. Alternativa manual equivalente: editar ambos archivos con el editor del propietario. En la cadena de conexión el valor debe ir codificado por ciento y en la variable de Compose sin comillas simples.

### Estado de TEST tras este incremento

Sin cambios funcionales: el contenedor conserva su identificador, su hora de arranque, cero reinicios y su volumen; las tres bases siguen presentes con 14 tablas, 7 migraciones aplicadas y ninguna sesión de cliente; la publicación sigue limitada al loopback. El rol `app_test_user` mantiene la contraseña anterior y sus privilegios. DEV no se tocó y su hora de arranque tampoco cambió.

### Condiciones de parada que siguen vigentes

- La validación desde el host no confirma la credencial nueva.
- Aparecen sesiones de cliente inesperadas o algún consumidor desconocido de la credencial.
- Cambia el identificador del contenedor, su hora de arranque o el volumen.
- Disminuyen las tablas, las filas representativas o las migraciones aplicadas.
- Cualquier indicación de que la operación afectaría a DEV o a producción.

### Acción que requiere el propietario

Completar los pasos manuales anteriores y comunicarlo. Después se repiten las fases E, F y G, se confirma la sustitución del verificador y la conservación de datos, y se registra la rotación verificada. Mientras eso no ocurra, **H03 sigue pendiente de acción operativa** y la contraseña anterior sigue vigente en TEST.

> El paso manual descrito en este incremento se completó y se verificó en el incremento 10.27; desde entonces el valor anterior ya no autentica en TEST.

## Incremento 10.27 — Rotación de PostgreSQL TEST verificada

El propietario completó manualmente `\password app_test_user` en una terminal interactiva y después ejecutó la utilidad local de actualización de consumidores. Este incremento **solo verifica** lo ocurrido, con consultas administrativas y de lectura: no se volvió a cambiar la contraseña, no se alteraron roles ni privilegios, no se aplicaron migraciones, no se escribieron datos, no se descifraron ni restauraron respaldos, no se recreó el contenedor y no se tocó DEV ni producción. El secreto no se solicitó ni se recibió en ningún momento.

### Alcance ejecutado

| Fase | Estado |
| --- | --- |
| C · Cambio de contraseña del rol | Ejecutada por el propietario en sesión interactiva, sin eco |
| D · Actualización de consumidores | Ejecutada por la utilidad local; solo las dos líneas previstas |
| E · Validación desde el host | Ejecutada y superada por la ruta de red protegida |
| F · Evidencia de sustitución | Verificada: verificador distinto y autenticación correcta |
| G · Integridad final | Verificada: sin cambios funcionales respecto a 10.25 y 10.26 |

### Evidencia de sustitución del verificador

| Comprobación | Resultado |
| --- | --- |
| Rol presente y fila única | Sí |
| Inicio de sesión | Conservado |
| Privilegio de superusuario | Conservado, con herencia, creación de roles y bases, replicación, omisión de seguridad por fila y sin límite de conexiones |
| Caducidad | Sin caducidad |
| Formato del verificador | Un único `SCRAM-SHA-256`, con la estructura de tres segmentos y la longitud propias del formato |
| Huella del verificador frente a la línea base de 10.26 | Distinta, comparada en memoria y sin registrar ningún valor ni huella |
| Identificador de transacción de la fila del rol | 742 → 38941 |
| Roles con inicio de sesión | Sigue siendo el único |

El cambio del identificador de transacción por sí solo no demuestra la rotación. Lo decisivo es la combinación de un verificador almacenado distinto del de la línea base con una autenticación correcta por la ruta que exige contraseña.

### Validación independiente desde Windows

- Conexión nueva a `127.0.0.1:5433`, el puerto publicado y restringido al loopback, usando `TEST_DATABASE_URL` leída en memoria. La contraseña viajó al proceso de comprobación por variable de entorno, se retiró al terminar y no apareció en argumentos de proceso, en pantalla ni en registros.
- La sesión observó como cliente la dirección de la puerta de enlace del host en la red interna de Docker, no el loopback del contenedor. Las reglas de autenticación del contenedor son de confianza para el socket local y el loopback interno, y exigen `scram-sha-256` al resto; esa dirección solo la cubre la regla estricta. La comprobación validó la contraseña de verdad y no un acceso local de confianza.
- Identidad confirmada: rol `app_test_user` y base `fullstack_nextjs_test`. Solo se ejecutaron consultas de lectura.
- Recuentos leídos por la ruta de red: 14 tablas públicas, 7 migraciones, 3 usuarios, 5 sesiones de clase, ninguna otra sesión de cliente y cifrado de contraseñas `scram-sha-256`.
- La utilidad ejecuta su comprobación como archivo de programa y no con código en línea, porque el intérprete de órdenes de Windows no escapa las comillas dobles al pasar texto a un ejecutable nativo.

### Consistencia de la configuración local

| Comprobación | Resultado |
| --- | --- |
| `.env` contiene `TEST_DATABASE_URL` | Sí |
| `.env.compose.local` contiene `POSTGRES_TEST_PASSWORD` | Sí |
| Ambas contraseñas coinciden, comparadas en memoria | Sí |
| Rol, host, puerto y base de la cadena de TEST | Correctos |
| `DATABASE_URL` de DEV | Intacta y ajena a TEST |
| Claves duplicadas | Ninguna en ninguno de los dos archivos |
| Archivos en Git | Ignorados, sin entrada en el índice |
| Restos temporales de la utilidad | Ninguno |

### Integridad del servicio y de los datos

- Contenedor `fullstack_nextjs_postgres_test`: mismo identificador, misma hora de arranque, `running/healthy`, cero reinicios y el mismo volumen persistente montado en el directorio de datos.
- Tres bases presentes. La principal conserva 14 tablas públicas, 3 usuarios y 5 sesiones de clase; la residual de demostración conserva 15 tablas; el diario de migraciones mantiene 7 entradas y no hay migraciones nuevas.
- Sin sesiones de cliente ajenas a las comprobaciones. La publicación sigue limitada a `127.0.0.1:5433`.
- DEV: mismo contenedor, misma hora de arranque y saludable, sin conexiones ni cambios.

### Estado del respaldo

- Se conservan los tres volcados cifrados con la protección de datos del perfil de Windows —base principal, base residual y base de mantenimiento— con sus tamaños, fechas y el archivo de resúmenes SHA-256 originales, fuera del repositorio y sin ningún volcado en texto claro conocido.
- El ensayo de restauración de 10.26 (14 de 14 tablas y 15 de 15 tablas con recuentos idénticos, 7 migraciones, sin errores) sigue siendo la referencia válida de recuperación. No se descifraron los respaldos ni se repitió el ensayo porque no hubo causa justificada.
- No quedan contenedores del ensayo ni temporales asociados.

### Riesgos residuales

- El rol sigue siendo **superusuario**: la credencial protege todo el clúster de TEST.
- El contenedor conserva en su configuración de arranque el valor anterior de la variable de contraseña empleada al inicializar el volumen. El valor anterior ya no autentica, pero sigue siendo una copia almacenada; reemplazarla exigiría recrear el contenedor, algo fuera de este alcance y no autorizado.
- Los respaldos solo se pueden abrir con la cuenta de Windows del propietario; si se pierde ese perfil, no son recuperables.
- Las copias de la credencial fuera de esta máquina, su posible reutilización histórica y los checkpoints de los agentes siguen sin confirmarse.
- DEV no se ha rotado.
- Falta la aceptación documentada del riesgo residual por el propietario.

### Estado

**POSTGRESQL TEST — CREDENCIAL ROTADA Y VERIFICADA.** La evidencia acredita la sustitución del verificador del rol en TEST y la autenticación correcta con la configuración actual. No acredita una ausencia histórica de exposición ni el alcance de copias externas.

**H03 GLOBAL — PENDIENTE DE ACCIÓN OPERATIVA.** Quedan la rotación controlada de PostgreSQL DEV, la confirmación de reutilización o no reutilización histórica, la evaluación de copias externas y checkpoints, y la aceptación documentada del riesgo residual.

### Siguiente acción

Aplicar a PostgreSQL **DEV** el mismo procedimiento ya ensayado en TEST: respaldo verificado, ensayo de restauración, cambio interactivo de la contraseña del rol, actualización de su consumidor local, validación desde el host por la ruta que exige contraseña y registro de la evidencia sin valores. Ese trabajo no forma parte de este incremento y no se inició.

## Incremento 10.28 — Preparación de la rotación de PostgreSQL DEV

Este incremento **solo prepara** la rotación independiente de la credencial PostgreSQL DEV persistente. Se ejecutaron comprobaciones de solo lectura: no se cambió ninguna contraseña, no se crearon ni descifraron respaldos, no se aplicaron migraciones, no se escribieron datos, no se detuvieron procesos, no se reiniciaron ni recrearon contenedores y no se modificaron los archivos de entorno. La rotación de DEV **no está autorizada** y queda pendiente de aprobación expresa tras presentar el plan y sus riesgos.

### Alcance ejecutado

| Fase | Estado |
| --- | --- |
| A · Inventario de metadatos de DEV | Ejecutada, solo lectura |
| B · Mapa de consumidores de la credencial | Ejecutada por lectura de repositorio |
| C · Procesos activos e interrupción previsible | Ejecutada, sin detener nada |
| D · Separación DEV/TEST | Verificada |
| E · Respaldo y ensayo de restauración | Diseñados, **no ejecutados** |
| F · Rotación y actualización de configuración | Diseñadas, **no ejecutadas** |
| G · Documentación y commit local | Ejecutada, sin push |

### Inventario del servicio DEV

| Comprobación | Resultado |
| --- | --- |
| Contenedor | `fullstack_nextjs_postgres_dev`, identificador `ad882b9f55a9` |
| Imagen y versión del servidor | `postgres:15`, PostgreSQL 15.20 (Debian) |
| Creación | 2026-11-20, anterior a la intervención de TEST |
| Arranque actual | 2026-11-23 08:11 UTC, anterior a la rotación de TEST |
| Estado | `running`, saludable, cero reinicios |
| Política de reinicio | `unless-stopped` |
| Volumen persistente | `fullstack-nextjs_postgres_dev_data`, montado en el directorio de datos |
| Publicación de puerto | `127.0.0.1:5432` hacia `5432`, solo loopback |
| Tamaño | 49 MB de volumen; 47 MB de directorio de datos |
| Cifrado de contraseñas | `scram-sha-256` |
| Reglas de autenticación | Confianza para el socket local y el loopback interno; `host all all scram-sha-256` para el resto |
| Variables de inicialización en el contenedor | Usuario, contraseña y base presentes; la contraseña coincide con la configuración local actual |

### Rol y privilegios

- El único acceso es el rol **`app_dev_user`**, que es además **superusuario** del clúster, con herencia, creación de roles y bases, replicación, omisión de seguridad por fila y sin límite de conexiones.
- Conserva inicio de sesión, no tiene caducidad y almacena un único verificador `SCRAM-SHA-256`. No se leyó ni comparó el contenido del verificador en este incremento.
- Hay 13 roles en total: el acceso de aplicación y los roles internos del sistema. No existe un rol administrativo separado, por lo que el mismo rol que usa la aplicación es el que administra el clúster.
- Línea base capturada en este incremento, sin leer el verificador: identificador de transacción **755**, inicio de sesión, superusuario y sin caducidad. Es el valor de referencia que una rotación posterior debe cambiar, igual que ocurrió en TEST con 742 → 38941. La huella del verificador deberá capturarse en memoria justo antes del cambio.

### Bases, esquema y migraciones

| Base | Propietario | Tamaño | Tablas públicas | Diario Drizzle |
| --- | --- | --- | --- | --- |
| `fullstack_nextjs` | `app_dev_user` | 8,5 MB | 12 | 6 migraciones aplicadas |
| `postgres` | `app_dev_user` | 7,6 MB | 0 | Sin diario |

- DEV tiene **dos** bases, no tres: no existe base residual de demostración como en TEST.
- Las 12 tablas públicas pertenecen todas a `app_dev_user`; solo hay dos esquemas propios, `public` y `drizzle`.
- Tablas presentes: `app_metadata`, `class_reservations`, `class_sessions`, `class_templates`, `credit_ledger_movements`, `reservation_attendance_records`, `reservation_cancellations`, `session_capacity_blocks`, `sessions`, `student_profiles`, `student_template_assignments`, `users`.
- **Desfase de esquema:** el diario del repositorio tiene 17 migraciones (última `0016_habitual_reservation_provenance`, del 2026-11-23) y DEV conserva **6**, con la última aplicada el 2026-11-18. TEST quedó en 7 tras su propio historial. DEV no está al día y esa diferencia no se corrige aquí: aplicar migraciones sigue fuera de alcance.
- La base de aplicación está **sin datos de negocio**: 0 usuarios y 0 sesiones de clase. No existe dato privado de alumnos que proteger en una rotación, pero el respaldo previo sigue siendo obligatorio porque el volumen también contiene la configuración de roles y el estado de las migraciones.


### Consumidores de la credencial

| Consumidor | Campo exacto | Naturaleza | Efecto tras la rotación |
| --- | --- | --- | --- |
| Aplicación Next.js en desarrollo | `DATABASE_URL` de `.env`, leída por la validación de entorno y por el módulo de base | Pool de 10 conexiones, inactividad de 30 s, instancia memoizada en el ámbito global | Requiere **reiniciar el proceso**: el pool se crea una vez con la cadena vigente en ese momento |
| Drizzle CLI | `DATABASE_URL` en `drizzle.config.ts` | Proceso de un solo uso; rechaza nombres de base de test | Sin cambios: lee la variable en cada ejecución |
| `npm run db:migrate:dev` | `DATABASE_URL` mediante el cargador de entorno | Selecciona destino, verifica que no sea TEST ni coincida con su identidad, lanza Drizzle | Sin cambios; no se ejecuta en este incremento |
| `npm run db:inspect -- dev` | Ninguna contraseña | Entra por el socket local del contenedor como superusuario con confianza | Sigue funcionando sin secreto: útil para validar después de la rotación |
| `npm run db:inspect -- connection` / `ready` | `DATABASE_INSPECTION_URL`, `DB_EXPECTED_NAME`, `DB_EXPECTED_SYSTEM_ID` | Conexión TCP real desde el host | Ejercita `scram-sha-256`: sirve como validación de contraseña nueva |
| `npm run admin:create-super-admin` | `DATABASE_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Escritura administrativa | Sin cambios |
| `npm run academic:generate-sessions` | `DATABASE_URL` | Transacción con bloqueo consultivo y escritura | Sin cambios; no se ejecuta |
| Suites y ensayo de base desechable | Contenedor desechable con su propia `DATABASE_URL` | Independiente de DEV | No le afecta |
| `psql` 17.12 del host | Contraseña introducida por el propietario | Cliente TCP al puerto publicado | Vía válida de validación desde Windows |

- La credencial vive en **dos lugares locales**: la cadena completa en `.env` y la variable de contraseña de DEV en `.env.compose.local`. Ambas contienen el mismo valor, comparado en memoria y sin imprimirlo, y ese valor coincide además con el que el contenedor guarda como variable de inicialización: son tres copias del mismo secreto.
- En Compose, las variables de usuario, contraseña y base solo se aplican al **inicializar** el volumen; el puerto sí se interpola en la publicación. Cambiar la contraseña en el archivo no altera el contenedor en marcha ni la copia almacenada en sus metadatos.
- `TEST_DATABASE_URL` en `.env` apunta a otro puerto y otra base; no comparte destino con `DATABASE_URL`.

### Procesos activos e interrupción previsible

- **No hay aplicación Next.js en ejecución**: no existen procesos de Node y el puerto de la interfaz no está a la escucha.
- **No hay conexiones establecidas** hacia los puertos publicados de PostgreSQL, ni sesiones de cliente de la aplicación. Las únicas sesiones observadas son las de estas comprobaciones, de solo lectura y sin transacciones abiertas mantenidas.
- No hay migraciones, generadores de sesiones ni herramientas de administración en curso.
- Una rotación de contraseña **no cierra las sesiones ya establecidas**; como hoy no hay ninguna, la interrupción esperada es nula en este momento.
- Riesgo real: si el propietario inicia `next dev` entre la actualización parcial de archivos y la rotación, el pool arrancaría con un valor desfasado y fallaría al conectar. El procedimiento debe actualizar los dos campos seguidos y validar antes de abrir la aplicación.
- No se pueden descartar tareas programadas, demostraciones manuales o terminales abiertas fuera del repositorio; se registran como riesgo no evaluable y la ventana de intervención debe confirmarlos.

### Separación respecto a TEST

| Elemento | DEV | TEST | Independencia |
| --- | --- | --- | --- |
| Contenedor | `fullstack_nextjs_postgres_dev` | `fullstack_nextjs_postgres_test` | Identificadores distintos |
| Volumen | `fullstack-nextjs_postgres_dev_data` | `fullstack-nextjs_postgres_test_data` | Sin montajes compartidos |
| Base principal | `fullstack_nextjs` | `fullstack_nextjs_test` | Nombres distintos |
| Puerto publicado | `127.0.0.1:5432` | `127.0.0.1:5433` | Sin solapamiento |
| Rol | `app_dev_user` | `app_test_user` | Nombres y secretos distintos |
| Contraseña | Valor propio | Valor nuevo de 10.27 | Comparación booleana: no coinciden |
| Consumidores | `DATABASE_URL` y la variable de contraseña de DEV | `TEST_DATABASE_URL` y la variable de contraseña de TEST | Campos separados en los mismos archivos |

- Los scripts de migración aceptan un único destino y rechazan nombres de base de test; la inspección fija base y puerto por modo y valida la identidad del contenedor antes de consultar. Ninguno recorre ambos entornos.
- No existe en el repositorio una utilidad de rotación: la de 10.26 se mantuvo fuera del repositorio, con destino TEST declarado y sin posibilidad de escribir variables de DEV. Cualquier reutilización para DEV debe reescribirse con destino explícito, autoprueba con datos ficticios y comprobación de cableado sin conexión.


### Plan de respaldo y ensayo de restauración propuesto

1. Capturar la línea base en memoria: tamaño de cada base, 12 tablas con recuentos, 6 migraciones, identificador de transacción y huella del verificador del rol. Sin registrar huellas ni valores.
2. Volcar en formato personalizado las **dos** bases con el cliente `pg_dump` del propio contenedor y añadir un volcado **solo de roles** del clúster, porque los roles no pertenecen a ninguna base y son la vía de recuperación administrativa.
3. Copiar los archivos a un directorio fuera del repositorio, con permisos restringidos a la cuenta del propietario y sin nombres que revelen contenido.
4. Comprobar el índice de cada volcado antes de cifrar y calcular un resumen SHA-256 por archivo, guardando el índice de resúmenes junto al conjunto.
5. Cifrar con la protección de datos del perfil de Windows y verificar el descifrado por comparación de resumen, sin conservar copias en texto claro.
6. Ensayar la restauración en un contenedor `postgres:15` desechable, con datos en memoria temporal, sin puertos publicados y sin relación con los volúmenes persistentes: restaurar las dos bases y los roles.
7. Comparar 12 de 12 tablas con recuentos idénticos, las 6 migraciones del diario, los propietarios y los privilegios del rol restaurado.
8. Destruir el contenedor de ensayo y verificar que no quedan recursos ni archivos temporales.
9. Documentar que la recuperación depende del perfil de Windows del propietario: si se pierde, los respaldos no son recuperables, y la alternativa sería un nuevo volcado antes de cualquier cambio destructivo.

Este plan **no se ejecutó**. DEV no tiene hoy ningún respaldo conocido, por lo que el respaldo es condición previa imprescindible de la rotación.

### Procedimiento de rotación previsto

**Antes del cambio**

- Respaldo verificado y ensayo de restauración superado, con la línea base del rol capturada en memoria.
- Consumidores revisados y ventana de intervención aprobada por el propietario, con confirmación de que no hay tareas ni terminales activas fuera del repositorio.
- Nueva contraseña única, generada y guardada por el propietario en su gestor; no reutilizada de TEST ni de ningún otro servicio.
- Recuperación administrativa confirmada: el socket local del contenedor sigue siendo de confianza y el rol es superusuario, de modo que un propietario con acceso a Docker puede restablecer la contraseña sin conocer la anterior.

**Cambio efectivo**

- Sesión interactiva del propietario: `docker exec -it fullstack_nextjs_postgres_dev psql -U app_dev_user -d postgres` y a continuación `\password app_dev_user`.
- La contraseña se introduce en el aviso interactivo, que no muestra eco. No viaja en argumentos de proceso, no se escribe en archivos y no se comunica al asistente.
- Ninguna variante automatizada: ni sentencias con el literal, ni variables de entorno persistentes, ni historiales.

**Actualización de configuración**

- Dos ediciones acotadas: el componente de contraseña de `DATABASE_URL` en `.env` y `POSTGRES_DEV_PASSWORD` en `.env.compose.local`.
- Se conservan intactas el resto de las líneas, las variables de TEST, los demás secretos y el orden de claves; se verifica que no aparezcan claves duplicadas.
- No se modifica `compose.yaml`: la contraseña de Compose solo afecta a la inicialización de un volumen vacío.

**Verificación**

- Conexión nueva desde Windows a `127.0.0.1:5432`, que se resuelve contra la puerta de enlace de Docker y por tanto exige `scram-sha-256`; confirma rol `app_dev_user`, base `fullstack_nextjs` y las 12 tablas.
- Comparación en memoria del verificador con la línea base: debe ser distinto, con la fila del rol cambiada de identificador de transacción y los atributos intactos.
- `db:inspect -- connection` con la cadena nueva como comprobación independiente por TCP.
- Reinicio del proceso de desarrollo por el propietario y comprobación de que el pool conecta con conexiones nuevas; después, arranque de la aplicación y una página que consulte la base.
- TEST sin cambios: mismo identificador, misma hora de arranque, saludable.

**Recuperación**

- Si el cambio de contraseña no llega a ejecutarse, revertir los dos campos al valor respaldado restaura el servicio sin tocar el clúster.
- Si la rotación se ejecuta y el secreto nuevo se pierde, el restablecimiento se hace por el socket local de confianza con una sentencia interactiva del propietario; los datos y el esquema no dependen de la contraseña.
- Si el pool falla tras la rotación, la causa esperada es configuración desfasada o proceso no reiniciado, no pérdida de datos.


### Copia antigua en los metadatos de Docker

- El contenedor DEV guarda hoy una variable de contraseña cuyo valor **coincide** con la configuración local vigente: es la credencial activa y no una copia residual como en TEST.
- Esa variable solo se aplica al inicializar un volumen vacío. Con el volumen ya poblado el script de entrada no la reutiliza, así que tras la rotación quedará como copia del valor anterior, inoperante pero almacenada.
- Eliminarla exige **recrear el contenedor** conservando su volumen, con `docker compose up -d --force-recreate` limitado al servicio de DEV. Requiere autorización específica, una parada breve y verificación posterior.
- Riesgos de la recreación: aplicar por error variables de otro servicio, recrear ambos servicios a la vez, cambiar de proyecto o de volumen si el entorno no está cargado, y reinicializar el volumen si estuviera vacío.
- Se documenta como riesgo **separado** de la rotación del rol y no se ejecuta aquí.

### Incidencia de este incremento

Durante una comprobación booleana de consistencia, una interpolación defectuosa en el intérprete de órdenes imprimió **una vez** el valor literal de la credencial DEV en la salida de esta sesión de trabajo. No se escribió en archivos, no entró en Git, no se envió a ningún servicio externo y no afectó a TEST. Consecuencia: el secreto de DEV debe considerarse expuesto en la transcripción de la sesión y la rotación pasa a ser la acción recomendada de máxima prioridad; ese valor no debe reutilizarse en ningún otro servicio. La comprobación se repitió después devolviendo únicamente booleanos.

### Comprobaciones de solo lectura ejecutadas

- Todas las sentencias fueron `select` y `show` a través del socket local del contenedor: ninguna escritura, ningún cambio de rol, de privilegios ni de esquema.
- La credencial vigente **autenticó por TCP desde el host** contra `127.0.0.1:5432` con la contraseña leída en memoria desde el archivo local y transmitida por variable de entorno, retirada al terminar. Eso confirma dos cosas: la contraseña de DEV no se modificó en este incremento y la vía de validación prevista en el plan funciona hoy.
- Una contraseña **sintética inválida** fue rechazada por la misma ruta con error de autenticación. La validación futura medirá autenticación real y no un acceso de confianza del loopback.
- Línea base del rol: identificador de transacción 755, sin caducidad, con inicio de sesión y superusuario.
- Diario en 6 migraciones, tamaños de base sin cambios (8,5 MB y 7,6 MB), cero sesiones de cliente ajenas a las comprobaciones. DEV y TEST siguen saludables, sin reinicios y con arranques anteriores a este incremento.
- `.env` y `.env.compose.local` conservan su fecha de modificación previa. No se crearon respaldos, directorios ni archivos temporales nuevos.
- En el repositorio solo cambiaron los dos documentos de este incremento; los cambios ajenos preexistentes siguen intactos y el diff no contiene contraseñas, cadenas de conexión ni verificadores.

### Riesgos residuales

- El rol es **superusuario** y protege todo el clúster DEV; no existe separación de privilegios entre aplicación y administración. Corregirlo exige cambios de privilegios, fuera de alcance.
- El secreto se almacena en claro en dos archivos locales ignorados por Git y en los metadatos del contenedor; no hay gestor de secretos integrado.
- DEV no tiene respaldo previo y su esquema está desfasado (6 de 17 migraciones): un respaldo tomado ahora reproduce ese estado, no el del repositorio.
- Los respaldos dependerán del perfil de Windows del propietario.
- No se han confirmado copias externas, checkpoints de agentes ni reutilización histórica de contraseñas.
- Persisten procesos no inventariables fuera del repositorio y la incidencia de exposición descrita arriba.

### Estado

**POSTGRESQL DEV — SIN ROTAR; PREPARACIÓN COMPLETA Y NO AUTORIZADA.** El inventario, el mapa de consumidores, la separación respecto a TEST y los procedimientos de respaldo, rotación, validación y recuperación están definidos. No se ejecutó ninguna fase que modifique DEV.

**H03 GLOBAL — PENDIENTE DE ACCIÓN OPERATIVA.** Quedan la rotación de DEV, la confirmación de reutilización histórica, la evaluación de copias externas y checkpoints, y la aceptación documentada del riesgo residual.

### Acción que requiere aprobación

1. Autorizar el **respaldo con ensayo de restauración** de DEV, sin cambio de contraseña.
2. Autorizar la **rotación interactiva** de `app_dev_user`, la actualización de los dos campos locales y la validación desde el host, en una ventana confirmada por el propietario.
3. Decidir por separado si se **recrea el contenedor** para eliminar de sus metadatos la copia de la contraseña anterior, con su parada breve y su verificación.

## Incremento 10.29 — Preflight de DEV y utilidad local preparada (sin respaldo ni rotación)

Este incremento se detuvo en la puerta de autorización. La rotación de la credencial PostgreSQL DEV exige una aprobación nueva, expresa y específica del propietario, y esa aprobación no existe todavía en la conversación de trabajo. Por tanto **no se ejecutó el respaldo, ni el ensayo de restauración, ni el cambio de contraseña, ni ninguna escritura en DEV**. Lo realizado es el preflight de solo lectura y la preparación de la utilidad local que se usará después del paso manual del propietario.

### Preflight de solo lectura

| Comprobación | Resultado |
| --- | --- |
| Contenedor DEV | `fullstack_nextjs_postgres_dev`, identificador `ad882b9f55a9`, sin recrear desde 10.28 |
| Creación y arranque | 2026-11-20 y 2026-11-23 08:11 UTC, ambos anteriores a la intervención de TEST |
| Estado | `running`, saludable, cero reinicios, política `unless-stopped` |
| Volumen | `fullstack-nextjs_postgres_dev_data`, montado en el directorio de datos, sin cambios |
| Publicación | `127.0.0.1:5432`, solo loopback |
| Rol | `app_dev_user`, único acceso, superusuario, sin caducidad, un verificador `SCRAM-SHA-256` |
| Línea base del rol | identificador de transacción **755**, idéntico al de 10.28 |
| Roles | 13 en total, uno con inicio de sesión |
| Bases | `fullstack_nextjs` 8,5 MB y `postgres` 7,6 MB, mismas propietarias y tamaños |
| Esquema | 12 tablas públicas, 6 migraciones en el diario, sin cambios |
| Datos de negocio | 0 usuarios y 0 sesiones de clase |
| Sesiones y transacciones | ninguna sesión de cliente ajena a estas comprobaciones y ninguna transacción abierta |
| Reglas de autenticación | confianza para socket local y loopback interno; `host all all scram-sha-256` para el resto |
| TEST | mismo identificador, misma hora de arranque, saludable, sin reinicios ni cambios |
| Repositorio | `HEAD` en `a8ec70d`; solo los cambios ajenos preexistentes |

- Los dos archivos de configuración conservan su fecha de modificación anterior al incremento: no se reescribieron.
- No hay procesos de Node ni conexiones establecidas hacia los puertos publicados de PostgreSQL.
- La identidad del contenedor, del volumen, del rol y de las bases coincide con la línea base registrada en 10.28, por lo que los datos de referencia siguen siendo válidos.

### Utilidad local preparada, sin ejecutar sobre DEV

Se prepararon fuera del repositorio, en el directorio temporal del propietario, dos archivos que no contienen secretos:

1. Un **orquestador** con tres modos excluyentes: `-CheckWiring` (comprobaciones estáticas, sin leer contraseñas ni conectar), `-SelfTest` (autopruebas con datos ficticios) y `-Apply` (lectura interactiva sin eco, validación desde el host y escritura atómica).
2. Un **validador** ejecutado como archivo `.cjs` externo, que recibe la contraseña candidata solo por variable de entorno del proceso hijo y devuelve un resultado no sensible: rol, base, cifrado, esquema del verificador, dirección del cliente, identificador de transacción del rol, tablas, migraciones y recuentos.

Protecciones implementadas:

- Solo dos destinos: el componente de contraseña de `DATABASE_URL` en `.env` y `POSTGRES_DEV_PASSWORD` en `.env.compose.local`.
- Se rechaza cualquier cambio fuera de esas dos líneas comparando el archivo completo línea a línea antes de escribir.
- Detección de claves duplicadas y de valores entrecomillados; rechazo si el destino no es `app_dev_user`, `fullstack_nextjs`, puerto `5432` y host local.
- Rechazo de la contraseña vigente como nueva y de cualquier valor idéntico a la credencial de TEST, comparado en memoria.
- Validación de la contraseña nueva desde el host antes de escribir; si falla, no se escribe nada.
- Escritura con archivo temporal en el mismo directorio y reemplazo atómico; si el segundo reemplazo falla, se restaura el primero desde sus bytes originales.
- Preservación de codificación y saltos de línea: ambos archivos usan **UTF-8 con BOM y CRLF**, y la utilidad conserva ambos.
- Limpieza de variables de entorno y de archivos temporales en `finally`, y salida sin contraseña, sin cadena de conexión y sin verificadores.

Resultados de las pruebas ejecutadas:

- `-SelfTest`: 9 de 9 casos superados (actualización acotada, CRLF, BOM, fallo de validación sin cambios, clave duplicada, puerto incorrecto, contraseña repetida, reutilización de credencial de TEST y cableado).
- `-CheckWiring` sobre la configuración real: 18 de 18 comprobaciones correctas, sin leer ninguna contraseña.
- Validador con una contraseña **sintética** generada en memoria: rechazado con error de autenticación, código de salida 1 y ninguna salida sensible; confirma la resolución del módulo, la ruta TCP real y el comportamiento de cierre seguro.
- `-Apply` **no se ejecutó**: requiere el paso manual previo del propietario y la contraseña nueva real.

### Estado

**POSTGRESQL DEV — SIN RESPALDO Y SIN ROTAR; PREFLIGHT COMPLETO Y UTILIDAD PREPARADA, PENDIENTE DE AUTORIZACIÓN.** El respaldo sigue siendo condición previa: DEV no tiene ningún respaldo conocido y el plan de 10.28 exige un ensayo de restauración superado antes de tocar el rol.

**H03 GLOBAL — PENDIENTE DE ACCIÓN OPERATIVA.** Además de la rotación de DEV, siguen abiertos la reutilización de contraseñas históricas, las copias y checkpoints de agentes, la copia del valor anterior en los metadatos del contenedor y la aceptación documentada de los riesgos residuales.

### Acción que requiere aprobación

1. Autorizar el **respaldo con ensayo de restauración** de DEV, sin cambio de contraseña.
2. Autorizar después la **rotación interactiva** de `app_dev_user`, la actualización de los dos campos locales y la validación desde el host.
3. Decidir por separado si se **recrea el contenedor** para retirar de sus metadatos la copia de la contraseña anterior.

## Incremento 10.30 — Respaldo, rotación y verificación de la credencial PostgreSQL DEV

Con la autorización del propietario se completó la rotación efectiva de la credencial PostgreSQL DEV en el orden previsto: respaldo cifrado y ensayo de restauración, cambio de la credencial, actualización de los dos consumidores locales y verificación independiente de solo lectura. La contraseña no aparece en esta documentación, ni en archivos, ni en la transcripción.

### Fase A — Respaldo lógico cifrado

| Elemento | Resultado |
| --- | --- |
| Directorio | `%USERPROFILE%\Documents\h03-secure-backups\dev-20261123-183957`, fuera del repositorio |
| Permisos | ACL protegida, solo la cuenta del propietario con control total |
| Formato | `pg_dump` 15.20, formato personalizado `-Fc -Z 6` |
| Base principal | 50 818 bytes en claro, 51 046 cifrados |
| Base de mantenimiento | 1 096 bytes en claro, 1 318 cifrados |
| Metadatos de roles | 367 bytes en claro, 582 cifrados; un `CREATE ROLE`, cero `GRANT`, `PASSWORD NULL`, ningún verificador exportado |
| Integridad | SHA-256 del texto claro y del cifrado en `manifest.json`, descifrado verificado por comparación de resumen |
| Cifrado | Protección de datos del perfil de Windows, ámbito del usuario actual, entropía etiquetada |
| Contenido | 12 tablas públicas, 6 migraciones y todas las tablas de negocio con cero filas, idéntico al preflight de 10.29 |

El texto claro se eliminó del disco tras cifrar y los temporales se retiraron del contenedor. El respaldo corresponde al estado **anterior** a la rotación.

### Fase B — Ensayo de restauración

Ensayo repetido sobre el respaldo anterior para confirmar que sigue siendo restaurable después de la rotación:

- Descifrado de los tres artefactos con resumen idéntico al manifiesto.
- Contenedor desechable `postgres` 15.20 con datos en memoria temporal de 768 MB, **sin volúmenes montados y sin puertos publicados**.
- Restauración de ambas bases sin errores ni advertencias.
### Fase F — Rotación ejecutada por el propietario

La utilidad local se ejecutó en modo determinista: fija la contraseña en PostgreSQL por entrada estándar —sin sentencia en argumentos ni historial—, compara los atributos del rol antes y después para abortar si cambian, valida la credencial nueva desde el host y solo entonces actualiza los dos consumidores.

Una incidencia previa obligó a corregir la captura: el primer intento se detuvo en una comprobación previa (longitud mínima o discrepancia entre las dos entradas) **sin escribir nada**; el identificador de transacción del rol siguió en 756 y ambos archivos conservaron su fecha de modificación. La captura se sustituyó por un ciclo de hasta tres intentos que informa la causa concreta de cada rechazo —longitud, caracteres no imprimibles, contraseña vigente, reutilización de la credencial de TEST o discrepancia— y solo continúa cuando la candidata es válida. Tras la corrección, el propietario obtuvo `ROTACION Y CONSUMIDORES DEV ACTUALIZADOS`.

### Fase G — Verificación independiente

Script de solo lectura, sin imprimir secretos, con 25 comprobaciones y resultado global correcto:

| Comprobación | Resultado |
| --- | --- |
| Identidad del contenedor | mismo identificador, `running`, saludable, cero reinicios, misma hora de arranque |
| Volumen | `fullstack-nextjs_postgres_dev_data`, sin cambios |
| Rol | `app_dev_user` presente; identificador de transacción del rol de 755 a 760 respecto de la línea base |
| Consumidores | claves únicas, `DATABASE_URL` igual a `POSTGRES_DEV_PASSWORD`, valor distinto del de TEST, 37 caracteres, rol/host/puerto/base correctos |
| Tamaños de archivo | sin truncamiento |
| Autenticación desde el host | conexión nueva por TCP al puerto publicado, cifrado y verificador `scram-sha-256`, cliente en la dirección de la puerta de enlace, lectura correcta |
| Autenticación negativa | contraseña incorrecta rechazada con error `28P01` |
| Reglas de autenticación | regla general `scram-sha-256`, sin confianza global |
| Integridad de datos | 12 tablas, 50 índices, 12 enumerados, 6 migraciones, 0 usuarios, 0 sesiones, ninguna tabla con propietario ajeno |
| Bases | `fullstack_nextjs` y `postgres`, sin bases nuevas |
| TEST | mismo identificador, saludable, sin reinicios ni recreación |
| Repositorio | `HEAD` en `6dc7bac`, documentación confirmada y archivos de entorno ignorados |
| Metadatos de Docker | valor anterior conservado, distinto del vigente, sin exponerlo |
| Restos | sin contenedores de ensayo, sin volúmenes añadidos, sin volcados ni temporales en claro en el host |


- Comparación estructural y de recuentos: 12 tablas, 12 con propietario `app_dev_user`, 50 índices públicos, 12 tipos enumerados, 6 migraciones y recuentos exactos iguales al manifiesto; base de mantenimiento sin tablas; privilegio de lectura presente.
- Contenedor eliminado, ningún volumen residual y ninguna copia en claro en el host.



### Deuda y hallazgos abiertos

1. **Copia en los metadatos del contenedor.** El entorno del contenedor expone `POSTGRES_PASSWORD` —el nombre que Compose genera al interpolar `POSTGRES_DEV_PASSWORD`— con el valor **anterior**, de 32 caracteres, que ya no autentica. Solo desaparece recreando el contenedor; se mantiene como deuda declarada.
2. **Confianza en el loopback interno.** Las reglas de la imagen aceptan el loopback interno del contenedor sin contraseña; el acceso desde el host llega con la dirección de la puerta de enlace y sí exige `SCRAM-SHA-256`, como demuestran la prueba positiva y la negativa. Endurecer esa regla exige recargar la configuración y se deja para un incremento aparte.
3. **Procesos con conexión memoizada.** El grupo de conexiones de la aplicación se resuelve al arrancar: no había ningún proceso de Next.js en ejecución, pero cualquier proceso que se inicie debe hacerlo después de la rotación.
4. **Riesgos residuales ya declarados**: el rol conserva privilegio de superusuario, los respaldos dependen del perfil del propietario y de su protección de datos —no salen del equipo—, la reutilización de credenciales históricas sigue sin confirmar y las copias en puntos de control de agentes continúan sin verificar.

Los dos archivos del árbol de trabajo modificados por el propietario (`app/admin/sesiones/[sessionId]/session-capacity.tsx` y `docs/database-drizzle.md`) no se tocaron en este incremento.

### Estado

**POSTGRESQL DEV — CREDENCIAL ROTADA, CONSUMIDORES ACTUALIZADOS Y VERIFICACIÓN SUPERADA.** Respaldo cifrado del estado anterior conservado y ensayo de restauración correcto.

**H03 GLOBAL — PENDIENTE DE ACCIÓN OPERATIVA.** Quedan la recreación del contenedor DEV para retirar la copia anterior de sus metadatos, la decisión sobre la regla de confianza del loopback interno, la revisión de credenciales históricas y la aceptación documentada de los riesgos residuales.

### Acciones pendientes

1. Recrear el contenedor DEV cuando sea aceptable una interrupción breve, para eliminar el valor anterior de su configuración de arranque.
2. Decidir si se endurece `pg_hba.conf` retirando la confianza del loopback interno, con recarga de la configuración.
3. Revisar la reutilización de credenciales históricas y las copias en puntos de control de agentes.
4. Retirar las utilidades temporales del directorio temporal cuando ya no se necesiten; los respaldos cifrados se conservan.

## Incremento 10.31 — Evaluación final de copias históricas, reutilización y riesgo residual

Este incremento es diagnóstico y documental. No repite las rotaciones de 10.27 y 10.30, no abre informes ni transcripciones, no se conecta a bases de datos, no arranca, detiene ni recrea contenedores, no modifica Compose ni archivos de entorno, no consulta el remoto por red, no ejecuta operaciones destructivas de Git y no elimina referencias, informes, transcripciones ni respaldos. Todo el análisis se apoya en metadatos: nombres de referencia, rutas, recuentos, fechas y estados.

### A. Evidencia de rotación ya verificada

| Entorno | Sustitución del verificador | Autenticación posterior | Prueba negativa | Estado |
| --- | --- | --- | --- | --- |
| PostgreSQL TEST | Un único `SCRAM-SHA-256` distinto de la línea base; fila del rol 742 → 38941 | Conexión nueva desde el host por `127.0.0.1:5433` con la credencial vigente | No se probó la anterior, por decisión del procedimiento | Mitigado con evidencia (10.27) |
| PostgreSQL DEV | Un único `SCRAM-SHA-256` distinto de la línea base; fila del rol 755 → 760 | Conexión nueva desde el host por `127.0.0.1:5432` con la credencial vigente | Contraseña incorrecta rechazada con `28P01` | Mitigado con evidencia (10.30) |

La sustitución en cada servidor implica que el valor anterior ya no existe como verificador válido en ese rol. Esta evidencia cubre PostgreSQL; no cubre otros servicios que pudieran haber usado el mismo valor ni copias almacenadas fuera del servidor. Detalle en [10.27](#incremento-1027--rotación-de-postgresql-test-verificada) y [10.30](#incremento-1030--respaldo-rotación-y-verificación-de-la-credencial-postgresql-dev).

### B. Clasificación de las credenciales históricas

| Categoría | Dónde consta la copia | Estado del valor histórico |
| --- | --- | --- |
| Contraseña del rol `app_dev_user` anterior a 10.30 | Quince informes locales y sus copias en checkpoints; además la salida de una comprobación en 10.28 | Sustituida en PostgreSQL DEV; las copias permanecen |
| Contraseña del rol `app_test_user` anterior a 10.27 | Quince informes locales y sus copias en checkpoints | Sustituida en PostgreSQL TEST; las copias permanecen |
| Valor de DEV expuesto en la transcripción de 10.28 | Salida de la sesión de trabajo de ese incremento | Era la credencial vigente entonces; ya sustituida en el servidor |
| Clave HMAC de limitación de inicio de sesión | Sin exposición detectada en 10.13 | No aplica mientras no aparezca evidencia |
| Credenciales sintéticas, fixtures y demostración | Repositorio, informes y suites | Sintéticas o efímeras; no son credenciales operativas |
| Cuenta administrativa, sesiones, proveedor, correo y claves privadas | Sin exposición detectada en 10.13 | No aplica mientras no aparezca evidencia |

Las dos categorías que motivan H03 son las dos primeras. Su valor ya no autentica en su servidor, pero cualquier copia histórica sigue siendo material sensible: describe una contraseña que pudo haberse reutilizado en otro sistema.

### C. Inventario de checkpoints Git (solo metadatos)

| Espacio de nombres | Referencias presentes | Con copia de alguno de los 15 informes | Posteriores al commit de 10.24 (`99642cc`) | Ámbito |
| --- | --- | --- | --- | --- |
| `refs/agents/*` | 60 | 33 | 0 | Local |
| `refs/codex/turn-diffs/*` | 5 | 4 | 0 | Local |
| `refs/cline/checkpoints/*` | 18 | 0 por nombre de archivo | 8 | Local |
| **Total** | **83** | **37** | **8** | |

- El inventario de 10.24 registró 21 referencias de agentes con copia de informes. El recuento actual es de 37 entre dos espacios de nombres y ninguno de sus commits es posterior al commit de aquel inventario, de modo que no hay indicios de checkpoints nuevos con contenido sensible. La diferencia entre ambas cifras se registra como **discrepancia de conteo no resuelta** y no se usa como evidencia de exposición nueva ni de ausencia de ella.
- Las 8 referencias nuevas de `refs/cline/checkpoints` son instantáneas de área de trabajo creadas por la extensión del IDE después de 10.24. Ninguna contiene los nombres de archivo de los 15 informes; su contenido no se ha inspeccionado y no se afirma que sea inocuo.
- Ninguna de las 83 referencias contiene `.env` ni `.env.compose.local`. 71 contienen únicamente la plantilla versionada `.env.compose.example`, sin credenciales reales.
- Los informes están presentes en disco (15 de 15), fuera del índice (0 coincidencias en `git ls-files`), fuera del árbol de `master` y de `origin/master` (0 coincidencias) y fuera de sus historiales (0 commits). Las 15 exclusiones exactas de `.git/info/exclude` siguen vigentes y se comprobaron con `git check-ignore`; `.env` y `.env.compose.local` siguen ignorados.
- Publicación: solo existen `refs/heads/master` y `refs/remotes/origin/master`; el *fetch* solo mapea ramas; no hay *refspec* de `push`, ni `push.default`, ni `remote.pushDefault`, ni espejo, ni etiquetas, ni entradas en la pila. No existe reflog por referencia para estos tres espacios de nombres; el de `HEAD`/`master` conserva 64 entradas.
- Objetos: 866 sueltos, 1454 empaquetados en 3 paquetes, 1 empaquetado podable, sin basura. Estas cifras no identifican qué objeto contiene qué.
- Protección frente al staging ordinario: el índice solo incorpora rutas seleccionadas explícitamente y los 15 informes están excluidos, así que no entrarían con `git add`. Ninguna comprobación impide, en cambio, un `git push --mirror` o un `git push origin 'refs/*'`, que publicarían los checkpoints; la exclusión de `.git/info/exclude` tampoco se replica en otros clones.
- Borrar una referencia no elimina el contenido: los objetos seguirían alcanzables desde reflogs, otros objetos y respaldos hasta que se ejecute una recolección autorizada. Tampoco devuelve los puntos de recuperación perdidos ni permite afirmar que la copia desapareció.
- Riesgos de borrarlas ahora: pérdida irreversible de puntos de recuperación del agente, pérdida de evidencia útil para esta investigación, posible corrupción del estado de la herramienta y falsa sensación de saneamiento.
- Una depuración completa y verificable exigiría, en un incremento autorizado aparte: copia de seguridad del repositorio fuera del árbol de trabajo como vía de recuperación; inventario previo de referencias y sus identificadores; decisión explícita sobre la conservación de evidencia; retirada de referencias; expiración de reflogs y recolección con poda solo en ventana autorizada; verificación posterior con `git fsck` y comprobación de que los informes ya no son alcanzables; y constancia de que las copias externas siguen fuera de alcance. Nada de esto se ejecutó.

### D. Informes locales, transcripciones y registros del agente

- **Informes locales.** Quince archivos presentes en el disco, excluidos del índice y ausentes de ramas e historiales. Se conservan; no se abrió su contenido.
- **Transcripciones.** La incidencia de 10.28 queda registrada como exposición histórica de una credencial ya rotada. Su reproducción no se repite. El alcance de las copias depende del almacenamiento de las herramientas usadas: el directorio de estado de Codex ocupa unos 569 MB en 5989 archivos, con 17 archivos de sesión; el de Cline unos 17,6 MB en 41 archivos; el almacenamiento global del IDE contiene un directorio de la extensión de chat. No se inspeccionó su contenido y no consta ni acceso de terceros ni inaccesibilidad a terceros.
- **Herramientas temporales.** El directorio temporal del propietario conserva la utilidad de rotación de DEV con 6 archivos; no se ha inspeccionado ni se ha retirado.
- **`test-results/`.** Sigue presente, sin seguimiento en Git y sin exclusión: se conserva y no se incorpora al índice.

### E. Metadatos de Docker

| Elemento | DEV | TEST |
| --- | --- | --- |
| Contenedor | `fullstack_nextjs_postgres_dev` | `fullstack_nextjs_postgres_test` |
| Imagen | `postgres:15` | `postgres:15` |
| Estado | `running`, saludable | `running`, saludable |
| Creación | 2026-11-20 09:36 UTC | 2026-11-20 09:36 UTC |
| Arranque actual | 2026-11-23 08:11 UTC | 2026-11-23 08:11 UTC |
| Reinicios / política | 0 / `unless-stopped` | 0 / `unless-stopped` |
| Volumen | `fullstack-nextjs_postgres_dev_data` | `fullstack-nextjs_postgres_test_data` |
| Variables de inicialización | incluye `POSTGRES_PASSWORD` | incluye `POSTGRES_PASSWORD` |

- Ambos contenedores conservan en su configuración de arranque la variable de contraseña con el valor de inicialización del volumen, que es **anterior** a la rotación y ya no autentica. Sus valores no se leyeron ni se registraron.
- Son copias de secretos históricos: inertes para autenticarse, pero sensibles si el valor se reutilizó en otro sistema.
- No deben usarse para inicializar volúmenes nuevos, porque crearían un rol con la contraseña histórica.
- Su retirada exige recrear cada contenedor conservando su volumen, con autorización específica, interrupción breve y verificación posterior. No se hizo: no se recreó ningún contenedor, no se detuvo Docker y no se modificó Compose.
- El volumen `gpt_codex_full_prueba_mysql_data` pertenece a otro proyecto y es ajeno a H03; no se evaluó.

### F. Reutilización histórica

No se comparó ninguna contraseña con otros archivos, gestores, servicios o bases, y no se accedió al gestor de contraseñas. La comprobación es administrativa y depende del propietario:

| Ámbito | Estado |
| --- | --- |
| PostgreSQL DEV | Pendiente de comprobar (valor sustituido en el servidor) |
| PostgreSQL TEST | Pendiente de comprobar (valor sustituido en el servidor) |
| Otros proyectos locales | Pendiente de comprobar |
| Bases remotas o alojadas | Pendiente de comprobar |
| Aplicaciones externas | Pendiente de comprobar |
| Cuentas personales | Pendiente de comprobar |
| Otros servicios conocidos | Pendiente de comprobar |

La respuesta válida es una de estas cuatro, por ámbito: **no se reutilizó**, **se reutilizó y ya se rotó**, **se reutilizó y sigue pendiente**, **no se sabe**. No se solicita ningún valor, cuenta ni nombre de servicio. Si existe reutilización sin mitigar, H03 no puede cerrarse.

### G. Posible exposición externa y respaldos

- No se hicieron consultas de red al remoto ni a servicios externos. El remoto configurado es el único conocido y no se ha consultado su contenido: la ausencia de los informes en el historial publicado de `origin/master` está comprobada contra la referencia local, no contra el servidor.
- Nada indica que los informes o las transcripciones se hayan compartido o sincronizado fuera del equipo, y nada permite descartarlo. El alcance de acceso de terceros sigue sin confirmar.
- **Respaldos DEV:** el conjunto `%USERPROFILE%\Documents\h03-secure-backups\dev-20261123-183957` conserva cuatro archivos: tres cifrados con la protección del perfil de Windows y el manifiesto de resúmenes. Su ACL está restringida y dependen de la cuenta de Windows del propietario.
- **Respaldos TEST:** no se localizó el conjunto documentado en 10.26 en las dos ubicaciones revisadas (`Documents` y `Downloads`). No hay indicios ni de borrado ni de conservación: su localización y su retención deben confirmarse antes de cualquier decisión sobre respaldos.
- **Copias de seguridad en general:** no se descifró, movió, renombró ni borró ningún artefacto.

### H. Matriz final de riesgo

| Categoría | Evidencia | Exposición activa | Riesgo residual | Acción requerida | Responsable |
| --- | --- | --- | --- | --- | --- |
| Contraseña histórica DEV | Verificador sustituido y autenticación verificada (10.30); copias en informes, checkpoints y metadatos | No en PostgreSQL DEV | Medio por reutilización desconocida | Confirmar reutilización | Propietario |
| Contraseña histórica TEST | Verificador sustituido y autenticación verificada (10.27); copias en informes y checkpoints | No en PostgreSQL TEST | Medio por reutilización desconocida | Confirmar reutilización | Propietario |
| Valor expuesto en la transcripción de 10.28 | Era la credencial DEV vigente; sustituida en el servidor | No en PostgreSQL DEV | Medio: copia en el almacén del agente | Decidir el tratamiento de la transcripción | Propietario |
| Checkpoints locales de Git | 83 referencias; 37 con copia de informes; locales y sin *refspec* de publicación | No activa | Medio mientras se conserven copias sensibles | Decidir conservación o saneamiento controlado | Propietario y administración del repositorio |
| Informes sensibles | 15 en disco, fuera de índice, ramas e historiales; 15 exclusiones vigentes | No activa | Medio | Conservar como evidencia y decidir su destrucción futura | Propietario |
| Registros del agente | 569 MB en Codex, 17,6 MB en Cline y el almacén del IDE | Pendiente de comprobar | Medio | Confirmar si se compartieron o sincronizaron | Propietario |
| Metadatos Docker | `POSTGRES_PASSWORD` con el valor de inicialización anterior en ambos contenedores | No (el valor ya no autentica) | Medio si el valor se reutilizó | Recrear los contenedores con autorización para retirar la copia | Administración del entorno |
| Reutilización en otros servicios | Sin comprobar | Pendiente de comprobar | Indeterminado | Comprobación administrativa del propietario | Propietario |
| Posible publicación externa | Sin evidencia de compartición y sin evidencia de lo contrario | Pendiente de comprobar | Indeterminado | Declaración del propietario | Propietario |
| Respaldos protegidos | DEV con cuatro artefactos cifrados por DPAPI; TEST no localizado en las ubicaciones revisadas | No activa | Bajo en DEV; indeterminado en TEST | Confirmar ubicación y retención; definir política | Propietario |

Estados utilizados: **mitigado con evidencia**, **pendiente de decisión**, **pendiente de comprobar**, **riesgo aceptado por el propietario** y **no aplica**. En este incremento no se declara ninguna aceptación de riesgo: esa casilla solo puede marcarla el propietario.

### I. Endurecimiento independiente de H03

Estas tareas **no** son credenciales activas expuestas y no se corrigen en 10.31:

| Tarea | Motivo | Prioridad propuesta |
| --- | --- | --- |
| Verificar ubicación y retención de los respaldos de TEST; definir política de conservación y destrucción | El conjunto de 10.26 no se localizó en las ubicaciones revisadas | Alta |
| Recrear los contenedores para retirar el valor anterior de `POSTGRES_PASSWORD` | Copia de secreto histórico en la configuración de arranque | Alta (requiere autorización y parada breve) |
| Separar el rol de aplicación del privilegio de superusuario | La credencial protege todo el clúster en DEV y en TEST | Media-alta |
| Retirar la confianza del socket y del loopback interno en `pg_hba.conf` | Reduce el efecto de una credencial filtrada dentro del contenedor | Media |
| Reducir la dependencia de la protección del perfil de Windows | Si se pierde el perfil, los respaldos no son recuperables | Media |
| Limitar el acceso administrativo a Docker | Equivale a control total del host y de los volúmenes | Media |
| Actualizar las migraciones atrasadas de DEV (6 de 17) y TEST (7 de 17) | Desfase operativo, no de credenciales | Baja-media |
| Decidir sobre la base residual de demostración del clúster de TEST | Comparte rol y clúster | Baja |

### J. Criterios de cierre de H03

| Criterio | Estado |
| --- | --- |
| 1. DEV y TEST con las credenciales anteriores invalidadas, con evidencia | Cumplido |
| 2. Sin otros sistemas conocidos donde esas contraseñas sigan activas | Pendiente del propietario |
| 3. Reutilización histórica evaluada por el propietario | Pendiente |
| 4. Copias conocidas clasificadas | Cumplido para las locales: informes, checkpoints, metadatos y almacenes del agente |
| 5. Decisión explícita sobre checkpoints y transcripciones | Pendiente |
| 6. Alcance desconocido documentado | Cumplido |
| 7. Aceptación expresa del riesgo residual | Pendiente |
| 8. Sin exposiciones activas conocidas sin mitigación | Cumplido para las dos credenciales PostgreSQL; las copias históricas no son credenciales activas |

**H03 — PENDIENTE DE CIERRE OPERATIVO.** Los criterios 2, 3, 5 y 7 dependen exclusivamente de decisiones del propietario. El criterio 8 no se extiende a servicios ajenos a PostgreSQL hasta que exista la respuesta del criterio 2.

### K. Decisiones del propietario

1. ¿Las contraseñas históricas de DEV y TEST se reutilizaron en otros servicios? Respuesta por ámbito: no se reutilizó / se reutilizó y ya se rotó / se reutilizó y sigue pendiente / no se sabe.
2. ¿Los informes o las transcripciones se compartieron o sincronizaron fuera de este equipo?
3. ¿Prefiere conservar temporalmente los checkpoints restringidos o autorizar después su saneamiento controlado?
4. ¿Acepta los riesgos residuales documentados una vez respondidas las tres preguntas anteriores?

Si alguna respuesta es «no se sabe», se registra la incertidumbre y se mantiene abierto el criterio correspondiente. La mitigación propuesta es tratar el valor como reutilizable hasta confirmación y no reintroducirlo en ningún servicio nuevo.

### L. Tratamientos que requieren autorización específica

1. Recrear el contenedor DEV, conservando su volumen, para retirar la copia anterior de la configuración de arranque.
2. Recrear el contenedor TEST con el mismo fin, o decidir su conservación.
3. Saneamiento controlado de referencias de checkpoint: copia de seguridad previa, inventario, ventana y verificación; nunca junto con una recolección de objetos no auditada.
4. Retención, traslado o destrucción de informes, transcripciones y utilidades temporales.
5. Confirmación de la ubicación y la política de retención de los respaldos de TEST y DEV.

### Estado de este incremento

No se modificó PostgreSQL DEV ni TEST, no se recreó ni detuvo ningún contenedor, no se ejecutaron operaciones destructivas de Git y no se borró evidencia. El único cambio es documental.

**H03 — PENDIENTE DE CIERRE OPERATIVO**, a la espera de las respuestas del propietario en la sección K y de la autorización de los tratamientos de la sección L. El siguiente incremento recomendado, sin ejecutarlo, es la verificación de la ubicación y la retención de los respaldos.

## Incremento 10.32 — Decisiones del propietario y evaluación de cierre de H03

Este incremento recoge las cuatro decisiones que 10.31 dejó abiertas y evalúa si permiten cerrar H03. No repite la auditoría, no busca contraseñas, no abre objetos con credenciales, no consulta el remoto por red, no conecta con PostgreSQL DEV ni TEST, no modifica secretos, bases, contenedores, referencias ni respaldos y no ejecuta operaciones destructivas. Las respuestas se registran como declaraciones del propietario: se distinguen de la evidencia técnica ya verificada y no se presentan como comprobaciones.

### A. Respuestas registradas

| Pregunta | Respuesta del propietario | Consecuencia documental |
| --- | --- | --- |
| A. Reutilización histórica de las contraseñas de DEV y TEST | «No se reutilizaron, según mi conocimiento.» | Declaración; no consta reutilización conocida ni se convierte en verificación técnica |
| B. Difusión de informes o transcripciones fuera del equipo | «Sí, pero conozco los destinos y puedo describirlos sin secretos.» | Existe difusión confirmada fuera del equipo |
| B2. Categoría del destino | «Repositorio remoto de código o espejo de Git (propio o de la organización).» | Destino conocido que exige actuación |
| C. Tratamiento de informes y checkpoints locales | «Preparar un saneamiento controlado en un incremento independiente.» | Decisión registrada; nada se ejecuta en este incremento |
| D. Aceptación del riesgo residual | «Sí, acepto el riesgo residual descrito.» | Aceptación expresa, con el alcance limitado de la sección E |

No se solicitó ni se registró ningún valor, cuenta, nombre de servicio ni dato personal. Las respuestas describen categorías.

### B. Evaluación de la reutilización

- La declaración A cubre en conjunto los siete ámbitos de 10.31 § F: PostgreSQL DEV y TEST, otros proyectos locales, bases remotas o alojadas, aplicaciones externas, cuentas personales y otros servicios conocidos.
- No se verificó técnicamente y no se repitió ninguna búsqueda de contraseñas. Lo declarado es coherente con la rotación verificada de ambos roles, pero la coherencia no equivale a prueba.
- Consecuencia: no se conoce ninguna contraseña antigua todavía activa en un servicio distinto de PostgreSQL. Esa ausencia se apoya en el conocimiento del propietario.
- Se mantiene la regla de 10.31: tratar el valor como reutilizable si aparece evidencia en contrario y no reintroducirlo en ningún servicio nuevo.
- Riesgo que permanece: una reutilización desconocida para el propietario no puede descartarse con medios técnicos desde este repositorio.

### C. Difusión de copias y destino remoto

- La respuesta B confirma que hubo salida de copias fuera del equipo, y B2 sitúa el destino en un repositorio remoto de código o espejo de Git, propio o de la organización. Es un **destino conocido con exposición potencial que exige actuación**.
- No se determinaron: el repositorio o espejo concreto, las rutas o ramas afectadas, su visibilidad, las personas con acceso ni si las copias siguen presentes o ya fueron retiradas. No se consultó el remoto por red, no se abrieron objetos y no se ejecutó ninguna operación de historial.
- La comprobación de 10.31 —cero coincidencias en el historial de `origin/master` local— sigue siendo válida como dato sobre esa referencia concreta. No cubre otros repositorios, otras ramas ni espejos, y no se usa como prueba de ausencia.
- Efecto sobre las credenciales: el valor histórico ya no autentica en DEV ni en TEST (10.27 y 10.30), de modo que la difusión no reabre una exposición activa en esos dos servidores. Lo que persiste es la copia del valor en un sistema ajeno a este equipo, con sus propios controles de acceso y retención.
- Lo que falta: identificar el destino y su visibilidad, y decidir si se retira la copia. Una retirada que afecte al historial exigirá un incremento autorizado, con coordinación y procedimiento de recuperación.
- Responsables: el propietario para la identificación del destino; la administración del repositorio para cualquier retirada.

### D. Tratamiento de las copias locales

- Decisión C: preparar un saneamiento controlado en un incremento independiente. Se registra la decisión y **no se ejecuta**: los 15 informes, las 83 referencias y los almacenes de las herramientas siguen intactos.
- El saneamiento deberá cubrir informes, referencias de checkpoint, utilidades temporales y transcripciones, con respaldo previo fuera del árbol de trabajo, inventario de identificadores, ventana autorizada, verificación posterior con `git fsck` y constancia de que las copias externas quedan fuera de su alcance.
- Los almacenes de las herramientas —Codex, Cline y la extensión del IDE— no se limpian con operaciones de Git y requerirán una decisión propia.
- Mientras no se ejecute, se mantienen el acceso restringido y la prohibición de publicar referencias de checkpoint.

### E. Riesgo residual aceptado

La respuesta D es una aceptación expresa, con este alcance: copias históricas locales conservadas a la espera de saneamiento; difusión a un destino remoto de Git todavía sin identificar; incertidumbre sobre reutilización que el propietario no puede descartar técnicamente; metadatos de Docker con el valor anterior; y endurecimiento independiente sin ejecutar.

- La aceptación se limita a los riesgos documentados. No cubre la aparición de una credencial activa comprometida, ni un destino con acceso de terceros que exija actuación inmediata, ni una reutilización desconocida por el propietario.
- Aceptar el riesgo no sustituye la acción pendiente sobre el destino remoto: el criterio 8 de 10.31 exige que no exista una exposición activa conocida sin mitigación y ese destino aún no se ha evaluado.
- No se declara corregido ningún punto de endurecimiento: superusuario, confianza interna, dependencia de DPAPI, migraciones atrasadas, retención de respaldos y acceso a Docker siguen como deuda documentada.

### F. Estado final de H03

| Criterio de cierre | Estado en 10.32 |
| --- | --- |
| 1. DEV y TEST con rotación verificada | Cumplido (10.27 y 10.30) |
| 2. Sin otros servicios con esas contraseñas activas | Declarado por el propietario; no verificado técnicamente |
| 3. Reutilización histórica evaluada | Declarada; suficiente para el conocimiento del propietario, insuficiente para descartar una reutilización desconocida |
| 4. Copias locales clasificadas | Cumplido (10.31) |
| 5. Decisión sobre informes y checkpoints | Cumplido: saneamiento controlado en un incremento independiente |
| 6. Incertidumbres documentadas | Cumplido |
| 7. Aceptación expresa del riesgo residual | Cumplido (sección E) |
| 8. Sin exposición activa conocida sin mitigación | **No cumplido**: destino remoto de Git conocido y sin evaluar |

**H03 — PENDIENTE DE ACCIÓN OPERATIVA.** La rotación de DEV y TEST sigue mitigada con evidencia y el riesgo residual está aceptado por el propietario, pero el criterio 8 no se cumple: existe un destino conocido —repositorio remoto de código o espejo de Git— que conserva copias históricas y cuya visibilidad y contenido no se han evaluado. Ninguna aceptación genérica de riesgo puede sustituir esa actuación.

El cierre será posible cuando se identifique el destino, se conozca su visibilidad y se decida si las copias se retiran. Ese cierre significará que no consta exposición activa sin mitigación; no significará que nunca existiera acceso de terceros.

### G. Acciones pendientes y responsables

| Acción | Responsable | Condición |
| --- | --- | --- |
| Identificar el repositorio o espejo, las rutas o ramas afectadas y su visibilidad | Propietario | Ninguna consulta al remoto se hace en este incremento |
| Decidir y, si procede, retirar las copias del destino remoto | Propietario y administración del repositorio | Incremento autorizado; si afecta al historial, coordinación y procedimiento de recuperación |
| Preparar el saneamiento local de informes, checkpoints, utilidades y transcripciones | Propietario | Incremento independiente; respaldo previo y verificación posterior |
| Limpiar los almacenes de las herramientas, que no dependen de Git | Propietario | Decisión propia; no incluida en el saneamiento de referencias |
| Confirmar ubicación y retención de los respaldos de DEV y TEST | Propietario | Antes de cualquier borrado |
| Endurecimiento independiente: superusuario, confianza interna, DPAPI, migraciones atrasadas, retención de respaldos y acceso a Docker | Administración del entorno | Incrementos propios; prioridades en 10.31 § I |
| Reevaluar H03 y, si procede, cerrarla | Propietario | Solo cuando el criterio 8 esté cumplido |

### H. Deriva observada durante el incremento

- El recuento de referencias de checkpoint pasó de 83 a 84 mientras se redactaba este incremento: la extensión del IDE creó una referencia nueva en `refs/cline/checkpoints` a las 19:16 (hora local del 2026-11-23), después de las ediciones documentales. La cifra 83 sigue siendo el registro histórico de 10.31 y no se corrige.
- Inspección **solo por nombres** de esa referencia: 262 rutas; ninguna corresponde a los 15 informes locales ni a un archivo de entorno real; las dos únicas coincidencias con patrones sensibles son la plantilla versionada `.env.compose.example` y este mismo documento. No se leyó ningún contenido.
- Consecuencia para el saneamiento: los checkpoints se regeneran con cada edición del área de trabajo, de modo que una limpieza posterior debe ejecutarse en una ventana sin ediciones y verificarse al final; si no, reaparecerán referencias con el estado actual.
- Consecuencia para el recuento: el inventario de 10.31 describe el estado de su momento y no debe citarse como cifra viva; lo mismo vale para la cifra 84 observada aquí, que puede crecer con cada edición posterior.

### Estado de este incremento

No se modificó PostgreSQL DEV ni TEST, no se recreó ni detuvo ningún contenedor, no se alteraron secretos ni respaldos, no se retiró ni alteró ninguna referencia existente, no se reescribió historial y no se ejecutaron operaciones destructivas. El único cambio provocado por este incremento es documental.

Siguiente incremento recomendado, sin ejecutarlo: identificación del destino remoto a partir de lo que declare el propietario, sin consultas de red ni apertura de objetos, y decisión sobre la retirada de esas copias.
