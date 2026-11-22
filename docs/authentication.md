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

## Rate limiting de login

Se implementa en memoria por clave `email_normalized + source`:

- máximo configurable por entorno
- ventana configurable por entorno

Limitación conocida:

- No es distribuido entre múltiples instancias.
- Se reinicia al reiniciar el proceso.

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
