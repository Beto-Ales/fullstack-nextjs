# Despliegue en Vercel

Este documento audita la compatibilidad del repositorio con un despliegue alojado en Vercel y describe la preparación de la cuenta, la base de datos y las variables de entorno. Corresponde al incremento 11.2 de la fase 11.

**No se ha creado ninguna cuenta, no se ha aprovisionado ninguna base, no se ha configurado ningún proyecto ni se ha ejecutado ningún despliegue.** Todo lo que sigue es análisis y procedimiento. Un despliegue real exige las decisiones del propietario del [apartado 3](#3-requisitos-previos-y-decisiones-del-propietario) y sigue sin cerrar H03.

## 1. Alcance y estado

### Qué se comprobó

| Comprobación | Resultado |
| --- | --- |
| `next build` con `DATABASE_URL` vacía y `.env` presente | Compila; 8 rutas; `/` y `/_not-found` estáticas y el resto dinámicas. La compilación no alcanza ninguna base. |
| `npm run staging:rehearse` (11.1, 23 de noviembre de 2026; no repetido en 11.2) | Código 0, **66 comprobaciones** y journal `0016_habitual_reservation_provenance`, con compilación de producción, arranque y recorridos HTTP sobre cookies reales. |
| `npm run test:verify` (línea base de 11.1, 23 de noviembre de 2026; no repetida en 11.2) | **385 pruebas Vitest** en 41 archivos, **50 escenarios Chromium** y **1 escenario** con normativa sintética, cada etapa sobre su PostgreSQL 15 desechable. |
| `npm run typecheck`, `npm run lint`, `npx drizzle-kit check` (24 de noviembre de 2026) | Sin errores. El journal sigue en `0016`. |
| Lectura de la configuración y del código de datos, sesión, bloqueos y scripts | Sin dependencias de rutas absolutas, del sistema de archivos ni de estado de proceso en tiempo de ejecución. |
| Documentación vigente de Vercel, Neon y Supabase | Límites de funciones, versiones de Node, entornos, protección de despliegues y modo transacción de los agrupadores. |

### Qué no se comprobó

- Ningún despliegue real en Vercel, ni siquiera de prueba.
- La batería de pruebas y el ensayo de staging no se repitieron en este incremento: las cifras de la tabla son las de 11.1, del 23 de noviembre de 2026.
- Ninguna base alojada: la línea base se ejecutó sobre PostgreSQL 15 local y desechable.
- Proveedor, región, plan, dominio, protección de despliegues y respaldos operativos.
- Node.js 26, que hoy es la versión predeterminada de Vercel, y PostgreSQL 16 o 17, que son las versiones que suelen ofrecer los proveedores.
- Un pipeline de CI: el repositorio sigue dependiendo de ejecuciones manuales.

### Advertencia sobre el método

`next build` y `next start` en la máquina local **no** demuestran compatibilidad con Vercel: la plataforma compila con su propia versión de Node, empaqueta las funciones con su trazador de archivos y ejecuta cada ruta en un entorno sin estado. El ensayo de [staging](staging-deployment.md) es el mejor sustituto local porque compila con un entorno inerte, arranca el servidor y comprueba sesiones reales, pero tampoco configura un servidor, DNS, TLS ni un gestor de secretos.

## 2. Modelo de despliegue

- **Origen.** Integración Git de Vercel con GitHub sobre el repositorio público `Beto-Ales/fullstack-nextjs`. `git ls-remote --heads origin` anuncia una sola rama, `master`, en `af64702` (`build(staging): ensayar despliegue reproducible con PostgreSQL aislado`), que es el mismo commit que `HEAD`. El requisito del cierre de la fase 10 de publicar el estado actual queda cubierto por esa observación de solo lectura; este incremento no hizo `push`.
- **Proyecto.** Se crea conectando el repositorio desde el panel. Cada `push` a `master` genera un despliegue de Production y el resto de ramas y pull requests, despliegues de Preview.
- **Configuración esperada.** Root Directory en la raíz del repositorio, Framework Preset `Next.js` detectado automáticamente, Install Command `npm install` (respeta `package-lock.json`, `lockfileVersion` 3), Build Command `npm run build` y Output Directory por defecto. No hay `vercel.json`, `now.json` ni carpeta `.vercel` versionada; `.gitignore` ya excluye `.vercel`.
- **Node.js.** Vercel usa por defecto la última LTS disponible (26.x en la consulta del 24 de noviembre de 2026) y permite fijar 24.x o 22.x en *Settings → Build and Deployment*. La línea base se verificó con Node.js 24.18.0 y `next` 16.3.8 exige Node.js 20.9 o superior. El repositorio no declara `engines`, así que **la versión queda a cargo de la configuración del proyecto**: se recomienda fijar 24.x para igualar el entorno verificado antes de desplegar.
- **Región.** Las funciones se ejecutan en una sola región, `iad1` por defecto, y solo los planes Pro y Enterprise admiten varias. Debe elegirse la región más próxima a la base de datos; cada salto transatlántico se paga en cada consulta.
- **Duración y memoria.** Ninguna ruta ni acción declara `maxDuration`, así que se aplica el valor de la plataforma (300 s en Hobby). Las operaciones de la aplicación son cortas; la generación de sesiones y las migraciones son comandos fuera de línea.
- **Límites relevantes.** 250 MB de función sin comprimir, 1.024 descriptores de archivo compartidos por instancia (incluidas las conexiones de base), 4,5 MB de cuerpo de petición y respuesta no transmitida. Ninguno se acerca con el uso previsto.

## 3. Requisitos previos y decisiones del propietario

Ninguna de estas decisiones está tomada. Sin ellas no debe iniciarse el despliegue.

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

- **Ámbito.** Cada variable se declara por entorno (`Production`, `Preview`, `Development`). Un valor exclusivo de Production no llega a Preview y viceversa. Si Preview comparte `DATABASE_URL` con Production, cada `push` de una rama escribirá en datos reales: la recomendación es una base o rama distinta para Preview, o no conectar Preview.
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

Orden previsto, con el resultado que debe observarse en cada paso. Los pasos 1 a 5 los ejecuta quien administra la cuenta; los pasos 6 a 9, quien opera la base.

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

El primer despliegue puede hacerse antes de las migraciones: la compilación no necesita base. Pero la aplicación responderá 500 en las rutas dinámicas hasta que el journal esté aplicado y las variables configuradas.

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
| `idle_in_transaction_session_timeout` no configurado | Una transacción colgada retiene bloqueos y conexiones. | Configurarlo en el proveedor. |
| Preview compartiendo base con Production | Cada `push` escribiría en datos reales. | Base o rama separada para Preview, o no conectar Preview. |
| Presupuesto global de login agotable | Un atacante puede consumir los 600 intentos y bloquear el acceso durante la ventana. | Es el compromiso de H05; vigilar los registros y considerar ajustes si ocurre. |
| Respaldos y restauración no definidos | Sin recuperación verificada ante borrado o migración fallida. | Decisión y prueba pendientes del propietario. |
| Generación de sesiones manual | El horizonte de sesiones se agota si nadie ejecuta el comando. | Programar la ejecución periódica fuera de Vercel o documentar el calendario operativo. |
| H03 abierto | Credenciales históricas y saneamiento pendiente. | No lo resuelve este incremento. |
| Protección de despliegues sin decidir | Los paneles podrían quedar públicos o las comprobaciones bloqueadas. | Decisión del propietario en el [apartado 3](#3-requisitos-previos-y-decisiones-del-propietario). |
| Portada heredada de la plantilla | `/` muestra el ejemplo de Full Stack Open, no el taller. | Es estática y no expone datos; decidir su contenido o retirarla antes de publicar. |
| Validación con lector de pantalla pendiente | Accesibilidad sin cierre manual con NVDA. | Pendiente heredado de la fase 10. |

Nada de esta lista se ha ejecutado ni modificado en este incremento: es un inventario para decidir antes de desplegar.

## Documentación relacionada

- [Ensayo de despliegue en staging](staging-deployment.md): compilación, arranque y humo HTTP sobre PostgreSQL desechable; el 11.1 que sirve de referencia local.
- [Pruebas](testing.md): batería, ensayo de staging y criterios de verificación.
- [Autenticación](authentication.md): sesiones, cookies y limitación de intentos.
- [Base de datos y Drizzle](database-drizzle.md): esquema, migraciones y comandos.
- [Planificación general](../planificacion_general.md): fases, requisitos de producción y estado de H03.

## Fuentes consultadas

- Vercel: almacenamiento y Marketplace, límites de funciones, versiones de Node.js, variables de entorno, protección de despliegues y rollback (documentación oficial consultada el 24 de noviembre de 2026).
- Supabase: *Connecting to your database* y limitaciones del agrupador en modo transacción.
- Neon: *Connection pooling* y diferencias entre el endpoint agrupado y el directo.
