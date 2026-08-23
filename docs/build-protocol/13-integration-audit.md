# Fase 13 — Integration Audit

Cuando los 6 módulos del MVP estén aprobados individualmente (Fase 12 VERDE para
todos en `state/STATUS.md`):

> **Antes de empezar:** verificá en `state/STATUS.md` que los 6 módulos del MVP
> tengan Fase 12 = VERDE. Si falta alguno, DETENÉTE.

Quiero auditar la integración completa del sistema.

Los 6 módulos del MVP ya pasaron sus respectivos Quality Gates.

NO MODIFIQUES CÓDIGO.

El objetivo es encontrar problemas que solamente puedan aparecer cuando los
módulos interactúan.

Mapeá las dependencias reales entre módulos (contrastá contra
`MVP_SCOPE.md`, que puede haber quedado desactualizado tras la
implementación — señalá las diferencias).

Para cada interacción verificá:

- contratos
- inputs
- outputs
- estados
- errores
- transacciones
- permisos
- consistencia
- concurrencia
- side effects

Prestá especial atención a las relaciones reales del proyecto.

Buscá:

- inconsistencias
- doble descuento de stock
- stock negativo
- ventas duplicadas
- operaciones parcialmente completadas
- datos huérfanos
- estados imposibles
- problemas de permisos
- errores transaccionales
- race conditions
- inconsistencias entre módulos

No asumas que los módulos funcionan correctamente juntos solo porque cada
uno pasó su Quality Gate.

## Escaneo de dependencias y secretos (a nivel sistema completo)

Ejecutá el escaneo de dependencias vulnerables (`npm audit`, `pip-audit` o
equivalente según el stack) y un escaneo de secretos expuestos (`gitleaks`
o equivalente) sobre todo el repositorio, no solo por módulo. Adjuntá los
resultados al reporte.

Generá un Integration Risk Report.

Clasificá:

CRITICAL
HIGH
MEDIUM
LOW

NO MODIFIQUES NADA.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/integration-audit-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (Fase 13, VERDE/BLOQUEADO, referencia al reporte).
