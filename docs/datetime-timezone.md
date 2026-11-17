# Fechas, horas y zona horaria

## Zona horaria de negocio

- Zona horaria oficial del centro: `Europe/Copenhagen`.
- Definida en `src/domain/time/timezone.ts`.
- Validada en entorno con `APP_TIME_ZONE`.

## Estrategia

1. **Persistencia**
   - Guardar instantes en UTC en PostgreSQL (`timestamptz`).
2. **Reglas de negocio mensuales**
   - Evaluar límites por mes natural usando la zona del centro (`Europe/Copenhagen`).
3. **Presentación**
   - Formatear fechas para UI usando la zona del centro, no la local del navegador, cuando la regla de negocio lo requiera.

## Horario estacional (DST)

La zona `Europe/Copenhagen` cambia entre CET/CEST automáticamente al formatear con `Intl.DateTimeFormat` y al usar `timestamptz` correctamente.

## Recomendación para fases siguientes

- Toda consulta de ventanas mensuales y cómputos de límites debe usar explícitamente la zona del centro.
- Evitar cálculos basados en `new Date()` local de cliente para reglas de negocio.
