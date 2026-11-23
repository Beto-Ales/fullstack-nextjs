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
