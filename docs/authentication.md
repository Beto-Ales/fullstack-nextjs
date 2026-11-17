# Identidad, autenticación y control de acceso (Prompt 02)

## Alcance implementado

- Login con email + contraseña.
- Hashing de contraseñas con `bcrypt`.
- Sesiones persistentes en PostgreSQL.
- Cookie HTTP-only para sesión.
- Guards de servidor por rol (`STUDENT`, `SUPER_ADMIN`).
- Logout con invalidación de sesión.
- Comando de creación inicial de `SUPER_ADMIN`.
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
- No se recorta ni transforma silenciosamente la contraseña.
- No se registra contraseña ni hash en logs.

## Sesiones y cookies

- Token generado criptográficamente (`crypto.randomBytes`).
- Solo se guarda hash SHA-256 del token en BD.
- Duración fija: 7 días (sin sliding expiration en esta fase).
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

## Rate limiting de login

Se implementa en memoria por clave `email_normalized + source`:

- máximo configurable por entorno
- ventana configurable por entorno

Limitación conocida:

- No es distribuido entre múltiples instancias.
- Se reinicia al reiniciar el proceso.

## Creación inicial del superadministrador

Comando:

```bash
SUPER_ADMIN_EMAIL=admin@example.com SUPER_ADMIN_PASSWORD='StrongPassword123!' npm run admin:create-super-admin
```

En PowerShell:

```powershell
$env:SUPER_ADMIN_EMAIL="admin@example.com"; $env:SUPER_ADMIN_PASSWORD="StrongPassword123!"; npm run admin:create-super-admin
```

Comportamiento:

- Solo permite creación si no existe ningún `SUPER_ADMIN`.
- Rechaza si el email ya existe.
- No imprime contraseña ni hash.
- No crea cuentas automáticamente al arrancar la app.

## Cambio de contraseña administrativo (pendiente)

En una fase posterior, el administrador gestionará credenciales desde interfaz protegida:

- regeneración o reasignación de contraseña temporal
- trazabilidad de la operación
- invalidación opcional de sesiones activas del usuario
