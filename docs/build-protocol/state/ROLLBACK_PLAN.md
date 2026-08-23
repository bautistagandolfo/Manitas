# ROLLBACK_PLAN

Este archivo se genera ejecutando `20-rollback-backup-drill.md`, después de
que la Fase 9 (Release Candidate) dio READY. No debería quedar vacío al
llegar a la Fase 10.

Secciones esperadas:

```
## Resultado del ensayo de restauración de backup
## Cómo revertir el código (versión/tag/artefacto anterior)
## Cómo revertir las migraciones de este release
## Cómo desactivar funcionalidades nuevas rápidamente (feature flags/config)
## Tiempo estimado de rollback completo
## Quién está autorizado a decidir un rollback
```
