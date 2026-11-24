# Despliegue en Vercel

Este documento audita la compatibilidad del repositorio con un despliegue alojado en Vercel y describe la preparación de la cuenta, la base de datos y las variables de entorno. Corresponde a los incrementos 11.2, 11.3 y 11.4 de la fase 11: el 11.3 añade la verificación real del agrupador en modo transacción ([apartado 8](#8-bloqueos-transacciones-y-concurrencia)), y el 11.4 fija la plataforma elegida por el propietario —**Vercel Hobby con repositorio público de GitHub y PostgreSQL Neon Free**, proyecto personal, educativo y no comercial— y deja preparado el primer Preview en el [apartado 16](#16-vercel-hobby-y-neon-free-incremento-114).

**No se ha creado ninguna cuenta, no se ha aprovisionado ninguna base, no se ha configurado ningún proyecto ni se ha ejecutado ningún despliegue.** Todo lo que sigue es análisis, procedimiento y una rama preparada en local: `preview/vercel-11-4`, que apunta a HEAD, cuya publicación requiere autorización expresa del propietario. Un despliegue real exige las decisiones del [apartado 3](#3-requisitos-previos-y-decisiones-del-propietario) y las autorizaciones del [apartado 16.7](#167-bloqueo-actual-y-autorizaciones-que-faltan), y sigue sin cerrar H03. La verificación de 11.3 demuestra el comportamiento de PgBouncer, no el del proxy de Neon, y no sustituye la prueba contra el endpoint alojado.

## 1. Alcance y estado

### Qué se comprobó

| Comprobación | Resultado |
| --- | --- |
| `next build` con `DATABASE_URL` vacía y `.env` presente | Compila; 8 rutas; `/` y `/_not-found` estáticas y el resto dinámicas. La compilación no alcanza ninguna base. |
| `npm run staging:rehearse` (11.1, 23 de noviembre de 2026; no repetido en 11.2) | Código 0, **66 comprobaciones** y journal `0016_habitual_reservation_provenance`, con compilación de producción, arranque y recorridos HTTP sobre cookies reales. |
| `npm run test:verify` (línea base de 11.1, 23 de noviembre de 2026; no repetida en 11.2) | **385 pruebas Vitest** en 41 archivos, **50 escenarios Chromium** y **1 escenario** con normativa sintética, cada etapa sobre su PostgreSQL 15 desechable. |
| `npm run typecheck`, `npm run lint`, `npx drizzle-kit check` (24 de noviembre de 2026) | Sin errores. El journal sigue en `0016`. |
| `npm run pooler:check` (11.3, 24 de noviembre de 2026) | **27 comprobaciones** sobre PgBouncer 1.26.1 en modo transacción delante de un PostgreSQL 15 desechable: journal `0016` por conexión directa, catálogo idéntico a través del agrupador, bloqueos de transacción y de fila, rollback, claves foráneas, `SET LOCAL statement_timeout`, sentencias sin nombre, concurrencia serializada e idempotente y liberación de conexiones. |
| `npm run staging:verify` y `npm run pooler:check` (11.4, 24 de noviembre de 2026) | Encadena `typecheck`, `lint`, `drizzle-kit check`, `db:rehearse` y el ensayo de staging: **66 comprobaciones**, journal `0016` y compilación de producción servida en un puerto libre. Después, **27 de 27** del agrupador. |
| Documentación oficial de Vercel y Neon (11.4, 24 de noviembre de 2026) | El primer despliegue de un proyecto nuevo **siempre** es de Production, aunque se lance por CLI o desde otra rama, y compila con las variables de Production; los proyectos nuevos arrancan con **Standard Protection + Vercel Authentication**; Vercel Authentication con alcance *All Deployments* no requiere complemento de pago; Password Protection no existe en Hobby y proteger solo Production exige Enterprise. Neon Free: 100 CU-horas, 1 GB por proyecto y 20 GB por cuenta, 10 ramas y suspensión a los 5 minutos. |
| Lectura de la configuración y del código de datos, sesión, bloqueos y scripts | Sin dependencias de rutas absolutas, del sistema de archivos ni de estado de proceso en tiempo de ejecución. |
| Documentación vigente de Vercel, Neon y Supabase | Límites de funciones, versiones de Node, entornos, protección de despliegues y modo transacción de los agrupadores. |

### Qué no se comprobó

- Ningún despliegue real en Vercel, ni siquiera de prueba: en 11.4 no se creó cuenta, proyecto ni rama remota. La rama `preview/vercel-11-4` solo existe en local.
- El agrupador **alojado**: la verificación de 11.3 es local, con PgBouncer 1.26.1 y sin TLS; no cubre el endpoint agrupado de Neon (`-pooler`) ni el puerto 6543 de Supabase.
- La protección de despliegues en una cuenta real: la disponibilidad en Hobby se leyó en la documentación, no se comprobó en un panel.
- La batería completa no se repitió en 11.4: se ejecutó `npm run staging:verify`, que compila y sirve la aplicación, pero no Vitest ni Playwright. Las cifras de 385 pruebas y 50 escenarios siguen siendo las de 11.1.
- Ninguna base alojada: la línea base se ejecutó sobre PostgreSQL 15 local y desechable.
- Proveedor, región, plan, dominio, protección de despliegues y respaldos operativos.
- Node.js 26, que hoy es la versión predeterminada de Vercel, y PostgreSQL 16 o 17, que son las versiones que suelen ofrecer los proveedores.
- Un pipeline de CI: el repositorio sigue dependiendo de ejecuciones manuales.

### Advertencia sobre el método

`next build` y `next start` en la máquina local **no** demuestran compatibilidad con Vercel: la plataforma compila con su propia versión de Node, empaqueta las funciones con su trazador de archivos y ejecuta cada ruta en un entorno sin estado. El ensayo de [staging](staging-deployment.md) es el mejor sustituto local porque compila con un entorno inerte, arranca el servidor y comprueba sesiones reales, pero tampoco configura un servidor, DNS, TLS ni un gestor de secretos.

## 2. Modelo de despliegue

- **Origen.** Integración Git de Vercel con GitHub sobre el repositorio público `Beto-Ales/fullstack-nextjs`. `git ls-remote --heads origin` anuncia una sola rama, `master`, en `af64702` (`build(staging): ensayar despliegue reproducible con PostgreSQL aislado`), que es el mismo commit que `HEAD`. El requisito del cierre de la fase 10 de publicar el estado actual queda cubierto por esa observación de solo lectura; este incremento no hizo `push`.
- **Proyecto.** Se crea conectando el repositorio desde el panel. Cada `push` a `master` genera un despliegue de Production y el resto de ramas y pull requests, despliegues de Preview. La excepción es el **primer despliegue**: Vercel lo clasifica como Production aunque se lance desde otra rama o por CLI y lo compila con las variables de Production ([apartado 16.2](#162-el-primer-despliegue-es-de-production)).
- **Configuración esperada.** Root Directory en la raíz del repositorio, Framework Preset `Next.js` detectado automáticamente, Install Command `npm install` (respeta `package-lock.json`, `lockfileVersion` 3), Build Command `npm run build` y Output Directory por defecto. No hay `vercel.json`, `now.json` ni carpeta `.vercel` versionada; `.gitignore` ya excluye `.vercel`.
- **Node.js.** Vercel usa por defecto la última LTS disponible (26.x en la consulta del 24 de noviembre de 2026) y permite fijar 24.x o 22.x en *Settings → Build and Deployment*. La línea base se verificó con Node.js 24.18.0 y `next` 16.3.8 exige Node.js 20.9 o superior. El repositorio no declara `engines`, así que **la versión queda a cargo de la configuración del proyecto**: se recomienda fijar 24.x para igualar el entorno verificado antes de desplegar.
- **Región.** Las funciones se ejecutan en una sola región, `iad1` por defecto, y solo los planes Pro y Enterprise admiten varias. Debe elegirse la región más próxima a la base de datos; cada salto transatlántico se paga en cada consulta.
- **Duración y memoria.** Ninguna ruta ni acción declara `maxDuration`, así que se aplica el valor de la plataforma (300 s en Hobby). Las operaciones de la aplicación son cortas; la generación de sesiones y las migraciones son comandos fuera de línea.
- **Límites relevantes.** 250 MB de función sin comprimir, 1.024 descriptores de archivo compartidos por instancia (incluidas las conexiones de base), 4,5 MB de cuerpo de petición y respuesta no transmitida. Ninguno se acerca con el uso previsto.

## 3. Requisitos previos y decisiones del propietario

El 11.4 el propietario decidió la plataforma: **Vercel Hobby** para un proyecto personal, educativo y no comercial, el **repositorio público `Beto-Ales/fullstack-nextjs`**, **Neon Free** con una base exclusiva de Preview en región europea y protección **All Deployments** con Vercel Authentication. Siguen abiertas la región y el nombre exactos de la base, la ventana de migración, el respaldo operativo, el dominio y las autorizaciones para crear recursos externos y publicar la rama. Sin ellas no debe iniciarse el despliegue ([apartado 16](#16-vercel-hobby-y-neon-free-incremento-114)).

| Decisión | Por qué importa | Efecto si falta |
| --- | --- | --- |
| Cuenta y equipo de Vercel, con plan definido | Determina región múltiple, protección de producción, retención de despliegues y límites. | No hay proyecto donde conectar el repositorio. |
| Autorización de la integración Git sobre `Beto-Ales/fullstack-nextjs` | El repositorio es público, así que la lectura no requiere permisos especiales, pero la integración sí necesita autorizar la cuenta. | No se crean despliegues automáticos. |
| Proveedor de PostgreSQL y plan | Vercel no aloja PostgreSQL. Decide agrupador, región, respaldos, límites de conexión y coste. | Sin base no hay login, ni reservas, ni normativa. |
| Base de Production y, si se quiere, una base o rama separada para Preview | Un `DATABASE_URL` compartido entre Production y Preview hace que cada `push` escriba en datos reales. | Riesgo de datos de prueba en producción. |
| Dominio y TLS | La cookie de sesión usa el prefijo `__Host-` en producción, que exige HTTPS. | Solo se podría usar el dominio `*.vercel.app`. |
| Modo de protección de despliegues | Decide si los paneles son públicos o quedan detrás de Vercel Authentication o Password Protection. | Ambigüedad sobre quién puede alcanzar `/admin`. |
| Responsable y ventana de las migraciones | El journal se aplica fuera del build, con la cadena directa y respaldo previo. | La aplicación arrancaría contra un esquema incompleto. |
| Respaldo, retención y restauración del proveedor | Sustituye a los respaldos locales del perfil de Windows. | No hay recuperación verificada ante un borrado o una migración fallida. |
| Rotación del secreto HMAC y de la cadena de producción | Son credenciales nuevas, ajenas a H03, que necesitan dueño y procedimiento. | Sin propietario no se pueden rotar sin interrumpir el login. |
| Autorización expresa del despliegue | Cerrar la fase de desarrollo no autoriza publicar. | Se estaría desplegando sin decisión registrada. |

H03 sigue **abierto como deuda operativa** (riesgo de credenciales activas mitigado, saneamiento histórico pendiente). Este documento no lo modifica; las credenciales del despliegue son nuevas y no heredan los valores locales.

## 4. Base de datos alojada

Vercel no ofrece PostgreSQL propio. Su catálogo de almacenamiento incluye Blob, Global Config y Runtime Cache, y las bases de datos llegan por **integraciones del Marketplace**: Neon, Supabase, Prisma Postgres, Nile, AWS y otras. La integración nativa aprovisiona el recurso, lo conecta al proyecto e inyecta variables de entorno en el ámbito de los entornos conectados; también se puede provisionar desde la CLI con `vercel install <proveedor>`.

- **Nombres inyectados.** El código lee exactamente `DATABASE_URL` (`src/infrastructure/env.ts`). Si el proveedor inyecta `POSTGRES_URL`, `DATABASE_URL_UNPOOLED` u otro nombre, hay que añadir `DATABASE_URL` a mano con el valor correcto; no se debe cambiar el código para aceptar alias.
- **Dos cadenas.** Los proveedores publican una cadena **agrupada** para la aplicación y una **directa** para migraciones, comandos y respaldos. En Supabase el agrupador escucha en el puerto 6543 en modo transacción y la conexión directa en el 5432; Neon publica ambas en su panel. La cadena directa es la única que debe usarse con `npm run db:migrate:dev`, `npm run admin:create-super-admin` y `npm run academic:generate-sessions`.
- **Requisitos del esquema.** Las migraciones `0000`–`0016` usan tipos enumerados, `timestamptz`, índices, claves foráneas, `text`, `hashtext()` y `pg_advisory_xact_lock()`. No usan extensiones, `CREATE SCHEMA`, `gen_random_uuid()`, tablas temporales ni cursores. La aplicación no necesita superusuario; las migraciones necesitan crear objetos en el esquema de la base y en `drizzle`.
- **Guardas de nombre.** `drizzle.config.ts` y `scripts/run-db-migrate.mjs` rechazan cualquier base cuyo nombre contenga `test`, `testing`, `e2e` o `ci` como token separado. La base alojada no debe llamarse así.
- **Versión del servidor.** La línea base se verificó en PostgreSQL 15. Los proveedores suelen ofrecer 16 o 17; no se ha ejecutado la batería en esas versiones, así que es una verificación pendiente, no una compatibilidad demostrada.
- **TLS.** La cadena debe incluir el parámetro que exija el proveedor (`sslmode=require` o `sslmode=verify-full` con el certificado raíz). `pg` interpreta `sslmode` desde la cadena de conexión y la aplicación no añade ninguno por su cuenta.
- **Región.** La base y las funciones deben compartir región o estar próximas. Es una decisión de latencia, no de corrección.
- **Respaldos.** La copia automática, la retención y la restauración son responsabilidad del proveedor y del plan. La aplicación no escribe respaldos.

## 5. Variables de entorno

El código solo lee las variables de la tabla siguiente. Cualquier otra que aparezca en `.env` es de uso local y no debe trasladarse al proyecto alojado. **No existe ninguna variable `NEXT_PUBLIC_*`**: nada del cliente necesita configuración y el README prohíbe secretos con ese prefijo, porque Next.js los inserta en el bundle que descarga el navegador.

| Variable | Para qué | ¿Compilación? | Entornos | Secreto | Obligatoria | Valor o generación |
| --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Cadena agrupada de PostgreSQL. Valida el prefijo `postgres://` o `postgresql://` y se usa al abrir el pool. | No. Verificado con la variable vacía: `next build` completa y ninguna ruta toca la base. | Production; Preview solo si se decide conectar Preview. | Sí, marcarla *Sensitive*. | Sí. Sin ella, toda ruta dinámica falla al importar y responde 500. | La publica el proveedor; si inyecta otro nombre, copiarla a `DATABASE_URL`. Incluir `sslmode`. |
| `AUTH_RATE_LIMIT_HMAC_KEY` | Clave HMAC-SHA256 del presupuesto de login por correo (H05, migración `0014`). Debe ser idéntica entre instancias que compartan base. | No. Se lee al iniciar sesión. | Production y cualquier Preview que use la misma base. | Sí, marcarla *Sensitive*. | Sí, para que el login funcione. Sin ella, `parseLoginRateLimitConfig` lanza y el login responde con el error temporal (fallo cerrado). | 32 bytes aleatorios en hexadecimal: `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`. No reutilizar la de desarrollo. |
| `APP_TIME_ZONE` | Zona del centro. El esquema Zod la compara con `Europe/Copenhagen` mediante `z.literal`. | No. Se lee en el primer import de `src/infrastructure/env.ts`. | Todos | No | No, tiene valor por defecto. | Dejar `Europe/Copenhagen`. Cualquier otro valor rompe el arranque de la ruta. |
| `LOG_LEVEL` | Nivel de los registros JSON en stdout. | No | Todos | No | No, por defecto `info`. | `debug`, `info`, `warn` o `error`. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | Intentos por correo dentro de la ventana. | No | Todos | No | No, por defecto 5. | Entero entre 1 y 100. |
| `AUTH_RATE_LIMIT_WINDOW_MINUTES` | Duración de la ventana del presupuesto por correo. | No | Todos | No | No, por defecto 15. | Entero entre 1 y 60. |
| `NODE_ENV` | Distingue desarrollo de producción; de él dependen el nombre `__Host-` de la cookie y el atributo `Secure`. | No | — | No | No | **No declararla.** La plataforma la fija en `production` y declararla a mano puede provocar un valor incoherente. |

### Variables que no deben configurarse en Vercel

`TEST_DATABASE_URL`, `DATABASE_INSPECTION_URL`, `DB_EXPECTED_HOST`, `DB_EXPECTED_PORT`, `DB_EXPECTED_NAME`, `DB_EXPECTED_JOURNAL`, `POSTGRES_*` de Compose, `E2E_*`, `E2E_PORT`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` y `POSTGRES_TEST_RUN` pertenecen a las pruebas, al aprovisionador desechable y a los comandos puntuales. Configurarlas en el proyecto solo amplía la superficie de error: `SUPER_ADMIN_PASSWORD` en particular nunca debe existir en la plataforma.

### Reglas de configuración

- **Ámbito.** Cada variable se declara por entorno (`Production`, `Preview`, `Development`). Un valor exclusivo de Production no llega a Preview y viceversa. Si Preview comparte `DATABASE_URL` con Production, cada `push` de una rama escribirá en datos reales: la recomendación es una base o rama distinta para Preview, o no conectar Preview. El **primer despliegue de un proyecto nuevo compila con las variables de Production** aunque acabe siendo un Preview, así que Production debe quedarse sin secretos hasta que exista una base de Production decidida ([apartado 16.2](#162-el-primer-despliegue-es-de-production)).
- **Secretos.** Marcar `DATABASE_URL` y `AUTH_RATE_LIMIT_HMAC_KEY` como *Sensitive*: Vercel no permite volver a leerlas y las oculta en los registros. El resto puede quedar como *Config*.
- **Vigencia.** Los cambios de variables **solo afectan a despliegues nuevos**; hay que volver a desplegar para que se apliquen. Cambiar una variable no reinicia las funciones en curso.
- **Un solo valor por entorno.** Vercel no admite dos valores para la misma variable en el mismo entorno; si se necesita una base distinta por rama, hay que usar variables por entorno o duplicar el proyecto.
- **Rotación.** Cambiar `AUTH_RATE_LIMIT_HMAC_KEY` no bloquea sesiones: solo reinicia los presupuestos de intentos. Cambiar `DATABASE_URL` invalida de hecho las sesiones guardadas en la base anterior.

## 6. Compatibilidad del código verificada

### Compilación sin base de datos

El 24 de noviembre de 2026 se ejecutó `npm run build` con `DATABASE_URL` vacía. El resultado fue `exit=0`, «Compiled successfully» y este reparto de rutas:

| Ruta | Modo |
| --- | --- |
| `/` | Estática |
| `/_not-found` | Estática |
| `/admin` | Bajo demanda |
| `/admin/alumnos/[studentId]` | Bajo demanda |
| `/admin/sesiones/[sessionId]` | Bajo demanda |
| `/login` | Bajo demanda |
| `/normativa` | Bajo demanda |
| `/student` | Bajo demanda |

Las dos rutas estáticas no leen sesión ni datos. Las seis restantes se renderizan en cada petición porque leen la cookie de sesión y consultan PostgreSQL, que es exactamente lo que impide servir contenido personalizado desde caché. La consecuencia práctica es que **Vercel puede compilar el proyecto sin la base conectada**; las variables de datos solo se necesitan en tiempo de ejecución. Aun así conviene declararlas antes del primer despliegue para no depender de esa casualidad.

### Configuración de rutas y empaquetado

- Ninguna ruta exporta `dynamic`, `revalidate`, `runtime`, `fetchCache` ni `maxDuration`. No hay `middleware.ts` ni `proxy.ts`, así que no existe código que Vercel deba ejecutar en el runtime Edge.
- No se usa `next/image`, `output: "standalone"` ni configuración de imágenes remotas: no hay nada que ajustar en el panel.
- El código de ejecución no importa `node:fs` ni escribe archivos; la única lectura del sistema de archivos vive en una prueba (`src/test-support/postgres-provisioning.integration.test.ts`). Tampoco depende de rutas absolutas del perfil de Windows.
- Las dependencias nativas están cubiertas: `bcrypt` y `pg` figuran en la lista predeterminada `serverExternalPackages` de Next.js 16 (`node_modules/next/dist/esm/lib/server-external-packages.jsonc`), y `next.config.ts` no la modifica. `bcrypt` publica binarios N-API con `prebuildify --napi --tag-libc` para `linux-x64` (glibc y musl) y su `install` es `node-gyp-build`, de modo que Vercel no compila nada; `pg` es JavaScript puro.
- `luxon` e `Intl` funcionan con el ICU completo que incluye Node.js en Vercel. El código fija la zona `Europe/Copenhagen` de forma explícita y no lee la variable `TZ` del servidor, así que la zona del contenedor no altera fechas ni horarios.
- Los registros salen por `console` en JSON y respetan `LOG_LEVEL`; no hay escritura en archivos ni en servicios externos.

### Modos de fallo intencionados

| Falta | Qué ocurre |
| --- | --- |
| `DATABASE_URL` | El esquema Zod de `src/infrastructure/env.ts` lanza al importar y la ruta dinámica responde 500. El mensaje queda en los registros de la función. |
| `AUTH_RATE_LIMIT_HMAC_KEY` | `parseLoginRateLimitConfig` lanza al intentar iniciar sesión; el formulario muestra el error temporal y no se consulta la cuenta. Es un fallo cerrado y deliberado. |
| Migración `0014` sin aplicar | El limitador consulta una tabla inexistente y el login falla con error de SQL. |
| `APP_TIME_ZONE` distinta de `Europe/Copenhagen` | El literal de Zod no coincide y el arranque de la ruta falla. |

## 7. Pool de conexiones en funciones serverless

`src/infrastructure/db/config.ts` fija `max: 10` e `idleTimeoutMillis: 30_000`, y `src/infrastructure/db/client.ts` construye un único `Pool` por proceso al importar el módulo Drizzle. En desarrollo lo guarda en `globalThis` para sobrevivir al recargado en caliente; con `NODE_ENV=production` esa memoización global no se aplica, de modo que **cada instancia de función tiene su propio pool**. `pg` no abre ninguna conexión hasta la primera consulta, así que un arranque en frío sin tráfico de datos no consume conexiones.

Consecuencias en Vercel:

- **Multiplicación.** Diez conexiones por instancia, multiplicadas por las instancias concurrentes que la plataforma decida arrancar. Con un agrupador externo, el límite práctico lo impone el agrupador; sin él, un pico puede agotar `max_connections` del proveedor y provocar errores de conexión en las funciones.
- **Descriptores.** Cada conexión ocupa un descriptor del límite de 1.024 por instancia, compartido con el resto de la función.
- **Congelación.** Cuando una función deja de recibir peticiones, Vercel puede congelarla. `idleTimeoutMillis` cierra las conexiones inactivas del lado del cliente, pero una instancia congelada no ejecuta ese temporizador mientras duerme: el socket lo acaba reciclando el agrupador o el proveedor. Hay que confiar en el agrupador, no en el cliente.
- **Sin driver serverless.** No se usa `@neondatabase/serverless` ni transporte HTTP: la aplicación habla el protocolo de PostgreSQL mediante `pg`, así que necesita una cadena agrupada compatible, no una cadena de solo HTTP.

El comportamiento del pool se verificó de forma empírica en 11.3: con `DEFAULT_POOL_SIZE=5`, al cerrar los clientes no quedaron conexiones `idle in transaction` y el servidor retuvo como máximo cinco. [Verificación del agrupador](#verificación-real-del-agrupador-incremento-113)

Recomendaciones, ninguna aplicada al código en este incremento:

1. Usar siempre la cadena agrupada del proveedor en `DATABASE_URL`.
2. Vigilar las métricas del agrupador (conexiones activas, espera, errores) durante las primeras semanas.
3. Si se mide contención o el plan limita las conexiones, reducir `max` o hacerlo configurable por entorno. Es un cambio de código pequeño, pero cambia el comportamiento verificado y exige repetir la batería.
4. Configurar en el proveedor un `idle_in_transaction_session_timeout` corto (por ejemplo 30 s) para cortar transacciones que una instancia congelada dejó abiertas.

## 8. Bloqueos, transacciones y concurrencia

| Mecanismo | Dónde | Alcance | Compatible con agrupador en modo transacción |
| --- | --- | --- | --- |
| `SELECT … FOR UPDATE` / `FOR NO KEY UPDATE` sobre `student_profiles`, `class_sessions`, `reservation_credits` | `academic-service.ts`, `credit-service.ts`, `recovery-service.ts` | Bloqueo de fila dentro de la transacción | Sí: la transacción completa vive en una sola conexión. |
| `pg_advisory_xact_lock(903000042)` | `academic-service.ts` (`detectAbsences`) | Clave única global: dos detecciones de ausencias se serializan | Sí: los bloqueos de transacción se conservan. |
| `pg_advisory_xact_lock(903000043)` | `regulation-service.ts` (`publishAcademicRegulation`) | Publicación de normativa, una a la vez | Sí |
| `pg_advisory_xact_lock(903000044, hashtext(templateId))` y por clave numérica | `src/infrastructure/db/habitual-reservations.mjs` | Comando fuera de línea de procedencia de reservas habituales | Sí, y además no compite con las funciones |
| `pg_advisory_xact_lock(903000045)` | `auth-rate-limit.ts` | Presupuesto global de login | Sí |
| `SET LOCAL statement_timeout = '5s'` | `auth-rate-limit.ts` | Solo la transacción del presupuesto | Sí, porque es `LOCAL` |
| `isolationLevel: "read committed"` y `repeatable read` de solo lectura | Varias | Transacción | Sí |

No hay estado de sesión que sobreviva a la transacción:

- No se usa `SET` de sesión, `LISTEN`/`NOTIFY`, tablas temporales, cursores ni bloqueos de sesión (`pg_advisory_lock` sin `_xact_`).
- No se usan sentencias preparadas con nombre. Drizzle envía `{ text, values }` sin `name` y el repositorio no llama a `.prepare()`, así que el agrupador no necesita recordar preparaciones entre transacciones.
- La documentación de Supabase lo confirma: en modo transacción se pierde el estado de sesión (`SET`/`RESET`, bloqueos de sesión, `LISTEN`/`NOTIFY`, tablas temporales), pero los bloqueos de transacción funcionan porque la transacción entera se ejecuta en la misma conexión. En Neon el mismo razonamiento aplica al endpoint agrupado.

Riesgos que sí existen:

- **Ámbito global.** `pg_advisory_xact_lock` es global a la base, no a la sesión: dos usuarios distintos que publican normativa se serializan, igual que dos intentos de login. Es intencionado, pero significa que una transacción larga bloquea a todas las instancias, no solo a la que la inició.
- **Transacción colgada.** Si una instancia se congela con una transacción abierta, el bloqueo persiste hasta que el servidor la corta. `statement_timeout` solo se aplica al limitador de login; el resto depende de que las transacciones sean cortas, como lo son hoy, y de un `idle_in_transaction_session_timeout` en el proveedor.
- **Ninguna ruta declara `maxDuration`**, así que el límite de la plataforma es el que corta una ejecución desbocada. Es una red de seguridad, no un plan.

### Verificación real del agrupador (incremento 11.3)

`npm run pooler:check` aprovisiona un `postgres:15` desechable, migra hasta `0016` por la conexión directa y coloca delante un PgBouncer 1.26.1 (`edoburu/pgbouncer`, digest `sha256:8638aa56…`) en modo transacción con `DEFAULT_POOL_SIZE=5` y `MAX_CLIENT_CONN=50`. Ejecuta 27 comprobaciones con identificadores estables y retira el agrupador y la base al terminar; falla si los contenedores DEV o TEST cambian de estado.

| Grupo | Comprobaciones |
| --- | --- |
| Migración y esquema | `migration.direct`, `schema.direct`, `schema.via.pooler`, `schema.pooler.matches.direct`: huella de catálogo idéntica por ambas conexiones. |
| Identidad y modo | `pooler.mode` (`pool_mode = transaction` leído del registro del contenedor), `pooler.identity`. |
| Bloqueos | `advisory.xact.serialized` y `advisory.xact.released` sobre la clave global 903000042, `rowlock.for.update.blocks`, `rowlock.released.after.commit`. |
| Integridad | `rollback.discards.writes`, `commit.persists.writes`, `fk.enforced`, `fk.no.partial.writes`, `writes.no.partial`. |
| Sentencias | `setlocal.timeout.enforced` y `setlocal.timeout.not.leaked` con `statement_timeout` de 250 ms, `unnamed.statements` con 100 ejecuciones parametrizadas. |
| Concurrencia | `concurrency.transactions`, `concurrency.serialized`, `concurrency.idempotent`, con 20 transacciones simultáneas sobre el bloqueo 903000044 y una clave única. |
| Sesión y conexiones | `ddl.via.pooler`, `session.set.persists.on.pooled.backend`, `session.advisory_lock.blocks.other.client`, `session.advisory_lock.released`, `connections.released`, `persistent.untouched`. |

Resultado del 24 de noviembre de 2026 sobre PostgreSQL 15.20: **27 de 27**. Lo relevante:

- **Los bloqueos de transacción funcionan.** Dos transacciones independientes se serializan en la clave global y el bloqueo se libera al confirmar; el bloqueo de fila rechaza con `55P03` mientras la otra transacción lo retiene.
- **El estado de sesión persiste en el backend agrupado.** Después de un `SET application_name` confirmado, otra conexión directa observó la conexión del agrupador con ese valor: con su configuración por defecto, PgBouncer no ejecuta `DISCARD ALL` en cada transacción. Por eso la regla del proyecto —solo `SET LOCAL` y bloqueos `_xact_`— es un requisito, no una preferencia: un `pg_advisory_lock` de sesión queda retenido en el pool y bloquea a otros clientes, como demostró `session.advisory_lock.blocks.other.client`.
- **`SET LOCAL` no se filtra**: en la transacción siguiente `statement_timeout` volvió a `0`.
- **La concurrencia no deja escrituras parciales**: 20 transacciones produjeron 20 incrementos exactos y una sola fila en la inserción idempotente.

Límites de la evidencia: PgBouncer no es el proxy de Neon, que tiene su propio comportamiento, y la prueba es local y sin TLS. La compatibilidad con el endpoint alojado sigue pendiente y debe comprobarse sobre la base de ensayo antes de abrir el Preview ([apartado 12](#12-procedimiento-de-despliegue)).

## 9. Limitación de intentos de login

El limitador de H05 vive en PostgreSQL, no en memoria del proceso:

- Antes de consultar la cuenta, `reserveLoginAttempt` abre una transacción `read committed`, fija `statement_timeout` de 5 s y toma `pg_advisory_xact_lock(903000045)`.
- Dentro de esa transacción reserva dos presupuestos: el del correo normalizado, con clave HMAC-SHA256 calculada con `AUTH_RATE_LIMIT_HMAC_KEY`, y uno global con tope de 600 intentos por ventana. Los valores por correo son 5 intentos y 15 minutos salvo configuración distinta.
- El reloj es `statement_timestamp()` del servidor de base de datos, no el de Vercel. La zona horaria de las funciones no influye y no hay desfase entre instancias.
- La tabla es `login_attempt_budgets`, creada por la migración `0014`, y sus filas caducan y se purgan solas.

Para que funcione con varias instancias hacen falta tres cosas: la misma base, la misma clave HMAC y la migración aplicada. Con ellas no se necesitan sesiones pegajosas ni memoria compartida; si falta cualquiera, el login falla en cerrado. **No se debe desactivar el limitador para simplificar el despliegue**: H05 lo exige y el escenario de fuerza bruta está cubierto por pruebas.

Rotar la clave no invalida sesiones: solo hace que los presupuestos nuevos se calculen con otra clave y que las filas antiguas caduquen sin coincidencia. Cambiar `AUTH_RATE_LIMIT_MAX_ATTEMPTS` o la ventana tampoco requiere migración.

## 10. Migraciones y datos iniciales

El build **no** migra, no siembra y no ejecuta ningún script de `package.json` salvo `next build`; tampoco hay `postinstall`. El journal se aplica a mano, desde la máquina del operador y con la cadena **directa** del proveedor.

1. Exportar la cadena directa en la sesión: `$env:DATABASE_URL = "<cadena-directa>"`. `@next/env` carga `.env`, pero no sobrescribe variables ya presentes en el proceso, así que la sesión manda.
2. Comprobar que el destino es el correcto: el host, el puerto y el nombre deben coincidir con el panel del proveedor, y el nombre no puede contener `test`, `testing`, `e2e` ni `ci`.
3. Verificar el journal local con `npx drizzle-kit check`. Este comando ya exige `DATABASE_URL` porque `drizzle.config.ts` la valida al cargarse, aunque no se conecte a la base.
4. Respaldar: instantánea o PITR del proveedor, o un `pg_dump` propio, con restauración comprobada antes de seguir.
5. Aplicar el journal con `npm run db:migrate:dev`. Imprime `[db:migrate:dev] Target => host:puerto/base` antes de ejecutar y rechaza bases con nombre de prueba o que coincidan con `TEST_DATABASE_URL`. No usar `npm run db:migrate:test`: ese comando aprovisiona un PostgreSQL desechable y no debe apuntar al proveedor.
6. Verificar el resultado: `select count(*) from drizzle.__drizzle_migrations;` debe devolver **17**, y `select id, hash, created_at from drizzle.__drizzle_migrations order by id desc limit 1;` debe corresponder a la última migración, `0016`. El ensayo de 11.1 comprueba esa misma tabla con `pg_restore` y comparación de journal.
7. Crear la cuenta administradora una sola vez, con `SUPER_ADMIN_EMAIL` y `SUPER_ADMIN_PASSWORD` en la sesión y nunca en Vercel: `npm run admin:create-super-admin`.
8. Publicar la normativa inicial desde la aplicación y solo después materializar las sesiones con `npm run academic:generate-sessions`. El script aborta con «Missing initial academic regulation» si se ejecuta antes; no crea normativa por su cuenta.

Las migraciones son aditivas y **no tienen vuelta atrás**. Un rollback de código no revierte el esquema (ver [apartado 14](#14-rollback-y-continuidad)).

## 11. Cookies, HTTPS y dominio

- La cookie se llama `__Host-artwork_session` cuando `NODE_ENV=production` y `artwork_session` en desarrollo y pruebas (`getSessionCookieName`). El prefijo `__Host-` obliga a `Secure`, `Path=/` y ningún atributo `Domain`; Vercel sirve HTTPS tanto en `*.vercel.app` como en dominios propios, así que se cumple sin configuración adicional.
- La cookie es `httpOnly` y `sameSite=lax`; no se comparte entre Preview y Production porque cambia el dominio y, en producción, el propio nombre.
- Las sesiones se guardan en PostgreSQL: cambiar de base invalida todas las sesiones vigentes. Es esperado y no requiere limpieza.
- Cualquier proxy intermedio que reescriba el esquema a `http` rompería el atributo `Secure`. No se prevé ninguno.
- **Protección de despliegues.** Vercel Authentication para todos los despliegues no exige complemento de pago; limitarla a Production exige Enterprise y Password Protection exige Pro. Es una decisión del propietario: no cambia el comportamiento de la aplicación, solo añade una capa antes de la cookie. Si se activa en Preview, las comprobaciones manuales necesitan el token de omisión.
- **Dominio.** Añadir el dominio en el panel y dejar que Vercel emita el certificado. La aplicación no construye URLs absolutas ni depende de la cabecera `Host`, así que el cambio de dominio no requiere código.

## 12. Procedimiento de despliegue

Orden previsto, con el resultado que debe observarse en cada paso. Los pasos 1 a 5 los ejecuta quien administra la cuenta; los pasos 6 a 9, quien opera la base. Antes del paso 1 hay una condición de seguridad: fijar la protección **All Deployments** del equipo, porque el primer despliegue se clasifica como Production y, con la protección predeterminada *Standard*, su URL quedaría pública ([apartado 16.3](#163-secuencia-de-inicialización-protegida)).

| # | Acción | Resultado esperado |
| --- | --- | --- |
| 1 | Crear o elegir el equipo en Vercel y autorizar la integración con GitHub sobre `Beto-Ales/fullstack-nextjs` | El repositorio aparece en la lista de importación. |
| 2 | Importar el repositorio como proyecto Next.js con Root Directory en la raíz | El proyecto muestra el framework detectado y la rama de producción `master`. |
| 3 | En *Settings → Build and Deployment*, fijar Node.js 24.x | La compilación usará la misma línea que la verificación local. |
| 4 | Aprovisionar PostgreSQL en el Marketplace y copiar la cadena agrupada y la directa | El recurso aparece conectado al proyecto y sus variables inyectadas. |
| 5 | Declarar las variables del [apartado 5](#5-variables-de-entorno) en Production y decidir si Preview recibe base propia | Solo `DATABASE_URL` y `AUTH_RATE_LIMIT_HMAC_KEY` como *Sensitive*. |
| 6 | Ejecutar las migraciones con la cadena directa ([apartado 10](#10-migraciones-y-datos-iniciales)) | Journal en `0016`, 17 filas. |
| 7 | Crear la cuenta administradora | `npm run admin:create-super-admin` termina sin error y el login funciona. |
| 8 | Publicar la normativa inicial y generar las sesiones | `npm run academic:generate-sessions` informa de las sesiones creadas. |
| 9 | Desplegar desde `master` y ejecutar la verificación del [apartado 13](#13-verificación-posterior) | Sin 500 en los registros y con los recorridos de rol correctos. |

Antes del paso 1, `npm run pooler:check` debe terminar con **27 comprobaciones**: fija el comportamiento esperado del agrupador y detecta regresiones en el código de transacciones. Cuando exista la base de ensayo, repetir ese humo contra su endpoint agrupado real y comparar el journal y la huella del catálogo con la conexión directa.

El primer despliegue puede hacerse antes de las migraciones: la compilación no necesita base. Pero la aplicación responderá 500 en las rutas dinámicas hasta que el journal esté aplicado y las variables configuradas. Con Hobby ese primer despliegue es de **inicialización** y de Production: no debe compartirse su URL, no debe tratarse como lanzamiento y su protección debe verificarse antes de usarlo ([apartado 16.3](#163-secuencia-de-inicialización-protegida)).

## 13. Verificación posterior

Comprobaciones mínimas tras el primer despliegue, en orden. Si el proyecto tiene protección de despliegues activa, hay que enviar el token de omisión o iniciar sesión en Vercel antes de cada petición.

| Comprobación | Cómo | Resultado esperado |
| --- | --- | --- |
| Portada pública | `Invoke-WebRequest https://<dominio>/` | 200, sin cookie. Hoy sirve la página de ejemplo de la plantilla, no contenido del taller. |
| Formulario de acceso | `GET /login` | 200 y formulario visible; con sesión redirige al área del rol. |
| Normativa sin sesión | `GET /normativa` | Redirección a `/login`: la página exige usuario. |
| Normativa con sesión | `GET /normativa` tras iniciar sesión | 200 con la normativa vigente publicada. |
| Rutas protegidas sin sesión | `GET /admin` y `GET /student` | Redirección a `/login`, sin 500. |
| Cookie inválida | Enviar `artwork_session=invalida` | Redirección a `/login`. La cookie solo se borra al cerrar sesión o al caducar la fila de `sessions`; el navegador conserva la cadena inválida hasta entonces. |
| Login de administración | Credenciales del paso 7 | Redirección a `/admin` con la cookie `__Host-artwork_session`. |
| Login de estudiante | Cuenta sintética o real | Redirección a `/student` y reservas visibles. |
| Registros | *Deployments → Functions → Logs* | Sin errores de Zod, SQL ni conexión; nivel `info`. |
| Conexiones | Panel del proveedor | Conexiones activas por debajo del límite del plan y sin esperas anómalas. |
| Limitador | Un intento fallido y consulta a `login_attempt_budgets` | Filas con clave HMAC y `expires_at` coherente. |
| Journal | `select count(*) from drizzle.__drizzle_migrations;` | 17. |
| Agrupador alojado | Abrir una transacción de lectura por la cadena agrupada y comparar el catálogo con la conexión directa | Misma huella de catálogo y ninguna conexión `idle in transaction` al cerrar. |
| Integridad del repositorio | `npm run typecheck`, `npm run lint`, `npx drizzle-kit check` en local | Sin errores antes y después del despliegue. |

## 14. Rollback y continuidad

- **Código.** Vercel permite volver a promover un despliegue anterior de inmediato, sin reconstruir. Los despliegues conservan su configuración, así que un rollback no aplica cambios de variables: para eso hay que desplegar de nuevo.
- **Esquema.** Las migraciones `0000`–`0016` son aditivas y no tienen script de vuelta atrás. Volver a un despliegue anterior sobre un esquema más nuevo solo es seguro si el código antiguo ignora las tablas y columnas añadidas; eso no se ha probado y no debe asumirse. Si una migración rompe, la salida es restaurar el respaldo previo, no deshacerla en caliente.
- **Datos.** La única recuperación verificable es el respaldo del proveedor. Los ensayos de respaldo y restauración de las fases 10 y 11 se hicieron sobre PostgreSQL desechable; para el entorno alojado hay que definir retención, ventana de PITR y una prueba de restauración real antes de considerar el despliegue operativo.
- **Sesiones.** Tras un rollback de código, las sesiones siguen siendo válidas si la tabla `sessions` no cambió. Si se restaura un respaldo anterior, se pierden las sesiones posteriores: los usuarios vuelven a iniciar sesión.
- **H03.** El despliegue crea credenciales nuevas (cadena de base y clave HMAC). Deben tener dueño, estar fuera del repositorio y seguir un procedimiento de rotación; el cierre de H03 no se hereda por desplegar.

## 15. Riesgos, límites y pendientes

| Riesgo | Impacto | Estado o mitigación |
| --- | --- | --- |
| Sin pipeline de CI | Cada verificación depende de una ejecución manual; un `push` puede desplegar código no verificado. | Asumido desde la fase 10; automatizarlo es endurecimiento posterior, no bloqueante. |
| Node.js 26 es el valor predeterminado de Vercel | La línea base se verificó en 24.18.0; 26 no se ha probado. | Fijar 24.x en el proyecto hasta verificar 26. |
| PostgreSQL 16 o 17 en el proveedor | No se ha ejecutado la batería en esas versiones. | Elegir 15 si el plan lo permite, o repetir la batería contra una instancia desechable de la versión elegida. |
| Pool de 10 conexiones por instancia | Un pico puede agotar el límite del plan o del servidor. | Cadena agrupada, métricas y, si hace falta, reducir `max` con un cambio de código verificado. |
| Endpoint agrupado alojado sin probar | La evidencia de 11.3 es local (PgBouncer 1.26.1); el proxy de cada proveedor puede diferir. | Repetir el humo transaccional contra la base de ensayo antes de abrir el Preview. |
| `idle_in_transaction_session_timeout` no configurado | Una transacción colgada retiene bloqueos y conexiones. | Configurarlo en el proveedor. |
| Preview compartiendo base con Production | Cada `push` escribiría en datos reales. | Base o rama separada para Preview, o no conectar Preview. |
| Presupuesto global de login agotable | Un atacante puede consumir los 600 intentos y bloquear el acceso durante la ventana. | Es el compromiso de H05; vigilar los registros y considerar ajustes si ocurre. |
| Respaldos y restauración no definidos | Sin recuperación verificada ante borrado o migración fallida. | Decisión y prueba pendientes del propietario. |
| Generación de sesiones manual | El horizonte de sesiones se agota si nadie ejecuta el comando. | Programar la ejecución periódica fuera de Vercel o documentar el calendario operativo. |
| Primer despliegue clasificado como Production | Aunque se lance desde una rama de Preview o por CLI, Vercel lo trata como Production y lo compila con las variables de Production. | Asumido y documentado: se protege el equipo antes de importar y no se declaran secretos de Production ([apartado 16.2](#162-el-primer-despliegue-es-de-production)). |
| Protección predeterminada *Standard* | Protege los despliegues de Preview pero deja pública la URL de producción, que es la del primer despliegue. | Cambiar a **All Deployments** con Vercel Authentication antes de importar; sin esa garantía, detenerse ([apartado 16.3](#163-secuencia-de-inicialización-protegida)). |
| Neon Free se suspende a los cinco minutos | La primera petición tras la inactividad espera el arranque del compute; la compilación no se ve afectada. | Aceptado en Preview; no justifica un plan de pago. |
| Integración automática Neon-Vercel | Puede inyectar variables en entornos que no son Preview o conectar una rama distinta de la prevista. | No se usa en 11.4: las variables se declaran a mano y se comprueba el entorno después de cada despliegue. |
| Límites de Hobby | 100 despliegues al día, una compilación concurrente y 200 proyectos por cuenta. | Suficiente para un uso educativo; los `push` frecuentes consumen la cuota diaria. |
| H03 abierto | Credenciales históricas y saneamiento pendiente. | No lo resuelve este incremento. |
| Protección de despliegues sin decidir | Los paneles podrían quedar públicos o las comprobaciones bloqueadas. | Decisión del propietario en el [apartado 3](#3-requisitos-previos-y-decisiones-del-propietario). |
| Portada heredada de la plantilla | `/` muestra el ejemplo de Full Stack Open, no el taller. | Es estática y no expone datos; decidir su contenido o retirarla antes de publicar. |
| Validación con lector de pantalla pendiente | Accesibilidad sin cierre manual con NVDA. | Pendiente heredado de la fase 10. |

En 11.4 el propietario resolvió la plataforma —Hobby y Neon Free—, la rama de Preview y el modo de protección; el inventario sigue vigente para el resto. Lo que cambió es la evidencia del [apartado 8](#verificación-real-del-agrupador-incremento-113), que pasa de argumento por código a 27 comprobaciones ejecutadas en local, y la preparación del [apartado 16](#16-vercel-hobby-y-neon-free-incremento-114).

## 16. Vercel Hobby y Neon Free (incremento 11.4)

El propietario confirmó que el proyecto es **personal, educativo y no comercial** y eligió **Vercel Hobby con el repositorio público `Beto-Ales/fullstack-nextjs` y PostgreSQL Neon Free**, sin planes de pago. Este apartado convierte esa decisión en un procedimiento comprobado contra la documentación oficial el 24 de noviembre de 2026 y en una rama preparada en local. **Ningún recurso externo existe todavía**: no hay cuenta, ni proyecto, ni base, ni despliegue.

### 16.1 Encaje en los planes gratuitos

| Límite | Vercel Hobby | Neon Free |
| --- | --- | --- |
| Coste | 0 € | 0 $ |
| Uso previsto | Personal y no comercial (fair use) | Prototipos y proyectos pequeños |
| Proyectos | 200 por cuenta | 100 por cuenta; 10 ramas por proyecto |
| Despliegues | 100 al día, **1 concurrente**, 45 min de compilación | No aplica |
| Cómputo | — | **100 CU-horas** por proyecto, autoscalado hasta 2 CU (8 GB de RAM) |
| Inactividad | Las funciones se congelan sin tráfico | Suspensión del compute a los **5 minutos** |
| Datos | — | **1 GB por proyecto** y 20 GB por cuenta; 5 GB de transferencia pública |
| Recuperación | Retención de despliegues | Restauración instantánea de 6 h y 1 GB; 1 instantánea manual; monitorización de 1 día |

Nada de lo que hace la aplicación se acerca a esos límites: ocho rutas, un puñado de usuarios ficticios y consultas cortas. Si el panel ofrece una prueba de Pro, créditos o un complemento de pago, debe rechazarse: no hay ninguna necesidad técnica que lo justifique.

### 16.2 El primer despliegue es de Production

La documentación de entornos de Vercel lo dice literalmente: «The exception is the first deployment of a new project, which is always a production deployment and builds with your Production variables». Las consecuencias para este proyecto son tres:

1. **`vercel deploy` sin `--prod` no evita la clasificación.** Tampoco desplegar desde `preview/vercel-11-4`: el primer despliegue de un proyecto nuevo es Production. Será un despliegue de **inicialización**, no un lanzamiento.
2. **Compila con las variables de Production.** Por eso Production debe quedarse **sin secretos**: sin `DATABASE_URL` y sin `AUTH_RATE_LIMIT_HMAC_KEY`. Es seguro porque `next build` completo se verificó con la variable vacía; las rutas dinámicas responderán 500 hasta que existan las variables de Preview y la base migrada.
3. **Su URL de producción queda pública con la protección predeterminada.** Los proyectos nuevos arrancan con *Standard Protection* y Vercel Authentication: eso protege los despliegues de Preview, pero **no** las URL de producción. La protección elegida —*All Deployments*— cubre también esas URL y, según la documentación, «Vercel Authentication for All Deployments … do not require a paid add-on», así que está disponible en Hobby. Password Protection no existe en Hobby y limitar la protección a Production exige Enterprise.

### 16.3 Secuencia de inicialización protegida

| # | Acción | Verificación |
| --- | --- | --- |
| 1 | En el equipo personal, *Settings → Deployment Protection*, elegir **All Deployments** con **Vercel Authentication** y guardarlo como valor predeterminado del equipo | El panel muestra la protección activa antes de que exista ningún proyecto |
| 2 | Importar `Beto-Ales/fullstack-nextjs`, Root Directory en la raíz, framework `Next.js`, rama de producción `master` | El proyecto detecta el framework y no crea variables |
| 3 | En *Settings → Build and Deployment*, fijar **Node.js 24.x**; en *Functions*, la región europea elegida | La compilación usará la misma línea que la verificación local |
| 4 | No declarar variables de Production, no habilitar cron ni tareas programadas, no conectar la base todavía | *Environment Variables* vacío para Production |
| 5 | Crear el primer despliegue (el panel lo hará al importar; por CLI sería `npx vercel@latest deploy`, nunca `--prod`) | El despliegue aparece como **Production** y es el de inicialización |
| 6 | Comprobar la protección **antes** de usar la URL | `Invoke-WebRequest https://<url>/ -MaximumRedirection 0` devuelve 401 o redirección al inicio de sesión de Vercel; con sesión en Vercel, 200 |
| 7 | Registrar la URL internamente y no compartirla | Ninguna mención pública, ningún enlace en el repositorio |
| 8 | Publicar `preview/vercel-11-4` con autorización expresa y desplegar desde esa rama | El despliegue figura como **Preview**, usa las variables de Preview y vuelve a pedir autenticación |

Si el paso 1 no puede completarse, **el despliegue no debe iniciarse**: una URL de producción pública con el login del taller accesible no es aceptable ni con datos ficticios. La comprobación del paso 6 es la puerta: sin 401 no hay Preview válido.

### 16.4 Rama de Preview

`git branch preview/vercel-11-4 HEAD` se ejecutó en 11.4 sobre `36aeafc`, sin cambiar el árbol de trabajo, y después avanzó al commit de documentación de este incremento: un avance de puntero, no una reescritura. Contiene los tres commits locales pendientes —11.2, 11.3 y 11.4— y ninguno de los cambios ajenos en curso (`app/admin/sesiones/[sessionId]/session-capacity.tsx`, `docs/database-drizzle.md`, `test-results/`), que siguen sin confirmar.

Auditoría previa a cualquier publicación:

- `git log --oneline origin/master..HEAD` muestra los dos commits anteriores y el de documentación de este incremento, en ese orden.
- El diff acumulado toca seis archivos: un script nuevo, un guard, `package.json` y tres documentos. No hay `.env`, respaldos, volcados, checkpoints ni informes de incidentes.
- La búsqueda de cadenas de conexión con credenciales, claves privadas, `VERCEL_TOKEN`, `NEON_API_KEY` y tokens de GitHub solo devuelve la plantilla de aprovisionador `postgresql://${run.user}:${password}@127.0.0.1:${port}/…`, que se construye en memoria y no contiene valores.
- `.gitignore` excluye `.env*`, `.vercel`, `.next`, `coverage` y `build`; `test-results/` no está versionado.

La publicación requiere autorización expresa y se limita a `git push -u origin preview/vercel-11-4`. **No se publica `master`**, no se usa `--force`, `--mirror` ni `--all`, y no se publica ninguna referencia de agente.

### 16.5 Base Neon Free

- **Proyecto independiente.** Se crea desde el panel de Neon con su propia cuenta, sin vincularlo a nada más. Nombre propuesto del proyecto: `art-workshop-preview`; nombre de la base: `art_workshop_preview`. El nombre no puede contener `test`, `testing`, `e2e` ni `ci` como token separado, porque `drizzle.config.ts` y `scripts/run-db-migrate.mjs` lo rechazan.
- **Región.** La europea más próxima entre las que ofrezca el panel (Fráncfort es la habitual) y, en Vercel, la región de funciones correspondiente —`fra1`—. Hobby permite una sola región: si la base queda en Europa y las funciones en `iad1`, cada consulta cruza el Atlántico. Es latencia, no corrección, pero se nota en cada carga.
- **Dos cadenas.** La **directa** se usa solo para migraciones, `npm run admin:create-super-admin` y `npm run academic:generate-sessions`. La **agrupada** (`-pooler`) es la única que se declara en `DATABASE_URL`. Ambas con TLS: `sslmode=require` como mínimo; `pg` lee el parámetro de la cadena y la aplicación no añade ninguno.
- **Aislamiento.** La base solo se declara en Preview. Production se queda sin variables: ni `DATABASE_URL` ni la clave HMAC. No hay conexión alguna con los contenedores DEV o TEST locales, que se quedan como están.
- **Integración automática con Vercel.** No se usa en 11.4. Si más adelante se conecta, hay que comprobar en el panel de Neon qué rama y qué variables recibe cada entorno: la integración puede inyectar en más de un entorno y una rama de GitHub no obtiene una base aislada por el mero hecho de ser Preview.
- **Suspensión.** El compute se suspende a los cinco minutos de inactividad. La primera petición tras la pausa paga el arranque; una comprobación manual puede tardar unos segundos y no es un error.
- **Agrupador.** Neon usa PgBouncer en modo transacción: `PREPARE`/`EXECUTE` a nivel SQL no están soportados, y las sentencias preparadas de protocolo sí desde PgBouncer 1.22. El proyecto envía sentencias sin nombre, así que no depende de ninguna de las dos cosas. El estado de sesión no está garantizado entre transacciones; la medición de 11.3 mostró que un `SET` persiste en el backend agrupado, de modo que solo `SET LOCAL` y los bloqueos `_xact_` son seguros.

### 16.6 Variables de Preview y migración controlada

Variables, solo en el entorno **Preview** y marcadas como *Sensitive*:

| Variable | Valor | Cómo se obtiene |
| --- | --- | --- |
| `DATABASE_URL` | Cadena **agrupada** de Neon con `sslmode=require` | Panel de Neon; nunca se copia al chat ni al repositorio |
| `AUTH_RATE_LIMIT_HMAC_KEY` | **64 caracteres hexadecimales en minúscula** (32 bytes) | `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`, ejecutado una vez y guardado en el gestor de secretos del propietario |

No se reutiliza ningún secreto local, no se declara ninguna `NEXT_PUBLIC_*` y no se copia `.env`. Los cambios de variables solo afectan a despliegues nuevos: hay que volver a desplegar después de guardarlas.

Migración de la base de Preview, en este orden y con la cadena **directa**:

1. **Identidad.** Comparar host, puerto y base con el panel y confirmar con `select current_database(), current_user, version();`.
2. **Base vacía.** `select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');` debe devolver `0`.
3. **Autorización.** Que exista una autorización registrada del propietario para migrar esa base concreta, con fecha y responsable; si no la hay, detenerse.
4. **Conexión directa con TLS.** Exportar la cadena directa en la sesión (`$env:DATABASE_URL = "<cadena-directa>"`), nunca en un archivo del repositorio.
5. **Aplicar** `npm run db:migrate:dev`. El script imprime el destino antes de ejecutar y rechaza nombres de prueba.
6. **Verificar** que `drizzle.__drizzle_migrations` tiene **17** filas y que la última es `0016_habitual_reservation_provenance`, y que la huella del catálogo coincide con `1714744711cd…`, la misma que producen el ensayo de staging y `pooler:check`.
7. **No migrar desde el build ni desde una función**: el build no ejecuta migraciones ([apartado 10](#10-migraciones-y-datos-iniciales)) y ninguna ruta debe hacerlo.

### 16.7 Bloqueo actual y autorizaciones que faltan

Comprobado en la máquina del proyecto el 24 de noviembre de 2026:

- `vercel` no está instalado, no existe `~/.vercel/auth.json` ni `%LOCALAPPDATA%\com.vercel.cli`, y no hay `VERCEL_TOKEN` en el entorno.
- No hay `NEON_API_KEY` ni credenciales de ningún proveedor PostgreSQL, y no existe `.vercel/` en el repositorio.
- El remoto sigue siendo `https://github.com/Beto-Ales/fullstack-nextjs.git` y `origin/master` no se ha tocado.

Por eso 11.4 termina aquí: **no se crea ninguna cuenta, ni proyecto, ni base, ni variable, ni despliegue**. Lo que falta es una acción del propietario, en este orden:

1. Crear la cuenta personal de **Vercel Hobby** vinculada a GitHub y autenticar la CLI (`npx vercel@latest login`) o trabajar desde el panel.
2. En el equipo personal, fijar **All Deployments** con Vercel Authentication como protección predeterminada.
3. Crear el proyecto de **Neon Free**, su base de Preview en región europea y sus dos cadenas, y **autorizar por escrito** la migración de esa base concreta (fecha, responsable y nombre de la base).
4. **Autorizar expresamente** el único `push` permitido: `git push -u origin preview/vercel-11-4`.
5. Autorizar la creación del primer despliegue de inicialización, que Vercel clasificará como Production, después de comprobar la protección.
6. Facilitar la cadena agrupada y la clave HMAC por el canal que elija, nunca en el chat ni en el repositorio, para declararlas solo en Preview.

Mientras falte cualquiera de los puntos 1 a 5, el estado es **bloqueado**, no completado.

### 16.8 Humo del agrupador alojado y validación del Preview

Cuando exista la base de Preview y esté migrada, el humo pendiente (read-only, todo dentro de transacciones que se revierten) debe comprobar, contra el endpoint `-pooler` real:

| Comprobación | Consulta o acción | Resultado esperado |
| --- | --- | --- |
| TLS efectivo | `select ssl from pg_stat_ssl where pid = pg_backend_pid();` | `t` tanto por la cadena directa como por la agrupada |
| Journal | `select count(*) from drizzle.__drizzle_migrations;` y la última fila | 17 y `0016_habitual_reservation_provenance` |
| Catálogo | Huella por la conexión directa y por la agrupada | Idéntica entre ambas, y `1714744711cd…` |
| Bloqueo de transacción | `pg_advisory_xact_lock(903000042)` en una conexión y `pg_try_advisory_xact_lock` en otra | `false` mientras la primera no confirma; `true` después |
| Bloqueo de fila | `select … for update nowait` sobre la misma fila desde dos conexiones | `55P03` en la segunda |
| `SET LOCAL` | `set local statement_timeout = '250ms'` y `pg_sleep(1)` | `57014`; en la transacción siguiente `statement_timeout` vuelve a su valor |
| Sentencias sin nombre | 20–100 ejecuciones parametrizadas | Sin error de sentencia preparada |
| Liberación | `select count(*) from pg_stat_activity where state = 'idle in transaction';` tras cerrar los clientes | 0 |
| Estado de sesión | Revisión de que ninguna consulta depende de `SET` de sesión ni de bloqueos sin `_xact_` | Ya se cumple en el código |

Si el endpoint de Neon se comporta distinto del ensayo local, **no se cambia la capa de persistencia**: se informa y se decide con evidencia. No se ejecutan pruebas de carga.

Validación del Preview, una vez desplegado y protegido: que el despliegue corresponda al commit esperado; Node.js 24.x y región europea en los detalles del despliegue; `/login` visible; `/admin`, `/student` y `/normativa` sin sesión redirigen a `/login`; cookie `__Host-artwork_session` con sesión válida; SUPER_ADMIN y STUDENT ficticios funcionan; los registros no muestran cadenas, claves ni contraseñas; ninguna variable apunta a DEV, TEST ni a `127.0.0.1`; y la protección sigue activa en la URL usada. Las credenciales de demostración no se publican y no se habilitan tareas periódicas.

## Documentación relacionada

- [Ensayo de despliegue en staging](staging-deployment.md): compilación, arranque y humo HTTP sobre PostgreSQL desechable; el 11.1 que sirve de referencia local.
- [Pruebas](testing.md): batería, ensayo de staging y criterios de verificación.
- [Autenticación](authentication.md): sesiones, cookies y limitación de intentos.
- [Base de datos y Drizzle](database-drizzle.md): esquema, migraciones y comandos.
- [Planificación general](../planificacion_general.md): fases, requisitos de producción y estado de H03.

## Fuentes consultadas

- Vercel: *Environments* (el primer despliegue de un proyecto nuevo siempre es de Production y compila con variables de Production; los proyectos nuevos arrancan con Standard Protection y Vercel Authentication), *Deployment Protection* (Vercel Authentication con All Deployments no requiere complemento; Password Protection no existe en Hobby; proteger solo Production exige Enterprise), *Limits* (100 despliegues al día, una compilación concurrente, 200 proyectos), almacenamiento y Marketplace, versiones de Node.js, variables de entorno y rollback. Consultada el 24 de noviembre de 2026.
- Neon: *Plans* (Free: 100 CU-horas, 1 GB por proyecto y 20 GB por cuenta, 10 ramas, suspensión a los 5 minutos; actualizada el 18 de noviembre de 2026) y *Connection pooling* (PgBouncer en modo transacción, `PREPARE`/`EXECUTE` a nivel SQL no soportado y sentencias de protocolo desde 1.22, métricas del pool). Consultada el 24 de noviembre de 2026.
- Supabase: *Connecting to your database* y limitaciones del agrupador en modo transacción.
