# TECH_DEBT

MEDIUM y LOW aceptados conscientemente en vez de corregidos, más los HIGH
que no bloquean automáticamente y fueron aprobados explícitamente por un
responsable. Referenciado desde `QUALITY_GATE.md` y desde la Fase 0.2.

| ID | Severidad | Descripción | Módulo/Fase de origen | Por qué se acepta | Aprobado por | Fecha |
|---|---|---|---|---|---|---|
| TD-1 | _ejemplo_ | ... | ... | ... | ... | ... |
| TD-2 | LOW | `coverageThreshold` de Jest (80% en `src/modules/**/*.service.ts`, BLUEPRINT §9.8) no está configurado en `backend/package.json`: con la carpeta `modules/` vacía, el glob no matchea ningún archivo y Jest falla (`Coverage data ... was not found`) en vez de solo no aplicar el umbral. | Fase 00 — Setup del proyecto | No hay servicios todavía; agregar el umbral ahora rompe el CI sin motivo. Se agrega en la Fase 07 (implementación de módulo) cuando exista el primer `*.service.ts`. | agente | 2026-08-19 |
