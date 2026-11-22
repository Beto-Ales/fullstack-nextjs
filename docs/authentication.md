# Identidad, autenticación y control de acceso (Prompt 02)

## Alcance implementado

- Login con email + contraseña.
- Hashing de contraseñas con `bcrypt`.
- Sesiones persistentes en PostgreSQL.
- Cookie HTTP-only para sesión.
- Guards de servidor por rol (`STUDENT`, `SUPER_ADMIN`).
- Logout con invalidación de sesión.
- Comando de creación inicial de `SUPER_ADMIN`.
- Alta de cuentas de alumno con perfil académico desde `/admin`.
- Cambio de contraseña propia desde `/student` con comprobación de la contraseña actual.
- Sin registro público.

## Modelo de identidad

### `users`

- `id` (PK, texto UUID generado en aplicación)
- `email`
- `email_normalized` (único)
- `password_hash`
- `role` (`STUDENT` | `SUPER_ADMIN`)
- `status` (`ACTIVE` | `DISABLED`)
- `deactivated_at`
- `created_at`
- `updated_at`

### `sessions`

- `id` (PK)
- `user_id` (FK -> `users.id`)
- `token_hash` (único)
- `created_at`
- `expires_at`
- `last_activity_at`
- `user_agent` (opcional)

## Contraseñas

- Algoritmo: `bcrypt`.
- Coste: constante centralizada en `src/domain/auth/password-policy.ts`.
- Política actual: mínimo 12 y máximo 128 caracteres.
- El alta de alumnos y el cambio de contraseña propia limitan la contraseña nueva a 72 bytes en UTF-8, el máximo que procesa bcrypt. La comprobación de contraseñas existentes conserva el formato admitido al iniciar sesión.
- No se recorta ni transforma silenciosamente la contraseña.
- No se registra contraseña ni hash en logs.

## Sesiones y cookies

- Token generado criptográficamente (`crypto.randomBytes`).
- Solo se guarda hash SHA-256 del token en BD.
- Duración fija: 7 días (sin sliding expiration en esta fase).
- Un cambio de contraseña propia actualiza el hash y revoca todas las sesiones del alumno en la misma transacción. El navegador que solicita el cambio borra su cookie y vuelve a `/login`. Un inicio de sesión que verificó la contraseña anterior debe comprobar que el hash sigue vigente antes de crear la sesión.
- Cookie:
  - `httpOnly: true`
  - `sameSite: "lax"`
  - `secure: true` en producción
  - `path: "/"`
  - nombre centralizado (`__Host-artwork_session` en producción, `artwork_session` fuera de producción)

## Guards y autorización

Funciones en servidor:

- `getCurrentUser()`
- `requireUser()`
- `requireRole("STUDENT" | "SUPER_ADMIN")`

Protecciones:

- `/student` requiere `STUDENT`.
- `/admin` requiere `SUPER_ADMIN`.
- `/login` redirige al área correspondiente si ya hay sesión válida.

## Permisos confirmados de fase 06

- `SUPER_ADMIN` crea cuentas con email y contraseña inicial, crea clases e inscribe alumnos de forma ordinaria.
- `STUDENT` consulta su calendario, cancela y reserva recuperaciones según la normativa y puede cambiar su propia contraseña.
- **Dar de alta a un alumno** crea la cuenta `STUDENT` y su perfil académico en una sola transacción. Usa el email normalizado para detectar duplicados y el perfil queda disponible para inscripciones.
- **Cambiar contraseña** usa la identidad de la sesión del alumno y requiere la contraseña actual.
- **Editar el correo de acceso** actualiza `email` y `email_normalized` en una transacción con los cambios de perfil y la auditoría. El índice único de PostgreSQL rechaza duplicados del correo normalizado, incluso en dos operaciones concurrentes. El nuevo correo identifica la misma cuenta y las sesiones existentes siguen vinculadas a su `user_id`. Un login en curso comprueba bajo bloqueo que el correo normalizado y el hash que verificó siguen vigentes antes de crear una sesión. El correo de contacto es independiente del de acceso. [Edición auditada](academic-model.md#edición-auditada-de-datos)

## Limitación de intentos de login

H05 identificó un contador por proceso que agrupaba por correo, primer valor de `X-Forwarded-For` y `User-Agent`. Reiniciar Next.js descartaba el estado, y cada instancia llevaba la cuenta por separado. Las cuentas inexistentes o desactivadas omitían bcrypt.

### Presupuestos y ventanas

Cada solicitud con correo y contraseña válidos en formato reserva una oportunidad del correo normalizado y otra del presupuesto general antes de consultar la cuenta o ejecutar bcrypt. El primer intento admitido abre una ventana fija e independiente para cada presupuesto. La fecha se calcula con el reloj de PostgreSQL. Una vez verificada la contraseña de una cuenta activa, se devuelve únicamente la oportunidad reservada en la ventana del correo antes de revalidar y emitir la sesión. El presupuesto general contabiliza todo intento admitido. Una solicitud limitada conserva ambos contadores y sus fechas de vencimiento, de modo que insistir durante el bloqueo no lo prolonga.

| Presupuesto | Valores predeterminados | Finalidad |
| --- | --- | --- |
| Correo normalizado | 5 intentos en 15 minutos | Contener intentos dirigidos al mismo correo, aunque se distribuyan entre conexiones. El sexto intento dentro de la ventana se limita. |
| General | 600 intentos en 15 minutos | Contener intentos dirigidos a muchos correos y acotar el trabajo de bcrypt admitido y la creación de filas. El umbral deja margen para logins ordinarios de identidades distintas. |

Todas las instancias deben compartir PostgreSQL, el secreto HMAC y los valores de configuración. El presupuesto del correo se admite entre 1 y 100 intentos y la duración de ambas ventanas entre 1 y 60 minutos. [Variables de entorno](../README.md#variables-de-entorno)

### Origen y privacidad

El despliegue del repositorio carece de un contrato de proxy que acredite la IP del cliente. Los presupuestos son independientes de `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `User-Agent` y demás cabeceras del navegador. El agente de usuario sigue siendo metadato opcional de la sesión emitida. Cualquier política futura por IP exige verificar que el backend es inaccesible sin el proxy y que este sobrescribe las cabeceras de origen, con una regla explícita para cada salto y para listas de direcciones.

El limitador guarda la clave derivada por HMAC-SHA-256, el contador y el vencimiento. Una fila con clave fija corresponde al presupuesto general. Los correos en claro, las contraseñas y sus hashes, los tokens y las cabeceras quedan fuera de la tabla. El secreto de 32 bytes se distribuye por la configuración del servidor. Rotarlo de forma coordinada cambia las claves por correo y reinicia esos presupuestos para los intentos posteriores. Las filas previas caducan y se limpian en el ciclo habitual. La fila general conserva su ventana. Los errores inesperados registran solo el lugar y el tipo de error.

### Respuestas y disponibilidad

- La entrada malformada o demasiado larga recibe «Credenciales inválidas.» antes de consultar PostgreSQL o ejecutar bcrypt. Se acota el correo bruto a 1024 caracteres y se conserva el formato de las contraseñas existentes.
- Los correos desconocidos, las cuentas desactivadas y las contraseñas incorrectas reciben el mismo mensaje. Los dos primeros ejecutan una comparación con un hash bcrypt ficticio del coste actual y siempre se rechazan. Esto reduce diferencias observables de trabajo. El acceso a datos y los hashes históricos pueden producir variaciones de tiempo.
- Una solicitud limitada recibe «Demasiados intentos. Inténtalo más tarde.». El mismo criterio se aplica a correos existentes y desconocidos. La respuesta omite los contadores.
- Si PostgreSQL falla al comprobar o actualizar el presupuesto o la configuración del limitador es inválida, el login se detiene y muestra un error temporal. Un intento fallido conserva la cookie de una sesión previa. La consulta de sesión y el logout siguen usando su acceso habitual a PostgreSQL sin pasar por el limitador.

Un abuso sostenido puede agotar repetidamente el presupuesto de un correo conocido, o el presupuesto general mediante muchas identidades, y retrasar accesos legítimos. La respuesta de limitación puede reflejar fallos anteriores o intentos simultáneos de una identidad. Para activar el control compartido, aplica primero la migración aditiva `0014`, configura la misma clave en todas las instancias y dirige el tráfico a instancias que ejecuten esta versión. [Persistencia y concurrencia](architecture.md#presupuestos-de-login-en-postgresql) · [Pruebas](testing.md#incremento-107--presupuesto-compartido-de-login)

## Creación inicial del superadministrador

Desde la raíz del repositorio, confirma primero el destino efectivo. El siguiente comando usa la misma carga de configuración que el script de alta y valida `DATABASE_URL` con el selector DEV del repositorio. Solo muestra host, puerto y nombre de la base. Para el entorno local predeterminado debe mostrar `localhost:5432/fullstack_nextjs`.

```powershell
@'
import nextEnv from '@next/env';
import { getDatabaseIdentity, selectTargetUrl } from './scripts/run-db-migrate.mjs';
try {
  nextEnv.loadEnvConfig(process.cwd());
  const { host, port, databaseName } = getDatabaseIdentity(new URL(selectTargetUrl('dev')));
  console.log(host + ':' + port + '/' + databaseName);
} catch {
  console.error('No se pudo confirmar el destino DEV.');
  process.exitCode = 1;
}
'@ | node --input-type=module -
```

Si el resultado coincide con tu DEV local y el esquema ya está migrado, ejecuta el alta en la misma consola. El prompt oculta la contraseña y el bloque elimina las variables del comando al terminar. Usa al menos 12 caracteres y un máximo de 72 bytes en UTF-8. El script recibe la contraseña temporalmente en su entorno de proceso.

```powershell
$env:SUPER_ADMIN_EMAIL = Read-Host 'Email del primer SUPER_ADMIN'
$adminSecret = Read-Host 'Contraseña inicial' -AsSecureString
$adminSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecret)
try {
  $env:SUPER_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminSecretPointer)
  npm.cmd run admin:create-super-admin
} finally {
  Remove-Item Env:SUPER_ADMIN_PASSWORD, Env:SUPER_ADMIN_EMAIL -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminSecretPointer)
  $adminSecret.Dispose()
}
```

Comportamiento:

- Solo permite creación si no existe ningún `SUPER_ADMIN`. Si hay uno, incluso desactivado, revierte la transacción y sale con código 1. La cuenta existente conserva su contraseña.
- Rechaza si el email ya existe.
- No imprime contraseña ni hash.
- No crea cuentas automáticamente al arrancar la app.

## Baja de alumnos

En **Dar de baja a un alumno**, el servidor exige `SUPER_ADMIN`. La baja cambia la cuenta a `DISABLED`, registra `deactivated_at` y revoca todas sus sesiones en la misma transacción que termina las inscripciones, libera las plazas de clases que aún no han empezado y registra las devoluciones que correspondan. La cuenta deja de aparecer entre los alumnos que pueden inscribirse y sigue disponible para consultar su historial. Una cuenta desactivada tampoco puede iniciar sesión ni recibir nuevas reservas. [Efectos académicos de la baja](academic-model.md#baja-definitiva-y-plazas).

## Cambio de contraseña administrativo (pendiente)

En una fase posterior, el administrador gestionará credenciales desde interfaz protegida:

- regeneración o reasignación de contraseña temporal
- trazabilidad de la operación
- invalidación opcional de sesiones activas del usuario
