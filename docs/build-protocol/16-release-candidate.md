# Fase 16 — Release Candidate

Una vez que todo esté verde (Fases 7 y 8.5 en `state/STATUS.md`):

> **Antes de empezar:** verificá en `state/STATUS.md` que Integration
> Audit, E2E y Concurrencia estén VERDE. Si falta alguna, DETENÉTE.

Este estado del proyecto representa el Release Candidate. El objetivo es
evaluar este estado exacto del sistema como candidato a producción.

Considerá el código congelado durante toda la auditoría.

Verificá:

- requisitos del MVP
- QUALITY_GATE.md
- los 6 módulos del MVP
- integración
- E2E
- concurrencia
- regresión
- seguridad
- permisos
- integridad de datos
- migraciones
- variables de entorno
- configuración de producción
- build
- tests
- lint
- **escaneo de dependencias vulnerables y secretos expuestos** (repetí el
  comando, no reutilices solo el resultado de la Fase 13)
- logs
- manejo de errores
- backups
- recuperación ante fallos
- performance

No confíes únicamente en resultados anteriores.

Repetí las verificaciones críticas cuando sea posible.

Al finalizar:

```
RELEASE STATUS: READY / NOT READY

BLOCKERS: ...
HIGH RISKS: ...
MEDIUM RISKS: ...

TEST SUMMARY: ...
SECURITY SUMMARY: ...
BUILD: ...
DATABASE: ...
DEPLOYMENT: ...
REMAINING RISKS: ...
```

No declares READY si existe un blocker según las reglas del
`QUALITY_GATE.md`.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/release-candidate-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (Fase 16, READY/NOT READY, referencia al reporte).
