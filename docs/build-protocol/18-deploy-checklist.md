# Fase 18 — Deploy checklist

> Esto no es una decisión que tome un agente solo: es una checklist de
> preparación. La autorización final la da una persona responsable.

> **Antes de empezar:** verificá que Fase 16 = READY y Fase 17 = VERDE en
> `state/STATUS.md`. Si falta alguna, DETENÉTE.

Generá `DEPLOY_CHECKLIST.md` verificando:

- [ ] Release Candidate con status READY (Fase 16).
- [ ] `state/ROLLBACK_PLAN.md` existe y fue probado (Fase 17).
- [ ] Variables de entorno de producción configuradas, sin valores de
      default/dev, sin secretos expuestos en el repo.
- [ ] Migraciones a aplicar identificadas y en orden, con backup fresco
      tomado inmediatamente antes de aplicarlas.
- [ ] Monitoreo/alertas configurados para los flujos críticos (venta, caja,
      stock, autenticación).
- [ ] Ventana de deploy y responsable de guardia definidos.
- [ ] Escaneo de dependencias/secretos corrido y sin hallazgos CRITICAL.
- [ ] Plan de comunicación si algo sale mal.

Marcá cada ítem LISTO / FALTA. Si falta backup, rollback probado,
variables de entorno o migraciones verificadas, es BLOCKER.

**La autorización de deploy la da explícitamente una persona responsable,
citando este checklist en verde. Ningún agente debe autodeployar a
producción.**

Una vez autorizado por la persona responsable:

1. Tomá el backup pre-deploy.
2. Aplicá las migraciones en el orden documentado.
3. Deployá el código congelado del Release Candidate (mismo commit/tag que
   se auditó, sin cambios de último momento).
4. Confirmá que la aplicación levantó correctamente antes de pasar a la
   Fase 19.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 18, VERDE,
> con el nombre de quién autorizó y la hora del deploy).
