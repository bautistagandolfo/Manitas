# Fase 05 — Crear QUALITY_GATE.md

> **Antes de empezar:** verificá que las Fases 00, 01 y 02 estén VERDE en
> `state/STATUS.md`. Si falta alguna, DETENÉTE.

Creá un archivo `QUALITY_GATE.md` en la raíz del proyecto.

```markdown
# Production Quality Gate

## Functional

- [ ] Todos los requisitos implementados.
- [ ] Reglas de negocio verificadas.
- [ ] Edge cases relevantes cubiertos.
- [ ] Manejo de errores implementado.
- [ ] Validación de inputs implementada.

## Testing

- [ ] Unit tests implementados.
- [ ] Integration tests implementados cuando corresponda.
- [ ] E2E implementados cuando corresponda.
- [ ] Tests de regresión pasan.
- [ ] No existen tests deshabilitados para ocultar fallos.

## Security

- [ ] Authentication verificada.
- [ ] Authorization verificada.
- [ ] No existen secretos hardcodeados.
- [ ] Inputs validados.
- [ ] No existen vulnerabilidades críticas conocidas.

## Data integrity

- [ ] Constraints verificadas.
- [ ] Transacciones verificadas cuando corresponda.
- [ ] Rollback verificado.
- [ ] Concurrencia evaluada cuando corresponda.
- [ ] Migraciones verificadas.

## Code quality

- [ ] Linter pasa.
- [ ] Build pasa.
- [ ] No existen errores críticos conocidos.
- [ ] No existen TODO críticos.
- [ ] No existen cambios fuera del alcance sin justificación.

## Reliability

- [ ] Errores manejados.
- [ ] Estados inconsistentes contemplados.
- [ ] Fallos externos contemplados cuando corresponda.
- [ ] Logs adecuados.

## Performance

- [ ] Queries relevantes revisadas.
- [ ] N+1 descartado cuando corresponda.
- [ ] Operaciones innecesarias descartadas.
- [ ] Performance razonable.

## Review

- [ ] Auditoría del módulo completada.
- [ ] QA adversarial completado.
- [ ] Security review completada cuando corresponda.
- [ ] Production readiness review completado.
- [ ] Revisión manual completada.

## Deuda técnica

- [ ] Todo MEDIUM/LOW aceptado está registrado en `state/TECH_DEBT.md` con
      responsable y motivo.

### Blocking rules

CRITICAL:
Siempre bloquea.

HIGH:
Bloquea si afecta seguridad, autenticación, autorización, dinero, stock,
integridad de datos, pérdida de información o funcionamiento esencial.

Otros HIGH:
Deben documentarse en `state/TECH_DEBT.md` y aprobarse explícitamente por
un responsable humano antes de producción.

MEDIUM:
No bloquean automáticamente, pero deben documentarse en
`state/TECH_DEBT.md`.

LOW:
Pueden permanecer como deuda técnica documentada en `state/TECH_DEBT.md`.
```

No modifiques código adicional.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 05, VERDE,
> referencia a `QUALITY_GATE.md`).
