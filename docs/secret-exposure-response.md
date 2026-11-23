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
