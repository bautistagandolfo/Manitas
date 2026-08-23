# Fase 12 — Production Readiness Review del módulo

> **Antes de empezar:** verificá que la Fase 11 (o su omisión justificada)
> esté registrada en `state/STATUS.md`. Si no, DETENÉTE.

Quiero realizar el Production Readiness Review definitivo del módulo
[NOMBRE].

## Security

- authentication/authorization aplicadas correctamente en este módulo
- secrets
- data exposure

## Reliability

- errors
- timeouts
- retries
- external failures
- inconsistent states

## Performance

- queries
- N+1
- unnecessary operations
- memory
- slow endpoints

## Code quality

- architecture
- duplication
- complexity
- maintainability

## Observability

- logs
- useful debugging information

## Deployment

- environment variables
- migrations
- configuration
- build

Ejecutá todos los tests relevantes.

Ejecutá lint.

Ejecutá build.

Ejecutá análisis estático disponible cuando corresponda.

NO CORRIJAS NADA.

Al finalizar:

```
PRODUCTION READY: YES / NO

CRITICAL ISSUES: ...
HIGH ISSUES: ...
MEDIUM ISSUES: ...
LOW ISSUES: ...

TEST RESULTS: ...
SECURITY RESULTS: ...
PERFORMANCE RESULTS: ...
REMAINING RISKS: ...
```

Aplicá las reglas de bloqueo definidas en `QUALITY_GATE.md`.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/modulo-<nombre>-prodready-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (módulo [NOMBRE], Fase 12, VERDE/BLOQUEADO). Este es el
> gate de cierre del módulo — solo si está VERDE se puede considerar el
> módulo aprobado para la Integration Audit.
