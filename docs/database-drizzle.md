# PostgreSQL y Drizzle ORM

## Dependencias

- `drizzle-orm`
- `drizzle-kit`
- `pg`
- `@types/pg`

## Archivos clave

- `drizzle.config.ts`: configuración de Drizzle Kit.
- `src/infrastructure/db/client.ts`: pool singleton y cliente Drizzle.
- `src/infrastructure/db/config.ts`: configuración de pool.
- `src/infrastructure/db/schema/`: esquemas Drizzle.

## Convenciones

- Esquemas en `src/infrastructure/db/schema`.
- Migraciones en `drizzle/`.
- Timestamps persistidos con zona horaria (`timestamptz`).

## Esquema actual

- `app_metadata`: metadatos técnicos.
- `users`: identidad, rol y estado de cuenta.
- `sessions`: sesiones persistentes con hash de token.
- `student_profiles`: perfil académico de usuario `STUDENT`.
- `class_templates`: plantilla semanal recurrente.
- `class_sessions`: ocurrencias concretas de clase.
- `student_template_assignments`: horarios habituales por alumno.
- `class_reservations`: reservas por sesión y alumno.
- `session_capacity_blocks`: plazas bloqueadas por administración.

## Flujo de migraciones

1. Cambiar esquemas en `src/infrastructure/db/schema`.
2. Ejecutar:
   - `npm run db:generate`
   - `npm run db:migrate`

## Entorno local

Configurar `DATABASE_URL` en `.env` usando `.env.example` como base.

Ejemplo local:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fullstack_nextjs
```

## Estado de migraciones

- `0000_smiling_hobgoblin.sql`: infraestructura base inicial.
- `0001_melted_christian_walker.sql`: tablas de identidad y sesiones.
- `0002_soft_toad.sql`: modelo académico (plantillas, sesiones, perfiles, reservas y capacidad).
