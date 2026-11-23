# Ensayo de despliegue en staging

`npm run staging:rehearse` reproduce, en la máquina local y sin tocar entornos persistentes, el camino completo de un despliegue: PostgreSQL 15 vacío, journal hasta `0016`, datos sintéticos, respaldo lógico, restauración equivalente en una segunda instancia, compilación de producción, arranque de `next start` y comprobaciones HTTP de sesiones reales, con retirada automática de todos los recursos.

El ensayo valida el procedimiento y los invariantes del despliegue. **No** sustituye un staging alojado: no configura un servidor, DNS, TLS, un gestor de secretos ni un pipeline de CI.

## Requisitos previos

- Node.js y `npm` con las dependencias instaladas (`npm install`). Verificado con Node.js 24.18.0.
- Docker en ejecución y la imagen `postgres:15` disponible; si falta, `docker pull postgres:15`.
- Al menos un puerto de loopback libre para PostgreSQL y otro para Next.js. El ensayo los elige y comprueba que siguen libres al terminar.
- La sesión de shell **sin** `TEST_DATABASE_URL` ni `POSTGRES_TEST_RUN`. Si existen, el ensayo aborta antes de crear recursos: el aprovisionador genera su propia identidad y no reutiliza ninguna.
- No hace falta `.env`. Si existe, Next lo carga al compilar y al arrancar; el ensayo tapa sus identidades persistentes (ver [Credenciales y compilación](#credenciales-y-compilación)).

## Comandos

| Comando | Alcance |
| --- | --- |
| `npm run staging:rehearse` | Ensayo completo de despliegue con sus 66 comprobaciones. |
| `npm run staging:verify` | `typecheck`, `lint`, `drizzle-kit check`, el ensayo H08 (`db:rehearse`) y el ensayo de despliegue. |

Ningún comando consume variables de entorno de despliegue: la base, la contraseña, el secreto HMAC y los puertos se generan en el proceso. La salida solo publica un resumen con la huella del esquema, la huella del respaldo y el puerto local usado; los valores sensibles se redactan incluso en los errores.

## Modelo de aislamiento

El ensayo reutiliza el aprovisionador de H08 con una etiqueta nueva, `staging`, autorizada en `scripts/postgres-test-guard.mjs`:

1. Crea un contenedor `postgres:15` desechable con datos en memoria temporal, contraseña aleatoria, base y rol propios, marcador de propiedad en `test_provisioning` y retirada forzada al salir.
2. Abre la conexión solo después de verificar contenedor, puerto, identidad del servidor, base, rol y marcador, y rechaza los puertos persistentes habituales.
3. Repite el ciclo en una **segunda** instancia desechable para la restauración. Ningún contenedor se reutiliza entre etapas.
4. Publica únicamente en `127.0.0.1` con puertos efímeros; nunca usa `5432` ni `5433`.
5. Registra `docker inspect` de `fullstack_nextjs_postgres_dev` y `fullstack_nextjs_postgres_test` antes y después, y falla si su estado cambia.
6. Siembra solo datos sintéticos con dominios `.invalid`, sufijos de prueba e identificadores reconocibles.
7. Mantiene los secretos en memoria del proceso; el respaldo se escribe en un directorio temporal del sistema y se borra en el mismo cierre, también cuando hay error.

## Comprobaciones del ensayo

Las 66 comprobaciones se agrupan así. Cualquier fallo detiene el ensayo con código distinto de cero y un mensaje redactado.

| Bloque | Qué demuestra |
| --- | --- |
| Entorno y herramientas | El proceso no hereda identidades persistentes; el cliente `pg_dump`/`pg_restore` es de la versión 15. |
| Migraciones | La base está vacía antes de migrar; el repositorio y el journal coinciden; el prefijo histórico `0000`–`0004` se aplica de verdad y su estado intermedio es válido; después se aplica el journal completo hasta `0016_habitual_reservation_provenance`; la huella del catálogo coincide con la de referencia. |
| Configuración | La comprobación de arranque falla cerrada sin clave HMAC y rechaza límites fuera de rango. |
| Datos sintéticos | Las 12 tablas sembradas tienen filas y hay exactamente dos sesiones de prueba. |
| Integridad | Seis consultas verifican enlaces habituales, reservas canceladas, consumos de crédito, el índice de procedencia y su clave foránea. |
| Respaldo | `pg_dump --format=custom` se conserva íntegro en disco, contiene las tablas y el journal de Drizzle, y excluye el esquema de aprovisionamiento. |
| Restauración | El destino está vacío; `pg_restore` reproduce journal, catálogo, huella, recuentos, filas comparadas en JSON y las seis comprobaciones de integridad; el estado queda listo en `0016`. |
| Compilación | `next build` produce `.next/BUILD_ID` y `.next/server/app`; la caché incremental se elimina; ni el artefacto ni el bundle cliente contienen credenciales conocidas ni URLs de base de datos. |
| Arranque y humo | Quince peticiones HTTP con cookies de sesión reales: páginas públicas, panel administrativo, área del alumno, normativa, redirecciones por rol y rechazo de una sesión inválida. |
| Solo lectura | El esquema, el journal y los recuentos de filas no cambian después de las peticiones; la base sigue en `0016`. |
| Cierre | El proceso de Next se detiene y su puerto queda libre; el respaldo temporal desaparece; el contenedor desechable ya no existe; los contenedores persistentes conservan su estado. |

### Equivalencia del respaldo y la restauración

El respaldo se toma con `--format=custom` y `--exclude-schema=test_provisioning`. La restauración usa `--single-transaction --exit-on-error --no-owner --no-acl` sobre una instancia recién creada, de modo que un fallo deja el destino intacto en vez de a medias. La equivalencia no se declara por el código de salida: se compara el journal completo de Drizzle, el catálogo normalizado de objetos, su huella SHA-256, los recuentos de las 12 tablas, las filas serializadas a JSON y las comprobaciones de integridad.

## Credenciales y compilación

Una compilación de staging no debe poder alcanzar ninguna base real. El ensayo compila con un `DATABASE_URL` inerte (`staging_build` sobre `127.0.0.1:1`), una clave HMAC sintética de ceros y límites fijos, y sin ninguna credencial del ensayo.

Next carga `.env` al compilar y al arrancar. Por eso el ensayo define `TEST_DATABASE_URL`, `POSTGRES_TEST_RUN` y `DATABASE_INSPECTION_URL` como cadenas vacías en el entorno hijo: el cargador de Next respeta los valores ya definidos y no puede inyectar la identidad persistente del archivo local. Además, los valores de `DATABASE_URL`, `DATABASE_INSPECTION_URL`, `TEST_DATABASE_URL` y `AUTH_RATE_LIMIT_HMAC_KEY` presentes en `.env` se registran solo en memoria y se buscan en `.next` tras eliminar su caché incremental. La aplicación arranca después con el `DATABASE_URL` del contenedor desechable y sin identidad de pruebas efectiva.

## Resultado verificado (23 de noviembre de 2026)

- `npm run staging:rehearse` terminó con código 0 y **66 comprobaciones** en unos 3 minutos, incluida la compilación.
- Journal en `0016_habitual_reservation_provenance` y huella de esquema estable (`1714744711cd…`); la huella del respaldo cambia entre ejecuciones porque incluye datos volátiles (`1afe1a7f3f84…` y `ff1e04660a39…` en dos ejecuciones del mismo día). La aplicación se sirvió cada vez en un puerto de loopback efímero distinto.
- El mismo día, `npm run test:verify` conservó la línea base: **385 pruebas Vitest** en 41 archivos, **50 escenarios Chromium** y **1 escenario** con normativa sintética.
- `npm run typecheck`, `npm run lint` y `npx drizzle-kit check` sin errores.
- No se aplicó ninguna migración en DEV, TEST ni producción, no se modificó ningún contenedor persistente y no se creó la migración `0017`.

## Retirada y repetición

El ensayo es idempotente: puede repetirse cuantas veces haga falta sin limpieza manual. Cada ejecución crea su propio contenedor y su propio directorio temporal, y los retira en el mismo proceso. Si una ejecución se interrumpe de forma abrupta, el contenedor aparece con el prefijo `fullstack-nextjs-test-` y la etiqueta del marcador; se puede retirar con `docker rm -f <nombre>` sin afectar a DEV ni a TEST.

## Problemas y resolución

| Síntoma | Causa y solución |
| --- | --- |
| `docker` no responde o el contenedor no arranca | Docker está detenido o falta la imagen. Inicia Docker y ejecuta `docker pull postgres:15`. |
| `El ensayo aprovisiona su propia identidad` | Hay `TEST_DATABASE_URL` o `POSTGRES_TEST_RUN` en la sesión. Retíralos y repite. |
| `no se encontró …/next/dist/bin/next` | Faltan dependencias: ejecuta `npm install`. |
| `next start no respondió en 120 s` | El proceso no llegó a escuchar. El mensaje incluye el final del registro de Next ya redactado. |
| `credenciales conocidas presentes en: …` | Un valor sensible quedó en `.next`. Elimina `.next`, revisa el empaquetado de variables y repite; no publiques el artefacto. |
| Una comprobación de restauración difiere | El respaldo o la restauración no son equivalentes: es un fallo real del procedimiento. Corrige la causa antes de desplegar. |
| El puerto sigue ocupado al cerrar | Otro proceso lo tomó al liberarse. Revisa qué proceso escucha en `127.0.0.1:<puerto>` y repite el ensayo. |

## Límites y siguientes pasos

- El ensayo prueba el procedimiento desde una base vacía. La actualización de un esquema intermedio con datos —el caso de H07 documentado en el [inventario y procedimiento de actualización](postgres-upgrade-recovery.md)— sigue siendo un procedimiento aparte; el prefijo `0000`–`0004` se aplica aquí como comprobación de que el journal histórico es reproducible.
- No hay staging alojado, TLS, DNS, gestor de secretos ni CI. La verificación depende de ejecuciones manuales reproducibles.
- H03 continúa abierto como deuda operativa con saneamiento histórico pendiente; este ensayo no lo modifica ni lo cierra.
- Los requisitos previos a producción siguen siendo los del [cierre de la fase 10](../planificacion_general.md#cierre-de-la-fase-de-desarrollo-10).

## Documentación relacionada

- [Pruebas y comandos vigentes](testing.md#comandos-vigentes-desde-106)
- [PostgreSQL, Drizzle y estado de migraciones](database-drizzle.md#estado-de-migraciones)
- [Actualización y recuperación de PostgreSQL](postgres-upgrade-recovery.md)

Next carga `.env` al compilar y al arrancar. Por eso el ensayo define `TEST_DATABASE_URL`, `POSTGRES_TEST_RUN` y `DATABASE_INSPECTION_URL` como cadenas vacías en el entorno hijo: el cargador de Next respeta los valores ya definidos y no puede inyectar la identidad persistente del archivo local. Además, los valores de `DATABASE_URL`, `DATABASE_INSPECTION_URL`, `TEST_DATABASE_URL` y `AUTH_RATE_LIMIT_HMAC_KEY` presentes en `.env` se registran solo en memoria y se buscan en `.next` tras eliminar su caché incremental. La aplicación arranca después con el `DATABASE_URL` del contenedor desechable y sin identidad de pruebas efectiva.
