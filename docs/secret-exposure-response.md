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
