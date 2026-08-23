# Fase 17 — Backup restore drill + plan de rollback

> **Antes de empezar:** verificá que la Fase 16 haya dado READY en
> `state/STATUS.md`. Si dio NOT READY, DETENÉTE — no tiene sentido preparar
> el rollback de un release que todavía no está listo.

Antes de autorizar el deploy quiero verificar que podemos recuperarnos de
un desastre.

1. Ejecutá (o simulá en un entorno aislado, **nunca contra producción**)
   una restauración real del último backup disponible y verificá la
   integridad de los datos restaurados.

   **Atención — hosting gratuito:** los planes gratuitos tienen retención
   mínima o nula, así que el backup que hay que restaurar es el **propio**
   (el `pg_dump` diario del blueprint 9.10), no el del proveedor. Verificá
   específicamente que:
   - la GitHub Action programada corrió en los últimos días;
   - el dump existe en el almacenamiento externo y **no está vacío**;
   - se puede descifrar y restaurar sobre una base limpia;
   - los datos restaurados están completos (ventas, caja, stock, gastos).

   Si el backup propio no existe o no se puede restaurar, es **BLOCKER**.
   No hay red de contención: perder la base es perder la contabilidad de la
   clienta.

2. Documentá en `state/ROLLBACK_PLAN.md`, paso a paso:
   - cómo revertir el deploy de código (versión/tag/artefacto anterior)
   - cómo revertir las migraciones aplicadas en este release, o por qué no
     son reversibles y qué mitigación existe en ese caso
   - cómo desactivar rápidamente las funcionalidades nuevas si hace falta
     (feature flags/config), o alternativa si no existen
   - tiempo estimado de rollback completo
   - quién está autorizado a decidir un rollback

3. Si el backup no pudo restaurarse correctamente, o no existe un
   mecanismo de rollback viable para las migraciones de este release, esto
   es BLOCKER — no se puede continuar a la Fase 18 aunque el Release
   Candidate haya dado READY.

NO MODIFIQUES CÓDIGO DE PRODUCCIÓN.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 17,
> VERDE/BLOQUEADO, referencia a `state/ROLLBACK_PLAN.md`).
