# Testing

## Objetivo en esta fase

Dejar lista una infraestructura de pruebas segura y mantenible, sin tocar datos reales.

## Herramientas

- **Vitest**: unitarias/integración técnica.
- **Playwright**: pruebas e2e.

## Estructura

- Unitarias/integración: `src/**/*.test.ts`
- E2E: `tests/e2e/**/*.spec.ts`

## Comandos

- `npm run test`
- `npm run test:watch`
- `npm run test:e2e`
- `npx playwright install chromium` (instala navegador E2E cuando falte)

## Base de datos para pruebas

- No usar base de datos de producción.
- Configurar una `DATABASE_URL` de test independiente cuando se añadan pruebas de integración con DB real.

## Cobertura de esta fase

Se incluyen pruebas de:

- Validación centralizada de entorno.
- Configuración de zona horaria.
- Configuración base de base de datos (pool).
- Normalización de email y validación de credenciales.
- Hash/compare de contraseñas (`bcrypt`).
- Generación y hash de tokens de sesión.
- Expiración de sesión y reglas de autorización por rol.
- Guards E2E de rutas protegidas y pantalla de login.
