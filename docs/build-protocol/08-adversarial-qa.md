# Fase 08 — QA adversarial

> **Antes de empezar:** verificá en `state/STATUS.md` que la Fase 07 de este
> módulo esté VERDE. Si no, DETENÉTE.

Actuá como un QA engineer extremadamente adversarial sobre el módulo
[NOMBRE]. Tu objetivo es romper el sistema, no confirmar que funciona.

## Lógica de negocio / integridad de datos

- fallos a mitad de operación
- transacciones incompletas
- rollback
- estados intermedios inconsistentes
- datos huérfanos

## API

- parámetros inválidos
- tipos incorrectos
- requests incompletos
- requests duplicados
- respuestas incorrectas
- HTTP status incorrectos

## UI

- estados vacíos
- errores
- loading
- doble click
- refresh
- navegación inesperada
- datos extremadamente largos

## Security

- autenticación
- autorización
- IDOR
- acceso a recursos ajenos
- manipulación de IDs
- inputs maliciosos
- exposición de información

## Testing de mutación (obligatorio en módulos de plata y stock)

Antes de dar el módulo por aprobado, corré Stryker sobre sus servicios:

```
npx stryker run --mutate "src/modules/<modulo>/**/*.service.ts"
```

Mide si los tests **detectarían** una falla real, en vez de confiar en que
se ven bien.

- Umbral: **80% de mutantes detectados**.
- Por cada mutante sobreviviente relevante, escribí el test que lo mata.
- Si un mutante sobrevive porque el código es inalcanzable o la mutación es
  irrelevante, documentalo; no fuerces el número.

Reportá el porcentaje antes y después.

No inventes requisitos de negocio. Si un comportamiento esperado no está
definido, reportalo como ambigüedad (agregala a `state/AMBIGUITIES.md`).

Creá tests automatizados para los casos relevantes.

No borres ni debilites tests existentes.

Ejecutá la suite correspondiente.

Por cada problema:

```
SEVERITY: CRITICAL / HIGH / MEDIUM / LOW
REPRODUCTION: ...
EXPECTED: ...
ACTUAL: ...
ROOT CAUSE: ...
FIX: ...
```

No declares el módulo aprobado si existe un problema que bloquee el
Quality Gate.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/modulo-<nombre>-qa-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (módulo [NOMBRE], Fase 08, VERDE/BLOQUEADO).
