# Arquitectura técnica (Prompt 01)

## Objetivo

Separar responsabilidades desde el inicio para mantener reglas de negocio fuera de la UI y preparar transacciones seguras en servidor.

## Estructura adoptada

- `app/`
  - Rutas de Next.js App Router y composición de interfaz.
  - Server Components por defecto.
- `src/domain/`
  - Elementos de dominio puros (sin dependencias de infraestructura).
  - En esta fase: estrategia de zona horaria + identidad + reglas académicas de recurrencia y capacidad.
- `src/application/`
  - Casos de uso/coordinación de operaciones.
  - En esta fase: autenticación y servicios académicos (plantillas, sesiones, asignaciones y reservas).
- `src/infrastructure/`
  - Implementaciones técnicas: entorno, logging, errores, base de datos, esquemas, hashing, rate limiting y persistencia académica.
- `src/interfaces/`
  - Integración con Next.js para sesión/cookies, auth y acciones académicas de servidor.

## Principios aplicados

1. **Server-first**: módulos de infraestructura protegidos con `server-only`.
2. **Sin lógica de negocio en componentes visuales**.
3. **Sin acceso directo a DB desde UI**.
4. **Configuración centralizada**: entorno, DB, fechas y logging.
5. **Preparado para crecer por fases** sin introducir abstracciones vacías.

## Fuera de alcance actual

- Reglas funcionales de asistencia, cancelaciones con ventana temporal, créditos y recuperaciones.
